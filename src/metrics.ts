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
}
export function routeMetric(result: RouteResult, config: Config) {
  const d = result.decision;
  return {
    mode: result.mode, reason: result.reason, effortApplied: result.effortApplied,
    selectedTool: typeof d?.tool.name === 'string' ? d.tool.name.slice(0, 256) : undefined,
    toolConfidence: probability(d?.tool.confidence) ? d.tool.confidence : undefined,
    selectedEffort: d && ['low','medium','high'].includes(d.reasoning.effort) ? d.reasoning.effort : undefined,
    effortConfidence: probability(d?.reasoning.confidence) ? d.reasoning.confidence : undefined,
    appliedEffort: result.mode !== 'direct' && object(result.request.reasoning) && typeof result.request.reasoning.effort === 'string' ? result.request.reasoning.effort.slice(0, 30) : undefined,
    jevProvider: config.provider, jevModel: d?.evaluator?.model ?? config.jevModel,
    jevCalled: result.jevCalled, jevLatencyMs: result.jevLatencyMs,
    jevInputTokens: d?.evaluator?.inputTokens, jevOutputTokens: d?.evaluator?.outputTokens,
  };
}

/** Observe usage without delaying forwarding or retaining output text. */
export class UsageObserver {
  private buffer = '';
  private decoder = new TextDecoder();
  private dropping = false;
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
    // ponytail: skip oversized individual events/JSON metrics, while streaming every byte to Codex.
    if (this.buffer.length > 2_000_000) { this.buffer = this.sse ? this.buffer.slice(-3) : ''; this.dropping = true; }
  }
  finish() { this.buffer += this.decoder.decode(); if (!this.sse && !this.dropping) this.parse(this.buffer); }
  private parse(value: string) {
    let raw: unknown;
    try { raw = JSON.parse(value); } catch { return; }
    if (!object(raw)) return;
    if (['response.completed','response.failed','response.incomplete'].includes(String(raw.type))) this.outcome = String(raw.type).slice(9);
    const response = object(raw.response) ? raw.response : raw;
    if (typeof response.status === 'string' && ['completed','failed','incomplete'].includes(response.status)) this.outcome = response.status;
    if (!object(response.usage)) return;
    const u = response.usage;
    const counts: JsonObject = { inputTokens: u.input_tokens, outputTokens: u.output_tokens,
      cachedInputTokens: object(u.input_tokens_details) ? u.input_tokens_details.cached_tokens : undefined,
      reasoningTokens: object(u.output_tokens_details) ? u.output_tokens_details.reasoning_tokens : undefined };
    for (const [key, value] of Object.entries(counts)) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) (this.usage as JsonObject)[key] = value;
  }
}
