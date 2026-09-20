"""验证抖音签名模块能否正常生成 a_bogus / x-secsdk-web-signature。

用法：python test_sign.py          （在 server/douyin 目录下执行）
"""
import sys
import traceback

sys.path.insert(0, ".")

QUERY = ("device_platform=webapp&aid=6383&channel=channel_pc_web"
         "&aweme_id=7687243185168632177&pc_client_type=1&version_code=170400"
         "&version_name=17.4.0&cookie_enabled=true&screen_width=1920&screen_height=1080"
         "&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome"
         "&browser_version=120.0.0.0&browser_online=true&engine_name=Blink"
         "&engine_version=120.0.0.0&os_name=Windows&os_version=10&cpu_core_num=8"
         "&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=50")

API = "https://www.douyin.com/aweme/v1/web/aweme/detail/"
URL = f"{API}?{QUERY}"

ok = 0
fail = 0


def step(name, fn):
    global ok, fail
    try:
        result = fn()
        print(f"  ✓ {name}")
        print(f"      {result}")
        ok += 1
        return result
    except Exception as e:
        print(f"  ✗ {name}")
        print(f"      {type(e).__name__}: {e}")
        traceback.print_exc(limit=3)
        fail += 1
        return None


print("=== 1. 导入模块 ===")
ABogusPureSigner = None
try:
    from utils.ab_pure import ABogusPureSigner
    print("  ✓ utils.ab_pure.ABogusPureSigner")
    ok += 1
except Exception as e:
    print(f"  ✗ 导入 ab_pure 失败: {type(e).__name__}: {e}")
    traceback.print_exc(limit=5)
    fail += 1

secsdk = None
try:
    from utils import secsdk_web_sign as secsdk
    print("  ✓ utils.secsdk_web_sign")
    ok += 1
except Exception as e:
    print(f"  ✗ 导入 secsdk_web_sign 失败: {type(e).__name__}: {e}")
    traceback.print_exc(limit=5)
    fail += 1

print()
print("=== 2. 生成 a_bogus ===")
if ABogusPureSigner:
    signer = step("构造 ABogusPureSigner", lambda: ABogusPureSigner() and "已构造")
    if signer:
        step("sign_query(query)", lambda: ABogusPureSigner().sign_query(QUERY)[:120] + "…")
        step("sign(完整URL)", lambda: ABogusPureSigner().sign(URL)[:120] + "…")

print()
print("=== 3. 生成 x-secsdk-web-signature ===")
if secsdk:
    step("secsdk_web_sign.sign_url()", lambda: str(secsdk.sign_url(URL, uifid=""))[:200])
    step("secsdk_web_sign.is_protected()", lambda: secsdk.is_protected("/aweme/v1/web/aweme/detail/"))

print()
print("=== 4. 指纹模块 ===")
try:
    from utils.fingerprint import get_profile, build_fpk2
    prof = p = None
    def _probe():
        p = get_profile()
        return f"ua={str(p.get('ua'))[:40]}…  keys={list(p.keys())}"
    step("fingerprint.get_profile()", _probe)
except Exception as e:
    print(f"  ✗ fingerprint 导入/调用失败: {type(e).__name__}: {e}")
    traceback.print_exc(limit=3)
    fail += 1

print()
print("=" * 50)
print(f"通过 {ok} 项，失败 {fail} 项")
if fail:
    print("提示：失败多为缺少 pip 依赖，可按提示安装后重试")
