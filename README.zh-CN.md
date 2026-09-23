# Jev Control

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

这是一个**实验性本地网关，通过一次 Jev 请求为 Codex 选择工具和推理强度（reasoning effort）**。包名为 `jev-control`，命令为 `jev-codex`。网关保留在 Codex 中选择的模型，不会替换模型。

```text
Codex → HTTP gateway → DecisionEngine → Jev (tool + effort)
                    → 独立的置信度检查 → 现有 upstream → HTTP/SSE
                    → 元数据与用量 → 本地仪表盘
```

需要 Node.js 22.15 或更高版本，以及已安装的 Codex CLI。没有外部运行时依赖。最初的设计、参考提交、实现顺序和风险见[架构提案](docs/architecture.md)；已完成的检查及其局限见[验证记录](docs/validation.md)。这两份文档以英文提供。

## 快速开始

```sh
npm install
npm run build
cp .env.example .env
chmod 600 .env
# 在 .env 中设置 Jev 服务商及其 API 密钥。
npm run codex
```

这些命令会在后台启动网关并运行 Codex。启动器读取当前工作目录中的 `.env`。如果缺少凭据或 Jev 调用失败，网关会转发原始模型请求。未配置密钥时，仪表盘会显示 `Credentials: missing` 和 `jev_credentials_missing`。

如需通过 PATH 使用该命令，请在此项目目录运行 `npm link`。无需全局注册，也可以用 `node bin/jev-codex.mjs …` 执行下面的所有命令。

```sh
jev-codex --start
jev-codex --status
jev-codex --dashboard
jev-codex --routing off
jev-codex --tool-routing on
jev-codex --effort-routing off
jev-codex --stop

# 将 Codex 选项和命令放在 -- 后面。
jev-codex -- --model gpt-6-astra
jev-codex -- exec --model gpt-6-astra '在此描述你的任务'
```

路由命令和仪表盘中的修改会立即应用于网关后续处理的请求。重启后恢复环境变量中的设置。修改环境变量、凭据或 upstream URL 后，请依次运行 `--stop` 和 `--start`。使用同一状态目录的终端共享一个网关。如需独立实验，请为 `JEV_STATE_DIR` 和 `JEV_PORT` 分别设置不同的值。

## 认证与配置

CLI 仅将 `-c model_provider=…` 和服务商配置传给它启动的 Codex 进程，不会修改 `~/.codex/config.toml` 或登录文件。模型认证和凭据刷新由 Codex 负责；网关将 `Authorization` 和 `ChatGPT-Account-Id` 转发至 upstream。Jev 凭据仅用于单独的评估请求。

如果可读取的 Codex `auth.json` 表明使用 ChatGPT 登录，默认 upstream 为 `https://chatgpt.com/backend-api/codex`；否则为 `https://api.openai.com/v1`。**如果登录凭据仅存储在钥匙串中，或使用自定义服务商，请显式设置 `UPSTREAM_BASE_URL`。** 正在运行的网关不会自动跟随登录方式的变化。

启动器仅为本次运行设置 `supports_websockets=false`，以使用 HTTP/SSE。不支持的 WebSocket 连接会被拒绝。此 CLI 不会自动连接 Codex 桌面应用中已有的任务。

| 环境变量 | 默认值 / 说明 |
|---|---|
| `JEV_PROVIDER` | 按 typesafe → openrouter → vercel 的顺序选择第一个已配置密钥的服务商；均未配置时使用 typesafe |
| `TYPESAFE_API_KEY` | TypeSafe 凭据；默认模型为 `jev-latest` |
| `OPENROUTER_API_KEY` | OpenRouter 凭据；默认模型为 `typesafe/jev-1.13` |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway 凭据；默认模型为 `typesafe-ai/jev` |
| `JEV_MODEL`, `JEV_URL` | 显式覆盖服务商模型和评估端点 |
| `JEV_TOOL_MIN_CONFIDENCE` | `0.85` |
| `JEV_EFFORT_MIN_CONFIDENCE` | `0.85` |
| `JEV_TIMEOUT_MS` | `2000`；整个决策过程的等待时限，不重试 |
| `JEV_ROUTING` | `on`；启动时同时启用或禁用两种路由决策 |
| `JEV_TOOL_ROUTING`, `JEV_EFFORT_ROUTING` | 均默认为 `on` |
| `JEV_DIRECT_CALLS` | `off`；需显式启用受限的函数调用合成 |
| `JEV_PORT` | `8791`；始终仅绑定 `127.0.0.1` |
| `UPSTREAM_BASE_URL` | 按上述登录方式选择；URL 中不允许包含凭据和查询参数 |
| `JEV_STATE_DIR` | `~/.local/state/jev-control`；包含本地令牌的 instance 文件权限为 0600 |
| `JEV_CODEX_BIN` | `codex`；可覆盖为其他 Codex 可执行文件路径 |

## 决策规则

- 工具和 effort 的阈值相互独立。如果只有一项决策达到置信度要求，就只修改该部分。如果两项都不确定，则按原始字节转发请求。
- 保留调用方指定的 `tool_choice=none`、`required`、特定工具或 allowed-tools 设置。effort 仍可独立评估。
- `forced` 为支持的 function/custom 工具设置 `tool_choice`。`none` 禁止下一次响应使用工具。`passthrough` 保持工具设置不变。
- `direct` 需要显式启用，并要求 `store:false`。它验证取值来自有限集合的函数参数，然后合成 Responses 函数调用。**网关本身不执行工具。** 如果参数包含自由文本或不支持的 JSON Schema 约束，则由主模型生成参数。支持 JSON 和 SSE 响应，此路径不应用 effort。
- 工具提取支持 `additional_tools` 和 namespace。hosted 工具以及默认 `functions` namespace 之外的工具会作为候选项考虑，但不会强制指定。工具超过120个时，跳过工具路由，不增加第二次 Jev 调用。
- 如果请求通过 `previous_response_id`、`conversation` 或 opaque item reference 引用了不可见的服务器端历史，则不进行评估，直接转发。存在 `configuration_update` 时跳过 effort 改写。`/responses/compact` 也原样转发。
- Jev 报错、超时或返回无效答案时，回退到原始请求。如果 upstream 以 HTTP 400/422 拒绝改写后的请求，网关会用原始请求重试一次。成功的响应或已经开始的流不会重试。

## 数据与测量

Jev 会收到最近的公开对话上下文、公开摘要、长度受限的工具结果摘录，以及可用工具定义。图片和加密的 reasoning 项会被排除。**网关在本地运行，但决策推理由所选的外部服务商执行。**

不会记录提示词、参数、认证头或 API 密钥。仪表盘在内存中保留请求发生时的实验模式、建议和已应用的工具/effort 决策、置信度、Jev 服务商/模型/延迟/用量、upstream 的 token/缓存/推理用量、模型和总请求延迟，以及结果状态。不保留原始提示词或服务商错误正文。

- 最多保留最近2,000个请求和200个包装器会话。重启会清空数据。
- 模型延迟从发送 upstream 请求开始，到流结束为止。如果重试了原始请求，则包含两次尝试的时间。
- 缺失的用量显示为 `—`，而不是零。`*` 表示只有部分请求报告了用量。
- direct 调用的 upstream token 用量为零，Jev 用量单独记录。由于尚未核实服务商价格，不计算美元成本。
- 任务耗时是 `jev-codex` 启动的 Codex 进程的完整运行时间。交互式会话还包括等待用户的时间。比较任务时，请用 `jev-codex -- exec …` 每次只运行一个任务。在会话中途切换模式会降低任务级比较的可靠性。
- 仪表盘令牌通过 URL fragment 传递，随后从地址中移除。控制 API 和模型代理都需要单独的本地令牌。外部 Origin/Host 请求头会被拒绝。

比较四种模式时，请使用相同的模型、初始 effort、仓库起始状态和任务，同时检查每次运行的结果质量。

| 模式 | Tool | Effort |
|---|---|---|
| baseline | off | off |
| tool-only | on | off |
| effort-only | off | on |
| tool+effort | on | on |

baseline 仍然经过网关，只是禁用了两种决策。它保留请求中的 effort，不会自动设为 HIGH。如需以 HIGH 为基准，请向 Codex 传入 `-c model_reasoning_effort=high`。另外直接运行一次 Codex，有助于单独测量代理本身的开销。

## 验证与范围

```sh
npm run typecheck
npm test
# 可选：使用临时 HOME、假密钥和本地服务商检查已安装的 Codex CLI。
npm run test:codex
```

测试使用 Node 内置测试运行器和本地模拟服务商/upstream。无需真实凭据或付费推理，即可检查置信度组合、错误和超时回退、没有可用工具、调用方设置保留、认证转发、压缩原始请求重放、SSE、各服务商的类型化问题请求、CLI 生命周期，以及正常配置未被修改。测试环境必须允许监听回环地址。

真实 Jev 响应、ChatGPT 订阅后端是否接受请求、token 节省和长会话缓存效率，都需要另行进行真实服务验证。HTTP effort 改写并不等同于 [Astra-Ares](https://github.com/miuuyy/Astra-Ares) 的原生检查点和 prefix 保留机制。尚未实现 lease、Codex 补丁、Laya 引擎、模型路由、工具类别路由或 MCP 分组。未来可以替换 `DecisionEngine` 的实现。

参考：[jev-gateway](https://github.com/vinilana/jev-gateway)、[Astra-Ares](https://github.com/miuuyy/Astra-Ares) 和 [Codex 服务商配置](https://learn.chatgpt.com/docs/config-file/config-reference)。这是独立实现，没有将参考仓库作为依赖，也没有整体复制其代码库。
