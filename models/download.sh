#!/bin/sh
# 下载 LaMa 修复模型 (Apache-2.0, 来自 opencv_zoo)
# 模型文件较大(约88MB)，不进版本控制，部署前/构建镜像前需要执行本脚本
set -e
cd "$(dirname "$0")"
if [ -f lama.onnx ]; then
  echo "lama.onnx 已存在，跳过下载"
  exit 0
fi
echo "下载 LaMa 模型..."
curl -fL -o lama.onnx \
  "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/inpainting_lama/inpainting_lama_2025jan.onnx"
echo "完成: $(ls -la lama.onnx)"
