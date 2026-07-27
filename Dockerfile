# ============================================================
#  去水印后端镜像（微信云托管）
#  运行镜像仍是 node:18-alpine，额外内置：
#    - whisper.cpp 离线语音识别（把视频里说的话转成文字）
#    - ffmpeg（从视频里抽出 16kHz 单声道音轨喂给 whisper）
# ============================================================

# ---------- 第一阶段：编译 whisper.cpp + 下载中文模型 ----------
FROM node:18-alpine AS whisper-builder

RUN apk add --no-cache build-base cmake git wget

WORKDIR /build
# 优先走国内可达的 GitHub 镜像，失败再回落直连（云托管构建环境常拉不动 GitHub）
RUN git clone --depth 1 https://ghfast.top/https://github.com/ggml-org/whisper.cpp.git . \
 || (rm -rf /build/.git /build/* \
     && git clone --depth 1 https://gh-proxy.com/https://github.com/ggml-org/whisper.cpp.git .) \
 || (rm -rf /build/.git /build/* \
     && git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git .)
RUN test -f CMakeLists.txt

# 静态链接 + 关闭 OpenMP：产物只依赖 libstdc++，方便原样拷进运行镜像
RUN cmake -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_OPENMP=OFF \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
 && (cmake --build build -j"$(nproc)" --target whisper-cli \
     || cmake --build build -j"$(nproc)") \
 && mkdir -p /out \
 && (cp build/bin/whisper-cli /out/whisper-cli || cp build/bin/main /out/whisper-cli) \
 && test -x /out/whisper-cli

# 模型优先走 hf-mirror 国内镜像，失败再回落官方源
#   tiny=75MB(最快/准确度一般) base=142MB(默认) small=466MB(更准但慢且镜像大)
ARG WHISPER_MODEL_SIZE=base
RUN wget -q --tries=3 --timeout=60 -O /out/ggml-model.bin \
      "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL_SIZE}.bin" \
 || wget -q --tries=3 --timeout=90 -O /out/ggml-model.bin \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL_SIZE}.bin"
# 校验模型确实下载完整（<10MB 说明拿到的是错误页而不是模型）
RUN test "$(wc -c < /out/ggml-model.bin)" -gt 10000000

# ---------- 第二阶段：运行镜像 ----------
FROM node:18-alpine

WORKDIR /app

# ffmpeg 抽音轨；libstdc++/libgcc 是 whisper-cli 的运行时依赖
RUN apk add --no-cache ffmpeg libstdc++ libgcc

COPY --from=whisper-builder /out/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-builder /out/ggml-model.bin /app/models/ggml-model.bin

COPY package*.json ./
RUN npm install --production

COPY . .

# LaMa ONNX 修复模型(图片去水印的本地 AI 兜底，仓库里不存大文件，构建时下载)：
# 镜像优先、直连兜底；均失败则跳过，代码会自动回退传统算法，不阻塞构建
RUN mkdir -p /app/models \
 && ([ -f /app/models/lama.onnx ] \
     || wget -q -T 60 -O /app/models/lama.onnx "https://ghfast.top/https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/inpainting_lama/inpainting_lama_2025jan.onnx" \
     || wget -q -T 90 -O /app/models/lama.onnx "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/inpainting_lama/inpainting_lama_2025jan.onnx" \
     || (rm -f /app/models/lama.onnx && echo "lama.onnx 下载失败，运行时将回退传统算法")) \
 && { [ ! -f /app/models/lama.onnx ] || [ "$(wc -c < /app/models/lama.onnx)" -gt 10000000 ] || rm -f /app/models/lama.onnx; }

EXPOSE 80

ENV PORT=80
ENV WHISPER_BIN=/usr/local/bin/whisper-cli
ENV WHISPER_MODEL=/app/models/ggml-model.bin

CMD ["node", "app.js"]
