import { object, probability, type JsonObject } from './decision.js';
import type { RouteResult } from './routing.js';
import type { Config } from './config.js';

export type Cohort = 'baseline' | 'tool-only' | 'effort-only' | 'tool+effort';
export const cohort = (c: Pick<Config, 'toolRouting' | 'effortRouting'>): Cohort => c.toolRouting ? c.effortRouting ? 'tool+effort' : 'tool-only' : c.effortRouting ? 'effort-only' : 'baseline';
export interface TokenUsage {
  inputTokens?: number; uncachedInputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number;
  cacheWrite5mInputTokens?: number; cacheWrite1hInputTokens?: number; outputTokens?: number; reasoningTokens?: number;
}
export interface UsageRecord { usage: TokenUsage; complete: boolean; reasons: string[] }
export interface UsageAttempt extends UsageRecord { dispatched: boolean | 'unknown'; status?: number; kind?: 'original' | 'rewrite' }
export interface UsageSummary extends UsageRecord {
  attempts: number; reportedAttempts: number; completeAttempts: number; knownTotalTokens?: number;
  fieldCoverage: Partial<Record<keyof TokenUsage, { reported: number; attempts: number }>>;
}
type UsageProtocol = 'responses' | 'messages' | 'jev';
const tokenCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const usageKeys = ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'cacheWrite5mInputTokens', 'cacheWrite1hInputTokens', 'outputTokens', 'reasoningTokens'] as const;

/** Normalize reported counts only; optional breakdowns never increase an existing total. */
export function usageRecord(raw: unknown, protocol: UsageProtocol): UsageRecord {
  if (!object(raw)) return { usage: {}, complete: false, reasons: ['missing_usage'] };
  const usage: TokenUsage = {};
  const reasons = new Set<string>();
  const assign = (key: keyof TokenUsage, value: unknown) => {
    if (tokenCount(value)) usage[key] = value;
    else if (value !== undefined && value !== null) reasons.add('invalid_usage');
  };
  const inputDetails = object(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const outputDetails = object(raw.output_tokens_details) ? raw.output_tokens_details : {};
  assign('outputTokens', raw.output_tokens ?? (protocol === 'jev' ? raw.outputTokens : undefined));
  assign('reasoningTokens', outputDetails.reasoning_tokens ?? outputDetails.thinking_tokens);
  if (protocol === 'messages') {
    assign('uncachedInputTokens', raw.input_tokens);
    assign('cachedInputTokens', raw.cache_read_input_tokens);
    assign('cacheWriteInputTokens', raw.cache_creation_input_tokens);
    const creation = object(raw.cache_creation) ? raw.cache_creation : {};
    assign('cacheWrite5mInputTokens', creation.ephemeral_5m_input_tokens);
    assign('cacheWrite1hInputTokens', creation.ephemeral_1h_input_tokens);
    const parts = [usage.uncachedInputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens];
    const known = parts.filter(tokenCount);
    if (known.length) assign('inputTokens', known.reduce((sum, n) => sum + n, 0));
    if (parts.some(n => n === undefined)) reasons.add('input_breakdown_missing');
    if (usage.cacheWriteInputTokens !== undefined && usage.cacheWrite5mInputTokens !== undefined && usage.cacheWrite1hInputTokens !== undefined &&
      usage.cacheWriteInputTokens !== usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens) reasons.add('invalid_usage');
  } else {
    assign('inputTokens', raw.input_tokens ?? (protocol === 'jev' ? raw.inputTokens : undefined));
    assign('cachedInputTokens', inputDetails.cached_tokens);
    assign('cacheWriteInputTokens', inputDetails.cache_write_tokens);
    if (usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined && usage.cacheWriteInputTokens !== undefined) {
      assign('uncachedInputTokens', usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens);
    }
  }
  if (usage.inputTokens === undefined) reasons.add('input_missing');
  if (usage.outputTokens === undefined) reasons.add('output_missing');
  if ((usage.cachedInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0) > (usage.inputTokens ?? Infinity) ||
      (usage.reasoningTokens ?? 0) > (usage.outputTokens ?? Infinity)) reasons.add('invalid_usage');
  return { usage, complete: reasons.size === 0, reasons: [...reasons] };
}

export function summarizeUsage(records: UsageAttempt[]): UsageSummary {
  const attempts = records.filter(a => a.dispatched !== false);
  const usage: TokenUsage = {};
  const reasons = new Set(attempts.flatMap(a => a.reasons));
  const fieldCoverage: UsageSummary['fieldCoverage'] = {};
  for (const key of usageKeys) {
    const values = attempts.map(a => a.usage[key]).filter(tokenCount);
    fieldCoverage[key] = { reported: values.length, attempts: attempts.length };
    if (values.length) {
      const sum = values.reduce((total, n) => total + n, 0);
      if (tokenCount(sum)) usage[key] = sum; else reasons.add('invalid_usage');
    }
  }
  if (!attempts.length) { usage.inputTokens = 0; usage.outputTokens = 0; }
  const counts = [usage.inputTokens, usage.outputTokens].filter(tokenCount);
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!tokenCount(total)) reasons.add('invalid_usage');
  return { usage, complete: attempts.every(a => a.complete) && reasons.size === 0, reasons: [...reasons], fieldCoverage, attempts: attempts.length,
    reportedAttempts: attempts.filter(a => tokenCount(a.usage.inputTokens) || tokenCount(a.usage.outputTokens)).length,
    completeAttempts: attempts.filter(a => a.complete).length,
    knownTotalTokens: counts.length && tokenCount(total) ? total : undefined };
}
export interface RequestMetric extends TokenUsage {
  id: string; time: string; cohort: Cohort; model: string; taskId?: string;
  mode: string; reason: string; selectedTool?: string; toolConfidence?: number;
  selectedEffort?: string; effortConfidence?: number; appliedEffort?: string; effortApplied: boolean;
  jevProvider: string; jevModel: string; jevCalled: boolean; jevLatencyMs: number;
  jevOutcome?: RouteResult['jevOutcome']; jevFailure?: RouteResult['jevFailure']; jevCompletedAt?: string; jevSequence?: number;
  jevInputTokens?: number; jevOutputTokens?: number;
  modelLatencyMs: number; requestLatencyMs: number; status: number; outcome: string;
  kind?: 'generation' | 'compaction'; modelAttempts?: UsageAttempt[]; jevAttempt?: UsageAttempt;
}
export interface TaskMetric { id: string; cohort: Cohort; durationMs: number; exitCode: number | null }
interface TaskState { started: boolean; launchCohort?: Cohort; active: number; historyLost: boolean; lateRequest: boolean; cohorts: Set<Cohort> }
export class Metrics {
  private requests: RequestMetric[] = [];
  private tasks: TaskMetric[] = [];
  private taskStates = new Map<string, TaskState>();
  private activeRequests = 0;
  private droppedRequests = 0;
  readonly startedAt = new Date().toISOString();
  private taskState(id: string) {
    let state = this.taskStates.get(id);
    if (!state) {
      state = { started: false, active: 0, historyLost: false, lateRequest: false, cohorts: new Set() };
      this.taskStates.set(id, state);
      if (this.taskStates.size > 200) this.taskStates.delete(this.taskStates.keys().next().value!);
    }
    return state;
  }
  startTask(task: Pick<TaskMetric, 'id' | 'cohort'>) {
    if (this.taskStates.has(task.id) || this.tasks.some(t => t.id === task.id) || this.requests.some(r => r.taskId === task.id)) return false;
    const state = this.taskState(task.id);
    state.started = true; state.launchCohort = task.cohort; state.cohorts.add(task.cohort);
    return true;
  }
  beginRequest(taskId?: string) {
    this.activeRequests++;
    const state = taskId ? this.taskState(taskId) : undefined;
    if (state) { state.active++; if (this.tasks.some(t => t.id === taskId)) state.lateRequest = true; }
    let released = false;
    return () => {
      if (released) return;
      released = true; this.activeRequests--; if (state) state.active--;
    };
  }
  add(event: RequestMetric) {
    if (event.taskId) this.taskState(event.taskId).cohorts.add(event.cohort);
    // shortcut: retain 2,000 requests; longer complete experiments need an external export strategy.
    this.requests.push(event);
    if (this.requests.length > 2000) {
      const removed = this.requests.shift()!; this.droppedRequests++;
      if (removed.taskId) { const state = this.taskStates.get(removed.taskId); if (state) state.historyLost = true; }
    }
  }
  addTask(task: TaskMetric) {
    const state = this.taskState(task.id); state.cohorts.add(task.cohort);
    this.tasks = this.tasks.filter(t => t.id !== task.id);
    this.tasks.push(task); if (this.tasks.length > 200) this.tasks.shift();
  }
  snapshot() {
    const groups = new Map<string, RequestMetric[]>();
    for (const request of this.requests) if (request.taskId) {
      const group = groups.get(request.taskId) ?? []; group.push(request); groups.set(request.taskId, group);
    }
    const ids = new Set([...this.taskStates.keys(), ...this.tasks.map(t => t.id), ...groups.keys()]);
    const taskUsage = [...ids].map(id => {
      const requests = groups.get(id) ?? [];
      const state = this.taskStates.get(id);
      const task = this.tasks.find(t => t.id === id);
      const reasons: string[] = [];
      if (!state?.started) reasons.push('task_start_missing');
      if (!task) reasons.push('task_end_missing');
      if (state?.active) reasons.push('requests_active');
      if (state?.historyLost) reasons.push('history_evicted');
      if (state?.lateRequest) reasons.push('request_after_task_end');
      const modes = new Set([...state?.cohorts ?? [], ...requests.map(r => r.cohort), ...(task ? [task.cohort] : [])]);
      const mode: Cohort | 'mixed' | 'unknown' = modes.size > 1 ? 'mixed' : state?.started && !state.historyLost ? [...modes][0] ?? 'unknown' : 'unknown';
      const usage = aggregateRequests(requests, reasons);
      return { id, cohort: mode, launchCohort: state?.launchCohort ?? task?.cohort, ended: Boolean(task), durationMs: task?.durationMs,
        exitCode: task?.exitCode, activeRequests: state?.active ?? 0, requestCount: requests.length,
        complete: usage.combined.complete, reasons: usage.combined.reasons, ...usage };
    });
    return { startedAt: this.startedAt, requests: this.requests, tasks: this.tasks, taskUsage,
      usage: aggregateRequests(this.requests, [...(this.droppedRequests ? ['history_evicted'] : []), ...(this.activeRequests ? ['requests_active'] : [])]),
      unassignedRequests: this.requests.filter(r => !r.taskId).length, activeRequests: this.activeRequests, droppedRequests: this.droppedRequests };
  }
  observations() {
    const evaluation = {
      state: 'not_evaluated' as 'not_evaluated' | NonNullable<RouteResult['jevOutcome']>,
      attempts: 0, successes: 0, failures: 0, cancellations: 0,
      latest: null as null | { time: string; outcome: NonNullable<RouteResult['jevOutcome']>; failure?: RouteResult['jevFailure'] },
      failureReasons: Object.create(null) as Record<string, number>,
    };
    const requests = this.requests.filter(r => r.kind !== 'compaction');
    const routing = { toolApplied: 0, effortApplied: 0, appliedDenominator: requests.length, passthrough: 0,
      passthroughReasons: Object.create(null) as Record<string, number>, rewriteRejections: 0 };
    let latestSequence = -1;
    for (const event of requests) {
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
      startedAt: this.startedAt, windowStartedAt: requests[0]?.time ?? null,
      windowEndedAt: requests.at(-1)?.time ?? null, retainedRequests: requests.length, requestLimit: 2000,
      evaluation, routing,
    };
  }
}
function aggregateRequests(requests: RequestMetric[], gaps: string[] = []) {
  const models = requests.flatMap(r => r.modelAttempts ?? [{ dispatched: 'unknown' as const, usage: Object.fromEntries(usageKeys.filter(k => r[k] !== undefined).map(k => [k, r[k]])), complete: false, reasons: ['accounting_unavailable'] }]);
  const evaluators = requests.flatMap(r => r.jevAttempt ? [r.jevAttempt] : r.jevCalled ? [{ dispatched: 'unknown' as const,
    usage: { inputTokens: r.jevInputTokens, outputTokens: r.jevOutputTokens }, complete: false, reasons: ['accounting_unavailable'] }] : []);
  const withGaps = (summary: UsageSummary): UsageSummary => ({ ...summary,
    ...(gaps.length && !summary.attempts ? { usage: {}, knownTotalTokens: undefined } : {}),
    complete: summary.complete && !gaps.length, reasons: [...new Set([...gaps, ...summary.reasons])] });
  return { model: withGaps(summarizeUsage(models)), evaluator: withGaps(summarizeUsage(evaluators)), combined: withGaps(summarizeUsage([...models, ...evaluators])) };
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
    jevInputTokens: result.jevAttempt?.usage.inputTokens ?? d?.evaluator?.inputTokens,
    jevOutputTokens: result.jevAttempt?.usage.outputTokens ?? d?.evaluator?.outputTokens, jevAttempt: result.jevAttempt,
  };
}

/** Observe usage without delaying forwarding or retaining output text. */
export class UsageObserver {
  private buffer = '';
  private decoder = new TextDecoder();
  private dropping = false;
  private anthropicUsage: JsonObject = {};
  private anthropicStop?: string;
  private finalDelta = false;
  private terminalUsage = false;
  private finished = false;
  private record: UsageRecord = { usage: {}, complete: false, reasons: ['missing_usage'] };
  private gaps = new Set<string>();
  usage: TokenUsage = {};
  outcome = 'unknown';
  constructor(private readonly sse: boolean, private protocol: UsageProtocol = 'responses') {}
  write(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (this.sse) {
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
        const block = this.buffer.slice(0, boundary.index);
        this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
        if (block.length > 2_000_000) this.gaps.add('body_limit');
        else if (!this.dropping) this.parseEvent(block);
        this.dropping = false;
      }
    }
    // shortcut: skip oversized events/JSON metrics while forwarding every byte; expand only if real usage envelopes need it.
    if (this.buffer.length > 2_000_000) { this.buffer = this.sse ? this.buffer.slice(-3) : ''; this.dropping = true; this.gaps.add('body_limit'); }
  }
  finish() {
    this.buffer += this.decoder.decode(); this.finished = true;
    if (!this.dropping) {
      if (!this.sse) this.parse(this.buffer);
      else if (this.buffer.trim()) { this.parseEvent(this.buffer); this.gaps.add('incomplete_stream'); }
    }
    this.buffer = '';
  }
  accounting(reason?: string): UsageRecord {
    const reasons = new Set([...this.record.reasons, ...this.gaps]);
    if (reason) reasons.add(reason);
    if (this.sse && !this.terminalUsage) reasons.add('incomplete_stream');
    if (!this.sse && !this.finished) reasons.add('body_incomplete');
    return { usage: { ...this.usage }, complete: this.record.complete && !reasons.size, reasons: [...reasons] };
  }
  private parseEvent(block: string) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') this.parse(data);
  }
  private parse(value: string) {
    let raw: unknown;
    try { raw = JSON.parse(value); } catch { this.gaps.add('invalid_json'); return; }
    if (!object(raw)) { this.gaps.add('invalid_json'); return; }
    if (raw.type === 'error') this.outcome = 'failed';
    if (raw.type === 'message_stop') {
      if (this.outcome === 'unknown') this.outcome = this.anthropicStop === 'max_tokens' ? 'incomplete' : 'completed';
      this.terminalUsage = this.finalDelta && this.record.complete && this.outcome !== 'failed';
    }
    if ((raw.type === 'message' || raw.type === 'message_delta') && this.outcome !== 'failed') {
      const stop = object(raw.delta) ? raw.delta.stop_reason : raw.stop_reason;
      if (typeof stop === 'string') {
        this.anthropicStop = stop;
        if (raw.type === 'message') this.outcome = stop === 'max_tokens' ? 'incomplete' : 'completed';
      }
    }
    const terminal = ['response.completed','response.failed','response.incomplete'].includes(String(raw.type));
    if (terminal) this.outcome = String(raw.type).slice(9);
    const response = object(raw.response) ? raw.response : object(raw.message) ? raw.message : raw;
    if (typeof response.status === 'string' && ['completed','failed','incomplete'].includes(response.status)) this.outcome = response.status;
    const anthropic = ['message','message_start','message_delta'].includes(String(raw.type));
    if (anthropic) this.protocol = 'messages';
    if (object(response.usage)) {
      let reported = response.usage;
      if (this.protocol === 'messages') {
        for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'cache_creation', 'output_tokens', 'output_tokens_details']) {
          if (Object.hasOwn(reported, key)) this.anthropicUsage[key] = reported[key];
        }
        if (raw.type === 'message_delta' && this.anthropicStop && tokenCount(reported.output_tokens)) this.finalDelta = true;
        reported = this.anthropicUsage;
      }
      this.record = usageRecord(reported, this.protocol);
      Object.assign(this.usage, this.record.usage);
    }
    if (terminal) {
      // A final event with missing usage cannot certify earlier intermediate counts.
      this.record = usageRecord(response.usage, this.protocol);
      this.terminalUsage = this.record.complete;
      if (this.record.complete) this.usage = { ...this.record.usage };
    }
  }
}

/** Read bodies that would otherwise be discarded, without holding up fallback indefinitely. */
export async function observeDiscardedUsage(response: Response, signal?: AbortSignal, protocol: UsageProtocol = 'responses'): Promise<UsageRecord> {
  const observer = new UsageObserver(response.headers.get('content-type')?.includes('text/event-stream') ?? false, protocol);
  if (!response.body) { observer.finish(); return observer.accounting(); }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); } catch { return observer.accounting('transport_error'); }
  const deadline = performance.now() + 100;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let ended = false;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('body_timeout')), 100);
    onAbort = () => reject(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    let bytes = 0;
    for (;;) {
      if (performance.now() >= deadline) return observer.accounting('body_timeout');
      const next = await Promise.race([reader.read(), interrupted]);
      if (next.done) { ended = true; observer.finish(); return observer.accounting(); }
      bytes += next.value.byteLength;
      if (bytes > 64 * 1024) return observer.accounting('body_limit');
      observer.write(next.value);
    }
  } catch (error) {
    const reason = error instanceof Error && ['body_timeout', 'cancelled'].includes(error.message) ? error.message : 'transport_error';
    return observer.accounting(reason);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (!ended) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Disposing an error body must not prevent fallback. */ }
  }
}
