import { object, probability, type JsonObject } from './decision.js';
import type { RouteResult } from './routing.js';
import type { Config } from './config.js';

export type Cohort = 'baseline' | 'tool-only' | 'effort-only' | 'tool+effort';
export const cohort = (c: Pick<Config, 'toolRouting' | 'effortRouting'>): Cohort => c.toolRouting ? c.effortRouting ? 'tool+effort' : 'tool-only' : c.effortRouting ? 'effort-only' : 'baseline';
export interface RequestMetric {
  id: string; time: string; cohort: Cohort; model: string; taskId?: string;
  mode: string; reason: string; selectedTool?: string; toolConfidence?: number;
  selectedEffort?: string; effortConfidence?: number; appliedEffort?: string; effortApplied: boolean;
  jevProvider: string; jevModel: string; jevCalled: boolean; jevLatencyMs: number;
  jevOutcome?: RouteResult['jevOutcome']; jevFailure?: RouteResult['jevFailure']; jevCompletedAt?: string; jevSequence?: number;
  jevInputTokens?: number; jevOutputTokens?: number;
  modelLatencyMs: number; requestLatencyMs: number; status: number; outcome: string;
  inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningTokens?: number;
}
export interface TaskMetric { id: string; cohort: Cohort; durationMs: number; exitCode: number | null }
export class Metrics {
  private requests: RequestMetric[] = [];
  private tasks: TaskMetric[] = [];
  readonly startedAt = new Date().toISOString();
  add(event: RequestMetric) {
    // ponytail: retain 2,000 requests in RAM; add durable storage only for longer experiments.
    this.requests.push(event); if (this.requests.length > 2000) this.requests.shift();
  }
  addTask(task: TaskMetric) { this.tasks.push(task); if (this.tasks.length > 200) this.tasks.shift(); }
  snapshot() { return { startedAt: this.startedAt, requests: this.requests, tasks: this.tasks }; }
  observations() {
    const evaluation = {
      state: 'not_evaluated' as 'not_evaluated' | NonNullable<RouteResult['jevOutcome']>,
      attempts: 0, successes: 0, failures: 0, cancellations: 0,
      latest: null as null | { time: string; outcome: NonNullable<RouteResult['jevOutcome']>; failure?: RouteResult['jevFailure'] },
      failureReasons: Object.create(null) as Record<string, number>,
    };
    const routing = { toolApplied: 0, effortApplied: 0, appliedDenominator: this.requests.length, passthrough: 0,
      passthroughReasons: Object.create(null) as Record<string, number>, rewriteRejections: 0 };
    let latestSequence = -1;
    for (const event of this.requests) {
      if (event.jevCalled) {
        evaluation.attempts++;
        const outcome = event.jevOutcome ?? 'failed';
        const failure = event.jevFailure ?? (outcome === 'failed' ? 'unknown' : undefined);
        if (outcome === 'succeeded') evaluation.successes++;
        else if (outcome === 'cancelled') evaluation.cancellations++;
        else { evaluation.failures++; evaluation.failureReasons[failure!] = (evaluation.failureReasons[failure!] ?? 0) + 1; }
        const time = event.jevCompletedAt ?? event.time;
        // Wall-clock timestamps can tie; model responses can finish in a different order.
        if ((event.jevSequence ?? 0) >= latestSequence) {
          latestSequence = event.jevSequence ?? 0;
          evaluation.latest = { time, outcome, ...(failure ? { failure } : {}) };
        }
      }
      if (event.mode !== 'passthrough') routing.toolApplied++;
      if (event.effortApplied) routing.effortApplied++;
      if (event.mode === 'passthrough' && !event.effortApplied) {
        routing.passthrough++;
        routing.passthroughReasons[event.reason] = (routing.passthroughReasons[event.reason] ?? 0) + 1;
      }
      if (event.reason === 'upstream_rejected_rewrite') routing.rewriteRejections++;
    }
    evaluation.state = evaluation.latest?.outcome ?? 'not_evaluated';
    return {
      startedAt: this.startedAt, windowStartedAt: this.requests[0]?.time ?? null,
      windowEndedAt: this.requests.at(-1)?.time ?? null, retainedRequests: this.requests.length, requestLimit: 2000,
      evaluation, routing,
    };
  }
}
export function routeMetric(result: RouteResult, config: Config) {
  const d = result.decision;
  const effort = object(result.request.reasoning) ? result.request.reasoning.effort : object(result.request.output_config) ? result.request.output_config.effort : undefined;
  return {
    mode: result.mode, reason: result.reason, effortApplied: result.effortApplied,
    selectedTool: typeof d?.tool.name === 'string' ? d.tool.name.slice(0, 256) : undefined,
    toolConfidence: probability(d?.tool.confidence) ? d.tool.confidence : undefined,
    selectedEffort: d && ['low','medium','high'].includes(d.reasoning.effort) ? d.reasoning.effort : undefined,
    effortConfidence: probability(d?.reasoning.confidence) ? d.reasoning.confidence : undefined,
    appliedEffort: result.mode !== 'direct' && typeof effort === 'string' ? effort.slice(0, 30) : undefined,
    jevProvider: config.provider, jevModel: d?.evaluator?.model ?? config.jevModel,
    jevCalled: result.jevCalled, jevLatencyMs: result.jevLatencyMs,
    jevOutcome: result.jevOutcome, jevFailure: result.jevFailure, jevCompletedAt: result.jevCompletedAt, jevSequence: result.jevSequence,
    jevInputTokens: d?.evaluator?.inputTokens, jevOutputTokens: d?.evaluator?.outputTokens,
  };
}

/** Observe usage without delaying forwarding or retaining output text. */
export class UsageObserver {
  private buffer = '';
  private decoder = new TextDecoder();
  private dropping = false;
  private anthropicInput: JsonObject = {};
  private anthropicStop?: string;
  usage: Partial<RequestMetric> = {};
  outcome = 'unknown';
  constructor(private readonly sse: boolean) {}
  write(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (this.sse) {
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
        const block = this.buffer.slice(0, boundary.index);
        this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
        if (!this.dropping) this.parse(block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'));
        this.dropping = false;
      }
    }
    // ponytail: skip oversized individual events/JSON metrics, while streaming every byte to the client.
    if (this.buffer.length > 2_000_000) { this.buffer = this.sse ? this.buffer.slice(-3) : ''; this.dropping = true; }
  }
  finish() { this.buffer += this.decoder.decode(); if (!this.sse && !this.dropping) this.parse(this.buffer); }
  private parse(value: string) {
    let raw: unknown;
    try { raw = JSON.parse(value); } catch { return; }
    if (!object(raw)) return;
    if (raw.type === 'error') this.outcome = 'failed';
    if (raw.type === 'message_stop' && this.outcome === 'unknown') this.outcome = this.anthropicStop === 'max_tokens' ? 'incomplete' : 'completed';
    if ((raw.type === 'message' || raw.type === 'message_delta') && this.outcome !== 'failed') {
      const stop = object(raw.delta) ? raw.delta.stop_reason : raw.stop_reason;
      if (typeof stop === 'string') {
        this.anthropicStop = stop;
        if (raw.type === 'message') this.outcome = stop === 'max_tokens' ? 'incomplete' : 'completed';
      }
    }
    if (['response.completed','response.failed','response.incomplete'].includes(String(raw.type))) this.outcome = String(raw.type).slice(9);
    const response = object(raw.response) ? raw.response : object(raw.message) ? raw.message : raw;
    if (typeof response.status === 'string' && ['completed','failed','incomplete'].includes(response.status)) this.outcome = response.status;
    if (!object(response.usage)) return;
    const u = response.usage;
    const counts: JsonObject = { inputTokens: u.input_tokens, outputTokens: u.output_tokens,
      cachedInputTokens: object(u.input_tokens_details) ? u.input_tokens_details.cached_tokens : u.cache_read_input_tokens,
      reasoningTokens: object(u.output_tokens_details) ? u.output_tokens_details.reasoning_tokens : undefined };
    if (['message','message_start','message_delta'].includes(String(raw.type))) {
      for (const key of ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens']) {
        const n = u[key];
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) this.anthropicInput[key] = n;
      }
      counts.inputTokens = typeof this.anthropicInput.input_tokens === 'number' ? Object.values(this.anthropicInput).reduce<number>((sum, n) => sum + Number(n), 0) : undefined;
    }
    for (const [key, value] of Object.entries(counts)) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) (this.usage as JsonObject)[key] = value;
  }
}
