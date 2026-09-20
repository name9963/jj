# 去水印助手 · 后端服务

微信云托管部署源，对应小程序「去水印助手」（appid `wx18c4183d2a082f90`）。

## 接口

| 接口 | 说明 |
|---|---|
| `POST /api/video/parse` | 多平台视频/图文解析（抖音、快手、小红书、B站、微博、皮皮虾） |
| `POST /api/session` | 建立签名会话 |
| `POST /api/upload` | 素材上传（需会话） |
| `POST /api/image/remove-watermark` | 图片去水印（石榴 API → 本地 LaMa → Criminisi 三级降级） |
| `POST /api/caption/extract` | 视频口播转文字（百炼 Paraformer → 本地 whisper 降级） |

## 架构约束（重要）

**本项目按单实例设计。**

- 任务与资源状态保存在本地文件（`APP_DATA_DIR`）
- 会话签名密钥 `signing.key` 在每个实例首次启动时随机生成
- **多实例会导致各实例签名密钥不一致，所有已签发会话立即失效**
- 云托管「实例副本数」必须保持 **最小 1 / 最大 1**

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `APP_DATA_DIR` | 建议 | 持久数据目录，需挂载持久卷；否则重启后丢失任务记录与已上传文件 |
| `DASHSCOPE_API_KEY` | 可选 | 阿里云百炼；配置后口播优先走云端识别，准确率更高 |
| `SHILIU_API_KEY` | 可选 | 石榴智能；配置后图片去水印优先走云端修复 |
| `PUBLIC_BASE_URL` | 可选 | 百炼回源拉取音频用的公网地址；默认取当前云托管域名 |
| `ASR_MAX_SECONDS` | 可选 | 最多识别视频前多少秒，默认 180 |
| `ASR_THREADS` | 可选 | 识别线程数，默认按 CPU 核数取（最多 4） |

> 🔐 密钥一律通过云托管控制台的环境变量配置，**不要写进代码**——本仓库是公开的。

### 图片去水印的降级链路

1. **石榴智能 API**（需 `SHILIU_API_KEY`）— 按次计费
2. **本地 LaMa ONNX 模型**（`models/lama.onnx`）— 免费，消耗 CPU
3. **Criminisi 样本块修复** — 纯 JS 兜底

未配置 KEY 时功能仍可用，只是走本地算法。

### 抖音解析（实现方式与其他平台不同）

抖音自 2026 年起改为客户端渲染，`_ROUTER_DATA` 不再内嵌作品数据，早期「解析分享页 HTML」的方案已失效。现在由镜像内的 Python 脚本完成：

```
Node 后端 → 子进程 → douyin/fetch_video.py
                        ├─ curl_cffi              冒充 Chrome 的 TLS/HTTP2 指纹
                        ├─ a_bogus                纯算法生成（无需第三方包）
                        ├─ x-secsdk-web-signature
                        └─ msToken + 浏览器指纹档案
```

**为什么必须伪装 TLS 指纹**：抖音在 **TLS 握手阶段**就会识别非浏览器客户端——指纹不符时，即使签名完全正确也只会得到空响应。

镜像构建时安装 `python3` 与独立 venv（`curl_cffi`、`cryptography`），解释器路径由 `DOUYIN_PYTHON` 指定（默认 `/opt/douyin/bin/python`）。快手 / B站 / 微博 / 皮皮虾仍用原有实现，互不影响。

### 口播识别的降级链路

1. **百炼 Paraformer**（需 `DASHSCOPE_API_KEY`）— 异步接口，阿里云需**回源拉取音频**，因此 `PUBLIC_BASE_URL` 必须公网可达
2. **本地 whisper.cpp**（镜像内置）— 离线识别

任一步失败都会静默降级到下一步，日志中会打印 `[Caption]` / `[Image]` 前缀的提示。

## 部署

代码推送到 `main` 分支后，云托管流水线自动构建。

**⚠️ 更新代码时请让流水线自动触发（推送即构建），不要走控制台「部署发布」手动创建版本。**
本服务最初由官方模板创建，手动部署会复用模板自带的 ZIP 旧镜像（其 Dockerfile 仅 88 字节、内容只有
`FROM 已有镜像`），**不会拉取仓库代码**——判断方法：手动部署耗时只有 90~100 秒且构建日志显示
「检出 ZIP 包」，而真正的构建需要 4 分钟以上并显示 `Cloning Git repository...`。

首次构建需编译 whisper.cpp 并下载语音模型，约 **8-15 分钟**；有缓存后会快很多。实例规格建议 **1核2G 以上**，否则口播识别容易内存不足。**实例副本数务必保持 最小1/最大1**：签名密钥与任务状态都在本地文件，扩到多实例会导致会话随机失效（401）。

**排查部署是否真正生效**：构建日志的第一行时间戳应为当天日期，且能看到 `Whisper model ready`、`sharp runtime ok` 与 `douyin deps ok`。若时间戳是历史日期，说明复用了旧镜像、并未拉取新代码。

## 本地开发

```bash
npm install
node app.js
```

本项目未引入 `dotenv`，本地请用系统环境变量：

```bash
# Windows cmd
set SHILIU_API_KEY=你的KEY
node app.js
```

```powershell
# PowerShell
$env:SHILIU_API_KEY="你的KEY"; node app.js
```

## 测试

```bash
npm test                  # 后端单元与集成测试
npm run audit:prod        # 生产依赖安全检查
```
