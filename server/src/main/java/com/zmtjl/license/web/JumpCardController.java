package com.zmtjl.license.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.domain.JumpCard;
import com.zmtjl.license.service.JumpCardService;
import com.zmtjl.license.web.JumpCardDtos.PublicJumpCardView;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.web.util.HtmlUtils;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;

/**
 * 跳转卡公开接口
 *
 *   GET /v1/jump/cards        客户端拉取启用中的卡片
 *   GET /v1/jump/cards/{code} 单张卡片
 *   GET /r/{code}             短链跳转（302）+ 点击统计
 */
@RestController
public class JumpCardController {
    private final JumpCardService service;
    private final ObjectMapper mapper;
    private final ClientIpResolver ipResolver;

    public JumpCardController(JumpCardService service, ObjectMapper mapper, ClientIpResolver ipResolver) {
        this.service = service;
        this.mapper = mapper;
        this.ipResolver = ipResolver;
    }

    private static String etagOf(Object value, ObjectMapper mapper) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(mapper.writeValueAsString(value).getBytes(StandardCharsets.UTF_8));
            return "\"" + HexFormat.of().formatHex(digest, 0, 12) + "\"";
        } catch (Exception e) {
            return null;
        }
    }

    @GetMapping("/v1/jump/cards")
    public ResponseEntity<List<PublicJumpCardView>> list(@RequestParam(required = false) String group,
                                                         HttpServletRequest req) throws Exception {
        List<PublicJumpCardView> body = service.publicList(group);
        String etag = etagOf(body, mapper);
        if (etag != null && new ServletWebRequest(req).checkNotModified(etag)) {
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).build();
        }
        return ResponseEntity.ok()
                .eTag(etag == null ? "" : etag)
                .cacheControl(CacheControl.maxAge(Duration.ofSeconds(30)).cachePublic())
                .body(body);
    }

    @GetMapping("/v1/jump/cards/{code}")
    public ResponseEntity<PublicJumpCardView> get(@PathVariable String code, HttpServletRequest req) {
        PublicJumpCardView body = service.publicGet(code)
                .orElseThrow(() -> new ApiException("JUMP_CARD_NOT_FOUND", "跳转卡不存在或已停用",
                        HttpStatus.NOT_FOUND));
        String etag = etagOf(body, mapper);
        if (etag != null && new ServletWebRequest(req).checkNotModified(etag)) {
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).build();
        }
        return ResponseEntity.ok()
                .eTag(etag == null ? "" : etag)
                .cacheControl(CacheControl.maxAge(Duration.ofSeconds(30)).cachePublic())
                .body(body);
    }

    @GetMapping("/r/{code}")
    public ResponseEntity<?> redirect(@PathVariable String code, HttpServletRequest req) {
        JumpCard card = service.findActive(code).orElse(null);
        if (card == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .contentType(new MediaType("text", "html", java.nio.charset.StandardCharsets.UTF_8))
                    .body("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                            + "<title>链接不可用</title></head>"
                            + "<body style=\"font-family:system-ui,sans-serif;background:#f6f7f9;color:#333;"
                            + "display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">"
                            + "<div style=\"text-align:center;padding:24px\">"
                            + "<h2 style=\"font-size:18px;margin:0 0 8px\">链接不可用</h2>"
                            + "<p style=\"font-size:13px;color:#888;margin:0\">卡片不存在或已停用</p>"
                            + "</div></body></html>");
        }

        service.recordClick(card.getId(), card.getCode(), ipResolver.resolve(req),
                req.getHeader("User-Agent"), req.getHeader("Referer"));

        if (JumpCard.TARGET_WECHAT_QR.equals(card.getTargetType())) {
            return qrPage(card);
        }
        if (JumpCard.TARGET_WECOM.equals(card.getTargetType())) {
            return wecomPage(card);
        }

        return ResponseEntity.status(HttpStatus.FOUND)
                .location(URI.create(card.getTargetUrl()))
                .cacheControl(CacheControl.noStore())
                .build();
    }

    /**
     * 个人微信二维码落地页。
     *
     * 个人微信没有官方“一键加好友”URL：这里先提供「打开微信」入口，
     * 由用户在微信里扫一扫/长按识别二维码完成添加。
     */
    private ResponseEntity<String> qrPage(JumpCard card) {
        String title = card.getTitle() == null || card.getTitle().isBlank()
                ? card.getName() : card.getTitle();
        String titleHtml = HtmlUtils.htmlEscape(title == null ? "添加微信" : title);
        String descHtml = HtmlUtils.htmlEscape(card.getDescription() == null ? "" : card.getDescription());
        String qrUrl = card.getQrImageUrl() == null ? "" : card.getQrImageUrl();
        String qrHtml = HtmlUtils.htmlEscape(qrUrl);

        String html = "<!doctype html><html lang=\"zh-CN\"><head>"
                + "<meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
                + "<title>" + titleHtml + "</title>"
                + "<style>"
                + "*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"
                + "'PingFang SC','Microsoft YaHei',sans-serif;background:linear-gradient(160deg,#eef6ff 0%,#f7f9fc 45%,#eefbf5 100%);"
                + "color:#172033;display:flex;align-items:center;justify-content:center;padding:28px 18px;}"
                + ".card{width:100%;max-width:420px;background:#fff;border:1px solid #e7edf5;border-radius:24px;"
                + "box-shadow:0 24px 70px rgba(34,63,110,.14);padding:30px 24px 26px;text-align:center;}"
                + ".eyebrow{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:#087f5b;"
                + "background:#e8faf3;border:1px solid #c8f0e2;border-radius:999px;padding:7px 13px;letter-spacing:.5px;}"
                + ".dot{width:7px;height:7px;border-radius:50%;background:#12b886;box-shadow:0 0 0 4px rgba(18,184,134,.14);}"
                + "h1{font-size:24px;line-height:1.35;margin:18px 0 8px;letter-spacing:.2px;}"
                + ".desc{font-size:14px;line-height:1.7;color:#667085;margin:0 auto 20px;max-width:330px;}"
                + ".qr-wrap{width:268px;height:268px;margin:0 auto;padding:12px;border-radius:20px;background:#fff;"
                + "border:1px solid #e3eaf3;box-shadow:0 10px 28px rgba(28,52,92,.10);display:flex;align-items:center;justify-content:center;}"
                + ".qr-wrap img{display:block;width:100%;height:100%;object-fit:contain;border-radius:10px;}"
                + ".tip{font-size:15px;font-weight:700;color:#1d2939;line-height:1.65;margin:20px 0 6px;}"
                + ".actions{display:flex;gap:10px;margin:16px 0 8px;}"
                + ".saveqr,.openwx{display:flex;align-items:center;justify-content:center;flex:1;height:46px;"
                + "border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;}"
                + ".saveqr{border:1px solid #07c160;color:#07c160;background:#fff;}"
                + ".openwx{background:#07c160;color:#fff;}"
                + ".saveqr:active,.openwx:active{opacity:.85;}"
                + ".small{font-size:12px;line-height:1.65;color:#98a2b3;margin:0;}"
                + ".save{display:inline-block;margin-top:16px;color:#0b6bcb;text-decoration:none;font-size:13px;font-weight:600;"
                + "border-bottom:1px solid rgba(11,107,203,.25);padding-bottom:2px;}"
                + "@media(max-width:380px){.qr-wrap{width:236px;height:236px}h1{font-size:21px}}"
                + "</style></head><body><main class=\"card\">"
                + "<div class=\"eyebrow\"><span class=\"dot\"></span>微信扫码添加</div>"
                + "<h1>" + titleHtml + "</h1>"
                + (descHtml.isBlank() ? "" : "<p class=\"desc\">" + descHtml + "</p>")
                + "<div class=\"qr-wrap\"><img src=\"" + qrHtml + "\" alt=\"微信二维码\" referrerpolicy=\"no-referrer\"></div>"
                + "<div class=\"actions\">"
                + "<a class=\"saveqr\" href=\"" + qrHtml + "\" download=\"wechat-qr.jpg\" rel=\"noreferrer\">保存二维码</a>"
                + "<a class=\"openwx\" href=\"weixin://\" rel=\"noreferrer\">打开微信</a>"
                + "</div>"
                + "<p class=\"tip\">先保存二维码，再打开微信 → 扫一扫 → 相册选择</p>"
                + "<p class=\"small\">也可以直接长按二维码识别添加；<br>如果无法识别，请保存二维码图片，打开微信「扫一扫」→ 相册选择。</p>"
                + "<a class=\"save\" href=\"" + qrHtml + "\" target=\"_blank\" rel=\"noreferrer\">打开二维码图片</a>"
                + "</main></body></html>";

        return ResponseEntity.ok()
                .contentType(new MediaType("text", "html", StandardCharsets.UTF_8))
                .cacheControl(CacheControl.noStore())
                .header("X-Robots-Tag", "noindex, nofollow")
                .header("Referrer-Policy", "no-referrer")
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy",
                        "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
                .body(html);
    }

    /**
     * 企业微信「联系我」落地页。
     *
     * targetUrl 可以是 https://work.weixin.qq.com/...，也可以是 weixin:// / wxwork://。
     * 有二维码时额外展示二维码兜底。
     */
    private ResponseEntity<String> wecomPage(JumpCard card) {
        String title = card.getTitle() == null || card.getTitle().isBlank()
                ? card.getName() : card.getTitle();
        String titleHtml = HtmlUtils.htmlEscape(title == null ? "添加企业微信" : title);
        String descHtml = HtmlUtils.htmlEscape(card.getDescription() == null ? "" : card.getDescription());
        String targetHtml = HtmlUtils.htmlEscape(card.getTargetUrl() == null ? "" : card.getTargetUrl());
        String qrUrl = card.getQrImageUrl() == null ? "" : card.getQrImageUrl();
        String qrHtml = HtmlUtils.htmlEscape(qrUrl);

        String html = "<!doctype html><html lang=\"zh-CN\"><head>"
                + "<meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
                + "<title>" + titleHtml + "</title>"
                + "<style>"
                + "*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"
                + "'PingFang SC','Microsoft YaHei',sans-serif;background:linear-gradient(160deg,#eef6ff 0%,#f7f9fc 45%,#eefbf5 100%);"
                + "color:#172033;display:flex;align-items:center;justify-content:center;padding:28px 18px;}"
                + ".card{width:100%;max-width:420px;background:#fff;border:1px solid #e7edf5;border-radius:24px;"
                + "box-shadow:0 24px 70px rgba(34,63,110,.14);padding:30px 24px 26px;text-align:center;}"
                + ".eyebrow{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:#087f5b;"
                + "background:#e8faf3;border:1px solid #c8f0e2;border-radius:999px;padding:7px 13px;letter-spacing:.5px;}"
                + ".dot{width:7px;height:7px;border-radius:50%;background:#12b886;box-shadow:0 0 0 4px rgba(18,184,134,.14);}"
                + "h1{font-size:24px;line-height:1.35;margin:18px 0 8px;letter-spacing:.2px;}"
                + ".desc{font-size:14px;line-height:1.7;color:#667085;margin:0 auto 20px;max-width:330px;}"
                + ".openwx{display:flex;align-items:center;justify-content:center;width:100%;height:48px;margin:8px 0 12px;"
                + "border-radius:12px;background:#07c160;color:#fff;text-decoration:none;font-size:16px;font-weight:700;}"
                + ".openwx:active{opacity:.85;}"
                + ".qr-wrap{width:240px;height:240px;margin:12px auto 0;padding:10px;border-radius:20px;background:#fff;"
                + "border:1px solid #e3eaf3;box-shadow:0 10px 28px rgba(28,52,92,.10);display:flex;align-items:center;justify-content:center;}"
                + ".qr-wrap img{display:block;width:100%;height:100%;object-fit:contain;border-radius:10px;}"
                + ".tip{font-size:14px;font-weight:700;color:#1d2939;line-height:1.65;margin:16px 0 6px;}"
                + ".small{font-size:12px;line-height:1.65;color:#98a2b3;margin:0;}"
                + "@media(max-width:380px){.qr-wrap{width:210px;height:210px}h1{font-size:21px}}"
                + "</style></head><body><main class=\"card\">"
                + "<div class=\"eyebrow\"><span class=\"dot\"></span>企业微信</div>"
                + "<h1>" + titleHtml + "</h1>"
                + (descHtml.isBlank() ? "" : "<p class=\"desc\">" + descHtml + "</p>")
                + "<a class=\"openwx\" href=\"" + targetHtml + "\" rel=\"noreferrer\">打开微信添加</a>"
                + (qrUrl.isBlank() ? "" : "<div class=\"qr-wrap\"><img src=\"" + qrHtml
                    + "\" alt=\"企业微信二维码\" referrerpolicy=\"no-referrer\"></div>"
                    + "<p class=\"tip\">长按识别企业微信二维码</p>")
                + "<p class=\"small\">点击后如提示「离开抖音」，请选择打开；<br>如果无法打开，请复制链接到微信或浏览器。</p>"
                + "</main></body></html>";

        return ResponseEntity.ok()
                .contentType(new MediaType("text", "html", StandardCharsets.UTF_8))
                .cacheControl(CacheControl.noStore())
                .header("X-Robots-Tag", "noindex, nofollow")
                .header("Referrer-Policy", "no-referrer")
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy",
                        "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
                .body(html);
    }

}
