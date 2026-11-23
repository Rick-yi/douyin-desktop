/**
 * 手机签名搜索服务
 *
 * 背景（实测 2026-10-29）：
 *   抖音网页端视频搜索接口对「车抵贷 / 汽车抵押 / 典当行」这类关键词
 *   会返回 search_nil_info = antispam_check / hit_limit，data 为空。
 *   但手机视口的 SEO 搜索页（so.douyin.com）能正常返回结果。
 *
 * 做法：
 *   1. 用隐藏 BrowserWindow + iPhone UA + 账号 Cookie 打开搜索页
 *   2. 抓页面自己发出的签名请求（msite/general/search/single，带 backtrace/msToken）
 *   3. 在页面内部 fetch 这个签名 URL，只改 keyword/offset/currentPage
 *   4. 从 business_data 里提取 aweme_info，返回视频列表
 *
 * 实测：同一份签名可以改关键词、改页码复用；单关键词池子约 80~115 条。
 */
import { BrowserWindow, session } from 'electron';
import { HarvestError } from './harvest-service.js';
import { rememberProxyCredential, proxyRulesOf } from './proxy-auth.js';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const SEARCH_API_PATH = '/s/fe/api/aweme/v2/search/msite/general/search/single/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, stepMs = 300) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function setCookies(ses, cookieString) {
  let ok = 0;
  for (const part of String(cookieString ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      await ses.cookies.set({
        url: 'https://www.douyin.com/',
        name,
        value,
        domain: '.douyin.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'no_restriction',
      });
      ok++;
    } catch {}
  }
  return ok;
}

function clickMore(win) {
  return win.webContents
    .executeJavaScript(`(() => {
      const el = [...document.querySelectorAll('button, a, div, span')]
        .find(e => (e.innerText || '').trim() === '更多搜索结果');
      if (el) { el.click(); return true; }
      return false;
    })()`)
    .catch(() => false);
}

/**
 * @param {object} opts
 * @param {string} opts.cookies  账号 Cookie 字符串（sdk.account.im.client.getCookies()）
 * @param {string[]} opts.keywords
 * @param {number} [opts.target] 总目标视频数
 * @param {number} [opts.maxPagesPerKeyword]
 * @param {number} [opts.count]
 * @param {number} [opts.intervalMs]
 * @param {(p: object) => void} [opts.onProgress]
 * @returns {Promise<{videos: object[], requests: number}>}
 */
export async function collectMobileSearchVideos({
  cookies,
  keywords = [],
  target = 300,
  maxPagesPerKeyword = 12,
  count = 20,
  intervalMs = 1500,
  proxyUrl = null,
  beforeRequest = null,
  onProgress,
} = {}) {
  const list = [...new Set((keywords ?? []).map((k) => String(k ?? '').trim()).filter(Boolean))];
  if (!list.length) throw new HarvestError('mobile_search_no_keyword', '没有有效关键词');
  if (!String(cookies ?? '').trim()) {
    throw new HarvestError('mobile_search_no_cookie', '账号 Cookie 为空，无法使用手机搜索');
  }

  const partition = `zmtjl-mobile-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ses = session.fromPartition(partition);
  ses.setUserAgent(MOBILE_UA);

  // 手机搜索页必须和 SDK 走同一个账号代理，否则会暴露本机真实 IP
  if (proxyUrl) {
    const rules = proxyRulesOf(proxyUrl);
    if (!rules) throw new HarvestError('mobile_search_proxy_invalid', '账号代理地址无效');
    rememberProxyCredential(proxyUrl);
    try {
      await ses.setProxy({
        proxyRules: rules,
        proxyBypassRules: '<-loopback>',
      });
    } catch (e) {
      throw new HarvestError('mobile_search_proxy_failed', `手机搜索无法设置代理：${e.message}`);
    }
  }

  const cookieCount = await setCookies(ses, cookies);
  if (!cookieCount) {
    throw new HarvestError('mobile_search_cookie_failed', 'Cookie 写入失败，无法使用手机搜索');
  }

  let signedUrl = '';
  const onBeforeSendHeaders = (details, cb) => {
    if (!signedUrl && details.url.includes(SEARCH_API_PATH)) {
      signedUrl = details.url;
    }
    cb({ requestHeaders: details.requestHeaders });
  };
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.douyin.com/*'] }, onBeforeSendHeaders);

  const win = new BrowserWindow({
    width: 390,
    height: 844,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setUserAgent(MOBILE_UA);
  win.webContents.setAudioMuted(true);
  try {
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  } catch {}

  let requests = 0;
  const found = new Map();
  const perKeywordTarget = Math.max(
    10,
    Math.ceil((Number(target) || 300) / Math.max(1, list.length) * 1.2),
  );

  try {
    const failedKeywords = [];

    for (const keyword of list) {
      // ★ 签名 URL 里的 keyword 是参与签名的，不能拿第一个关键词的 URL
      //   直接改 keyword 复用；每个关键词都必须重新打开搜索页取一份签名。
      signedUrl = '';
      if (beforeRequest) await beforeRequest({ phase: 'page-load', keyword });
      try {
        await win.loadURL(
          'https://www.douyin.com/search/' + encodeURIComponent(keyword),
          { userAgent: MOBILE_UA },
        );
      } catch {}

      let captured = await waitFor(() => !!signedUrl, 12000, 400);
      if (!captured) {
        await clickMore(win);
        captured = await waitFor(() => !!signedUrl, 9000, 400);
      }
      if (!captured && !signedUrl) {
        failedKeywords.push(keyword);
        continue;
      }

      let noNew = 0;
      let kwAdded = 0;

      for (let page = 0; page < maxPagesPerKeyword; page++) {
        const offset = page * count;
        const u = new URL(signedUrl);
        u.searchParams.set('keyword', keyword);
        u.searchParams.set('pd', 'video');
        u.searchParams.set('count', String(count));
        u.searchParams.set('offset', String(offset));
        u.searchParams.set('currentPage', String(page + 1));

        let res;
        try {
          if (beforeRequest) {
            await beforeRequest({ phase: 'search', keyword, page: page + 1 });
          }
          res = await win.webContents.executeJavaScript(`(async () => {
            try {
              const r = await fetch(${JSON.stringify(u.href)}, {
                credentials: 'include',
                headers: { Accept: '*/*' },
              });
              const text = await r.text();
              let json = null;
              try { json = JSON.parse(text); } catch {}
              if (!json) return { status: r.status, error: 'non-json', len: text.length };
              const list = [];
              const seenId = new Set();
              const walk = (o, depth) => {
                if (!o || depth > 8) return;
                if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
                if (typeof o !== 'object') return;
                if (o.aweme_id && o.desc !== undefined && !seenId.has(String(o.aweme_id))) {
                  seenId.add(String(o.aweme_id));
                  const st = o.statistics || {};
                  list.push({
                    awemeId: String(o.aweme_id),
                    desc: String(o.desc || '').slice(0, 120),
                    authorUid: o.author?.uid ? String(o.author.uid) : null,
                    authorName: o.author?.nickname || '',
                    createTime: o.create_time || null,
                    diggCount: st.digg_count ?? 0,
                    commentCount: st.comment_count ?? 0,
                    shareCount: st.share_count ?? 0,
                  });
                }
                for (const k of Object.keys(o)) walk(o[k], depth + 1);
              };
              walk(json.business_data || json.data || json, 0);
              return { status: r.status, len: text.length, videos: list };
            } catch (e) { return { error: String(e) }; }
          })()`);
        } catch (e) {
          if (e?.code === 'quota') throw e;
          res = { error: e.message };
        }
        requests++;

        if (res?.error || !Array.isArray(res?.videos)) {
          noNew++;
          if (noNew >= 2) break;
          await sleep(intervalMs);
          continue;
        }

        let added = 0;
        for (const v of res.videos) {
          if (found.has(v.awemeId)) continue;
          found.set(v.awemeId, {
            ...v,
            shareUrl: `https://www.douyin.com/video/${v.awemeId}`,
            keyword,
          });
          added++;
        }
        kwAdded += added;
        if (onProgress) {
          try {
            onProgress({
              keyword,
              page: page + 1,
              offset,
              returned: res.videos.length,
              added,
              total: found.size,
            });
          } catch {}
        }

        if (added === 0) {
          noNew++;
          if (noNew >= 2) break;
        } else {
          noNew = 0;
        }
        if (kwAdded >= perKeywordTarget) break;
        await sleep(intervalMs);
      }
    }

    if (!found.size) {
      throw new HarvestError(
        'mobile_search_empty',
        failedKeywords.length
          ? `手机搜索没有返回视频；以下关键词未取到签名：${failedKeywords.join('、')}`
          : '手机搜索没有返回视频。可能是关键词无结果、签名过期或触发风控，请稍后重试。',
      );
    }

    return { videos: [...found.values()], requests };
  } finally {
    try { ses.webRequest.onBeforeSendHeaders(null); } catch {}
    try { win.destroy(); } catch {}
    try { await ses.clearStorageData(); } catch {}
  }
}
