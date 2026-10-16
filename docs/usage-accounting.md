# Reported usage accounting

This implements the measurement boundary agreed for [#2](https://github.com/gaeng2y/llm-metis/issues/2) and supplies task-level exports for the [#1 experiment](https://github.com/gaeng2y/llm-metis/issues/1). Local fixture results establish accounting behavior, not live savings, provider billing, or task quality. The [ADR](adr/0001-reported-usage-accounting.md) records the scope decisions.

## What is counted

Each generation request retains its model attempts separately, including a rejected rewrite and its original-request retry. The request's legacy token fields are the sum of those attempts; do not add the request total to its attempts again. Codex `/responses/compact` is forwarded unchanged and counted as model usage. Anthropic `count_tokens` estimates and model-list requests are outside consumed-token accounting.

Jev usage is recorded independently of the validity of its decisions or HTTP success. A response with invalid answers can still report complete usage. A failed, cancelled, timed-out, or unobservable dispatch without usage is unknown, not free. A verified local rejection before dispatch, disabled evaluation, or a direct response that bypasses the model has no upstream attempt and contributes known zero for that component. Uninstrumented custom decision engines retain available legacy counts but cannot certify complete accounting.

Discarded rewrite-rejection and Jev error bodies have a 100 ms / 64 KiB observation budget. Jev remains subject to its existing deadline, and client cancellation interrupts collection. The first reached limit stops observation, records a reason, and permits the normal fallback; cleanup failure cannot block retry. Successful model responses continue streaming as they arrive. An unfinished stream retains observed counts as partial. Oversized individual events/JSON and malformed data also leave explicit gaps.

## Totals and breakdowns

| Field | Interpretation |
| --- | --- |
| `inputTokens` | Reported total input, or known input subtotal when accounting is partial |
| `uncachedInputTokens` | Anthropic ordinary input; derived for Responses only when both cache breakdowns are reported |
| `cachedInputTokens` | Cache-read portion of input |
| `cacheWriteInputTokens` | Cache-creation portion of input |
| `cacheWrite5mInputTokens`, `cacheWrite1hInputTokens` | Reported Anthropic cache-write lifetime breakdowns |
| `outputTokens` | Reported output, including reasoning where applicable |
| `reasoningTokens` | Reported reasoning/thinking portion of output |
| `knownTotalTokens` | Known input plus known output; never adds their breakdowns again |

Anthropic ordinary input, cache reads, and cache writes are disjoint categories and are added once. Cache-write lifetime breakdowns are retained without adding them to the cache-write total again. Missing/null Anthropic input categories remain unknown: the known subtotal is retained with `input_breakdown_missing`. Responses already reports total input; optional cache details are subsets. Cumulative streaming counts replace earlier values instead of accumulating every event.

Every component summary includes `complete`, `reasons`, `attempts`, `reportedAttempts`, and `completeAttempts`. `fieldCoverage` reports the number of attempts supplying each field. Complete input/output totals do not imply complete optional cache or reasoning breakdowns; the dashboard shows their individual coverage. Unknown counts appear as `—`; a numeric partial subtotal is always labelled partial/unknown. No pricing or dollar estimate is inferred from tokens.

## Task coverage and retention

A task is one wrapper invocation, joined by `taskId`. Updated wrappers register a start before spawning the client when the gateway advertises `accountingVersion: 1`. Registration failure or an older gateway does not block the client, but cannot establish complete task coverage. The end report records process duration and exit status, not output quality.

The authenticated `/control/metrics` snapshot retains `requests` and completed `tasks`, and adds:

- `taskUsage`: per-task model, evaluator, and combined summaries, lifecycle state, observed mode, and coverage reasons.
- `usage`: model, evaluator, and combined summaries of retained requests across all tasks.
- `unassignedRequests`, `activeRequests`, `droppedRequests`: gaps that must not disappear from interpretation of the totals.

A task is complete only when its start and end are known, all its requests have finished, its history was retained, and every dispatched call reports complete input/output usage. `exitCode: 0` does not imply complete accounting; a failed task can have complete usage. Missing end reports are labelled **End unconfirmed**, since the wrapper might have ended without reporting. Requests without a task ID stay in overall usage and are not assigned a synthetic task.

History is limited to 2,000 metered requests and bounded records for 200 task starts/lifecycles and 200 completions. Evicted request history marks affected tasks partial. Evicted lifecycle evidence cannot be recreated from an end report or a later request. A fresh task can still be complete after unrelated older records were evicted. Restarting clears all observations; data is not combined across gateway instances. There is no independent lifetime token accumulator or durable store.

Tasks whose observed modes differ, including from the launch mode, are labelled `mixed`. They retain one task total and stay in overall usage, but are excluded from the four-mode task comparison. Unconfirmed modes are labelled `unknown`. Partial, failed, and cancelled run overhead remains visible; only fully accounted runs are eligible for comparisons requiring complete totals.

## Export and interpretation

Use **Download metrics JSON** in the authenticated dashboard after each experiment session. It downloads the current `/control/metrics` snapshot with separate model/evaluator/combined totals, per-attempt records, and completeness evidence. Export before restarting or losing records to retention. An export taken after eviction cannot recover the missing counts.

Keep the experiment manifest, acceptance results, and output review separately, as specified in #1. Link sanitized run-level exports and that report from #1 before making net-savings claims. This implementation has not run that live experiment or produced a savings report. Provider reconciliation is still required when APIs omit usage or when making billing claims. Prompt text, tool arguments, credentials, and provider error bodies are not retained in these exports.

Protocol references: [Responses compaction](https://developers.openai.com/api/reference/resources/responses/methods/compact), [Responses usage](https://developers.openai.com/api/reference/resources/responses/methods/create), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Anthropic cache usage](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), and [token-count estimates](https://platform.claude.com/docs/en/build-with-claude/token-counting).
