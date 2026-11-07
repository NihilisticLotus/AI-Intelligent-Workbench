# CC Switch 的多服务、多模型与模型资料来源调研

日期：2026-11-08。状态：已完成固定版本的静态源码核查；未做运行时或模型能力实测。

## 1. 结论与适用边界

CC Switch 确实实现了多家 API 服务、每家多个模型、手动添加模型和能力参数补全。但它不是从一个通用模型列表接口自动获得全部能力：**模型 ID 发现、资料表补全、用户配置、客户端目录生成、请求参数转换，是不同的链路。** 模型能列出来，不等于图片、上下文窗口或思考档位已经验证能用。

可借鉴的是“服务和模型分开管理、按服务地址匹配资料、补空缺并标来源、未知保留未知、明确请求归属”。不能照搬的是它管理和改写 Claude Code、Codex 等客户端的配置、模型目录、连接与认证的方式。本项目已在 [design.md 6.4](../design/design.md#64-账号配置与环境隔离) 和 [phase-1.md 9.15](../plans/phase-1.md#915-用户澄清第三方配置与工作台独立-agent2026-11-08) 确认：第三方 Agent 使用自己的设置；工作台自有 API 仅供独立 Agent 使用。

下文“已证实”表示在所列版本源码或官方文档中找到对应实现；不表示已经向任何服务发请求验证，更不表示供应商当前部署必然满足该能力。

## 2. 项目身份、版本与方法

| 项目 | 核查结果 |
|---|---|
| 官方项目 | [farion1231/cc-switch](https://github.com/farion1231/cc-switch)，[ccswitch.io 官方网站](https://ccswitch.io/zh/) 反向链接到该仓库；本文的 CCSwitch 指这个项目 |
| 固定版本 | [v4.0.26 发布页](https://github.com/farion1231/cc-switch/releases/tag/v4.0.26)，发布日期为 2026-11-05 |
| 固定提交 | [`f621d4216189ef06bcc6acd3588c84937b9794e1`](https://github.com/farion1231/cc-switch/commit/f621d4216189ef06bcc6acd3588c84937b9794e1) |
| 许可证 | [同一提交的 LICENSE](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/LICENSE) 为 MIT，署名 Copyright (c) 2025 Jason Young；本轮只研究设计，没有复制实现代码；以后复制 / 分发时保留相关许可声明 |
| 标签核对 | GitHub [tag 引用](https://api.github.com/repos/farion1231/cc-switch/git/ref/tags/v4.0.26) 指向 annotated tag `8e975496f2e172230a509a2a5961899a926f5525`；[tag 对象](https://api.github.com/repos/farion1231/cc-switch/git/tags/8e975496f2e172230a509a2a5961899a926f5525) 指向上述提交 |
| 阅读方式 | 联网查看官方仓库、发布说明、固定提交文档；将公开源码归档下载到系统临时目录，使用文本检索追踪实现 |
| 未执行 | 未安装 CC Switch 或依赖，未启动 CC Switch / 真实 Agent，未调用模型，未读取第三方 Agent 凭据或个人配置；未将源码放入项目目录 |

以下源码链接全部固定到同一个提交。models.dev 的网站只用于确认它是独立的公开模型资料库；未对它当前全部条目做快照审计，本文也不把其内容当作模型厂商承诺。

## 3. 多 API、多模型是怎么做的

| 功能 | 核查结果 | 来源与确定性 |
|---|---|---|
| 多服务卡片 | 为每个客户端保存多个供应商条目，包含连接配置和模型；不是只有一个全局模型名 | **已证实**：[供应商预设类型与生成函数](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/config/codexProviderPresets.ts#L19) |
| 单服务多个模型 | Codex 供应商有 `modelCatalog`，支持显示名称、实际模型、窗口、思考等级等逐行配置 | **已证实**：[官方添加供应商手册“模型映射”](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/docs/user-manual/zh/2-providers/2.1-add.md#L496) |
| 查询后按需加入 | 获取列表后搜索、勾选和批量添加，也可手动填供应商支持的模型 ID | **已证实**：[聚合手册“设置每家的模型”](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/docs/user-manual/zh/4-proxy/4.6-aggregation.md#L49) |
| 直连、路由、聚合 | 直连改客户端连接；路由经本机代理；聚合把多个服务的模型发布到客户端菜单，再按选择分发 | **已证实**：[连接模式与生效方式](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/docs/user-manual/zh/2-providers/2.2-switch.md#L3) |
| 聚合的服务身份 | 模型 ID 编码服务 key；已分配 key 不复用；无法解析的保留前缀 ID 报错，不悄悄转到默认服务 | **已证实**：[Stack 实现与 `resolve`](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/mode/stack.rs#L1) |

注意一个版本内的资料差异：该版聚合手册开头只列 Claude Code / Codex，但 `supports_stack` 源码同时包含 Claude Desktop。本文以代码确认其分支存在，不据此宣称三个客户端都已经做过端到端验收。[源码位置](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/mode/stack.rs#L54)

## 4. 模型 ID 与模型能力的来源不同

### 4.1 通用“获取模型列表”只留下 ID 和归属

后端 `FetchedModel` 只有 `id` 和 `owned_by`。OpenAI / Anthropic 风格的 `data[]` 解析成这两个字段；另兼容 `models[].slug`、`id` 和特定的 `models/` 名称写法。即使上游响应含额外能力字段，这条通用路径也没有把它们传进返回模型。

因此，**不能把 CC Switch 的自动补全解释为“所有 `/models` 都返回了窗口、图片和强度”。** 它还支持模型 URL 覆盖和不同协议的地址、请求头适配，列表拉取成功证明的范围仍有限。[后端解析与返回类型](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/services/model_fetch.rs#L14)、[前端接口](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/lib/api/model-fetch.ts#L6)

另外，OAuth 模型选择器的 ID 拉取与完整官方目录同步也不是同一条链路。`services/codex_oauth_models.rs` 将 ChatGPT Codex 后端结果转换为同一个简化的 `FetchedModel`；不能由“这里调了官方接口”推导出这一返回值包含全部能力。[OAuth 列表解析](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/services/codex_oauth_models.rs#L1)

### 4.2 表单补全是预设与 models.dev 的合并

`resolveModelMetadata` 逐字段补空缺，优先级为：

1. 当前 API 地址匹配到的内置预设模型参数。
2. models.dev 中 API 地址匹配到的供应商名下模型。
3. models.dev 的原厂条目作为兜底；有歧义则不选。

原厂兜底不带价格。它的 GPT 窗口还被该软件自己的 `272000` 策略上限约束；这不是通用 API 规格，也不是一次探测量出的数值。同地址预设和同供应商资料不走这个封顶规则。[匹配、合并与封顶实现](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/lib/modelMetadata.ts#L350)

地址匹配不仅看域名，还看套餐路径；代码明确区分同域名下普通 API 和 coding 套餐。模型 ID 有大小写、命名空间、变体后缀等归一化。归一化有助匹配，但不是证明别名所指模型和能力完全相同。[地址与 ID 匹配实现](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/lib/modelMetadata.ts#L79)、[ID 归一化](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/lib/modelsDev.ts#L77)

`presetModelMetadata.ts` 从各客户端的预设配置提取窗口、最大输出、输入模态、思考等信息。源码称这些预设为人工核查资料；部分预设附官方资料注释。但本文没有逐一重验所有模型，不能把整个预设集合标为本项目“实测通过”。[预设资料适配](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/config/presetModelMetadata.ts#L1)

models.dev 是[独立的开源模型数据库](https://models.dev/)，有[其自己的仓库](https://github.com/anomalyco/models.dev)。CC Switch 通过后端拉取公开 `api.json`，前端查询缓存为一小时；读取 `limit.context/output`、`modalities`、`reasoning`、`reasoning_options`、`cost` 等字段。缓存新鲜不代表数据经过当前 API 服务实测。[数据结构与缓存](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/lib/modelsDev.ts#L1)、[后端拉取](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/services/model_pricing.rs#L364)

### 4.3 自动补全与手填的覆盖规则有细节

Hook 会先用预设和缓存补一次，models.dev 晚到时再补；补全后提示来源并让用户核对。窗口等通常只补空字段，但部分客户端的布尔能力会朝“支持”方向补：例如 OpenClaw 已有 `reasoning: false`，资料为 true 时仍可能变为 true。因此不能泛称它所有字段都绝不覆盖。

Codex 的图片补全更特殊：只自动补“支持图片”，不会仅凭资料为纯文字而写入禁用图片，因为源码记录了误关入口后编辑界面不能恢复的问题。[补全调度](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/hooks/useModelMetadataFill.ts#L16)、[各客户端字段写入规则](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/components/providers/forms/modelMetadataFill.ts#L1)

## 5. 四类关键信息的核查结果

| 信息 | 已证实的来源与行为 | 尚不能确定的内容 |
|---|---|---|
| 上下文窗口 | 可手填；可从预设 / models.dev 补全；Codex 目录还可来自完整官方目录；通用模板缺资料时可采用 128000 默认值 | 目录显示的数字是否等于当前转售服务真实上限；本调研未发送长上下文请求 |
| 最大输出 | `KnownModelMetadata.maxOutputTokens` 读取 models.dev 的 `limit.output`，部分客户端映射为自身字段 | 不能由上下文窗口推断最大输出；不是每种客户端都使用同一字段 |
| 图片输入 | 可由配置声明或资料模态补全；后端还有明确的纯文本模型注册表；Unknown 单独存在 | Codex 目录把未知模型按可收图片发布属于兼容策略，不能标成“已验证支持图片” |
| 思考 / 强度 | 资料有 `reasoning` 布尔值及 effort 档位列表；表单可手填；目录可以声明档位；转换层另按协议和供应商映射请求 | “支持思考”不等于“支持调档”，显示某档也不保证上游接收并产生该强度 |

窗口与目录生成的源码依据：[`codex_catalog_from_specs_for_row`](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/codex_config.rs#L2408)。它在可用时保留官方或供应商目录，否则按模板与配置构造；供应商级窗口覆盖还会影响逐模型条目。默认窗口、自动压缩阈值和客户端显示的可用比例不能混成同一个概念。[官方手册的窗口说明](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/docs/user-manual/zh/2-providers/2.1-add.md#L515)

图片的源码依据：`ImageInputCapability` 区分 Supported / Unsupported / Unknown，先读显式声明，再查精确纯文本注册表；**Codex 目录将 Unknown 当作支持，媒体修复器对 Unknown 则不改请求体。** 这是两种执行策略，不能转换成同一个“事实”。[图片能力解析与注册表](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/model_capabilities.rs#L1)

思考的源码依据：Claude 经 Chat / Responses 路由时，可配置自动、不发送、原样发送；自动模式依赖已知模型和供应商推断，对未知厂商会采取保守档位映射。Pi 的档位映射也检查协议、地址和 compat，而不是见到 `reasoning: true` 就统一发送一个参数。[Claude 档位转换](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/proxy/providers/claude_reasoning.rs#L1)、[Pi 协议检查](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src/components/providers/forms/modelMetadataFill.ts#L237)

### 5.1 完整官方目录确实是另一个信息来源

`codex_official_models.rs` 的链路可取得官方完整模型条目，按身份和客户端版本缓存；不能取得时退回本机 Codex 自带目录。后者通过 `codex debug models --bundled` 获取，不是测出模型能力，也不是静态读取模型 ID 列表。代码保留原生字段并补必要的解析字段。[官方目录来源、身份与缓存规则](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/services/provider/codex_official_models.rs#L1)、[内置目录加载与规范化](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/codex_config.rs#L1832)

这证明“接口可以有完整能力资料”与“通用 `/models` 路径只取 ID”可以同时成立，须逐个协议与实现分析。**本项目不能复制它读取登录凭据去自行访问 ChatGPT 后端的路径**；第三方 Agent 的信息仍须来自自身公开的会话能力。

### 5.2 连通性检查不等于能力实测

该版仍叫 `stream_check` 的服务实际只 GET 供应商 Base URL，取得任意 HTTP 响应即算可达，包括 401、403、5xx；它不验证 Key、模型存在性，不发送模型推理请求，不验证图片、上下文或思考档位。真实流量失败用于另一条熔断 / 故障转移链路。[连通性检查完整说明与实现](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/services/stream_check.rs#L1)

在本次追踪的列表、补全、目录生成、连通检查链路中，**未发现通过自动发图片、填满窗口、遍历思考档位来探测能力的步骤**。这个结论仅覆盖所查链路，不能扩大为“仓库任何功能都不可能调用模型”。

## 6. 对 AI Console 的建议

以下为基于源码的产品建议，不表示本项目已经实现，也不新增运行或计费授权。

| 可借鉴 | 落在本项目的做法 |
|---|---|
| 服务与模型拆开 | 仅为工作台独立 Agent 建自有服务目录；服务包含协议、Base URL、受保护的凭据；模型通过 serviceId 归属。新增服务 / 模型是追加，不替换已有默认值 |
| ID 发现与能力资料拆开 | “获取模型列表”只承诺获得接口明确提供的字段。每字段保存来源类别、来源 URL / 版本、获取日期、服务匹配范围和确认状态；同一条记录允许窗口来自接口、图片来自手填 |
| 同服务优先 | 按服务身份、协议、套餐路径和模型 ID 匹配。原厂资料作为待确认参考，不把原厂价格或理论能力直接赋给转售商 |
| 用户值保护 | 用户确认 / 手填字段不被自动刷新覆盖，包括明确的 false。资料冲突保留候选与来源；不能直接复制 CC Switch 部分布尔字段朝 true 合并的规则 |
| 不确定性可见 | 模态和能力用“支持 / 不支持 / 未知”，不能把 Unknown 在界面显示为“已支持”。若执行器允许尝试，要把尝试策略与证据状态分开 |
| 强度要分协议 | 分开保存是否支持思考、允许档位、默认档位、接口参数映射；以当前服务协议可发送的交集形成选择器。未知档位不给承诺，不靠模型名无声推断 |
| 故障与费用归属明确 | 任务绑定所选服务和模型；失败明确报错，不换订阅、不换服务兜底。可借鉴 Stack 对过期 / 无效服务标识立即失败的处理 |
| 验证拆成多种状态 | 界面分清“地址可达”“列表获取成功”“资料已填写”“真实调用已验证”；能力实测需要另定范围、消息预算、费用和用户授权 |

对于第三方 Agent，工作台只消费 Agent 自身 `configOptions` / 已声明模型与会话能力；没有暴露的自定义模型如实标记不可选，不尝试读它的私有文件来补齐。工作台资料表可以用于解释和估算，但不能借此制造第三方会话未声明的能力或改写其默认设置。

不能照搬的路径有三类：

1. **写入第三方连接与模型配置。** CC Switch 的 Codex 投影会写 `model_provider`、模型、推理档位、连接表和目录指针；聚合不是仅修改自己的列表，而是要让客户端读到生成目录。[Codex 投影实现](https://github.com/farion1231/cc-switch/blob/f621d4216189ef06bcc6acd3588c84937b9794e1/src-tauri/src/live/project/codex.rs#L1)
2. **读取 / 托管第三方登录。** 上述完整官方目录链路依赖身份和凭据，这不符合本项目用户明确划定的第三方认证边界。不能为了列全模型而采用。
3. **把兼容默认当能力事实。** 128k 默认、GPT 原厂兜底 272k 封顶、未知图片按可用发布、未知供应商强度保守映射，都是该软件特定策略。若本项目确需估算默认，应单独标“估算 / 待确认”，不可标“接口报告”或“实测”。

## 7. 仍不确定与后续核查范围

- 没有验证 CC Switch UI、所有支持客户端和该固定版本的全部部署组合；手册与代码出现支持范围差异时已明确记录。
- 没有验证任一供应商的实际 Key、套餐、可用模型、窗口、图片或强度，也没有验证价格对具体账号是否准确。
- 没有逐条核查所有内置预设的原始资料与更新时间；人工维护注释不是独立实测证据。
- models.dev 是动态数据源。本次证明的是 CC Switch 如何读取它，不保证未来数据结构或内容不变；若采用，应为实际导入保留快照版本 / 获取时间和字段来源。
- 本报告只增加调研文档，不选择独立 Agent 引擎，不引入依赖，不修改协议、产品设计或实现。未改代码，未运行 typecheck / test / build；本次验证为文档和公开源码静态交叉核查。
