import { object, probability, validArguments, type ControlDecision, type DecisionEngine, type JsonObject, type Mode } from './decision.js';
import { extractState } from './state.js';
import { extractAnthropicState } from './anthropic.js';
import type { Config } from './config.js';
import { JevError, type JevFailure } from './jev.js';
import { usageRecord, type UsageAttempt } from './metrics.js';

let evaluationSequence = 0;
export interface RouteResult {
  request: JsonObject; mode: Mode; reason: string; effortApplied: boolean;
  jevCalled: boolean; jevLatencyMs: number; decision?: ControlDecision;
  jevOutcome?: 'succeeded' | 'failed' | 'cancelled'; jevFailure?: JevFailure | 'timeout'; jevCompletedAt?: string; jevSequence?: number;
  jevAttempt?: UsageAttempt;
  direct?: { name: string; arguments: JsonObject };
}
export async function control(request: JsonObject, engine: DecisionEngine, config: Config, signal?: AbortSignal, protocol: 'responses' | 'messages' = 'responses'): Promise<RouteResult> {
  const messages = protocol === 'messages';
  const effortField = messages ? 'output_config' : 'reasoning';
  const result: RouteResult = { request, mode: 'passthrough', reason: 'unchanged', effortApplied: false, jevCalled: false, jevLatencyMs: 0 };
  if (!config.toolRouting && !config.effortRouting) return { ...result, reason: 'routing_disabled' };
  let state;
  try { state = messages ? extractAnthropicState(request) : extractState(request); }
  catch { return { ...result, reason: 'state_extraction_failed' }; }
  if (state.incompleteHistory) return { ...result, reason: 'incomplete_history' };
  const routeTool = config.toolRouting && state.toolChoice === 'auto' && state.availableTools.length > 0 && state.availableTools.length <= 120;
  const routeEffort = config.effortRouting && !state.nativeEffort;
  if (!routeTool && !routeEffort) return { ...result, reason: 'caller_constraints' };
  const started = performance.now();
  const abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let acceptingUsage = true; let reportedUsage = false;
  const onUsage = (attempt: UsageAttempt) => {
    if (!acceptingUsage) return;
    reportedUsage = true;
    result.jevAttempt = { ...attempt, usage: { ...attempt.usage }, reasons: [...attempt.reasons] };
  };
  try {
    result.jevCalled = true;
    result.jevAttempt = { dispatched: false, usage: {}, complete: true, reasons: [] };
    combined.throwIfAborted();
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener('abort', onAbort, { once: true });
      if (combined.aborted) onAbort();
      timer = setTimeout(() => abort.abort(new Error('deadline')), config.timeoutMs);
    });
    const decision = await Promise.race([Promise.resolve().then(() => {
      combined.throwIfAborted();
      result.jevAttempt = { dispatched: 'unknown', usage: {}, complete: false, reasons: ['accounting_unavailable'] };
      return engine.decide(state, combined, onUsage);
    }), deadline]);
    if (!reportedUsage) {
      const record = usageRecord(object(decision) ? decision.evaluator : undefined, 'jev');
      result.jevAttempt = { ...record, dispatched: 'unknown', complete: false, reasons: [...record.reasons, 'accounting_unavailable'] };
    }
    if (!object(decision) || !object(decision.tool) || !object(decision.reasoning)) throw new JevError('invalid_response');
    result.decision = decision;
    result.jevOutcome = 'succeeded';
    if ((routeTool && decision.evaluator?.invalidAnswers?.includes('tool')) || (routeEffort && decision.evaluator?.invalidAnswers?.includes('effort'))) {
      result.jevOutcome = 'failed'; result.jevFailure = 'invalid_response';
    }
    const { tool, reasoning } = decision;
    if (routeTool && probability(tool.confidence) && tool.confidence >= config.toolMinConfidence) {
      const selected = state.availableTools.find(t => t.name === tool.name);
      if (tool.mode === 'none') {
        result.request = { ...request, tool_choice: messages ? { type: 'none' } : 'none' }; result.mode = 'none';
      } else if ((tool.mode === 'forced' || tool.mode === 'direct') && selected?.forceable) {
        if (!messages && tool.mode === 'direct' && config.directCalls && request.store === false && validArguments(selected, tool.arguments)) {
          result.mode = 'direct'; result.direct = { name: selected.name, arguments: tool.arguments };
        } else {
          result.request = { ...request, tool_choice: messages ? { ...(object(request.tool_choice) ? request.tool_choice : {}), type: 'tool', name: selected.name } : { type: selected.kind, name: selected.name } }; result.mode = 'forced';
        }
      }
    }
    if (result.mode !== 'direct' && routeEffort && probability(reasoning.confidence) && reasoning.confidence >= config.effortMinConfidence && ['low','medium','high'].includes(reasoning.effort) && (request[effortField] === undefined || request[effortField] === null || object(request[effortField]))) {
      if (state.currentEffort !== reasoning.effort) {
        result.request = { ...result.request, [effortField]: { ...(object(request[effortField]) ? request[effortField] : {}), effort: reasoning.effort } };
        result.effortApplied = true;
      }
    }
    result.reason = result.mode === 'direct' || result.request !== request ? 'applied' : 'confidence_or_constraints';
  } catch (error) {
    result.request = request; result.mode = 'passthrough'; result.effortApplied = false; delete result.direct; delete result.decision;
    const cancelled = signal?.aborted && combined.reason === signal.reason;
    result.reason = cancelled ? 'jev_cancelled' : abort.signal.aborted ? 'jev_timeout' : 'jev_error';
    result.jevOutcome = cancelled ? 'cancelled' : 'failed';
    result.jevFailure = cancelled ? undefined : abort.signal.aborted ? 'timeout' : error instanceof JevError ? error.category : 'unknown';
    if (result.jevAttempt && result.jevAttempt.dispatched !== false && !result.jevAttempt.complete && (cancelled || abort.signal.aborted)) {
      result.jevAttempt.reasons = [...new Set([...result.jevAttempt.reasons, cancelled ? 'cancelled' : 'timeout'])];
    }
  } finally {
    acceptingUsage = false;
    clearTimeout(timer);
    if (onAbort) combined.removeEventListener('abort', onAbort);
    result.jevLatencyMs = performance.now() - started;
    result.jevCompletedAt = new Date().toISOString();
    result.jevSequence = ++evaluationSequence;
  }
  return result;
}
