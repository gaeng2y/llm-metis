# Architecture proposal and implementation plan

Recorded before implementation, 2026-09-23. Package/command: `jev-control` / `jev-codex`; workspace: Metis.

## Evidence

- [jev-gateway](https://github.com/vinilana/jev-gateway/tree/a197836755671fc224cc3d7f91a8592d56ca665c): inspected `src/{jev,questions,decide,app,upstream}.ts`, `src/adapters/responses.ts`, `bin/clients.mjs`, provider fixtures. Jev accepts multiple typed questions in one request. Tool forcing is not universal: namespaced/hosted tools and some subscription backends need passthrough. Modern requests can declare tools in `additional_tools` input items. The reference retries original requests after rewrite rejection.
- [Astra-Ares](https://github.com/miuuyy/Astra-Ares/tree/a1dbc976103e300419cb0b4ab54150ad6a3e0b4b): inspected `src/jev.mjs` and `docs/architecture.md`. A native sampling checkpoint sends public state to Jev; Codex applies and acknowledges settings. Native `configuration_update` preserves the request effort baseline. HTTP rewriting cannot claim this property.
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference): custom provider `base_url`, `wire_api=responses`, `requires_openai_auth`, and `supports_websockets` are documented. Installed CLI reports 0.155.1; its help confirms per-invocation `-c` overrides.

## Flow and responsibility

```text
Codex HTTP/SSE request
  → gateway: bounded body, original bytes retained, auth stays in transport
  → state: bounded public text, current task, declared tools, tool history
  → DecisionEngine.decide(state, optional abort signal)
  → Jev: ONE typed evaluation for tool + effort + finite arguments
  → routing: independent confidence gates, caller constraints preserved
  → gateway: rewritten request or original bytes → upstream → streamed response
  → metrics: metadata and usage only → local dashboard
```

`DecisionEngine` is the single requested replaceable interface. HTTP transport, provider protocol, extraction, policy, metrics, CLI and dashboard remain separate modules. No lease abstraction, model-routing framework, or MCP server is introduced.

## Proposed structure

```text
bin/jev-codex.mjs
src/{config,decision,state,jev,routing,gateway,metrics,cli}.ts
src/dashboard.html
test/{routing,jev,gateway,cli}.test.mjs
docs/architecture.md
README.md
```

## Implementation order

1. Write deterministic confidence/failure/preservation tests before provider use.
2. Implement types, bounded extraction, one-call Jev adapter and routing policy.
3. Implement HTTP/SSE forwarding, cancellation, usage collection and rewrite fallback.
4. Implement local lifecycle commands, process-only Codex overrides and dashboard comparison.
5. Typecheck and run unit/integration/CLI tests against local fake providers. Inspect the dashboard.

## Policy

- Tool and effort routing have independent enable flags and confidence thresholds. Routing off makes no Jev call. Missing provider credentials and provider failure preserve the model request.
- Honor any explicit caller `tool_choice` other than `auto` (including `required`); effort may still change independently.
- Unknown/ambiguous tool definitions, hosted tools and non-default namespaces are visible as candidates but not forcibly rewritten. More than 120 tools skips tool routing instead of adding a second Jev call.
- Tool `direct` requires opt-in, `store:false`, no hidden history, a plain function, and a fully validated finite argument schema. It synthesizes a function-call response; it never executes tools. Unsafe/incomplete arguments fall back to forcing. Direct calls bypass model inference, so selected effort is recorded as unapplied.
- No decisions with `previous_response_id`, server-side `conversation`, or opaque item references. Native configuration updates also bypass effort rewriting because they can supersede request-level effort. Compressed requests are decoded for inspection, with original bytes retained for fallback.
- A rewrite rejected with HTTP 400/422 is retried once with the original body. No retry after a successful response or partial stream. Error text, prompts, tool arguments, auth headers and API keys are never recorded in metrics.
- Bind to `127.0.0.1`. A private random token protects model/control endpoints; browser navigation uses a fragment token that is not sent as part of the URL. Reject foreign Origin/Host headers. Upstream URL is fixed at startup, and redirects are not followed with credentials.

## Risks and unknowns

- Backend tool-choice support varies. A rejected rewrite also loses its effort change on the fallback request; metrics distinguish proposal from application.
- Closed-set certainty is not proof of semantic correctness. Direct is opt-in and deliberately narrow; Codex retains its normal execution/approval responsibilities.
- Bounded public context can miss relevant earlier evidence; encrypted reasoning and image/file payloads are excluded. Relevant public excerpts and tool definitions ARE sent to the configured Jev provider. Local-only describes the gateway, not Jev inference.
- One evaluator round trip per eligible generation adds latency. No claim of savings until comparable workloads finish successfully in all four modes.
- HTTP effort changes do not establish prefix preservation or Ares equivalence. Supported effort levels depend on the selected model. No model substitution is permitted.
- HTTP/SSE is the MVP transport. The launcher disables provider WebSocket support for that invocation. Compaction is forwarded without control decisions.
- Subscription authentication is passed through, not refreshed or read by the gateway. CLI reads only login mode metadata to select a default upstream. Real subscription/API acceptance still needs live testing.
- Dashboard comparisons are observational, not randomized experiments. Missing usage stays unknown. Per-request latency includes complete stream duration; wrapper task duration includes tool/user wait time. Direct inference uses zero upstream tokens and separately reports evaluator usage.
- Metrics are bounded in memory and reset on restart. No persistence/database, native patch, leases, local Laya engine, or MCP grouping in this phase.
