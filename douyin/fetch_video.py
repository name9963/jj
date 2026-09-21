#!/usr/bin/env python3
"""抖音视频解析 —— 供 Node 后端子进程调用。

用法:
    python fetch_video.py <分享链接或 aweme_id>

输出（stdout，单行 JSON）:
    成功: {"ok": true,  "videoUrl": "...", "cover": "...", "title": "...", "awemeId": "..."}
    失败: {"ok": false, "error": "原因"}

技术要点（来自 cv-cat/DouYin_Spider 的实战经验）:
  * TLS 指纹：必须用 curl_cffi 冒充 Chrome，普通 HTTP 客户端会在握手阶段被识别
  * a_bogus：由 ABogusPureSigner 纯算法生成，内嵌 (aid, page_id)，随 host 变化
  * x-secsdk-web-signature：query 必须用 sign_url() 返回的规范化版本，服务端按收到的 query 校验
  * 参数顺序：verifyFp/fp 必须在 a_bogus 之后
"""
import sys
import os
import re
import json
import time
import random
import string

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils import http_client                       # noqa: E402
from utils.ab_pure import ABogusPureSigner          # noqa: E402
from utils import secsdk_web_sign as secsdk         # noqa: E402
from utils.fingerprint import get_profile           # noqa: E402

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")

HOST = "https://www.douyin.com"
DETAIL_API = "/aweme/v1/web/aweme/detail/"


def out(payload):
    """把结果写到 stdout 并结束（Node 侧按单行 JSON 解析）。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(0 if payload.get("ok") else 1)


def extract_aweme_id(session, raw):
    """从分享链接里取出 aweme_id；短链靠会话跟随重定向。"""
    text = str(raw or "").strip()
    m = re.search(r"(?:video|note|share/video|share/note)/?(\d{15,25})", text)
    if m:
        return m.group(1)
    if re.fullmatch(r"\d{15,25}", text):
        return text
    # 短链：跟随重定向，从落地 URL 里找
    if re.search(r"https?://", text):
        resp = session.get(text, allow_redirects=True)
        for candidate in (getattr(resp, "url", ""), getattr(resp, "text", "")[:5000]):
            m = re.search(r"(?:video|note|share/video|share/note)/?(\d{15,25})", str(candidate))
            if m:
                return m.group(1)
    return ""


def rand_token(n=126):
    alphabet = string.ascii_letters + string.digits
    return "".join(random.choice(alphabet) for _ in range(n))


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        out({"ok": False, "error": "缺少分享链接参数"})

    raw_input = sys.argv[1].strip()
    session = http_client.Session()

    # ---- 可选：注入浏览器 Cookie（DOUYIN_COOKIES 环境变量）----
    # 数据中心 IP（如云托管）访问抖音会被直接 403（Uifid Not Found），
    # 连 Argus 挑战机会都不给 —— uifid 只能由真实浏览器交互产生。
    # 因此支持把用户浏览器里的 Cookie（至少含 uifid，建议带 ttwid/msToken）
    # 通过环境变量注入，脚本将完全以该身份请求。
    injected_raw = (os.getenv("DOUYIN_COOKIES") or "").strip()
    injected = {}
    if injected_raw:
        for pair in injected_raw.replace("\n", ";").split(";"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                k, v = k.strip(), v.strip()
                if k and v:
                    injected[k] = v
        missing = [k for k in ("uifid", "UIFID") if k not in injected]
        if len(injected) < 2 or (missing and len(missing) == 2):
            out({"ok": False, "error": "DOUYIN_COOKIES 里没识别到 uifid，请从登录后的 douyin.com 复制完整 Cookie"})

    try:
        def read_cookies(sess):
            """curl_cffi 的 Cookies 与 requests 不同：不能按对象迭代取 .name。"""
            got = {}
            try:
                for name in sess.cookies.keys():
                    got[name] = sess.cookies.get(name)
            except Exception:
                try:
                    got = dict(sess.cookies)
                except Exception:
                    got = {}
            return got

        def cookie_header_of(jar):
            return "; ".join(f"{k}={v}" for k, v in jar.items() if v)

        # ---- 1. 预热 + 过 Argus 挑战（注入 Cookie 模式则整体跳过）----
        challenge_notes = []
        if injected:
            cookies = dict(injected)
            cookie_with_sig = injected_raw.replace("\n", "; ")
            challenge_notes.append(f"使用注入的浏览器 Cookie（{len(injected)} 项）")
        else:
            # 首次响应会下发 __ac_nonce，但直接请求 API 会得到
            # `403 Blocked by ArgusSecurityPlugin Uifid Not Found`。
            # 必须用页面 JS（VMP）算出 __ac_signature 再请求一次，抖音才肯下发 UIFID。
            try:
                session.get(HOST + "/", headers={"User-Agent": UA})
            except Exception as e:
                out({"ok": False, "error": f"访问抖音首页失败: {type(e).__name__}: {e}"})

            cookies = read_cookies(session)
            cookie_with_sig = cookie_header_of(cookies)

            nonce = cookies.get("__ac_nonce") or ""
            has_uifid = bool(cookies.get("UIFID") or cookies.get("uifid"))
            if nonce and not has_uifid:
                try:
                    from utils.acrawler import generate_ac_signature
                    ac = generate_ac_signature(
                        nonce=nonce,
                        cookie=cookie_with_sig,
                        url="https://www.douyin.com/",
                        ua=UA,
                    )
                    sig = str((ac or {}).get("sig") or "")
                    if sig:
                        cookie_with_sig = f"{cookie_with_sig}; __ac_signature={sig}"
                        session.get(HOST + "/", headers={"User-Agent": UA, "Cookie": cookie_with_sig})
                        cookies = read_cookies(session)
                        has_uifid = bool(cookies.get("UIFID") or cookies.get("uifid"))
                        challenge_notes.append(f"已提交 __ac_signature（{len(sig)} 字符），UIFID={'有' if has_uifid else '无'}")
                    else:
                        challenge_notes.append("acrawler 返回空签名")
                except Exception as e:
                    challenge_notes.append(f"acrawler 执行失败: {type(e).__name__}: {e}")
            elif has_uifid:
                challenge_notes.append("预热即拿到 UIFID")

        ttwid = cookies.get("ttwid", "") or ""

        # ---- 2. 取 aweme_id ----
        aweme_id = extract_aweme_id(session, raw_input)
        if not aweme_id:
            out({"ok": False, "error": "无法从链接中识别作品 ID，请确认是抖音分享链接"})

        # ---- 3. msToken（注入模式优先用 Cookie 里自带的）----
        ms_token = injected.get("msToken", "")
        if not ms_token:
            try:
                from utils.mstoken import get_mstoken
                ms_token = get_mstoken(ttwid=ttwid) or ""
            except Exception:
                ms_token = rand_token()

        # ---- 4. 组装参数（顺序按抓包：verifyFp/fp 放最后，a_bogus 之后）----
        profile = get_profile()
        params = [
            ("device_platform", "webapp"),
            ("aid", "6383"),
            ("channel", "channel_pc_web"),
            ("aweme_id", aweme_id),
            ("pc_client_type", "1"),
            ("version_code", "170400"),
            ("version_name", "17.4.0"),
            ("cookie_enabled", "true"),
            ("screen_width", str(profile.get("screen_width", 1920))),
            ("screen_height", str(profile.get("screen_height", 1080))),
            ("browser_language", "zh-CN"),
            ("browser_platform", "Win32"),
            ("browser_name", "Chrome"),
            ("browser_version", "150.0.0.0"),
            ("browser_online", "true"),
            ("engine_name", "Blink"),
            ("engine_version", "150.0.0.0"),
            ("os_name", "Windows"),
            ("os_version", "10"),
            ("cpu_core_num", str(profile.get("cpu_core_num", 8))),
            ("device_memory", str(profile.get("device_memory", 8))),
            ("platform", "PC"),
            ("downlink", "10"),
            ("effective_type", "4g"),
            ("round_trip_time", "50"),
        ]
        query = "&".join(f"{k}={v}" for k, v in params)

        # ---- 5. a_bogus ----
        signer = ABogusPureSigner(ua=UA)
        a_bogus = signer.sign_query(query)

        # ---- 6. 拼出最终 URL：a_bogus 之后再接 SECSDK 签名（顺序不能颠倒）----
        url_with_bogus = f"{HOST}{DETAIL_API}?{query}&a_bogus={a_bogus}"
        final_url = secsdk.sign_url(url_with_bogus, uifid=cookies.get("UIFID", ""))

        # ---- 7. 发请求 ----
        headers = {
            "User-Agent": UA,
            "Referer": f"https://www.douyin.com/video/{aweme_id}",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
        # 带上完整 Cookie（含 __ac_signature / UIFID），再补 msToken
        full_cookie = cookie_with_sig
        if ms_token:
            full_cookie = f"msToken={ms_token}; {full_cookie}" if full_cookie else f"msToken={ms_token}"
        if full_cookie:
            headers["Cookie"] = full_cookie

        resp = session.get(final_url, headers=headers)
        status = getattr(resp, "status_code", 0)
        body = getattr(resp, "text", "") or ""

        if status != 200:
            hint = f"｜挑战处理：{'; '.join(challenge_notes)}" if challenge_notes else ""
            out({"ok": False, "error": f"接口返回 HTTP {status}{hint}", "bodyHead": body[:300]})

        if not body.strip():
            out({"ok": False, "error": "接口返回空响应（通常是风控未通过：TLS 指纹/Cookie/签名之一不符）"})

        if "<script" in body[:200] and "argus" in body[:3000]:
            out({"ok": False, "error": "命中抖音 WAF 挑战页（需要处理 __ac_signature）"})

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            out({"ok": False, "error": "响应不是 JSON", "bodyHead": body[:300]})

        detail = data.get("aweme_detail")
        if not detail:
            out({"ok": False, "error": f"响应里没有作品数据（status_code={data.get('status_code')}）",
                 "bodyHead": body[:300]})

        # ---- 8. 取无水印地址 ----
        video = detail.get("video") or {}
        play = video.get("play_addr") or {}
        urls = play.get("url_list") or []
        # ---- 8.5 统一代理包装：小程序 downloadFile 只能访问后台白名单域名，
        # 而各平台 CDN 域名动态变化，媒体地址一律改为服务端代理的相对路径
        # （服务端 /api/video/proxy 维护全平台 CDN 白名单并携带防盗链请求头）。
        def via_proxy(u):
            return f"/api/video/proxy?url={urllib.parse.quote(u, safe='')}"

        if not urls:
            # 图文作品
            images = detail.get("images") or []
            image_urls = []
            for img in images:
                lst = (img or {}).get("url_list") or []
                if lst:
                    image_urls.append(lst[-1])
            if image_urls:
                proxied = [via_proxy(u) for u in image_urls]
                out({"ok": True, "isImage": True, "videoUrl": proxied[0],
                     "imageUrls": proxied, "cover": image_urls[0],
                     "title": detail.get("desc") or "抖音图文", "awemeId": aweme_id})
            out({"ok": False, "error": "作品里没有可用的视频/图片地址"})

        # play_addr 里可能混有水印版本，优先选 uri 里不含 watermark 的
        clean = [u for u in urls if "watermark" not in u.lower()] or urls

        cover = ""
        cov = video.get("cover") or video.get("origin_cover") or {}
        if isinstance(cov, dict) and cov.get("url_list"):
            cover = cov["url_list"][0]

        proxied = [via_proxy(u) for u in clean]
        out({
            "ok": True,
            "videoUrl": proxied[0],
            "allUrls": proxied[:3],
            "cover": cover,
            "title": detail.get("desc") or "抖音视频",
            "awemeId": aweme_id,
        })

    except Exception as e:
        import traceback
        out({"ok": False, "error": f"{type(e).__name__}: {e}",
             "trace": traceback.format_exc()[-600:]})


if __name__ == "__main__":
    main()
