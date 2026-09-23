import { object, probability, validArguments, type ControlDecision, type DecisionEngine, type JsonObject, type Mode } from './decision.js';
import { extractState } from './state.js';
import type { Config } from './config.js';

export interface RouteResult {
  request: JsonObject; mode: Mode; reason: string; effortApplied: boolean;
  jevCalled: boolean; jevLatencyMs: number; decision?: ControlDecision;
  direct?: { name: string; arguments: JsonObject };
}
export async function control(request: JsonObject, engine: DecisionEngine, config: Config, signal?: AbortSignal): Promise<RouteResult> {
  const result: RouteResult = { request, mode: 'passthrough', reason: 'unchanged', effortApplied: false, jevCalled: false, jevLatencyMs: 0 };
  if (!config.toolRouting && !config.effortRouting) return { ...result, reason: 'routing_disabled' };
  let state;
  try { state = extractState(request); }
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
  try {
    result.jevCalled = true;
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener('abort', onAbort, { once: true });
      if (combined.aborted) onAbort();
      timer = setTimeout(() => abort.abort(new Error('deadline')), config.timeoutMs);
    });
    const decision = await Promise.race([Promise.resolve().then(() => engine.decide(state, combined)), deadline]);
    if (!object(decision) || !object(decision.tool) || !object(decision.reasoning)) throw Error('invalid_decision');
    result.decision = decision;
    const { tool, reasoning } = decision;
    if (routeTool && probability(tool.confidence) && tool.confidence >= config.toolMinConfidence) {
      const selected = state.availableTools.find(t => t.name === tool.name);
      if (tool.mode === 'none') {
        result.request = { ...request, tool_choice: 'none' }; result.mode = 'none';
      } else if ((tool.mode === 'forced' || tool.mode === 'direct') && selected?.forceable) {
        if (tool.mode === 'direct' && config.directCalls && request.store === false && validArguments(selected, tool.arguments)) {
          result.mode = 'direct'; result.direct = { name: selected.name, arguments: tool.arguments };
        } else {
          result.request = { ...request, tool_choice: { type: selected.kind, name: selected.name } }; result.mode = 'forced';
        }
      }
    }
    if (result.mode !== 'direct' && routeEffort && probability(reasoning.confidence) && reasoning.confidence >= config.effortMinConfidence && ['low','medium','high'].includes(reasoning.effort) && (request.reasoning === undefined || request.reasoning === null || object(request.reasoning))) {
      if (state.currentEffort !== reasoning.effort) {
        result.request = { ...result.request, reasoning: { ...(object(request.reasoning) ? request.reasoning : {}), effort: reasoning.effort } };
        result.effortApplied = true;
      }
    }
    result.reason = result.mode === 'direct' || result.request !== request ? 'applied' : 'confidence_or_constraints';
  } catch {
    result.request = request; result.mode = 'passthrough'; result.effortApplied = false; delete result.direct; delete result.decision;
    result.reason = abort.signal.aborted ? 'jev_timeout' : 'jev_error';
  } finally {
    clearTimeout(timer);
    if (onAbort) combined.removeEventListener('abort', onAbort);
    result.jevLatencyMs = performance.now() - started;
  }
  return result;
}
