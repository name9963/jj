# ============================================================
#  去水印后端镜像（微信云托管）
#  基底用 Debian(bookworm-slim) 而非 Alpine：
#    onnxruntime-node 的原生二进制只支持 glibc，Alpine(musl) 下
#    require 即报错导致容器反复重启（Back-off restarting）
#  内置：
#    - whisper.cpp 离线语音识别（口播文案提取）
#    - ffmpeg（抽音轨）
#    - LaMa ONNX 修复模型（图片去水印本地 AI 兜底）
# ============================================================

# ---------- 第一阶段：编译 whisper.cpp + 下载模型 ----------
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
# 优先走国内可达的 GitHub 镜像，失败再回落直连
RUN git clone --depth 1 https://ghfast.top/https://github.com/ggml-org/whisper.cpp.git . \
 || (rm -rf /build/.git /build/* \
     && git clone --depth 1 https://gh-proxy.com/https://github.com/ggml-org/whisper.cpp.git .) \
 || (rm -rf /build/.git /build/* \
     && git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git .)
RUN test -f CMakeLists.txt

# 静态库 + 关闭 OpenMP；GGML_NATIVE=OFF 关掉 -march=native，
# 构建机与运行机 CPU 型号可能不同，避免运行时非法指令崩溃
RUN cmake -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_OPENMP=OFF \
      -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
 && (cmake --build build -j"$(nproc)" --target whisper-cli \
     || cmake --build build -j"$(nproc)") \
 && mkdir -p /out \
 && (cp build/bin/whisper-cli /out/whisper-cli || cp build/bin/main /out/whisper-cli) \
 && test -x /out/whisper-cli

# whisper 模型：hf-mirror 国内镜像优先，失败回落官方源。
# 默认 small-q5_1（官方多语言量化模型，约181MiB）：准确率接近 small，显著降低
# 微信云托管构建下载、镜像推送、冷启动和运行内存压力。可用构建参数改成 base 或 small。
ARG WHISPER_MODEL_SIZE=small-q5_1
RUN wget -q --show-progress --tries=3 --timeout=60 -O /out/ggml-model.bin \
      "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL_SIZE}.bin" \
 || wget -q --show-progress --tries=3 --timeout=90 -O /out/ggml-model.bin \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL_SIZE}.bin"
RUN test "$(wc -c < /out/ggml-model.bin)" -gt 50000000 \
 && echo "Whisper model ready: ${WHISPER_MODEL_SIZE}, $(du -h /out/ggml-model.bin | cut -f1)"

# LaMa ONNX 修复模型：GitHub LFS 媒体域名的镜像常 403，直连优先、镜像兜底；
# 全部失败则生成空文件占位(保证 COPY 不失败)，运行时会自动禁用并回退传统算法
RUN (wget -q -T 90 -O /out/lama.onnx \
      "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/inpainting_lama/inpainting_lama_2025jan.onnx" \
 || wget -q -T 60 -O /out/lama.onnx \
      "https://ghfast.top/https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/inpainting_lama/inpainting_lama_2025jan.onnx" \
 || wget -q -T 60 -O /out/lama.onnx \
      "https://gh-proxy.com/https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/inpainting_lama/inpainting_lama_2025jan.onnx" \
 || true) \
 && { [ -f /out/lama.onnx ] && [ "$(wc -c < /out/lama.onnx)" -gt 10000000 ] \
      || { echo "lama.onnx 下载失败，运行时将回退传统算法"; : > /out/lama.onnx; }; }

# ---------- 第二阶段：运行镜像 ----------
# sharp@0.35.x 要求 Node.js >= 20.9，使用 Node 22 LTS，避免容器启动时原生模块拒绝加载。
FROM node:22-bookworm-slim

WORKDIR /app

# ffmpeg 用于抽音轨/转码（语音识别预处理）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version >/dev/null

COPY --from=builder /out/whisper-cli /usr/local/bin/whisper-cli

COPY package*.json ./
RUN npm ci --omit=dev \
 && node -e "require('sharp'); console.log('sharp runtime ok')"

COPY . .

# 模型放在 COPY . . 之后，避免被构建上下文覆盖
COPY --from=builder /out/ggml-model.bin /app/models/ggml-model.bin
COPY --from=builder /out/lama.onnx /app/models/lama.onnx

EXPOSE 80

ENV PORT=80
ENV WHISPER_BIN=/usr/local/bin/whisper-cli
ENV WHISPER_MODEL=/app/models/ggml-model.bin

CMD ["node", "app.js"]
