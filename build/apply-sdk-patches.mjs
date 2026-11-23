/**
 * 给 douyin-im 打本地补丁（幂等）
 *
 * 这些补丁修的是 SDK 传输层的问题，无法只靠外层封装解决：
 *   1. WebSocket 连接支持按账号注入 CONNECT agent（代理真正生效）
 *   2. transport 的 iid 改为每次请求读取（设备注册晚于构造时不再用旧值）
 *   3. transport 超时复用 ApiConnection.requestTimeoutMs
 *   4. 上传凭据按 configKey 缓存 10 分钟
 *   5. 视频分片失败重试一次
 *   6. 本机硬件信息进程内缓存
 *   7. 空闲账号保持低频 session 续期
 *
 * 用法：npm run patch:sdk
 * 重新安装依赖后需要再跑一次。脚本会检查版本和补丁点，不会静默跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkDir = path.join(root, 'node_modules', 'douyin-im');
const pkgFile = path.join(sdkDir, 'package.json');

if (!fs.existsSync(pkgFile)) {
  console.error('[patch:sdk] 找不到 douyin-im，请先 npm install');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
if (version !== '1.1.0') {
  console.error(`[patch:sdk] 当前 douyin-im 版本是 ${version}，补丁只针对 1.1.0；请先核对再更新脚本`);
  process.exit(1);
}

let failed = 0;
let changed = 0;

function apply(rel, marker, before, after) {
  const file = path.join(sdkDir, rel);
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes(marker)) {
    console.log(`[patch:sdk] 已存在 ${marker}  ${rel}`);
    return;
  }
  if (!text.includes(before)) {
    console.error(`[patch:sdk] 补丁点未找到 ${marker}  ${rel}`);
    failed++;
    return;
  }
  text = text.replace(before, after);
  fs.writeFileSync(file, text, 'utf8');
  changed++;
  console.log(`[patch:sdk] 已应用 ${marker}  ${rel}`);
}

// 1. WS 连接注入 agent
apply(
  'lib/services/im/ws-client.js',
  '__ZMTJL_WS_AGENT__',
  '            const ws = new WebSocket(url, IM_WS_CONFIG.wsProtocols, { headers: wsHeaders });',
  `            // __ZMTJL_WS_AGENT__ pass a per-account CONNECT agent for wss
            const wsOptions = { headers: wsHeaders };
            if (this.opts.agent)
                wsOptions.agent = this.opts.agent;
            const ws = new WebSocket(url, IM_WS_CONFIG.wsProtocols, wsOptions);`,
);

// 2. receiver 在每次连接/重连时解析 agent
apply(
  'lib/base/runtime/adapters/frontier-websocket.js',
  '__ZMTJL_WS_AGENT__',
  `        if (this.opts.verbose != null)
            wsOpts.verbose = this.opts.verbose;
        this.ws = new FrontierImWs(wsOpts);`,
  `        if (this.opts.verbose != null)
            wsOpts.verbose = this.opts.verbose;
        // __ZMTJL_WS_AGENT__ resolve a per-account CONNECT agent from the app registry
        if (typeof globalThis.__zmtjlWsAgent === 'function') {
            const agent = globalThis.__zmtjlWsAgent({
                deviceId: this.opts.deviceId,
                installId: this.opts.installId,
            });
            if (agent)
                wsOpts.agent = agent;
        }
        this.ws = new FrontierImWs(wsOpts);`,
);

// 3. iid 动态读取
apply(
  'lib/services/im/transport.js',
  '__ZMTJL_DYNAMIC_IID__',
  `        if (this.installId !== undefined)
            url.searchParams.set('iid', this.installId);`,
  `        // __ZMTJL_DYNAMIC_IID__ device registration can finish after transport construction
        const iid = this.client.getInstallId?.();
        if (iid !== undefined)
            url.searchParams.set('iid', iid);`,
);

// 4. 超时复用连接配置
apply(
  'lib/services/im/transport.js',
  '__ZMTJL_TIMEOUT__',
  '            signal: AbortSignal.timeout(20_000),',
  `            // __ZMTJL_TIMEOUT__
            signal: AbortSignal.timeout(this.client.requestTimeoutMs ?? 20_000),`,
);

// 5. 上传凭据缓存
apply(
  'lib/services/im/upload.js',
  '__ZMTJL_UPLOAD_CACHE__',
  'const VIDEO_PART_SIZE = 5 * 1024 * 1024;',
  `const VIDEO_PART_SIZE = 5 * 1024 * 1024;
// __ZMTJL_UPLOAD_CACHE__ credentials are valid for minutes; avoid refetching per message
const __zmtjlCredentialCache = new Map();
const __ZMTJL_CREDENTIAL_TTL_MS = 10 * 60 * 1000;`,
);
apply(
  'lib/services/im/upload.js',
  '__ZMTJL_UPLOAD_CACHE_READ__',
  `    async credentials(configKey = 'public_image_config') {
        const deviceId = this.client.getDeviceId?.() ?? await this.deviceId();`,
  `    async credentials(configKey = 'public_image_config') {
        // __ZMTJL_UPLOAD_CACHE_READ__
        const cached = __zmtjlCredentialCache.get(configKey);
        if (cached && cached.expiresAt > Date.now())
            return cached.value;
        const deviceId = this.client.getDeviceId?.() ?? await this.deviceId();`,
);
apply(
  'lib/services/im/upload.js',
  '__ZMTJL_UPLOAD_CACHE_WRITE__',
  `        if (!response.ok || !credentials.accessKeyId || !credentials.secretAccessKey || !credentials.spaceName) {
            throw new Error(\`upload credentials unavailable (HTTP \${response.status})\`);
        }
        return credentials;
    }`,
  `        if (!response.ok || !credentials.accessKeyId || !credentials.secretAccessKey || !credentials.spaceName) {
            throw new Error(\`upload credentials unavailable (HTTP \${response.status})\`);
        }
        // __ZMTJL_UPLOAD_CACHE_WRITE__
        __zmtjlCredentialCache.set(configKey, {
            value: credentials,
            expiresAt: Date.now() + __ZMTJL_CREDENTIAL_TTL_MS,
        });
        return credentials;
    }`,
);

// 6. 视频分片重试
apply(
  'lib/services/im/upload.js',
  '__ZMTJL_PART_RETRY__',
  '            await this.transferPart(address, uploadId, part, crc, chunk);',
  `            // __ZMTJL_PART_RETRY__ same part number is safe to resend once
            try {
                await this.transferPart(address, uploadId, part, crc, chunk);
            } catch {
                await this.transferPart(address, uploadId, part, crc, chunk);
            }`,
);

// 7. 硬件信息缓存
apply(
  'lib/desktop/device-registration.js',
  '__ZMTJL_HARDWARE_CACHE__',
  `const headers = { 'Content-Type': 'application/json', 'User-Agent': 'TTNetwork PC' };`,
  `const headers = { 'Content-Type': 'application/json', 'User-Agent': 'TTNetwork PC' };
// __ZMTJL_HARDWARE_CACHE__ hardware identity is stable per machine
let __zmtjlHardwareCache;`,
);
apply(
  'lib/desktop/device-registration.js',
  '__ZMTJL_HARDWARE_CACHE_READ__',
  `export async function readDesktopHardware() {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {`,
  `export async function readDesktopHardware() {
    // __ZMTJL_HARDWARE_CACHE_READ__
    if (__zmtjlHardwareCache)
        return __zmtjlHardwareCache;
    if (process.platform !== 'darwin' && process.platform !== 'win32') {`,
);
apply(
  'lib/desktop/device-registration.js',
  '__ZMTJL_HARDWARE_CACHE_WRITE__',
  `    return {
        platform: process.platform, release: os.release(), model, uuid, serial, sku, resolution,
        mac: Object.values(os.networkInterfaces()).flat().find((entry) => entry?.mac && entry.mac !== '00:00:00:00:00:00')?.mac ?? '',
        timezone, timezoneName: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneOffset: -new Date().getTimezoneOffset() * 60,
        language: Intl.DateTimeFormat().resolvedOptions().locale,
    };
}`,
  `    // __ZMTJL_HARDWARE_CACHE_WRITE__
    __zmtjlHardwareCache = {
        platform: process.platform, release: os.release(), model, uuid, serial, sku, resolution,
        mac: Object.values(os.networkInterfaces()).flat().find((entry) => entry?.mac && entry.mac !== '00:00:00:00:00:00')?.mac ?? '',
        timezone, timezoneName: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneOffset: -new Date().getTimezoneOffset() * 60,
        language: Intl.DateTimeFormat().resolvedOptions().locale,
    };
    return __zmtjlHardwareCache;
}`,
);

// 8. 空闲账号低频续期
apply(
  'lib/desktop/token-beat.js',
  '__ZMTJL_IDLE_BEAT__',  `        this.timer = setInterval(() => {
            if (!this.operated) {
                this.pause();
                return;
            }
            this.operated = false;
            void this.beat('polling');
        }, 600_000);`,
  `        this.timer = setInterval(() => {
            // __ZMTJL_IDLE_BEAT__ keep a low-frequency renewal for WS-only accounts
            if (!this.operated) {
                this.idleBeats = (this.idleBeats ?? 0) + 1;
                if (this.idleBeats < 3)
                    return;
                this.idleBeats = 0;
                void this.beat('polling');
                return;
            }
            this.idleBeats = 0;
            this.operated = false;
            void this.beat('polling');
        }, 600_000);`,
);

// 9. 保留蓝V/企业认证字段（mapProfile 目前会丢掉）
apply(
  'lib/services/im/user-directory.js',
  '__ZMTJL_PROFILE_VERIFY__',
  `        ...(typeof user['remark_name'] === 'string' ? { remark: user['remark_name'] } : {}),`,
  `        ...(typeof user['remark_name'] === 'string' ? { remark: user['remark_name'] } : {}),
        // __ZMTJL_PROFILE_VERIFY__ keep enterprise verification for account typing
        ...(typeof user['enterprise_verify_reason'] === 'string' && user['enterprise_verify_reason']
            ? { enterpriseVerify: user['enterprise_verify_reason'] } : {}),
        ...(typeof user['custom_verify'] === 'string' && user['custom_verify']
            ? { customVerify: user['custom_verify'] } : {}),`,
);

if (failed) {
  console.error(`[patch:sdk] ${failed} 个补丁点失败，SDK 可能已被改动或版本不符`);
  process.exit(1);
}
console.log(`[patch:sdk] 完成：新应用 ${changed} 个，其余已存在`);
