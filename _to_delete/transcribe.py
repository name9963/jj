# -*- coding: utf-8 -*-
"""
本地视频语音转文字脚本（由 Node 后端 utils/asrClient.js 以子进程方式调用）

用法:   python transcribe.py <视频或音频文件路径>
输出:   单行 JSON 到 stdout:
        成功 {"code": 0, "text": "识别出的文字"}
        失败 {"code": -1, "msg": "错误原因"}

依赖:   pip install faster-whisper
        (mp4/mov 视频经内置 PyAV 直接读音轨，无需单独安装 ffmpeg)
模型:   默认 base(约150MB)，首次运行自动下载(走 hf-mirror 国内镜像)。
        环境变量 ASR_MODEL 可换 tiny(更快更省内存) / small(更准)。
        环境变量 ASR_LANG 默认 zh，设为 auto 则自动检测语种。
"""
import json
import os
import sys

# 国内网络从 HuggingFace 镜像下载模型；外部已设置过则不覆盖
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        out({"code": -1, "msg": "缺少文件路径参数"})
        return 1

    media_path = sys.argv[1]
    if not os.path.exists(media_path):
        out({"code": -1, "msg": "文件不存在: %s" % media_path})
        return 1

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        out({"code": -1, "msg": "服务端未安装语音识别组件(pip install faster-whisper)"})
        return 1

    try:
        model_size = os.environ.get("ASR_MODEL", "base")
        lang = os.environ.get("ASR_LANG", "zh")
        language = None if lang == "auto" else lang

        # int8 量化：CPU 上内存占用和速度都友好
        model = WhisperModel(model_size, device="cpu", compute_type="int8")

        segments, _info = model.transcribe(
            media_path,
            language=language,
            beam_size=5,
            vad_filter=True,  # 跳过无人声片段：更快，也减少幻听
            initial_prompt="以下是普通话的句子，请加上标点符号。",
        )
        text = "".join(seg.text.strip() for seg in segments).strip()

        if not text:
            out({"code": -1, "msg": "未识别到语音内容，视频可能没有人声"})
            return 1

        out({"code": 0, "text": text})
        return 0
    except Exception as e:  # noqa: BLE001 - 所有异常统一转成 JSON 返回给 Node
        out({"code": -1, "msg": "识别失败: %s" % e})
        return 1


if __name__ == "__main__":
    # Windows 控制台默认 GBK 编码，强制 stdout 输出 UTF-8，Node 端统一按 utf8 解析
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
