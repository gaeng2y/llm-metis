# MVP validation · 2026-09-23

Environment: macOS, Node 24.3.0, installed Codex CLI 0.155.1.

| Check | Result | Boundary |
|---|---|---|
| TypeScript strict build/typecheck | Passed | Compile-time checks |
| `npm test` | 37 tests passed | Local fixtures; no real evaluator/model inference |
| `npm run test:codex` | Passed | Installed Codex with temporary HOME, fake credentials, local Jev and Responses servers |
| Dashboard | Inspected in Codex browser | Four comparison rows, missing-data rendering, private fragment removed from URL, mode change reflected by server |

The Codex smoke check observed one evaluator request containing typed `tool` and `effort` questions, followed by one model request retaining `gpt-6-astra` with effort changed from `high` to `low`. Codex received and displayed the fixture SSE response. Its original TUI header still displayed `high`: this MVP changes the HTTP request, not Codex's internal turn settings. The actual request declared tools through `additional_tools`.

This check exposed a real CLI integration problem: provider `-c` overrides placed before `exec` were lost when `exec` received its own `-c` flags. The wrapper now places its overrides within the active command. The smoke check and argument-order regression protect this path. The initial failed check used only a fabricated key but attempted the default OpenAI endpoint; the committed check also pins default API/ChatGPT base URLs to the local fixture server.

Fixture coverage includes independent confidence combinations, error/timeout fail-open, tool constraints, missing tools, opaque history, namespace handling, closed-set argument checks, credential passthrough, gzip original-body replay after rejection, incremental SSE usage, stream cancellation, redirect refusal, private control endpoints, daemon lifecycle and unchanged normal Codex configuration.

Not established: real TypeSafe/OpenRouter/Vercel acceptance, real ChatGPT subscription acceptance, cost reduction, task quality, long-session compaction behavior, or native Ares cache preservation. No production credentials were used for validation. The temporary dashboard server and test daemons were stopped after checks.
