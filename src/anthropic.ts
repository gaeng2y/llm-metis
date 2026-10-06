import { object, type AgentState, type JsonObject } from './decision.js';
import { extractState } from './state.js';

/** Keep only visible message text; images, thinking and signatures stay upstream. */
function publicText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(object).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
}

export function extractAnthropicState(request: JsonObject): AgentState {
  const input: JsonObject[] = [];
  let incompleteHistory = !Array.isArray(request.messages);
  let nativeEffort = false;
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    if (!object(message)) { incompleteHistory = true; continue; }
    if (object(message.output_config) && message.output_config.effort !== undefined) nativeEffort = true;
    const text = publicText(message.content);
    if (text) input.push({ role: message.role, content: text });
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!object(block)) continue;
      if (['compaction', 'redacted_compaction', 'item_reference'].includes(String(block.type))) incompleteHistory = true;
      if (block.type === 'tool_use') input.push({
        type: 'function_call', name: block.name, call_id: block.id,
        arguments: object(block.input) ? JSON.stringify(block.input) : undefined,
      });
      if (block.type === 'tool_result') input.push({
        type: 'function_call_output', call_id: block.tool_use_id, output: publicText(block.content),
      });
    }
  }
  const rawTools = Array.isArray(request.tools) ? request.tools.filter(object) : [];
  const state = extractState({
    model: request.model, instructions: publicText(request.system), input,
    tools: rawTools.map(tool => ({
      type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema,
    })),
    reasoning: object(request.output_config) ? { effort: request.output_config.effort } : undefined,
  });
  state.toolChoice = request.tool_choice === undefined || (object(request.tool_choice) && request.tool_choice.type === 'auto') ? 'auto'
    : request.tool_choice === 'auto' ? { type: 'invalid' } : request.tool_choice;
  // Conservative forcing: newer models and thinking modes have different constraints.
  const forceModel = /^claude-(?:opus-4(?:-[5678])?|sonnet-4(?:-[56])?|haiku-4-5)(?:-\d{8})?$/.test(state.model);
  const forceThinking = request.thinking === undefined || (object(request.thinking) && request.thinking.type === 'disabled');
  for (const tool of state.availableTools) {
    const raw = rawTools.find(candidate => candidate.name === tool.name);
    tool.forceable = tool.forceable && forceModel && forceThinking && /^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) && raw !== undefined &&
      (raw.type === undefined || raw.type === 'custom') && object(raw.input_schema) && raw.defer_loading !== true &&
      (raw.allowed_callers === undefined || (Array.isArray(raw.allowed_callers) && raw.allowed_callers.includes('direct')));
  }
  state.incompleteHistory ||= incompleteHistory;
  state.nativeEffort = nativeEffort || !object(request.output_config) || typeof request.output_config.effort !== 'string';
  return state;
}
