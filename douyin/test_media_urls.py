import unittest
from urllib.parse import parse_qs, urlsplit
from media_urls import proxy_media_url


class MediaUrlsTest(unittest.TestCase):
    def test_image_query_survives_proxy_encoding(self):
        url = "https://p3.douyinpic.com/图片.jpeg?signature=a+b/c=&size=large"
        result = proxy_media_url(url)
        self.assertEqual(urlsplit(result).path, "/api/video/proxy")
        self.assertEqual(parse_qs(urlsplit(result).query)["url"], [url])

    def test_gallery_preserves_all_images(self):
        urls = [f"https://p3.douyinpic.com/{i}.webp?x=a&y=b" for i in range(8)]
        encoded = [proxy_media_url(url) for url in urls]
        self.assertEqual(len(encoded), 8)
        self.assertEqual([parse_qs(urlsplit(url).query)["url"][0] for url in encoded], urls)

    def test_video(self):
        self.assertTrue(proxy_media_url("https://v.douyinvod.com/a.mp4").startswith("/api/video/proxy?url=https%3A"))

    def test_non_http_rejected(self):
        for value in (None, "", "file:///etc/passwd", "javascript:alert(1)"):
            with self.assertRaises(ValueError):
                proxy_media_url(value)


if __name__ == "__main__":
    unittest.main()
