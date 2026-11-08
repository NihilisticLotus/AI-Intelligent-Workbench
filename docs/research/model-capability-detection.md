# 独立 Agent 的模型能力自动识别调研

> 日期：2026-11-08。状态：官方文档与固定源码已核查；未做真实上游调用。本文是调研及建议契约，不是已实现规格。
> 范围：AI Console 独立 Agent，使用工作台自己的 API 服务、密钥与模型。第三方 Agent 的设置、认证、模型配置均不修改、不读取。CC Switch 的实现细节另见同伴专项报告，本文独立核查能力来源与识别边界。

## 1. 结论

可以自动填入相当一部分模型能力，但不存在适用于所有 API 的统一、完整发现接口。应把“发现可选模型”“获得能力声明”“证明某次请求成功”分开保存。模型出现在列表里，不等于图片、工具、思考档位、流式用量全部可用。

建议采用“所选上游元数据 → 同服务官方规格 → 可核对身份的公开目录补全 → 人工覆盖”的来源链。每个字段独立记录证据；未给出就保持未知。公开目录只是元数据来源，不自动成为请求代理；添加某模型也不意味着把独立 Agent 的请求交给 OpenRouter、OpenCode 或其他服务。

“自动识别”不等于从名称猜能力，也不等于悄悄发付费提示词试探。发现阶段只请求有文档依据、用户已配置服务的模型元数据端点，以及允许的公共元数据目录；默认不发送推理、图片、工具或长上下文测试请求。连通性检查、模型列表读取、计费试验应在界面上明确区分。

## 2. 已证实：模型接口究竟能返回什么

以下“已证实”指检索日的官方文档声明或固定版本源码，不代表本机账号实测。文档示例中的具体 token 数不应复制成全局默认值。

| 服务 / 协议 | 已证实可获得的信息 | 不能据此推出的信息与处理方式 |
| --- | --- | --- |
| OpenAI 标准 `GET /v1/models` | 当前文档列出 `id`、`object`、`created`、`owned_by`、可选 `shutdown_date`。[官方列表接口](https://developers.openai.com/api/reference/resources/models/methods/list) | 没有通用的上下文、图片、工具或思考档位字段。不能把“兼容 OpenAI”解释为有完整发现能力。 |
| OpenAI 模型规格页 | 官方模型页另列上下文、最大输出、模态、端点与特性；例如 GPT-5 页列出上下文和最大输出，亦写明其 effort 子集。[官方模型页](https://developers.openai.com/api/docs/models/gpt-5) | 是官方直连模型的规格来源；不能仅凭自定义中转给出同名 ID 就认定继承全部规格。 |
| Anthropic Models API | 当前 `GET /v1/models`、单模型接口提供可空的 `max_input_tokens`、`max_tokens`、`capabilities`。能力树包括 `image_input`、thinking 类型、effort 档位、structured outputs、server tools 等。[官方 Models API](https://platform.claude.com/docs/en/api/models/list) | 字段为 `null` 或兼容上游未实现时保持未知。`server_tools` 不等于工作台本地工具调用能力；也不能认定所有旧 API 版本或兼容服务具有同一响应树。 |
| DeepSeek 官方 `/models` | 当前文档新增 `context_window`、`max_output_tokens`、输入 / 输出模态、`effort.supported_levels` 与默认档位，还提供 `api_capabilities` 下的协议行为；元数据字段允许缺省。[官方模型列表](https://api-docs.deepseek.com/zh-cn/api/list-models/) | 这是厂商扩展，不能当作所有 OpenAI 兼容端点的标准。其 `context_window` 明确定义为输入与输出合计；协议行为字段也不能扩展解释成一切能力已知。 |
| 智谱 OpenAI Chat / Responses / Anthropic 兼容协议 | 官方文档确认协议与端点分开，且承认兼容存在差异。[OpenAI 兼容说明](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)、[Responses 兼容说明](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction) | 本次未找到智谱官方统一模型列表能力 schema，不能声称任意智谱基址的 `/models` 必有完整字段。按已核查的具体模型文档或人工填写补全；列表失败不代表模型不支持调用。 |

Anthropic 不能再沿用“模型列表只有 ID 和名称”的旧印象：本次打开的当前文档已包含能力树，页面选择的 API 版本是 `2026-10-21`。实现必须保存所请求的 API 版本，并以实际返回、经校验的字段为准；不是要求现在将现有第三方 Agent 的 API 版本改掉。[官方接口及版本选择](https://platform.claude.com/docs/en/api/models/list)

智谱给出了模型名不能代表能力、协议与套餐也必须进入识别范围的具体例子：GLM-5.3 文档声明目前只处理文本，支持思考但不能关闭，提供 `low` / `high` / `max` 档位，并列出三种协议的不同基址。[GLM-5.3 官方规格](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3) 其深度思考文档还区分普通 API 与 Coding Plan 对输入 effort 的接受 / 映射规则；不能统一硬编码成所有服务都支持 `none`、`medium`、`xhigh`。[智谱思考参数](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)

## 3. 已证实：思考、工具、流式与用量不是一个布尔值

| 事项 | 文档证据 | 对独立 Agent 的含义 |
| --- | --- | --- |
| OpenAI 思考参数 | Chat Completions 使用顶层 `reasoning_effort`；Responses 使用 `reasoning.effort`，具体模型只支持枚举中的部分值。[Chat 请求参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[推理指南](https://developers.openai.com/api/docs/guides/reasoning) | 保存控制类型、请求字段路径、允许值、默认值与条件；不能把一个 `reasoning=true` 自动变成固定的强度菜单。 |
| Anthropic effort | Messages 的 effort 位于 `output_config.effort`，影响输出与工具参数等 token，能与 thinking 分别使用。[官方 effort 指南](https://platform.claude.com/docs/en/build-with-claude/effort) | “允许开启思考”“允许关闭思考”“强度控制”“预算 token”要拆开，不把关闭与低强度当成同义词。 |
| Anthropic 工具 | 客户端工具经 `tool_use` / `tool_result` 往返，由应用执行；服务端工具由 Anthropic 执行。[官方工具概览](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) | 模型会生成工具调用，不代表执行器已经有文件、终端、MCP 权限。有效工具能力还要与本地运行时和审批策略求交集。 |
| OpenAI Chat 流式 usage | 设置 `stream_options.include_usage` 可在结束前得到整请求用量块；中断时可能收不到最终块。[官方 Chat 流式参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) | `stream=true` 与 `streamUsage=true` 分开；缺 usage 不能记成 0，也不能再次发送模型请求来补统计。 |
| Anthropic 流式 usage | Messages 的 `message_delta.usage` token 数为累计值，协议还有命名事件及工具 JSON / 思考增量。[官方流式指南](https://platform.claude.com/docs/en/build-with-claude/streaming) | 不能把每次累计值相加。必须按协议合并，区分完整、部分与缺失统计。 |
| 智谱流式 | Chat 文档将 `usage` 放在最后 chunk；Responses 官方说明不发送 `data: [DONE]`。[Chat 流式说明](https://docs.bigmodel.cn/cn/guide/capabilities/streaming)、[Responses 差异](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction) | 同一厂商的不同协议也需要独立结束条件和 usage 解析器；不能只共用一个 Chat SSE 解析器。 |

上述只是已核查的代表性差异，不是完整兼容表。需要另存工具的 `tool_choice`、并行调用、严格 JSON schema、流式工具参数、工具结果续接等子能力，不能由 `tools=true` 一概推出。

上下文容量、单次最大输入、单次最大输出、思考预算、当前会话已占用 token、账号速率 / 额度必须分开。部分服务把推理 token 算入输出预算；OpenAI 文档明确其推理 token 占上下文并按输出计费。[官方推理与输出预算说明](https://developers.openai.com/api/docs/guides/reasoning) 因此不可用“上下文减最大输出”普遍推导一个上游未声明的最大输入，也不可把 usage 总 token 当作上下文窗口。

## 4. 已证实：公共目录与开源消费方式

### 4.1 models.dev

models.dev 自称社区维护的开源数据库，公开 `/api.json`，另有模型本体信息 `/models.json` 与合并目录 `/catalog.json`。模型本体与 provider 实际供应的规格分开；provider 可以有不同的上下文、特性和价格。[固定 README，commit `ef3c74e17d9fccab661ff412643c72fbbedd91d0`](https://github.com/anomalyco/models.dev/blob/ef3c74e17d9fccab661ff412643c72fbbedd91d0/README.md)

本次固定源码同时存在旧 schema 和 v2 schema。旧形态有 `tool_call`、`reasoning`、`reasoning_options`、`modalities`、`limit.context/input/output`；v2 进一步描述 MIME 模态、`capabilities`、推理控制、限制、`stream_usage` 及每 API 的兼容字段 / 工具细节。[旧 schema](https://github.com/anomalyco/models.dev/blob/ef3c74e17d9fccab661ff412643c72fbbedd91d0/packages/core/src/schema.ts)、[v2 schema](https://github.com/anomalyco/models.dev/blob/ef3c74e17d9fccab661ff412643c72fbbedd91d0/packages/core/src/schema-v2.ts)

建议只通过指定版本的目录适配器读取白名单字段，不能拿当前 README 的 v2 示例去直接解释任意 `/api.json` 响应。没有原始字段的旧目录，不能被转换器默认的 `false` 误写为上游明确“不支持”。`attachment` 也不能单独等同于图片输入；应优先解析输入模态及图片限制。

官方开源 SDK `@opencode-ai/models` 展示了三种消费方式：请求 provider 目录、请求模型目录、使用随包快照；可注入 fetch、超时信号并区分传输 / 状态 / 格式错误。[固定 SDK README](https://github.com/anomalyco/models.dev/blob/ef3c74e17d9fccab661ff412643c72fbbedd91d0/packages/sdk/README.md) 本项目可参考这套数据消费边界，是否新增依赖仍需单独选型、精确锁版；本次没有安装。

### 4.2 OpenRouter

OpenRouter `/api/v1/models` 文档提供 `context_length`、`architecture.input_modalities/output_modalities`、`supported_parameters`、`top_provider` 限制等。[官方模型目录接口](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) 单模型 endpoints 接口还区分 provider、`max_prompt_tokens`、`max_completion_tokens` 和端点参数。[官方端点目录接口](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model)

这些是 OpenRouter 供应路径的元数据。某模型在 OpenRouter 支持工具或某种上下文，不足以证明用户填写的其他服务也支持。精确匹配的模型本体信息可作为低优先级补充；OpenRouter 端点限制只有在用户明确选择该服务与供应路径时，才可成为相应路径的直接证据。`supported_parameters` 出现 `reasoning` 或 `tools` 也不完整定义所有允许值、字段语义和组合限制。

公共目录读取应尝试其文档允许的无凭据方式；如某端点需要 OpenRouter 凭据，而用户未配置该服务，则跳过该来源或使用审核过的快照，绝不附带用户其他上游的密钥。这里未发送任何 OpenRouter API 请求，故其当前匿名访问条件仍待单独核验。

### 4.3 OpenCode 的实际消费例子

固定 OpenCode commit `c33eaa170ed5093c08f1684862a695aae036dcda` 的 `models-dev.ts` 采用字段校验、跳过坏记录、缓存、内置快照、ETag、内容摘要及刷新；默认目录源是 `models.opencode.ai` 的实验 v2 路径，并非直接套用旧版 `/api.json`。[固定目录消费源码](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/models-dev.ts) 它还对 v1 目录做专门转换，源码说明 v1 不能表达 v2 的全部能力；转换中的缺省值属于消费者选择。[固定 v1 转换器](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/models-dev/v1.ts)

可参考缓存与容错思路，但不照搬远程目录决定 SDK 包、基址、请求体 / header 的完整逻辑。AI Console 的请求目标与凭据归属必须由本地服务配置决定，目录只能补充说明性能力。

## 5. 建议契约：来源、三态与冲突

本节为设计建议，尚未实现。

### 5.1 能力记录的身份

主键至少是“本地服务配置 ID × 原样模型 ID × 协议 × API 版本 / 能力配置修订”。服务配置应保留用户确认的基址、账号引用、区域 / 套餐及部署标识；同域名的不同路径也可能是不同服务。切换账号或鉴权范围后，模型可用性应重新获取；不将密钥本身或其可反推表示写进公开缓存。

两个服务都叫 `glm-5.3`，不合并成一份有效能力。目录 ID 映射必须经过已知 provider + 精确 ID 或明确别名映射，保存映射来源；模糊搜索只供用户选项参考，不参与能力自动赋值。`owned_by`、模型名后缀和模型自我介绍均不能证明真实底模身份。

### 5.2 逐字段证据与生效优先级

| 顺序 | 证据 / 配置 | 生效规则 |
| --- | --- | --- |
| 1 | 用户针对此服务、模型、协议保存的人工覆盖 | 生效值可置顶，但标为“手动设置”，不包装为自动验证；保留自动值及差异，提供恢复自动按钮。不能覆盖安全规则。 |
| 2 | 所选上游、所选认证范围返回的明确机器字段 | 校验 schema 与字段语义，标注“接口声明”；缺字段不会抹掉其他来源。 |
| 3 | 同一供应商、套餐、模型、协议的官方规格 / 随版本审核的规格快照 | 标注“官方文档”，保留适用条件；不将官方直连规格直接套给不明中转。 |
| 4 | 精确 provider / endpoint 的公开目录记录 | 标注“公共目录”，显示日期；只补缺项，不覆盖更强来源。 |
| 5 | 可确认身份的模型本体目录记录 | 只作规格参考，不能证明实际部署限制与参数兼容。匹配不可靠则未知。 |
| 无 | 模型名字、前缀、经验、未受控试探 | 不生成能力结论。 |

正常请求产生的观察单列为运行证据：成功返回结构化工具调用能证明该条件下有成功样本；没有调用工具、没有思考文本或没有 usage，不能反证模型不支持。泛化 400 也可能是其他参数组合问题。只有可归因的明确能力错误才影响对应能力 / 参数组合，并带有效期；401、429、网络失败归连接或配额状态，不能误写成模型“不支持”。人工覆盖与运行事实冲突时，应提示核查并保留原请求错误，不能伪造成功。

每个布尔能力均使用“支持 / 不支持 / 未知”。未出现字段、`null`、未识别版本、无法匹配模型、来源冲突都不是 `false`。数值字段用“已知值 / 未知”，不能用 0 或一个猜测的 128K 代替未知；记录单位、总容量或输入上限的语义。推理控制保存原始允许值，不向服务补造 `medium` 等选项。

每条字段证据至少包含：值、来源类型与 URL / 固定提交、原始字段路径、适用服务 / 模型 / 协议 / 套餐、获取时间、来源版本、失效时间、是否手动、冲突原因。相同范围同级来源冲突不能靠“后下载覆盖”解决；保留候选并显示冲突。不同范围先判定能否适用，不能简单取最大上下文。产品可采用较小值作为明确标注的临时本地预算，但它不是已核实的上游限制。

### 5.3 对界面的建议

- 模型选择器展示服务与模型；能力详情可查看“接口声明 / 官方文档 / 公共目录 / 手动设置 / 未知”、更新时间和冲突。公共目录匹配不应自动启用新服务。
- 思考菜单仅列当前路径已知的真实控制项；未知时显示“使用服务默认”，不发送未经证实的思考参数。强制思考模型不显示可关闭选项。
- 图片、工具等未知能力不显示为已支持；附图发送与工具模式应给出明确状态，并允许用户在模型管理界面补充覆盖。执行器不支持的能力不能仅靠勾选模型能力启用。
- 上下文未知就显示未知，自动压缩采用明确的本地安全预算或等待人工填写，不把本地策略标成模型规格。统计区将上游实报与本地估算分开。

## 6. 建议契约：缓存、刷新与失败

公共目录与带认证的服务发现缓存隔离；带认证数据还按服务配置修订 / 认证范围隔离，不和其他账号共享可用模型列表。缓存存原始可审计摘要及规范化字段，完全不存认证 header。为 schema 和解析器设置版本，格式升级时重新归一化。

使用随发布审核的离线快照保证首次启动可显示已知规格，联网更新只拉元数据；显示快照来源与日期。公共目录可每日检查一次，服务发现可在保存服务、用户点击刷新、能力失效时更新，具体 TTL 后续按接口约束确定；不要每轮对话刷新。支持 ETag / Last-Modified 时条件获取。对失败做限流与退避，保留“上次成功数据 + 已过期”状态，刷新不能静默删除用户自建模型或覆盖人工值。

单次运行固定使用启动时确认的能力配置修订，刷新影响下一次请求；不会在流式中途改变协议或模型。基址、协议、部署或账号变更应使相应路径缓存失效。别名指向可能变化，刷新只重新确认能力，不能把它当成固定快照模型。

发现失败提供“重试 / 手动添加模型 / 查看错误”；推理失败报告具体服务与错误。失败不得自动换其他服务、密钥或模型重发，尤其不能因为目录说某路径更兼容就把已有会话送过去。用户明确选择切换后才能按新路径发送；重试和是否可能重复计费要保持可追踪。

usage 按每次请求存输入、输出、推理、缓存读写等原始可得项，以及来源、完整 / 部分 / 缺失状态；同一请求累计更新而非重复相加。本地估算单列，费用估算标注价格来源日期。流中断不补写零用量，不用新请求补齐，也不由 token 用量推断账号剩余额度。

## 7. 建议契约：网络与远程元数据边界

以下是实现硬边界建议，不表示本次已完成安全测试。

1. 所有发现和推理请求由 Gateway 执行，网页只访问 `/api/v1`。密钥只在 Gateway 内按独立 Agent 所选服务引用解密；不读取任何第三方 Agent 凭据，不复用第三方软件的环境变量或登录状态。
2. 请求地址只由用户保存并确认的本地服务配置及本地协议适配器生成。公共目录中的 `api`、`base_url`、`npm`、`sdk`、`env`、headers、请求模板、安装指令一律不能改变网络目标、获取密钥、加载模块或执行程序。
3. 公共目录下载使用无认证的隔离客户端，不附带模型上游密钥、Cookie、用户文件、任务内容或来源服务的自定义 header；模型发现只使用该服务自己的凭据。不能将 A 服务的密钥拿去试 B 服务或目录 URL。
4. 公共目录来源使用本地维护的 HTTPS 允许名单，限制端口、解析后的目标 IP、内容类型、响应体及解压后体积、嵌套深度、记录条数、超时。拒绝 loopback、私网、链路本地、云元数据地址及 DNS 重绑定；这些规则覆盖 IPv4 / IPv6 和每次实际连接。
5. 用户可能主动配置本机模型服务。此类本地 / 私网例外必须绑定到用户保存的具体服务地址、端口和范围，只对该服务生效，不能被远程目录或重定向自动扩大；不对整个私网解禁。
6. 模型请求及带凭据发现请求默认不跟随重定向。公共目录如允许迁移，逐跳验证协议、域名与 IP，跨源不带认证；无需依靠 HTTP 库是否“通常会移除 Authorization”。重定向目的地不因目录内容而加入允许名单。
7. 严格校验有限数值、合法上限、枚举、字符串长度和记录主键；拒绝原型污染键。不执行目录表达式、动态 JS / 模块、shell、模板插值，不递归抓取任意 `links` / 图片 / SVG / 文档 URL。描述按不可信文本渲染，不能成为 Agent 系统指令或自动工具任务。
8. 更新在校验成功后原子替换；坏条目隔离并保留旧数据，未知 schema 不扩大解释。记录目录摘要用于变更追踪，但内容哈希本身不证明发布者可信。人工覆盖也不能绕过凭据隔离、工具权限或 URL 约束。

## 8. 待验证与后续验收清单

- 智谱各端点 / 套餐的模型列表是否存在、真实响应 schema、是否带能力字段，目前未用账号验证；不能从第三方项目支持某格式推断所有端点都如此。
- Anthropic 新旧版本、分页、可空能力树及各家兼容服务的实际响应；DeepSeek 扩展字段在不同服务版本是否齐全。均需用脱敏固定 fixture 先验证解析器，再在用户授权的具体服务做独立集成验收。
- models.dev v1 / v2 的端点稳定性、字段继承与缺省值语义；OpenRouter 公共元数据读取的匿名访问条件、限流与 schema 版本。没有这些信息仍可用审核过的快照和人工设置。
- 未检测任何真实模型的图片、工具、思考、上下文极限或 usage 行为，未推断本机任何密钥的权限、余额和套餐。默认识别流程不增加付费探测；后续若设计“验证模型”功能，要明示请求内容、目标与可能费用，并取得该项操作授权。
- 验收至少覆盖：相同模型 ID 在两个服务上的不同能力、一个服务两种协议的差异、未知字段保留、目录冲突与过期、用户覆盖不被刷新冲掉、列表失败可手动加模型、流中断 usage 未知、发现失败不改发其他服务、跨源重定向不泄露凭据、恶意目录不能安装或执行内容、私网目录 SSRF / DNS 重绑定防护。

本次仅新增本调研文档，读取项目规则并浏览上述官方文档 / 固定源码；未安装依赖、未调用模型、未修改第三方设置、未读取 Agent 凭据。没有代码改动，因此未运行 typecheck / test / build，也没有把未做的运行验证写成已通过。

## 9. 发现接入前补充核查（2026-11-08）

本节追加最新证据，不改写上述调研时点的未验证记录。用户授权继续多路调研；本轮分别复核协议字段和公共目录发布格式，再实现 phase-1 9.19。

- [OpenAI 模型列表](https://developers.openai.com/api/reference/resources/models/methods/list)未声明能力字段或分页契约，兼容服务不能仅因采用同一传输就按 DeepSeek 格式解释额外字段。
- [Anthropic Models](https://platform.claude.com/docs/en/api/models/list)、[HTTP 定义](https://platform.claude.com/docs/en/api/http/models)、[版本规则](https://platform.claude.com/docs/en/api/versioning)核实 2026-10-21 版本的最大输入 / 输出、image_input、structured_outputs、thinking 类型、effort 独立档位及 after_id / has_more。禁用思考只取 disabled.supported，工具服务器列表不证明本地工具支持；不静默修改服务版本。
- [DeepSeek 列表](https://api-docs.deepseek.com/zh-cn/api/list-models/)声明 context_window / max_output_tokens、模态及 effort 列表与默认值。[OpenRouter 模型元数据](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)的顶层 context_length / architecture 与 top_provider 含义不同，不能把聚合结果的某供应商限制当成当前账号实测。
- models.dev 固定核查提交 `c46cf594fe855f42d2ce7a53a38db7778aab4973`（2026-11-07，MIT，仍在更新）。[官方路由](https://github.com/anomalyco/models.dev/blob/c46cf594fe855f42d2ce7a53a38db7778aab4973/packages/function/src/worker.ts#L94)显示 `/catalog.json` 是 v1 聚合，真正 v2 为 `/experimental/v2.0/api.json`，只有 type 筛选，没有按 provider 缩小 JSON 的接口。v1 的首协议投影会丢失能力适用范围，不能降级用于当前配置的有效证据。
- [v2 定义](https://github.com/anomalyco/models.dev/blob/c46cf594fe855f42d2ce7a53a38db7778aab4973/packages/core/src/schema-v2.ts#L353)与[发布合并](https://github.com/anomalyco/models.dev/blob/c46cf594fe855f42d2ce7a53a38db7778aab4973/packages/core/src/generate-v2.ts#L479)：model.api 按 responses / chat-completions / messages 区分地址；工具 supported 来自顶层，API 级工具细节不是整个顶层能力的替代。modalities.input 实际包含 image/jpeg 等 MIME。精确匹配 API 地址后仍属于目录声明，不是实际能力验证。
- v2 未提供标准化 plan / apiVersion，不能把缺失当默认套餐，也不能从 SDK 名字推断。api.path 或模板无对应实现时拒绝匹配。reasoning.budget 为 min / max，但未核实单位；toggle 的“可关闭”语义未独立证实。首批不把两者写成令牌预算 / thinkingCanDisable；stream_usage 只取显式布尔，一般 streaming 留未知。
- 调研子智能体匿名实读 `?type=chat`：HTTP 200、233 个 provider、解压 9,635,409 字节；v1 另一次为 5,968,194 字节。ETag 可见，但条件 304 未验证。本实现不使用 ETag 重验证，不把这些动态大小当永久规格。
- 新 Gateway 客户端三次匿名读取固定 v2：前两次按 50 万节点限制拒绝；区分固定结构错误后，将公共来源上限调为 100 万节点（仍限制 16 MiB / 深度 24），第三次通过，并按 openai / gpt-6-sol / responses / 官方基础地址解析出窗口、输入 / 输出、MIME 图片、工具、结构化输出、思考与其原始档位。此次内容 SHA-256 为 `a2129f2c2af4ef9c3a2113cc830f83ccd8f17c0c8f96cb468809092a9d3a723d`。没有向 OpenAI 或任何用户模型服务发请求；此结果只证明公共目录下载和样本解析。
- 网络实现依据 Node 24.14 的 [HTTP](https://nodejs.org/download/release/v24.14.0/docs/api/http.html) 和 [net.BlockList](https://nodejs.org/download/release/v24.14.0/docs/api/net.html)；本机实际连接 / 压缩 / DNS / 超时测试另记验收，不以 API 文档替代运行证据。

本轮未读取第三方凭据、未改第三方设置、未新增依赖、未发真实模型消息。用户 API 的列表、套餐、真实能力、完整独立执行器及付费验证继续未验证；实现和 GUI 结果见 [step-1.3](../acceptance/step-1.3.md)。


## 2026-11-08 智谱 Responses 官方资料核对

本次只浏览公开文档，没有读取服务密钥、模型目录或生成接口。依据：

- [Responses 指南](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction)：基础地址是 open.bigmodel.cn/api/v1；端点表没有列出模型目录，但缺少条目不足以证明 /models 不支持，更不能解释此前实际结构失败。该协议默认 max，none / minimal、low / medium、xhigh 有独立映射说明，不沿用 Chat 档位。
- [创建 Response](https://docs.bigmodel.cn/api-reference/response/%E5%88%9B%E5%BB%BA-response)：明确 max_output_tokens 上限 131072，提供 tools 与 stream。这里取协议声明，不据此推断账号权限、流用量或结构化输出支持。
- [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[GLM-5.3-Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)：前者文本，后者支持图片 / 视频 / 文本 / 文件输入与文本输出；均把上下文标为 1M，没有精确整数，不把它自行换算为 1000000 或 1048576。Chat 的思考说明与 Responses 参数不能混用；暂不录入 thinkingCanDisable。

新增内置适配仅对应以上精确服务 / 模型，核对时间固定，7 天后标过期；本地预览不会重新获取资料或更新日期。实际上下文、账号可用性、目录返回结构和新导入能力下的付费生成未验证。实现与界面规则见 phase-1 9.32，实际结果见 step-1.3 最新节。
