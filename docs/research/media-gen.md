# 媒体生成技术选型调研（图片、视频、音频）

> 调研日期：2026-11-06。对应设计文档第 27 节。不预设工具，ComfyUI 只是候选之一。价格、版本、许可证变化很快，接入前按来源复核。
> 标注：「官方」= 厂商文档或仓库原文；「第三方」= 媒体、博客或聚合平台转述；「估算」= 本文推算；「未查到」= 没找到可靠来源。GitHub 星数和推送时间均为 2026-11-06 通过 API 抓取。
> 商用判断针对“用生成结果做商业游戏”，不是法律意见。

## 0. 结论速览

| 类别 | 本机默认 | 本机备选 | 云端默认 | 云端备选 |
|---|---|---|---|---|
| 图片 | ComfyUI 便携版 + Z-Image / Qwen-Image / FLUX.2 Klein 4B（均 Apache-2.0） | InvokeAI（Apache-2.0，官方图形安装器） | OpenAI `gpt-image-2.6`（透明 PNG、文字、编辑） | Google Nano Banana 2.1（1K $0.0336/张） |
| 视频 | ComfyUI + Wan2.2（Apache-2.0） | WanGP（Windows 安装器、RTX 50 优化，许可有限制） | Runway Dev API（一个 Key 调 Veo 3.1、Kling、Seedance、Wan 3.0、Hailuo、Gen-4.5） | MiniMax Hailuo H3 官方 API（768p $0.08/秒） |
| 音效 | ComfyUI + Stable Audio 3 Small-SFX | ThinkSound（Apache-2.0，视频配音效） | ElevenLabs Sound Effects（官方 `loop` 参数，按次计费，$0.12/分钟） | Stable Audio API（$0.08/次） |
| 音乐 | ComfyUI + ACE-Step 1.5（MIT） | Stable Audio 3 Medium | Google Lyria 3.5（$0.08/首） | ElevenLabs Music（$0.15/分钟） |
| 配音 | Qwen3-TTS（Apache-2.0，中英；克隆和指令控制是不同检查点） | Chatterbox Multilingual（MIT）/ CosyVoice3（Apache-2.0） | ElevenLabs TTS（$0.08/千字符） | Gemini 3.8 Flash TTS |

要点：
- 本机只装一个引擎：ComfyUI 一套就能覆盖图片、视频、音效、音乐，配音可走 ComfyUI 节点或独立小服务。一个安装、一个接口、一个模型库，最适合“不碰命令行”。
- 云端按“一个 Key 覆盖多类”挑：OpenAI（图片）、Google Gemini（图片、音乐、配音、视频）、ElevenLabs（音效、音乐、配音）、Runway（视频聚合）。
- 架构：统一 `Generator` 接口 + 多家插件（第 27.1 节已定），见 6.2。
- 许可是最大的坑：Qwen-Image-2.1、FLUX.2 dev / Klein 9B、MMAudio、AudioGen、YuE2、F5-TTS 权重、Fish Speech 都不能（或只能有限）商用；FLUX 3 Klein、LTX-2.x、Stable Audio 3、MiniMax H3 本机版、HunyuanVideo 有收入门槛或地区限制。
- 不建议接入：Midjourney（无官方 API）、Google Imagen（已停用）、OpenAI Sora（API 2026-09-24 已关闭）、Suno / Udio（无自助 API，Udio 已禁止下载）、Fooocus（只修 bug）。
- “Codex image 2.6”：指 OpenAI 2026-11-04 发布的 Images 2.6。Codex 里用 `$imagegen` 调用，计入订阅额度；只是图片云端的一个入口，不是必选。


## 附：独立核查记录（2026-11-06）

本文的 28 条关键断言，每条由两位核查员各自联网复核，只认官网、许可证原文、官方文档等一手来源。结果：20 条确认，3 条部分有误，5 条需要更正。已在正文相应位置标注“核查更正”。

| 断言 | 更正 |
|---|---|
| Imagen 4 停用日期 | Vertex AI 是 2026-06-30，不是 2026-10；“不接入”的结论不变 |
| OpenAI Images 2.6 支持原生透明 PNG/WebP 和 SVG | 型号名和发布日期属实。SVG 是两步生成，有限制；透明背景官方只写在 2.5 名下，2.6 待实测 |
| Qwen3-TTS 1.7B 同时支持 3 秒克隆和指令控制 | 是三个不同的检查点，克隆和指令控制不能在同一个模型里同时用 |
| ElevenLabs 有官方托管 MCP 可生成音效 | 托管 MCP 只覆盖 Agents 和 TTS；价格和 `loop` 参数属实，但按生成次数计费 |
| Runway 可输出 ProRes / PNG 序列 | 只有 Gen-4.5 和 Aleph 2.0 支持 |
| Kling 4 每秒 0.157–0.235 美元 | 这是 12 月起的标价；11 月底前 8 折；带输入视频时另有计费方式 |
| Stable Audio 3 年收入 < 100 万美元免费商用 | 属实，但商用前要先在 Stability 注册；内含的 T5Gemma 文本编码器还要遵守 Gemma 使用条款 |
| Gemini 3.8 Flash TTS 价格 | 当前价属实，但只到 2026-12-31，2027 年起翻倍 |

## 1. 图片

### 1.1 本机工具

| 工具 | 版本 / 活跃度 | 程序化接口 | 新手安装 | RTX 5090 D | 支持模型 | 工具许可 | 游戏资产相关 |
|---|---|---|---|---|---|---|---|
| ComfyUI | 便携版 v0.44.0（2026-11-04） | 完整 HTTP/WS；官方 MCP（comfy-mcp） | 便携版解压即用，工作台可全自动安装；桌面版有图形向导 | 便携版自带 PyTorch cu130，支持 | 最全：FLUX.2/3、Qwen-Image、Z-Image、SDXL、视频、音频 | GPL-3.0 | 全部靠节点：抠图、RGBA 模型、分层、参考图编辑、无缝贴图（社区节点） |
| SwarmUI | 0.9.8-Beta（2026-02-06），推送 2026-11-05，4.7k 星 | 自有 REST + WS（`POST /API/<route>`，先取会话）；MCP 仅第三方原型 | `install-windows.bat` 后网页向导；`.exe` 安装器仍是待办 | 后端就是 ComfyUI 官方便携版，跟随支持 | FLUX.2、Qwen-Image、Wan、LTX-2 等；Z-Image 未查到 | MIT | 无缝贴图参数（仅 SDXL 类）；`<clear:>` 自动抠透明 |
| InvokeAI | v6.14.4（2026-11-03），29.0k 星 | FastAPI（REST + socket.io）；公开 API 稳定性承诺未查到；MCP 仅第三方 | 官方 Launcher 图形安装器（v1.8.5） | 依赖 torch ≥ 2.7；RTX 50 启动器崩溃 issue 已于 2026-06 关闭 | FLUX.1、FLUX.2 Dev / Klein、Z-Image、Qwen-Image | Apache-2.0 | Unified Canvas 分层修图、局部重绘；无缝贴图、透明背景未查到 |
| Forge Neo | 2.31（2026-10-21），1.9k 星 | `--api`（A1111 风格 REST） | 需 git，无图形安装器 | 默认 torch 2.14 + cu130 | FLUX.2 Klein、Qwen-Image、Z-Image、Wan 2.2、SDXL | AGPL-3.0 | 继承 A1111 生态：ControlNet、IP-Adapter、局部重绘 |
| Forge（原版） | 最近推送 2025-07 | `--api` | 解压包 | 需手动换 PyTorch | Flux.1、SDXL | AGPL-3.0 | LayerDiffuse 透明图扩展（状态未核实） |
| reForge | 最近推送 2026-04，README 建议改用 Forge Classic/Neo | `--api` | 手动 | 未查到 | SDXL 等 | AGPL-3.0 | 基本停更 |
| Fooocus | v2.5.5（2024-08），README 声明“只修 bug” | 无官方 API | 解压即用 | 默认环境报 sm_120 不兼容 | 仅 SDXL | GPL-3.0 | 不建议 |
| Krita AI Diffusion | v1.53.0（2026-08-22），10.8k 星 | 插件内部调用 ComfyUI，自身不对外提供 API | 在 Krita 里装插件，自动安装本地服务 | 自动安装用 cu130 | Flux 2、Z-Image、SDXL 等 | GPL-3.0 | 图层、IP-Adapter、区域提示、实时绘画；美术手工精修最强 |
| Stability Matrix（启动器） | v2.16.5（2026-10-21） | 自身 API 未查到 | 一键装 ComfyUI、SwarmUI、InvokeAI、Forge 等 | 取决于所装的包 | — | AGPL-3.0 | — |
| Pinokio（启动器） | v8.3.7（2026-11-05） | 无生成 API | 一键脚本 | 取决于脚本 | — | MIT | — |

结论：
- 程序化调用友好度：ComfyUI > SwarmUI > InvokeAI > Forge Neo。只有 ComfyUI 有官方 MCP。
- 默认 ComfyUI：接口最完整、模型最新最全，同一引擎还能做视频和音频。
- 备选 InvokeAI：独立引擎（不依赖 ComfyUI），Apache-2.0，图形安装器对新手友好，自带画布，适合手动修图。SwarmUI 底层就是 ComfyUI，作为“备选”意义不大，但可以推荐给想要手动操作界面的用户。
- Krita AI Diffusion 适合美术在 Krita 里精修，可与工作台共用同一个 ComfyUI 和模型库。
- 工作台只是拉起这些工具的独立进程并通过 HTTP 调用，GPL / AGPL 一般不影响工作台代码；如果把工具打包进安装包分发，需要履行源码提供义务。

### 1.2 本机模型（按 32 GB 显存）

“文件合计”为 ComfyUI 官方教程所用文件在 Hugging Face 上的实际大小（官方）。“显存”除注明官方外均为估算；ComfyUI 会把文本编码器等卸载到内存，文件合计超过 32 GB 也常能跑，只是更慢。

| 模型 | 适合 | 许可 / 商用 | 文件合计 | 显存 |
|---|---|---|---|---|
| Z-Image-Turbo（6B） | 文生图主力，8 步，中英文字 | Apache-2.0 ✅ | bf16 12.31 + 文本编码器 8.04 + VAE 0.34 ≈ 20.7 GB；int8 版主模型 6.20 GB | 官方：16 GB 可跑 |
| Z-Image（基础版） | 质量优先、可微调 | Apache-2.0 ✅ | ≈ 20.7 GB | 估算 ≤ 24 GB |
| Qwen-Image-2512（20B） | 写实、立绘、复杂文字排版 | Apache-2.0 ✅ | fp8 20.43 + 9.38 + 0.25 ≈ 30.1 GB | 估算 24–32 GB |
| Qwen-Image-Edit-2511 | 参考图编辑、换材质、多角度 | Apache-2.0 ✅ | ≈ 30.1 GB | 估算 24–32 GB |
| Qwen-Image-Layered | 拆成多个 RGBA 图层 | Apache-2.0 ✅ | fp8 ≈ 30.2 GB | 官方：建议 fp8 |
| FLUX.2 Klein 4B | 轻量文生图 + 参考图编辑 | Apache-2.0 ✅ | 7.75 + 8.04 + 0.34 ≈ 16.1 GB | 估算 ≤ 16 GB |
| Ming Image 0.1 Design（6B） | 图标、UI、海报，原生 RGBA 透明 | MIT ✅ | int8 6.18 + 文本编码器 19.51 + 0.25 ≈ 25.9 GB；可选提示词增强再加 17.29 GB | 估算 32 GB 内（关闭增强） |
| BiRefNet（工具） | 抠图出透明背景 | MIT ✅ | 0.44 GB | 很小 |
| SDXL Base 1.0 | 无缝贴图（配合环形填充节点） | OpenRAIL++-M ✅（有使用限制条款） | 6.94 GB | 估算 8–12 GB |
| FLUX 3 Klein（5.6B，2026-10） | 新一代文生图 / 编辑 | FLUX Kommunity：年收入（含关联方）< 500 万美元可商用输出 ⚠️ | int8 / nvfp4 / bf16 | — |
| Krea-2 | 风格 LoRA 丰富 | Krea AI Community License（未逐条核查）⚠️ | — | — |
| Qwen-Image-2.1（2026-09） | 2K、原生 RGBA | Qwen 研究许可，禁止商用 ❌ | — | — |
| FLUX.2 dev、FLUX.2 Klein 9B | 质量高 | FLUX 非商用许可 ❌ | — | — |

### 1.3 云端服务

| 服务 | 官方 API / MCP | 价格（2026-11-06，除另注） | 商用与版权 | 游戏资产相关 | 新手接入 |
|---|---|---|---|---|---|
| OpenAI `gpt-image-2.6-sunburst` / `-flare`（2026-11-04） | REST（Images API、Responses API） | 输出 $30 / 百万 token；1024² 低质量约 $0.025（第三方实测，比 2.5 多 3–4 倍 token）；`gpt-image-2` 1024² 低 / 中 / 高约 $0.006 / $0.053 / $0.211 | 无需署名；OpenAI 条款原文未逐条核查 | 原生透明 PNG/WebP、SVG 输出、GIF、标注引导编辑、多参考图、文字强 | 贴 Key；需完成组织验证 |
| Codex 内置图片生成 | Agent 任务中 `$imagegen`；CLI `-i` 附参考图 | 计入 Codex 订阅额度，带图轮次消耗快 3–5 倍；批量时官方建议改走 API | 同上 | 同上；Codex 官方文档当天仍写“使用 gpt-image-2”，与 2.6 发布报道不一致 | 已有 Codex 订阅即可 |
| Google Nano Banana 2.1 / 2 / Pro | Gemini API | 2.1：1K $0.0336、2K $0.0504、4K $0.113；Pro：1K/2K $0.134、4K $0.24 | 未逐条核查 | 多参考图、编辑；透明背景未查到 | 贴 Key |
| Google Imagen 4 | 已停用：Gemini API 2026-08-17、Vertex AI 2026-06-30 关停（核查更正） | — | — | 不接入 | — |
| Black Forest Labs（api.bfl.ai） | REST（异步提交 + 轮询）；MCP 未查到 | FLUX 3 Image：1K $0.048、2K $0.10；FLUX 3 Klein：1K $0.009；FLUX.2 pro 起 $0.03（第三方） | API 条款允许 BFL 用你的输入输出训练模型 ⚠️；输出归属未查到 | 多参考图、编辑、微调端点（beta）；原生透明未查到 | 贴 Key，预付 |
| Ideogram（4.0 / 4.5） | REST v2；官方 MCP | 4.0 Turbo / Default / Quality $0.03 / $0.06 / $0.10（第三方，2026-06）；去背景 $0.01 | 输出归属条款未查到 | 原生透明背景端点；文字排版强；角色一致端点（3.0）；自定义模型 | 贴 Key，预付 |
| Midjourney | 无官方 API（第三方，截至 2026-09） | 订阅 $10/月起 | 第三方代理违反条款，有封号风险 | 画质口碑高但无法程序化调用 | 不接入 |
| Leonardo.ai | REST；MCP 未查到 | 美元按量，$5 约 100 次（官方新闻）；单图价未查到 | 未查到 | `transparency: foreground_only` 透明图（部分模型）、批量去背景、Elements 风格 | 贴 Key |
| Scenario（面向游戏资产） | REST + 官方 MCP（含训练模型、组合 LoRA） | Starter $15/月起才能用 API；训练从 Pro 起（约 $45/月，第三方）；单图价未查到 | 随档位不同，细节未查到 | 自训风格 / 角色 LoRA，最适合保持美术风格统一；可调用 GPT Image、Gemini 等；去背景 | 简单（MCP 现成） |
| Adobe Firefly Services | REST（OAuth） | 只走企业合同，价格不公开 | IP 赔偿需企业合同单独购买 | 号称商用安全 | 个人基本拿不到 |
| Recraft（V4.1） | REST；MCP 未查到 | 位图 $0.035、SVG $0.08、Flash $0.007；去背景 / 矢量化 $0.01 | 付费期间生成的产出归你，完整商用权；产出不得用于训练 AI | 唯一原生 SVG（图标、UI）；风格参考 | 贴 Key |
| Stability AI API | REST | Ultra $0.08、Core $0.03 | 托管 API 条款未逐条核查 | 质量已不领先 | 贴 Key |
| Seedream 5.0（BytePlus） | REST | 5.0 Pro 起 $0.045/张 | 未查到 | 多参考图，角色一致性强 | 需 BytePlus 账号 |
| 腾讯混元 Hy Image 3.5 | 腾讯云 REST | 约 $0.024 / 2K（第三方） | 未查到 | — | 需实名和云控制台 |
| fal.ai（聚合） | REST、SDK、MCP | 按模型，如 FLUX dev $0.025/MP | 按上游条款 | 一个 Key 用很多模型 | 贴 Key |
| ComfyUI Partner Nodes | ComfyUI 内置节点 | Comfy 预付积分 | 按上游条款 | 在本机工作流里混用云端模型（Patina 可平铺 PBR、Recraft、GPT Image 等） | 登录 Comfy 账号 |

### 1.4 游戏资产能力对照

| 需求 | 本机方案 | 云端方案 |
|---|---|---|
| 透明背景 | Ming Image 0.1 Design（原生 RGBA）；任意模型 + BiRefNet 抠图；Qwen-Image-Layered 分层 | OpenAI gpt-image（原生）、Ideogram 透明端点、Leonardo transparency、Recraft / Ideogram 去背景 $0.01 |
| 无缝贴图 | SDXL + 环形填充节点（spinagon，仅卷积 UNet 有效）；SwarmUI 的 Seamless 参数（同限制）；DiT 模型用 Universal Seamless Tiles（14 星，不成熟） | 没有通用 API 提供专用参数；ComfyUI Partner Node Patina 可生成可平铺 PBR 材质 |
| 图标 / UI / 矢量 | Ming Image（文字多的 UI）、Z-Image + 抠图 | Recraft（原生 SVG）、gpt-image-2.6（SVG 输出）、Ideogram（文字） |
| 风格统一 | LoRA 训练（ComfyUI / 社区工具）、IP-Adapter、参考图编辑模型 | Scenario 自训风格；Recraft 风格参考；Ideogram 自定义模型 |
| 角色一致 | Qwen-Image-Edit-2511、FLUX.2 Klein 多参考图 | Seedream、Nano Banana、gpt-image 多参考图；Scenario 角色 LoRA |

## 2. 视频

### 2.1 本机工具

| 工具 | 新手安装 | 程序化接口 | 支持模型 | RTX 5090 D | 工具许可 |
|---|---|---|---|---|---|
| ComfyUI | 同 1.1 | HTTP/WS、MCP | Wan2.1/2.2、Wan-Alpha、LTX-2/2.3/2.5、HunyuanVideo 1.5、MiniMax H3、Kandinsky 5 等，均有官方模板 | 支持 | GPL-3.0 |
| WanGP（原 Wan2GP，11.4k 星，2026-11-04 仍在更新） | 官方 `WanGPManager.exe`（实验性，自动装 Python 和依赖，可回滚）；或 Pinokio 社区脚本 | 进程内 Python API（`submit_task`、进度事件）；无头批处理；README 写有 MCP 但文档缺失；无独立 REST 服务 | Wan2.1/2.2、LTX-2.x、HunyuanVideo、MiniMax H3、LongCat 等；另含图片、TTS | 有专门优化（NVFP4、Blackwell 编译缓存），低显存优化是强项 | WanGP Community License 2.0：免费、产出可出售（直接售卖产出需署名）；不得嵌入付费产品或提供付费 API ⚠️ |
| LTX Desktop（Lightricks 官方，测试版） | 桌面安装包 | 无本地 API；有云端 API 模式 | 本地 LTX 2.5 Fast / 2.3 Fast | 支持 NVIDIA，fp8 需 ≥ 9 GB 显存 | 个人免费；模型受 LTX-2 Community License 约束 |
| FramePack | Windows 一键包，50 系反馈需手动换 torch | Gradio，官方 API 未查到 | 基于 HunyuanVideo 的图生视频，6 GB 显存可出约 1 分钟 | 有坑 | 模型许可推测受腾讯许可约束（未核实） |

### 2.2 本机模型

| 模型 | 能力 | 许可 / 商用 | 文件合计 | 显存 / 速度 |
|---|---|---|---|---|
| Wan2.2 TI2V 5B | 文生 + 图生视频，720p 24fps | Apache-2.0 ✅ | 10.00 + umt5 fp8 6.74 + VAE 1.41 ≈ 18.2 GB | 官方：配合卸载 8 GB 可跑；4090 不优化 9 分钟内出 5 秒 720p |
| Wan2.2 I2V / T2V A14B | 质量档，480p / 720p | Apache-2.0 ✅ | fp8 高噪 + 低噪各 14.29 + 6.74 + 0.25 ≈ 35.6 GB（轮流加载） | 见 2.3 实测 |
| Wan-Alpha（Wan2.1 14B + RGBA LoRA） | 带透明通道的视频（特效素材） | 底模 Apache-2.0；LoRA 许可未核查 | — | — |
| LTX-2.3（22B） | 视频 + 同步音频，速度快 | LTX-2 Community License：年收入 ≥ 1000 万美元需付费授权 ⚠️ | fp8 约 29.2 GB（主模型） | 见 2.3 |
| LTX-2.5（2026-07） | 4K HDR、音视频同步；WanGP 有 Alpha Gen | “LTX-2.x Community License”，HF 需申请；条款原文未能读取，推测同上 ⚠️ | — | — |
| HunyuanVideo 1.5（8.3B） | 720p，可超分 1080p | 腾讯混元许可：不适用于欧盟、英国、韩国；MAU > 1 亿另授权 ⚠️ | ≈ 28.6 GB | 官方：24 GB 可跑 |
| MiniMax H3 | 视频 + 原生立体声 | 本机生成结果商用需向 Comfy 购买许可 ⚠️ | — | WanGP 称 NVFP4 版在 5090 上接近实时 |

### 2.3 RTX 5090 实测（均为第三方）

| 测试 | 设置 | 耗时 |
|---|---|---|
| RunPod：Wan2.2 官方 ComfyUI 模板 | 1280×704，81 帧（约 5 秒），20 步 | 约 22 分钟（峰值显存仅 14 GB，模型在从内存串流） |
| RunPod：LTX-2.3 distilled | 768×512，97 帧（约 3.9 秒），8 步 | 15.3 秒 |
| zenn：Wan2.2 14B Q4 图生视频 vs LTX-2.3 22B Q4 | 832×480，81 帧 | Wan 125 秒（开 sageattn3），LTX 22.1 秒 |
| WanGP 作者 | LTX 2.x，480p，20 秒视频 | 约 28 秒 |

结论：Wan2.2 14B 默认模板在 5090 上很慢，需要量化、加速 LoRA 或 WanGP 的优化；LTX 快 5 倍以上，但有收入门槛。入门模板用 Wan2.2 5B。

### 2.4 云端服务

| 服务 | 官方 API | 价格（美元/秒） | 时长 / 分辨率 | 原生音频 | 图生视频、首尾帧、参考 | 游戏资产相关 |
|---|---|---|---|---|---|---|
| Google Veo 3.1（Vertex） | REST / SDK | 含音频 $0.40、无音频 $0.20、4K $0.60；Fast $0.08–0.30；Lite $0.03–0.08（Vertex 官方页，2026-11） | 4/6/8 秒，最高 4K | 有 | 支持；首尾帧和参考图限 8 秒 | 口碑最好之一；需 Google Cloud 项目，新手门槛高 |
| Google Gemini Omni 1.2 Flash | Gemini API | 720p 约 $0.07、1080p 约 $0.104（官方） | 未查到 | 未查到 | 未查到 | 贴 Key 即可 |
| OpenAI Sora | 已停：网页 / App 2026-04-26、API 2026-09-24 关闭 | — | — | — | — | 不接入 |
| Runway Dev API（聚合） | REST / SDK | 1 credit = $0.01；Gen-4.5 $0.12；Veo3.1 含音频 $0.40；Kling3 Pro $0.12–0.17；Kling 4 $0.157–0.235（11/30 前 8 折）；Wan3 $0.05–0.20；Hailuo3 $0.10–0.15（官方，2026-11） | 按模型 | 按模型 | 按模型 | 一个 Key 用多家；可输出 ProRes、PNG 序列（+$0.05/秒） |
| Kling 4.0 / 3.0（快手） | 官方 API 预付资源包；也可经 Runway、Cloudflare | Kling 4：720p $0.157、1080p $0.235（Cloudflare，2026-11） | Kling 4：3–30 秒，1080p | 有 | 10 关键帧、10 参考图、5 参考视频 | 角色一致性强 |
| MiniMax Hailuo H3 | platform.minimax.io REST | 2K $0.13、768p $0.08；Highspeed $0.04–0.06；Lite $0.025–0.04（官方，2026-11） | 最长 15 秒，2K | 有（立体声） | 图生视频、参考视频、参考音频 | 性价比高 |
| Seedance 2.0 / 2.5（BytePlus） | REST / SDK | 约 $0.15 / $0.23（720p，第三方换算，2026-10） | 未查到 | 有 | 首尾帧、多模态参考 | — |
| Wan 3.0（阿里 Model Studio） | REST | 480p $0.05、720p $0.10、1080p $0.20（第三方，2026-08 起） | 2–30 秒，1080p | 有 | 图生视频、首尾帧、多模态参考 | — |
| Luma Ray 3.2 | REST（提交 + 轮询） | 5 秒 720p 约 $0.30（第三方）；官方称正式上线前可能调价 | 5/10 秒，1080p | 未查到 | 最多 16 关键帧 | 唯一官方 `loop` 参数（无缝循环）；HDR / EXR，适合特效循环 |
| Pika | “API Club”，$10/月 | 约 $0.04 起（第三方）；实际聚合 Seedance、Veo、Kling、H3 | 按模型 | 按模型 | 按模型 | 本质是聚合器 |
| fal.ai / Replicate | REST / SDK | 按模型；Replicate 上有 Wan-Alpha | 按模型 | 按模型 | 按模型 | 云端唯一能找到的透明视频（Wan-Alpha） |

游戏资产要点：
- 透明视频：云端主流模型都没有原生 alpha。用本机 Wan-Alpha，或正常生成后用 WanGP 的 LTX-2.5 Alpha Gen 输出 PNG 序列 / ProRes 4444。
- 无缝循环：只有 Luma 有官方 `loop`；其他用“首帧 = 尾帧”变通（Veo、Kling、Seedance、Wan 3.0 支持首尾帧）。
- 角色一致：Kling 4、Seedance 2.5、Wan 3.0、H3 支持多参考。
- 预告片和过场草稿：Kling 4、Wan 3.0 单段可到 30 秒带音频；Veo 3.1 质量好但最长 8 秒。
- 云端视频的产出商用条款本次没有逐家核查官方 ToS。

## 3. 音频

### 3.1 音效

| 方案 | 接入 | 价格 | 许可 / 商用 | 游戏资产相关 |
|---|---|---|---|---|
| ElevenLabs Sound Effects v2 | REST；官方托管 MCP 只覆盖 Agents 和 TTS，不含音效（核查更正）；能生成音效的是本地开源 elevenlabs-mcp，已标记弃用 | $0.12/分钟（官方） | 付费档（$6/月起）可商用、免版税；免费档仅个人（第三方） | 0.5–30 秒；`loop=true` 生成可无缝循环；mp3 / opus / pcm / wav，44.1k WAV 需 Pro 档 |
| Stable Audio API（3.0 / 2.5） | REST | $0.08/次（官方） | 免费档生成的曲目也可商用（Stability 知识库） | 3.0 最长 6 分钟；loop 参数未查到 |
| Mirelo SFX 2.0 | 自有平台、fal.ai、ComfyUI Partner Node | fal 上 $0.015/秒（2026-12-13 前 $0.010） | 未查到 | 强项是视频配音效 |
| Stable Audio 3 Small-SFX（本机） | ComfyUI 原生 + 官方模板 | 免费 | Stability Community License：年收入 < 100 万美元免费商用 ⚠️ | ≤ 2 分钟，可在 CPU 跑；2.27 + 1.19 ≈ 3.5 GB |
| Stable Audio 3 Medium（本机） | ComfyUI 原生 | 免费 | 同上 ⚠️ | 音乐 / SFX / One-shot 分类模板；≈ 10.4 GB |
| ThinkSound（本机） | 本机运行；Windows 易用性未查到 | 免费 | Apache-2.0 ✅ | 视频 / 文本转音频 |
| HunyuanVideo-Foley（本机） | 本机运行 | 免费 | 腾讯许可，不适用于欧盟、英国、韩国 ⚠️ | 视频转拟音 |
| MMAudio（本机） | ComfyUI 社区节点（kijai，581 星，推送 2026-02） | 免费 | CC-BY-NC-4.0 ❌ | 视频配音效 |
| AudioCraft / AudioGen（本机） | 无维护中的 ComfyUI 节点 | 免费 | 权重 CC-BY-NC-4.0 ❌ | — |

循环：除 ElevenLabs 外都要后处理（零点裁切 + 首尾交叉淡化）。建议工作台内置“自动找循环点 + 淡化 + 循环试听”工具，任何来源的音频都能做成循环。

### 3.2 音乐

| 方案 | 接入 | 价格 | 商用 | 备注 |
|---|---|---|---|---|
| Google Lyria 3.5 | Gemini API | $0.08/首完整歌曲；Lyria 3 Clip（30 秒）$0.04（官方） | Google 不主张生成内容所有权（论坛转述）；全部带 SynthID 水印 | 44.1 kHz 立体声 |
| ElevenLabs Music | REST | $0.15/分钟（官方） | 按档分级；第三方称自助档不含影视和“Studio Games”用途，需 Enterprise ⚠️ 需按官方表核实 | 3 秒–10 分钟，`force_instrumental` |
| Stable Audio 3.0 | API / 本机 | API $0.08/次 | 本机为社区许可 ⚠️ | 适合纯器乐 BGM |
| Suno v6（2026-09-09） | 无公开自助 API，仅合作伙伴 beta；2026-10-28 推出 MCP | 订阅制 | 付费期间生成可商用；Pro 每月下载 20 首（第三方） | 不适合程序化批量；非官方“Suno API”有风险 |
| Udio | 无 API | — | 2025-10-29 与环球合作后禁止下载 | 不可用 |
| ACE-Step 1.5（本机） | ComfyUI 原生 | 免费 | MIT ✅ | 带歌词歌曲 / 配乐；turbo 4.79 GB + 文本编码器 1.19–8.38 GB |
| YuE2（本机） | ComfyUI 原生 | 免费 | 权重 CC-BY-NC-4.0 ❌ | 不能商用 |

### 3.3 配音 / 语音

| 方案 | 类型 | 价格 / 许可 | 中英 | 克隆与情感 | 接入 |
|---|---|---|---|---|---|
| ElevenLabs TTS | 云端 | multilingual $0.08 / 千字符，flash $0.04（官方）；付费档可商用 | 支持 | 声音克隆、声音设计 | REST、官方 MCP |
| Gemini 3.8 Flash TTS | 云端 | 文本输入 $0.50 / 百万 token、音频输出 $9.00（官方，至 2026-12-31）；商用条款未查到 | 支持 | 表现力强 | Gemini API |
| Gemini 3.8 Flash-Lite TTS | 云端 | 输出 $6.00 / 百万 token（官方） | 支持 | — | Gemini API |
| OpenAI gpt-4o-mini-tts | 云端 | 已弃用，2027-01-06 停服 | — | — | 不建议新接入 |
| Qwen3-TTS 1.7B（三个检查点） | 本机 | Apache-2.0 ✅ | 10 种语言含中英 | 1.7B-Base：3 秒克隆，但不支持指令；1.7B-CustomVoice：预置音色 + 指令控制语气；1.7B-VoiceDesign：文字描述设计声音。同一个模型不能既克隆又按指令控制（核查更正） | 多个 ComfyUI 节点 |
| Fun-CosyVoice3 0.5B | 本机 | Apache-2.0 ✅ | 中英 | 克隆 | ComfyUI TTS-Audio-Suite |
| Chatterbox Multilingual / Turbo | 本机 | MIT ✅ | Multilingual 含中文 | 克隆 | ComfyUI 节点；本机 HTTP 服务 Chatterbox-TTS-Server（MIT） |
| Kokoro-82M | 本机 | Apache-2.0 ✅ | 有普通话音色 | 不能克隆 | Kokoro-FastAPI 本机 HTTP 服务，很小 |
| Dia 1.6B | 本机 | Apache-2.0 ✅ | 中文未查到 | 多人对话 | — |
| IndexTTS-2 / 2.5 | 本机 | bilibili 许可：月活 > 1 亿或年收入 > 10 亿元需授权；禁止用输出训练其他模型 ⚠️ | 中英 | 音色与情感分离控制、可控时长 | — |
| Higgs Audio v2 | 本机 | Boson 许可：年活跃用户 > 10 万需授权 ⚠️ | 中文未查到 | 表现力强 | — |
| Fish Speech / OpenAudio | 本机 | 许可互相冲突（社区许可 vs CC-BY-NC-SA / 研究许可）❌ | 中英 | 克隆 | 风险高 |
| F5-TTS | 本机 | 权重 CC-BY-NC ❌ | 中英 | 克隆 | 不可商用 |
| VibeVoice TTS | 本机 | 微软已移除 TTS 代码 ❌ | — | — | 不建议 |

角色声音一致：为每个角色固定一段参考音频做克隆（Qwen3-TTS、CosyVoice3、Chatterbox、ElevenLabs），把参考音和参数存进生成记录。ComfyUI 的 TTS-Audio-Suite 节点统一了多个引擎，支持角色标签和 SRT 时间轴，可作为本机配音的单一入口。

## 4. ComfyUI 接入细节（本机默认引擎）

### 4.1 安装方式

| | 便携版 | 桌面版（Comfy Desktop） | 手动 / comfy-cli |
|---|---|---|---|
| 形态 | `.7z`，解压即用，内置 `python_embeded` | NSIS 安装器 + Electron 启动器，可管理多实例 | git + venv，或 `comfy install` |
| 当前版本 | v0.44.0（2026-11-04），NVIDIA 包 2.05 GB，Python 3.13 + PyTorch cu130 | 默认跟随 stable | 跟随主干 |
| 自动化 | 好：下载、解压、启动都可脚本化，启动参数全部公开 | 差：首次启动必须在全屏向导里勾 EULA；静默安装参数未查到 | 中：`--skip-prompt` 可无交互，但要系统 Python 3.10+、git |
| 数据位置 | 全在解压目录 | 默认 `%LOCALAPPDATA%\Comfy-Desktop\...`；有自定义路径未被遵守的反馈（Issue #14844） | 自选 |
| 官方定位 | “不推荐普通用户” | 面向普通用户 | 面向开发者 |
| 许可 | GPL-3.0 | AGPL-3.0 或商业许可 | comfy-cli GPL-3.0 |

官方推荐普通用户用桌面版，是因为它有图形向导；但向导要用户亲手点，工作台无法代办。由工作台一键安装时，便携版更合适：工作台替代桌面版的图形外壳，隐藏控制台，日志转到工作台。已装桌面版的走 [自动检测]。便携版是 `.7z`，工作台需要自带解压能力（如随包附带 `7zr.exe`）。

RTX 5090 D（Blackwell，sm_120）：PyTorch 2.7.0 起、CUDA 12.8 及以上构建均支持 sm_120（PyTorch 官方答复）；ComfyUI 要求 20 系及以上用 cu130；CUDA 13.0 对应驱动 R580 分支，本机 617.42（R615）满足。网上“PyTorch 稳定版不支持 sm_120”的说法已过时，不需要第三方 Blackwell 安装器。

一键安装流程：
1. 检测显卡、显存、驱动 ≥ 580。
2. 下载 `https://github.com/Comfy-Org/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z`（断点续传），解压到 `<工作台数据目录>/comfyui/`。
3. 写 `extra_model_paths.yaml`，指向工作台共享模型库 `<工作台数据目录>/models/`（按 ComfyUI 子目录结构：`diffusion_models`、`text_encoders`、`vae`、`loras`、`checkpoints` 等）。
4. 后台启动：`python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --disable-auto-launch --listen 127.0.0.1 --port 8188 --preview-method auto --output-directory <...> --extra-model-paths-config <...>`。
5. 轮询 `GET /system_stats` 直到就绪。
6. 自动检测：探测本机端口的 `/system_stats`；桌面版共享模型库默认在 `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared`。

安全：ComfyUI 没有登录鉴权，只能监听 `127.0.0.1`；局域网模式需在界面明确警告。自定义节点会执行任意代码，只装白名单节点。

### 4.2 接口

| 接口 | 工作台用途 |
|---|---|
| `POST /prompt`（带 `client_id`） | `submit()`；校验失败返回 `node_errors` |
| `/ws?clientId=` | `progress()`：`execution_start`、`executing`、`progress`、`executed`、`execution_success`、`execution_error`，以及二进制预览帧 |
| `GET /history/{prompt_id}` + `GET /view` | `result()`：取输出文件 |
| `POST /upload/image`、`/upload/mask` | 参考图、蒙版 |
| `POST /interrupt`；`POST /queue`（删除排队项） | `cancel()` |
| `GET /object_info` | 生成表单控件、提交前校验 |
| `GET /models/{folder}` | 显示“模型是否已下载” |
| `GET /system_stats`、`POST /free` | 健康检查、显存分档、用完释放显存 |

工作流格式：提交必须用 API 格式（`File → Export Workflow (API)`），结构为 `{节点ID: {class_type, inputs, _meta.title}}`，连线写成 `["上游ID", 输出序号]`；保存格式含布局，只用于界面编辑，官方无服务端转换接口（未查到）。输出的 PNG / MP4 默认内嵌 `workflow` 和 `prompt`，可用于“相同参数再生成”，但应视为不可信输入。

识别可暴露的输入：
1. 只看字面量输入（不是连线）。
2. 白名单：`CLIPTextEncode.text`（按下游采样器的 `positive`/`negative` 区分正负）、采样器的 `seed`/`steps`/`cfg`、latent 节点的 `width`/`height`/`batch_size`/`length`、`LoadImage.image`、音频节点的时长。
3. 约定：节点标题以 `in:` 开头的一律暴露，后半段作为表单标签。
4. 用 `/object_info` 补全类型、范围、枚举；模型名输入显示为“所需模型”。
5. 内置模板预先标注 `exposed_inputs`，存入 `gen_workflows`。

### 4.3 MCP

| 项目 | 星数 / 推送 | 特点 | 评估 |
|---|---|---|---|
| Comfy-Org/comfy-mcp（官方本机） | 325 / 2026-11-05 | stdio；`run_workflow`、`fetch_outputs`、`search_templates`、`validate_workflow` 等，包装 comfy-cli | 官方、活跃，但依赖系统 Python + comfy-cli |
| Comfy Cloud MCP（`cloud.comfy.org/mcp`） | — | 远程 + OAuth，跑在 Comfy Cloud | 只作云端补充 |
| artokun/comfyui-mcp | 893 / 2026-11-04，MIT | 可编辑实时画布、管理模型和节点 | 社区最活跃，权限面大 |
| joenorton/comfyui-mcp-server | 410 / 2026-02，Apache-2.0 | 轻量 | 9 个月未更新 |

其他工具的 MCP：Ideogram、Scenario 有官方 MCP；ElevenLabs 的官方托管 MCP 不含音效（核查更正）；SwarmUI、InvokeAI 只有第三方。

建议：工作台自己在 MCP Hub 把生成器暴露成 `gen__image`、`gen__sfx`、`gen__video` 等，审批、预算、独占排队和结果进“改动”面板都在工作台掌控。第三方 MCP 会绕过这些控制，不默认启用。

### 4.4 官方模板

模板库来自 Comfy-Org/workflow_templates（MIT），当前 736 个，其中开源本机模型 267 个，其余调用云端 Partner Nodes。可直接用作起点：Z-Image-Turbo、Qwen-Image / Edit-2511 / Layered、Ming Image Design、FLUX.2 Klein 4B、`video_wan2_2_5B_ti2v`、`video_wan2_2_14B_i2v`、`video_wan2.1_alpha_t2v_14B`、HunyuanVideo 1.5、`audio_stable_audio_3_medium`、ACE-Step 1.5。无缝贴图、精灵图、角色转面没有开源本机模板（只有云端 Patina、sprite sheet、turnaround 等）。

## 5. 建议

### 5.1 每类默认与备选

| 类别 | 选择 | 理由 |
|---|---|---|
| 图片·本机默认 | ComfyUI 便携版 | 接口最完整、有官方 MCP 和模板、模型最新；与视频、音频共用一个引擎和模型库 |
| 图片·本机备选 | InvokeAI | 独立引擎、Apache-2.0、图形安装器、REST 接口；ComfyUI 出问题时可切换，也适合手动修图 |
| 图片·云端默认 | OpenAI gpt-image-2.6 | 文字和编辑能力强；SVG 是“先出位图再转写”的两步生成，n 只能为 1、不支持编辑端点；透明背景官方只写在 2.5 名下，2.6 是否支持需实测，需要透明图时先用 2.5 或本机抠图（核查更正）；Agent 任务中还可走 Codex 订阅额度 |
| 图片·云端备选 | Google Nano Banana 2.1 | 1K $0.0336/张，同一个 Google Key 还能做音乐、配音、视频 |
| 视频·本机默认 | ComfyUI + Wan2.2 5B（质量档 14B） | Apache-2.0 可商用；与图片同一引擎 |
| 视频·本机备选 | WanGP | Windows 安装器、低显存和 RTX 50 优化；只有 Python API，接入成本高，许可禁止嵌入付费产品 |
| 视频·云端默认 | Runway Dev API | 一个 Key 调 Veo 3.1、Kling、Seedance、Wan 3.0、Hailuo、Gen-4.5；ProRes / PNG 序列只有 Gen-4.5 和 Aleph 2.0 支持（核查更正） |
| 视频·云端备选 | MiniMax Hailuo H3 | 官方 API 便宜（768p $0.08/秒），15 秒带立体声 |
| 音效·本机默认 | ComfyUI + Stable Audio 3 Small-SFX | 小（≈ 3.5 GB）、有官方模板；收入 < 100 万美元免费商用 |
| 音效·本机备选 | ThinkSound | Apache-2.0，无收入门槛；Windows 易用性待验证 |
| 音效·云端默认 | ElevenLabs Sound Effects | 官方 `loop` 参数（单次最长 30 秒，按生成次数计费）；同一个 Key 覆盖音乐和配音；托管 MCP 不含音效，工作台直接调 REST（核查更正） |
| 音效·云端备选 | Stable Audio API | $0.08/次，条款宽松 |
| 音乐·本机默认 | ACE-Step 1.5 | MIT，ComfyUI 原生 |
| 音乐·本机备选 | Stable Audio 3 Medium | 纯器乐 BGM 好用；有收入门槛 |
| 音乐·云端默认 | Google Lyria 3.5 | $0.08/首，复用 Google Key；注意 SynthID 水印 |
| 音乐·云端备选 | ElevenLabs Music | 复用 ElevenLabs Key；游戏用途条款需先核实 |
| 配音·本机默认 | Qwen3-TTS | Apache-2.0，中英；克隆用 1.7B-Base，控制语气用 1.7B-CustomVoice，两种需求要分别选模型（核查更正） |
| 配音·本机备选 | Chatterbox Multilingual（MIT）或 CosyVoice3（Apache-2.0） | 许可干净，有本机 HTTP 服务或 ComfyUI 节点 |
| 配音·云端默认 | ElevenLabs TTS | 质量口碑好、克隆和声音设计、MCP |
| 配音·云端备选 | Gemini 3.8 Flash TTS | 复用 Google Key，价格低 |

### 5.2 架构与首批插件

沿用设计 27.1：一个 `Generator` 接口，每家服务一个插件，界面按 `describe()` 返回的参数自动生成表单，Agent 通过 MCP Hub 调用同一批插件。插件分两类：
- 本机引擎插件：负责安装、启动、健康检查、模型下载、显存独占排队（ComfyUI、InvokeAI、WanGP）。
- 云端 API 插件：只需 Key（存凭据库）、价格表（用于预算和审批）、并发上限。

首批（M10 第一阶段，覆盖全部 5 类的本机和云端默认）：

| 插件 | 覆盖 | 说明 |
|---|---|---|
| `comfyui` | 图片、视频、音效、音乐（配音经 TTS 节点） | 一键安装便携版 + 内置模板 |
| `openai-image` | 图片 | API Key；另在 Agent 任务中允许 Codex 自带 `$imagegen` |
| `google-gemini` | 图片（Nano Banana）、音乐（Lyria）、配音（TTS）、视频（Omni Flash） | 一个 Key 覆盖四类 |
| `elevenlabs` | 音效、音乐、配音 | 一个 Key 覆盖三类 |

第二阶段：`runway`（视频聚合）、`minimax`（视频）、`scenario`（自训风格，有官方 MCP）、`recraft`（SVG 图标）、`ideogram`（透明图和文字）、`luma`（循环特效）、`invokeai`、`wangp`、本机 TTS 服务（Qwen3-TTS / Chatterbox）。

通用工具（不属于某个生成器）：抠图（BiRefNet）、音频自动循环点 + 交叉淡化、视频首尾帧闭环、批量重命名导出到 Unity 工程。

### 5.3 ComfyUI 首批 6 个入门模板

| 模板 | 模型 | 许可 | 下载量 | 备选 |
|---|---|---|---|---|
| 文生图 | Z-Image-Turbo bf16 | Apache-2.0 | ≈ 20.7 GB | 小一档：int8 + fp8 文本编码器 ≈ 12 GB；高一档：Qwen-Image-2512 fp8 |
| 图生图（参考图） | FLUX.2 Klein 4B | Apache-2.0 | ≈ 16.1 GB | 高一档：Qwen-Image-Edit-2511 fp8（≈ 30 GB） |
| 无缝贴图 | SDXL Base 1.0 + spinagon 环形填充节点（社区，GPL-3.0） | OpenRAIL++-M | ≈ 7 GB | 云端 Patina（可平铺 PBR） |
| 图标 / UI 元素 | Z-Image-Turbo + BiRefNet | Apache-2.0 + MIT | 与文生图共用 + 0.44 GB | 文字多的 UI：Ming Image 0.1 Design（MIT，原生透明，≈ 26 GB） |
| 角色立绘 | Qwen-Image-2512 fp8 + BiRefNet | Apache-2.0 + MIT | ≈ 30 GB | 需要分层：Qwen-Image-Layered |
| 短视频（首帧生成） | Wan2.2 TI2V 5B | Apache-2.0 | ≈ 18.2 GB | 高一档：Wan2.2 I2V A14B fp8（≈ 35.6 GB） |

再加两个：音效（Stable Audio 3 Small-SFX，≈ 3.5 GB）、配乐（ACE-Step 1.5）。全套首批约 95 GB（共用文件只算一次，估算），按模板按需下载。

### 5.4 需要用户决定

1. 公司或个人年收入是否超过 100 万 / 500 万 / 1000 万美元：决定 Stable Audio 3、FLUX 3 Klein、LTX-2.x 能否免费商用。不确定时只用 Apache-2.0 / MIT 模型。
2. 首批开哪些云端账号：OpenAI、Google、ElevenLabs、Runway；用 API Key 还是只用 Codex 订阅做图片；每月预算上限。
3. 是否需要自训美术风格（决定是否接 Scenario 或本机 LoRA 训练）。
4. 是否接受安装社区自定义节点（无缝贴图、TTS 需要），白名单范围。
5. 是否提供 Hugging Face Token（下载需申请许可的模型）。
6. 模型库放哪个盘（首批约 95 GB，视频模型再加数十 GB）。
7. 是否发行到欧盟、英国、韩国（决定能否用 HunyuanVideo、HunyuanVideo-Foley）。
8. 工作台将来是否对外售卖：若是，WanGP 不能嵌入，需另购授权或不用。

## 来源

ComfyUI
- [系统要求](https://docs.comfy.org/installation/system_requirements) · [便携版](https://docs.comfy.org/installation/comfyui_portable_windows) · [桌面版概览](https://docs.comfy.org/installation/desktop/overview) · [桌面版 Windows](https://docs.comfy.org/installation/desktop/windows) · [README](https://github.com/Comfy-Org/ComfyUI/blob/master/README.md) · [v0.44.0 Release](https://github.com/Comfy-Org/ComfyUI/releases/latest) · [Issue #14844](https://github.com/Comfy-Org/ComfyUI/issues/14844) · [更新](https://docs.comfy.org/installation/update_comfyui)
- [启动参数](https://docs.comfy.org/development/comfyui-server/startup-flags) · [Server Routes](https://docs.comfy.org/development/comfyui-server/comms_routes) · [WebSocket 消息](https://docs.comfy.org/development/comfyui-server/comms_messages) · [API 格式](https://docs.comfy.org/development/api-development/workflow-api-format) · [Workflow Metadata](https://docs.comfy.org/development/api-development/workflow-metadata) · [SDK](https://docs.comfy.org/development/api-development/sdks) · [comfy-cli](https://github.com/Comfy-Org/comfy-cli)
- [Comfy MCP 文档](https://docs.comfy.org/agent-tools/mcp) · [comfy-mcp](https://github.com/Comfy-Org/comfy-mcp) · [artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp) · [joenorton/comfyui-mcp-server](https://github.com/joenorton/comfyui-mcp-server) · [Partner Nodes](https://docs.comfy.org/tutorials/partner-nodes/overview) · [workflow_templates](https://github.com/Comfy-Org/workflow_templates)

显卡
- [PyTorch 论坛：2.7.0 + cu128 起支持 sm_120](https://discuss.pytorch.org/t/rtx-5050-sm-120-support-timeline-when-in-stable-pytorch/224288/5) · [CUDA 发行说明](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/) · [sageattention-blackwell](https://github.com/mobcat40/sageattention-blackwell)

本机图片工具
- [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) · [SwarmUI API](https://github.com/mcmonkeyprojects/SwarmUI/blob/master/docs/API.md) · [InvokeAI](https://github.com/invoke-ai/InvokeAI) · [Invoke Launcher](https://github.com/invoke-ai/launcher/releases) · [Forge Neo](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo) · [Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) · [reForge](https://github.com/Panchovix/stable-diffusion-webui-reForge) · [Fooocus](https://github.com/lllyasviel/Fooocus) · [Fooocus #3862](https://github.com/lllyasviel/Fooocus/issues/3862) · [Krita AI Diffusion](https://github.com/Acly/krita-ai-diffusion) · [Stability Matrix](https://github.com/LykosAI/StabilityMatrix) · [Pinokio](https://github.com/pinokiocomputer/pinokio)

图片模型与许可
- [Z-Image-Turbo 教程](https://docs.comfy.org/tutorials/image/z-image/z-image-turbo) · [Qwen-Image-2512](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2512) · [Qwen-Image-Edit-2511](https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit-2511) · [Qwen-Image-Layered](https://docs.comfy.org/tutorials/image/qwen/qwen-image-layered) · [Qwen-Image-2.1 许可](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE) · [FLUX.2 Klein](https://docs.comfy.org/tutorials/flux/flux-2-klein) · [FLUX 3 Klein](https://docs.comfy.org/tutorials/flux/flux-3-klein) · [FLUX Kommunity 解读](https://huggingface.co/mlx-community/flux-3-image-klein-bf16) · [Ming Image](https://docs.comfy.org/tutorials/image/ming-image/ming-image-0-1-design) · [BiRefNet](https://docs.comfy.org/tutorials/utility/remove-background-birefnet) · [seamless-tiling](https://github.com/spinagon/ComfyUI-seamless-tiling) · [Universal Seamless Tiles](https://github.com/OliverCrosby/ComfyUI-Universal-Seamless-Tiles)

云端图片
- [Codex 图片生成](https://learn.chatgpt.com/docs/image-generation) · [OpenAI 图片指南](https://developers.openai.com/api/docs/guides/image-generation) · [OpenAI 定价](https://developers.openai.com/api/docs/pricing) · [Images 2.6 报道](https://huggingface.co/blog/ai-shu/image-2-6-explained) · [eesel 2.6 定价分析](https://www.eesel.ai/blog/chatgpt-images-2-6-pricing)
- [Gemini API 定价](https://ai.google.dev/gemini-api/docs/pricing) · [Imagen 停用](https://ai.google.dev/gemini-api/docs/models/imagen) · [BFL 定价](https://bfl.ai/pricing) · [BFL API 条款](https://bfl.ai/legal/flux-api-service-terms) · [Ideogram API](https://developer.ideogram.ai/ideogram-api/api-setup) · [Ideogram 透明端点](https://developer.ideogram.ai/api-reference/api-reference/generate-transparent-v4) · [Midjourney API 现状（第三方）](https://www.aifreeapi.com/en/posts/midjourney-api-guide) · [Leonardo 透明](https://docs.leonardo.ai/docs/generate-images-using-transparency) · [Scenario API](https://help.scenario.com/articles/7934059476-api-usage-and-credits-compute-units) · [Scenario MCP](https://www.scenario.com/features/mcp) · [Firefly API](https://developer.adobe.com/firefly-services/docs/firefly-api) · [Recraft 定价](https://www.recraft.ai/docs/api-reference/pricing) · [Recraft 版权](https://www.recraft.ai/docs/plans-and-billing/commercial-rights-and-ownership) · [Stability 定价](https://docs.stability.ai/pricing) · [Seedream](https://www.byteplus.com/en/product/Seedream) · [fal 定价](https://fal.ai/pricing)

视频
- [Wan2.2 教程](https://docs.comfy.org/tutorials/video/wan/wan2_2) · [Wan2.2-TI2V-5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) · [LTX-2.5 教程](https://docs.comfy.org/tutorials/video/ltx/ltx-2-5) · [LTX-2 许可](https://huggingface.co/Aga16/LTX-2/raw/main/LICENSE) · [HunyuanVideo 1.5](https://docs.comfy.org/tutorials/video/hunyuan/hunyuan-video-1-5) · [混元许可](https://huggingface.co/tencent/HunyuanVideo-1.5/blob/main/LICENSE) · [MiniMax H3 许可](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)
- [WanGP README](https://github.com/deepbeepmeep/Wan2GP) · [WanGP API](https://raw.githubusercontent.com/deepbeepmeep/Wan2GP/main/docs/API.md) · [WanGP 许可](https://raw.githubusercontent.com/deepbeepmeep/Wan2GP/main/LICENSE.txt) · [LTX Desktop](https://github.com/lightricks/ltx-desktop) · [FramePack](https://github.com/lllyasviel/FramePack)
- [RunPod 实测（第三方）](https://www.runpod.io/articles/guides/best-gpu-for-ai-video) · [zenn 实测（第三方）](https://zenn.dev/toki_mwc/articles/ltx23-vs-wan22-i2v-benchmark-rtx5090?locale=en)
- [Vertex 定价](https://cloud.google.com/vertex-ai/generative-ai/pricing) · [Veo 3.1 文档](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate) · [Sora 停服](https://help.openai.com/nl-nl/articles/20001152) · [Runway API 定价](https://docs.dev.runwayml.com/guides/pricing/) · [Runway 专业输出](https://docs.dev.runwayml.com/guides/professional-outputs/) · [Kling 4（Cloudflare）](https://developers.cloudflare.com/ai/models/klingai/kling-v4/) · [MiniMax 定价](https://platform.minimax.io/docs/guides/pricing) · [Wan 3.0 定价（第三方）](https://evolink.ai/blog/wan-api-pricing-guide) · [Seedance 定价（第三方）](https://blog.picassoia.com/seedance-api-pricing-key-byteplus-access-and-docs) · [Luma 生成](https://docs.agents.lumalabs.ai/guides/videos/generation/) · [Luma 定价](https://docs.agents.lumalabs.ai/guides/pricing/) · [Pika API Club](https://pika.art/blog/pika-api-club) · [Wan-Alpha（Replicate）](https://replicate.com/atonamy/wan-alpha)

音频
- [Stable Audio 3 教程](https://docs.comfy.org/tutorials/audio/stable-audio/stable-audio-3) · [Stability 公告](https://stability.ai/news-updates/meet-stable-audio-3-the-model-family-built-for-artistic-experimentation-with-open-weight-models) · [Stable Audio 商用](https://kb.stability.ai/knowledge-base/stable-audio-commerical-and-usage-licensing) · [ACE-Step 1.5](https://huggingface.co/ACE-Step/Ace-Step1.5) · [MMAudio](https://huggingface.co/hkchengrex/MMAudio) · [AudioGen](https://huggingface.co/facebook/audiogen-medium) · [HunyuanVideo-Foley 许可](https://raw.githubusercontent.com/Tencent-Hunyuan/HunyuanVideo-Foley/main/LICENSE)
- [ElevenLabs API 定价](https://elevenlabs.io/pricing/api) · [ElevenLabs SFX API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert/llms.txt) · [ElevenLabs Music API](https://elevenlabs.io/docs/api-reference/music/compose/llms.txt) · [Eleven Music 条款](https://elevenlabs.io/eleven-music-model-specific-terms) · [ElevenLabs MCP](https://github.com/elevenlabs/elevenlabs-mcp) · [Mirelo（fal）](https://fal.ai/models/mirelo-ai/sfx2.0/text-to-audio)
- [Lyria](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/music/overview) · [Suno MCP 与 API（第三方）](https://www.musicbusinessworldwide.com/sunos-new-mcp-tool-lets-users-make-songs-inside-chatgpt-claude-and-gemini-as-its-developer-api-gets-a-sign-in-portal-but-remains-in-beta/) · [Udio 变更](https://help.udio.com/en/articles/12683565-changes-associated-with-the-universal-music-group-umg-partnership) · [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech)
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) · [Chatterbox](https://github.com/resemble-ai/chatterbox) · [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) · [IndexTTS 许可](https://raw.githubusercontent.com/index-tts/index-tts/main/LICENSE) · [Fish Speech 许可](https://raw.githubusercontent.com/fishaudio/fish-speech/main/LICENSE) · [VibeVoice](https://github.com/microsoft/VibeVoice) · [TTS-Audio-Suite](https://github.com/diodiogod/TTS-Audio-Suite) · [游戏循环后处理（第三方）](http://hackernoon.com/how-to-turn-an-ai-generated-track-into-a-seamless-game-loop-with-ffmpeg-godot-unity-and-web-audio)

