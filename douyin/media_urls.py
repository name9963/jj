"""Media URL encoding, independent of the HTTP/signing dependencies."""
from urllib.parse import quote, urlsplit


def proxy_media_url(url):
    if not isinstance(url, str) or urlsplit(url).scheme not in ("http", "https"):
        raise ValueError("无效的抖音媒体地址")
    return "/api/video/proxy?url=" + quote(url, safe="")
