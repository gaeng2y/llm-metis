# Jev 1.14 validation · 2026-10-31

OpenRouter accepted both pinned versions and all 60 final-run evaluations met the authored routing expectations. This supports an opt-in trial of `typesafe/jev-1.14`; it does not yet justify changing the default in [issue #9](https://github.com/gaeng2y/llm-metis/issues/9). The sample does not establish task completion quality, confidence calibration, or total task cost.

## Method and evidence

Environment: macOS arm64, Node 24.18.1, baseline `71bcb1fb5aa090074742a54afb16093daab5f4c1` with the cancellation fix and comparison files in this change. Final run: 2026-10-31 00:51:07–00:51:43 KST (2026-10-30 15:51:07–15:51:43 UTC).

The [manual comparison](../test/jev-compare.mjs) uses the production `control()` and `JevDecisionEngine` paths with a fresh engine per request, a 2,000ms timeout, 0.85 tool/effort confidence thresholds, and the existing 80,000-byte budget. This avoids runtime toggle issue #6. Only synthetic state is sent; no user history, upstream model generation, or actual tool execution is involved. Direct calls are enabled only for the finite-argument cases.

Five scenarios in English and Korean give 10 fixed cases. Each version receives each case three times, sequentially, alternating which version goes first between repeats: 30 requests per version. Both versions receive the same state and questions. The fixture suite separately checks timeout, malformed answers, cancellation, and missing usage; these failures were not induced against the paid service.

| Scenario, in both languages | Authored expectation |
|---|---|
| Translate a sentence | No tool; low effort |
| Read an explicitly named file | Force `read_file`, without search or editing |
| Analyze duplicate charges across crashes and late retries | No tool; retain high effort |
| Project and symptoms are unknown; ask for clarification | No forced tool; `no_tool` or `passthrough` is acceptable |
| Set a finite display mode | Direct `set_mode({mode:"full"})` decision; no tool execution |

The [recorded evidence](jev-1.14-openrouter-2026-10-31.jsonl) is JSON Lines: the first line contains run metadata, cases, settings and summaries; the next 60 lines contain the evaluations in dispatch order. Records retain requested/returned models, raw successful answers and usage, separate confidence/selected probability, provider-reported cost, applied routes, and latency. They contain no credentials. Non-2xx raw bodies are deliberately not captured; their normalized usage and failure category remain available.

## Final-run results

| Measurement | Jev 1.13 | Jev 1.14 |
|---|---:|---:|
| Successful API responses | 30/30 | 30/30 |
| Applied routing expectation met | 30/30 | 30/30 |
| Unsafe applied decisions | 0 | 0 |
| Errors / timeouts | 0 / 0 | 0 / 0 |
| Raw tool decisions matching the authored expectations | 30/30 | 30/30 |
| Raw effort decisions matching explicitly scored expectations | 12/12 | 12/12 |
| Latency p50 | 579.43ms | 578.70ms |
| Latency p95 | 895.05ms | 644.33ms |
| Reported input tokens | 32,472 | 32,472 |
| Reported output tokens | 3,042 | 3,042 |
| Input/output accounting coverage | 30/30 | 30/30 |
| Cache breakdown reported | 0/30; unknown | 0/30; unknown |
| Provider-reported evaluator cost, USD | $0.001363824 | $0.001363824 |
| Applied effort changes | 18/30 | 13/30 |

Returned model names were `typesafe/jev-1.13-20260917` and `typesafe/jev-1.14-20261014`, distinct from the requested version IDs. Every successful choice supplied both `confidence` and `probabilities`; the probability fallback was not used. Both versions returned the snake_case input/output usage fields accepted by Metis. Missing cache fields remain unknown, not zero.

The p95 values use nearest-rank percentiles over 30 calls each. This short run from one machine, with repeated prompts and nonrandom case order, does not establish a general latency improvement or multilingual quality gain. A routing pass can include safely retaining caller settings; it is not a completed-task correctness score. All uncertainty cases chose `no_tool`, so live tool-level `passthrough` was not observed.

Final-run provider-reported evaluator cost totals **$0.002727648**. An earlier 60-call run used a duplicate JSON read for instrumentation; it is excluded from the latency table. Its reported cost was also $0.002727648, giving **$0.005455296 across the 120 actual calls**. These are response-reported evaluator costs, not invoice reconciliation or total task costs.

## Confidence observation and remaining gates

In five of six final-run clarification cases, 1.14 chose low effort with confidence 0.79–0.83 but selected probability 0.86–0.89. The existing 0.85 confidence gate correctly retained the caller's high effort. Version 1.13 lowered effort in all six cases; 1.14 did so in one. This difference could affect downstream token use, but no upstream model was run to measure its consequences. The threshold remains unchanged.

This also demonstrates why confidence and selected probability must be recorded separately. TypeSafe documents choice confidence as `(p_max - 1/n) / (1 - 1/n)`. The existing fallback in `parseChoiceAnswer()` uses selected probability when confidence is absent; this run did not exercise that fallback and does not validate treating the two values as equivalent. See [TypeSafe confidence](https://docs.typesafe.ai/confidence).

Before changing defaults, remaining evidence includes harder and near-threshold cases, end-to-end task correctness and unnecessary tool calls, total model-plus-evaluator usage/cost, and live TypeSafe/Vercel compatibility. Vercel's unversioned alias remains unresolved. The available [TypeSafe model documentation](https://docs.typesafe.ai/models), [OpenRouter 1.14 catalog](https://openrouter.ai/typesafe/jev-1.14), and [Vercel 1.14 catalog](https://vercel.com/ai-gateway/models/jev-1.14.0) document provider-specific IDs; they do not substitute for authenticated compatibility tests on the other providers.

## Reproduction and regression checks

Store an OpenRouter key locally with `node bin/metis-codex.mjs configure --provider openrouter`, then run:

```sh
npm run build
node test/jev-compare.mjs --live --repeats 3 --output /absolute/path/to/new-results.json
```

This explicitly makes up to 60 paid evaluator requests. `--repeats 1` limits it to 20. Without `--live`, the script makes no request. It refuses to overwrite an existing output file and stops after authentication failure. Ordinary `npm test` uses only fake providers and credentials, including the comparison's fixture tests.

Local validation passed TypeScript checking, all 122 fixture tests, and the installed Codex and Claude smoke checks with temporary configuration and fake local providers. An existing test initially failed on Node 24.18.1: a buffered body could win `Promise.race` against an already-aborted signal. Giving the interruption promise priority fixes that race; the strengthened regression asserts that cancelled usage stays incomplete and empty. The only production code change is this one-line cancellation fix.

The first remote CI run also exposed an existing Windows-specific fixture expectation: self-sending `SIGTERM` exits with code 1 on Windows, whereas POSIX reports a signal and null code. The lifecycle test now checks the platform's actual termination result while still requiring task accounting before exit; client runtime behavior is unchanged.

No provider defaults, confidence thresholds, timeout, request budget, or user configuration were changed by the implementation. To opt in separately, select OpenRouter with `METIS_MODEL=typesafe/jev-1.14`; rollback is `METIS_MODEL=typesafe/jev-1.13`. Restart the gateway after either change. Issue #9 stays open until its remaining gates are met.
