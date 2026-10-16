---
status: accepted
---

# Report task usage within explicit observation limits

For [issue #2](https://github.com/gaeng2y/llm-metis/issues/2), task accounting includes model generation, Codex session compaction (`/responses/compact`), and Jev evaluations. Reported tokens are evidence of observed usage, not a provider billing reconciliation; missing usage stays unknown. Including compaction prevents an unmeasured part of a task from disappearing from its apparent total.

Keep bounded in-memory history and aggregate the retained records, without a separate lifetime token accumulator. A task whose records have been evicted has partial accounting and is excluded from comparisons requiring complete task totals. This accepts gaps for long-running tasks in exchange for the existing bounded storage scope.

Before retrying a rejected rewrite with the original request, collect the rejected response's reported usage for at most 100 ms and 64 KiB. Apply the same bounds to discarded Jev error responses, within the existing evaluator deadline. When a limit is reached, continue the original-request fallback and mark the accounting gap. Bounded observation accepts potentially missing usage to keep an unresponsive rejection body from indefinitely delaying fallback; normal streamed responses retain incremental forwarding.

Register the task before launching the client and track in-flight requests. Complete task accounting requires observed start and end, no active requests, retained history, and complete reported input/output usage. End-only or legacy tasks remain unconfirmed rather than inheriting a false claim of completeness. Task exit status is independent of usage completeness.

Keep a task spanning routing modes as one `mixed` row. Include its known usage in overall totals and exclude it from the four-mode task comparison; allocating its duration between modes would require evidence we do not collect.

These decisions were agreed on 2026-10-16 and are implemented as described in [usage accounting](../usage-accounting.md). This decision does not resume the separate [request-pruning experiment](../pruning-evaluation.md).
