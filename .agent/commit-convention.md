# 提交规范

## 1. 标题

```
<type>(<scope>): <一句话：动机与结果>
```

- 用中文写，不超过 72 个字符（中文按 2 个算）。说清“做了什么、得到什么”，不写“更新文件”“修改代码”这类空话。
- 一个提交同时带配套文档时，用 ` + ` 连接，例如：
  `feat(gateway): 设备令牌鉴权与 Host/Origin 校验 + plan-phase1 §2 接口规则`
- 结尾不加句号。

### type

| type | 用于 |
|---|---|
| `feat` | 新功能、新界面、新接口 |
| `fix` | 修 bug（正文里写根因；有问题单的要引用） |
| `docs` | 只改文档：设计、调研、计划、验收、开发笔记、问题收纳、本目录的规则 |
| `build` | 构建、依赖、启动脚本、工程结构 |
| `chore` | 不影响功能的杂项：整理目录、改忽略规则、清理 |
| `test` | 只加或改测试 |
| `refactor` | 不改变行为的代码重构 |

### scope

用改动所在的模块，取下表之一；跨多个模块时取最主要的那个，别的写进正文。

| scope | 范围 |
|---|---|
| `protocol` | `packages/protocol` |
| `gateway` | `packages/gateway`（需要时细化为 `auth`、`ws`、`db`、`events`） |
| `adapters` | `packages/adapters`，单个 Agent 可写 `adapter-claude`、`adapter-codex` 等 |
| `web` | `apps/web` |
| `prototype` | `docs/prototype` |
| `design` / `research` / `plan` | `docs/design`、`docs/research`、`docs/plans` |
| `devlog` / `issues` / `acceptance` | `docs/devlog`、`docs/issues`、`docs/acceptance` |
| `rules` | `.agent/` |
| `repo` | 根目录文件、目录结构、忽略规则 |
| `start` | 启动脚本 |

## 2. 正文：三段式

```text
<type>(<scope>): <一句话动机与结果>

<动机：现象 / 根因 / 为谁提供什么，1–2 句>

本提交:
- <改动点 1：动词开头，具体到机制、文件、入口>
- <改动点 2>
- <配套文档 / 脚本 / 证据的落点，例如 docs/acceptance/step-1.1.md>

验收:
- <怎么验证的：测试命令及结果、在浏览器里实际操作了什么>
- <边界：没覆盖到的情况、已知限制、后续事项（写进问题单的给出编号）>

关联: ISSUE-0003, devlog 2026-11-06
Co-Authored-By: <AI 协作者，如有>
```

- 三段都要有。纯文档提交的“验收”写“链接已检查”“与代码一致”这类核对结果即可。
- “本提交”列具体机制，不要只列文件名。例如写“WebSocket 重连时带 lastSeq，服务端补发缺失事件”，不写“改了 ws.ts”。
- “验收”写真实做过的验证；没做的写“未验证：……”，不许编造。
- “关联”一行：有对应的问题单、开发笔记、验收记录就写上，没有就省略这一行。
- 由 AI Agent 生成的提交，在最后加上 `Co-Authored-By:` 行，注明协作者。

## 3. 提交粒度

- 一个提交只做一件事；能单独回滚，回滚后仓库仍然能构建、测试能通过。
- 代码和它直接配套的文档（接口说明、验收记录）放进同一个提交；和代码无关的文档整理单独提交。
- 不提交：`node_modules/`、构建产物、`.aic-data/` 等本机数据、日志、任何密钥和令牌、个人机器上的绝对路径配置。提交前看一遍 `git status` 和 diff。
- 大段生成的内容（例如调研报告）要和人工编写的规则分开提交，方便审阅。

## 4. 分支与推送

- 远程仓库：`https://github.com/NihilisticLotus/AI-Intelligent-Workbench.git`（`origin`）。
- `main` 始终可以构建、测试通过。初次导入可以直接推送到 `main`；之后每一步在分支上开发，例如 `step/1.2-agents`、`fix/ws-replay`，完成验收后再合并到 `main`。
- 禁止强制推送 `main`；禁止跳过 hooks（`--no-verify`）；不改写已经推送的历史。
- 推送前确认：测试和类型检查通过；正文三段齐全；没有密钥。

## 5. 示例

```text
feat(gateway): 本机设备配对与令牌鉴权 + plan-phase1 §2 接口规则

浏览器里任意网页都能请求 127.0.0.1，没有鉴权时等于把执行命令的能力暴露给所有网页。

本提交:
- 启动时生成一次性配对码（2 分钟有效），浏览器配对后下发 HttpOnly Cookie 设备令牌，库里只存 SHA-256
- 所有 /api/v1 请求和 WebSocket 握手校验令牌、Host、Origin；不开 CORS
- docs/acceptance/step-1.1.md 记录验证过程

验收:
- npm test：auth 相关 9 个用例全部通过（无令牌 401、错误 Origin 403、配对码只能用一次）
- 浏览器实测：首次打开自动配对；清掉 Cookie 后提示重新配对
- 未验证：局域网访问（第 1.5 步）

关联: devlog 2026-11-06
```
