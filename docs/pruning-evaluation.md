# Request Pruning Evaluation

Status: on hold at the user's request as of 2026-10-13. This document records agreed evaluation decisions, not a shipped feature. Further implementation and live execution have not resumed.

Related issue: [#5](https://github.com/gaeng2y/llm-metis/issues/5). Terms are defined in the [glossary](../GLOSSARY.md).

## Scope

Evaluate outgoing Claude Messages requests first. Request pruning remains disabled by default and leaves the client's original conversation intact. It does not replace native session compaction. Codex compaction and Claude token-counting requests retain their current behavior.

Reuse the existing OpenRouter, Vercel, and TypeSafe provider configuration. Evaluator credentials remain in the gateway.

## Agreed success criteria

- Measure whether Jev's relevance decisions improve on the duplicate baseline. Building duplicate removal alone does not answer the evaluation question.
- Reject a strategy if it makes an incorrect edit or violates a user constraint in an evaluated case. Passing a finite test set does not establish a universal safety guarantee.
- Additional reads are acceptable only when both total cost and total task completion time improve. Include evaluator overhead and repeated work in those totals; a smaller request alone is not evidence of success.

## Evaluation data

Start with two synthetic miniature repositories with explicit expected outcomes:

1. Repeated file reads followed by a narrow configuration change. Check the exact expected values and verify that unrelated keys and protected files are unchanged.
2. Repeated reads mixed with older, still-relevant evidence, followed by a small bug fix. Check the required behavior, existing behavior, and the permitted edit scope.

The initial experiment uses authored fixtures rather than personal conversation transcripts.

## Execution approach and coding model

Use a dedicated evaluation program in which the real coding model operates on the synthetic repositories through fixed read, search, and edit tools. This experiment does not establish end-to-end Claude Code CLI compatibility.

The user selected Claude Opus 5.5 instead of the proposed Sonnet model. Keep the proposed OpenRouter coding-model transport and fixed `medium` reasoning effort. Verify the exact model identifier, availability, supported effort setting, pricing, and fixed upstream provider before resuming; no live model configuration has been validated.

## Candidate scope

Include older plain-text results from known read-only file and search tools, including results that are not duplicates. This allows the experiment to measure relevance selection beyond deterministic duplicate removal.

Keep recent results, errors, and results from operations that can change state. A tool's name alone does not establish that it is read-only; eligibility must follow the experiment's known tool behavior. User instructions and constraints remain protected.

## Transformation and retention

Replace selected result text with a short omission marker. Preserve the tool call, result identifier, and ordering. The model can read the source again when necessary.

Protect results from the latest two user turns. For Jev selection, require an explicit `prune` answer and a valid selected-choice probability of at least 0.95. This gate is not a calibrated guarantee that removal is safe.

The duplicate baseline considers repeated results only when the tool, input, and output match, and retains the newest copy. Both pruning strategies use the same omission marker and protected-result rules.

## Matched comparison

Compare three strategies: no pruning, the duplicate baseline, and Jev selection. Run each strategy five times on each of the two tasks, for 30 task runs in total. Keep the coding model and reasoning effort fixed; disable existing tool and effort routing in every arm.

Retain caching, include cache reads and writes in the cost comparison, and rotate execution order across the three strategies. Cache disruption caused by pruning counts against its measured benefit.

Any incorrect edit or user-constraint violation disqualifies that strategy. Jev qualifies for further validation only if its mean total cost and mean task completion time are each at least 10% lower than both controls. Include model calls, evaluator calls, retries, and repeated work in the measurements.

These repetitions provide an exploratory result, not general evidence of safety or performance. Qualification does not enable pruning by default or establish readiness to ship.

## Provider coverage

Use OpenRouter for the live Jev evaluation. Check Vercel and TypeSafe request and response compatibility with contract tests; do not claim live behavior or equivalent performance for those providers from these tests.

## Hold and resumption

The user deferred the experiment rather than accepting the proposed US$10 and 60-minute limits. Those limits remain proposals, not an approved execution budget. No paid inference has been performed for this evaluation.

Resume only after the user requests it. Before live execution, resolve the budget and time limits, verify the selected model configuration, and confirm the complete evaluation plan. Preserve the agreed design while the experiment is on hold.

## Existing validation boundaries

Gateway tests can check synthetic request transformations and exact fallback behavior. Existing installed-client smoke checks use fixed responses; the Claude smoke disables tools. These checks do not establish task quality, reread frequency, or actual cost savings.

Current metrics do not expose cache-creation tokens separately. A cost comparison needs the relevant raw model and evaluator usage categories, including cache writes, with pricing recorded for the experiment.
