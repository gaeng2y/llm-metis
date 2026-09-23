# Jev Control

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

An **experimental local gateway that selects tools and reasoning effort for Codex with a single Jev request**. The package is `jev-control`, and the command is `jev-codex`. The gateway preserves the model selected in Codex.

```text
Codex → HTTP gateway → DecisionEngine → Jev (tool + effort)
                    → Independent confidence gates → Existing upstream → HTTP/SSE
                    → Metadata and usage → Local dashboard
```

Requires Node.js 22.15 or later and an installed Codex CLI. There are no external runtime dependencies. See the [architecture proposal](docs/architecture.md) for the original design, reference commits, implementation order, and risks, and the [validation record](docs/validation.md) for completed checks and their limits.

## Getting started

```sh
npm install
npm run build
cp .env.example .env
chmod 600 .env
# Set your Jev provider and its API key in .env.
npm run codex
```

These commands start the gateway in the background and launch Codex. The launcher reads `.env` from the current working directory. If credentials are missing or Jev fails, the gateway forwards the original model request. The dashboard shows `Credentials: missing` and `jev_credentials_missing` when no key is configured.

To make the command available on your PATH, run `npm link` from this checkout. Without registering it globally, you can run every command below as `node bin/jev-codex.mjs …`.

```sh
jev-codex --start
jev-codex --status
jev-codex --dashboard
jev-codex --routing off
jev-codex --tool-routing on
jev-codex --effort-routing off
jev-codex --stop

# Pass Codex options and commands after --.
jev-codex -- --model gpt-6-astra
jev-codex -- exec --model gpt-6-astra 'Describe your task here'
```

Routing commands and dashboard changes apply immediately to subsequent requests handled by the running gateway. Restarting restores the environment settings. Run `--stop` followed by `--start` after changing environment variables, credentials, or the upstream URL. Terminals using the same state directory share one gateway. Set different values for both `JEV_STATE_DIR` and `JEV_PORT` to run independent experiments.

## Authentication and configuration

The CLI passes `-c model_provider=…` and provider settings only to the Codex process it launches. It does not modify `~/.codex/config.toml` or login files. Codex owns model authentication and credential refresh; the gateway forwards `Authorization` and `ChatGPT-Account-Id` to the upstream. Jev credentials are used only for separate evaluator requests.

If the readable Codex `auth.json` identifies a ChatGPT login, the default upstream is `https://chatgpt.com/backend-api/codex`. Otherwise, it is `https://api.openai.com/v1`. **Set `UPSTREAM_BASE_URL` explicitly for keychain-only logins or custom providers.** A running gateway does not automatically follow changes to the login method.

The launcher sets `supports_websockets=false` for that invocation to use HTTP/SSE. Unsupported WebSocket connections are rejected. This CLI does not automatically connect existing tasks in the Codex desktop app.

| Environment variable | Default / description |
|---|---|
| `JEV_PROVIDER` | First provider with a configured key, in typesafe → openrouter → vercel order; typesafe if none is configured |
| `TYPESAFE_API_KEY` | TypeSafe credentials; default model `jev-latest` |
| `OPENROUTER_API_KEY` | OpenRouter credentials; default model `typesafe/jev-1.13` |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway credentials; default model `typesafe-ai/jev` |
| `JEV_MODEL`, `JEV_URL` | Explicit overrides for the provider model and evaluation endpoint |
| `JEV_TOOL_MIN_CONFIDENCE` | `0.85` |
| `JEV_EFFORT_MIN_CONFIDENCE` | `0.85` |
| `JEV_TIMEOUT_MS` | `2000`; deadline for the entire decision, with no retries |
| `JEV_ROUTING` | `on`; enables or disables both routing decisions at startup |
| `JEV_TOOL_ROUTING`, `JEV_EFFORT_ROUTING` | Both default to `on` |
| `JEV_DIRECT_CALLS` | `off`; opt in to restricted function-call synthesis |
| `JEV_PORT` | `8791`; always binds only to `127.0.0.1` |
| `UPSTREAM_BASE_URL` | Selected from the login method as described above; credentials and query parameters are not allowed in the URL |
| `JEV_STATE_DIR` | `~/.local/state/jev-control`; the instance file containing the local token uses mode 0600 |
| `JEV_CODEX_BIN` | `codex`; override with a different Codex executable path |

## Decision policy

- Tool and effort thresholds are independent. If only one decision is confident, only that part changes. If neither is confident, the original bytes are forwarded unchanged.
- Caller settings such as `tool_choice=none`, `required`, a specific tool, or allowed-tools are preserved. Effort can still be evaluated independently.
- `forced` sets `tool_choice` for a supported function/custom tool. `none` disables tool use for the next response. `passthrough` leaves the tool setting unchanged.
- `direct` requires explicit opt-in and `store:false`. It validates function arguments from finite sets and synthesizes a Responses function call. **The gateway never executes tools.** Free-text arguments or unsupported JSON Schema constraints leave argument generation to the main model. Both JSON and SSE responses are supported. Effort is not applied on this path.
- Tool extraction supports `additional_tools` and namespaces. Hosted tools and tools outside the default `functions` namespace are considered as candidates but are not forced. More than 120 tools skips tool routing without adding a second Jev call.
- Requests with hidden server history through `previous_response_id`, `conversation`, or opaque item references are forwarded without evaluation. A `configuration_update` skips effort rewriting. `/responses/compact` is also forwarded unchanged.
- Jev errors, timeouts, or invalid answers fall back to the original request. If the upstream rejects a rewrite with HTTP 400/422, the gateway retries once with the original request. Successful responses and streams that have already started are never retried.

## Data and measurement

Jev receives recent public conversation context, public summaries, bounded excerpts of tool results, and available tool definitions. Images and encrypted reasoning items are excluded. **The gateway runs locally, but decision inference runs at the selected external provider.**

Prompts, arguments, authentication headers, and API keys are not logged. The dashboard retains request-time experiment modes, proposed and applied tool/effort decisions, confidence, Jev provider/model/latency/usage, upstream token/cache/reasoning usage, model and total latency, and outcome status in memory. Raw prompts and provider error bodies are not retained.

- Retention is limited to the latest 2,000 requests and 200 wrapper sessions. Restarting clears the data.
- Model latency runs from the upstream request until the stream ends. If the original request is retried, it includes both attempts.
- Missing usage appears as `—`, not zero. `*` indicates that only some requests reported usage.
- Direct calls use zero upstream tokens; Jev usage is recorded separately. Dollar costs are not calculated because provider pricing has not been verified.
- Task duration is the total lifetime of the Codex process launched by `jev-codex`. It includes user wait time in interactive sessions. For task comparisons, run one task per invocation with `jev-codex -- exec …`. Changing modes during a session makes its task-level comparison unreliable.
- The dashboard token is passed in a URL fragment, then removed from the address. Both the control API and model proxy require a separate local token. Foreign Origin/Host headers are rejected.

To compare the four modes, use the same model, initial effort, repository starting state, and task. Check the quality of each result as well.

| Mode | Tool | Effort |
|---|---|---|
| baseline | off | off |
| tool-only | on | off |
| effort-only | off | on |
| tool+effort | on | on |

Baseline still passes through the gateway with both decisions disabled. It preserves the requested effort rather than automatically setting HIGH. For a HIGH baseline, pass `-c model_reasoning_effort=high` to Codex. A separate direct Codex run can help isolate the proxy's own overhead.

## Validation and scope

```sh
npm run typecheck
npm test
# Optional: check the installed Codex CLI with a temporary HOME, fake keys, and local providers.
npm run test:codex
```

Tests use Node's built-in test runner and local fake providers/upstreams. Without real credentials or paid inference, they cover confidence combinations, timeout/error fallback, missing tools, caller-setting preservation, authentication passthrough, compressed original-body replay, SSE, provider-specific typed requests, CLI lifecycle, and unchanged normal configuration. The environment must permit loopback listeners.

Real Jev responses, ChatGPT subscription backend acceptance, token savings, and long-session cache efficiency require separate live validation. HTTP effort rewriting is not equivalent to [Astra-Ares](https://github.com/miuuyy/Astra-Ares)'s native checkpoint and prefix preservation. Leases, Codex patches, a Laya engine, model routing, tool-family routing, and MCP grouping are not implemented. The `DecisionEngine` implementation can be replaced later.

References: [jev-gateway](https://github.com/vinilana/jev-gateway), [Astra-Ares](https://github.com/miuuyy/Astra-Ares), and [Codex provider configuration](https://learn.chatgpt.com/docs/config-file/config-reference). This is an independent implementation; the reference repositories are not dependencies, and their codebases were not copied wholesale.
