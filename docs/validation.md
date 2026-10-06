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

## Provider support validation · 2026-10-06

`npm run typecheck`, all 40 tests in `npm test`, and `npm run test:codex` passed. The Codex smoke check used the default OpenRouter selection with temporary state, fake credentials and local servers, and observed one Jev decision followed by a completed response with effort changed from high to low.

Provider fixtures cover OpenRouter, Vercel AI Gateway and TypeSafe: endpoints, default models, authentication, provider-specific request fields, and a single evaluation request. Configuration checks cover the OpenRouter default, all three keys configured together, explicit selection of each provider's own key, missing keys without fallback, and the parsed example environment. The CLI check verifies that all three evaluator keys are removed from the launched Codex process environment.

The setup example defaults to OpenRouter. Provider selection follows [Astra-Ares's configuration](https://github.com/miuuyy/Astra-Ares/blob/main/docs/configuration.md): select OpenRouter, Vercel or TypeSafe explicitly, with no automatic switching based on available keys or failures. English, Korean, Japanese and Simplified Chinese guides contain equivalent provider settings. API contracts were checked against the official provider documentation linked in the README. No live evaluator calls were made; real provider acceptance and routing quality remain unverified by these checks.

## Platform validation · 2026-10-06

On macOS arm64 (Apple Silicon), Node 24.3.0 passed `npm run typecheck`, all 48 tests in `npm test`, and `npm run test:codex`. The lifecycle test launches a non-executable JavaScript fixture in a path containing spaces and preserves Korean text, quotes and shell metacharacters in its arguments. The installed Codex smoke check uses temporary state and local fake providers; no paid model request is made.

Platform unit tests cover Windows native executables and standard global/local npm shims, JavaScript entry points, OS-specific browser commands, and private-file creation. Windows permissions are applied to an empty file before the token is written, using the current user's SID; simulated permission failures remove the empty file. The native Windows lifecycle test additionally checks the resulting DACL and case-insensitive evaluator-key removal.

[CI](../.github/workflows/ci.yml) is configured for Ubuntu 24.04 x64, macOS 15 arm64 and Windows Server 2022 x64, with Node 22.15.0 and 24. It runs dependency installation, type checking and the fixture suite on pushes and pull requests. At the time of local validation, CI results were pending. Actual Linux/Windows execution, Windows npm installation integration, and desktop browser/terminal interaction remain unverified by these local checks. The optional installed-Codex smoke test is separate from CI's fake-Codex lifecycle test.
