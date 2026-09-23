import { object, type AgentState, type AvailableTool, type JsonObject } from './decision.js';

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (object(value) && ['input_text','output_text','text','summary_text'].includes(String(value.type))) return typeof value.text === 'string' ? value.text : '';
  return '';
}

export function extractState(request: JsonObject): AgentState {
  let truncated = false;
  const clip = (value: string, max = 3000) => {
    if (value.length <= max) return value;
    truncated = true; return `${value.slice(0, max / 2)}\n[omitted]\n${value.slice(-max / 2)}`;
  };
  const items = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : Array.isArray(request.input) ? request.input.filter(object) : [];
  const tools = new Map<string, AvailableTool>();
  const add = (raw: unknown, namespace?: string, depth = 0) => {
    if (!object(raw) || depth > 8) return;
    if (raw.type === 'namespace' && Array.isArray(raw.tools)) {
      for (const nested of raw.tools) add(nested, typeof raw.name === 'string' ? raw.name : '__unknown__', depth + 1);
      return;
    }
    if (typeof raw.type !== 'string') return;
    const kind = raw.type === 'function' || raw.type === 'custom' ? raw.type : 'hosted';
    const bare = kind === 'hosted' ? raw.type : raw.name;
    if (typeof bare !== 'string' || !bare.length || bare.length > 256) return;
    const ns = namespace && namespace !== 'functions' ? namespace : undefined;
    const name = ns ? `${ns}.${bare}` : bare;
    const entry: AvailableTool = { name, kind, description: clip(typeof raw.description === 'string' ? raw.description : '', 400),
      namespace: ns, forceable: kind !== 'hosted' && !ns,
      parameters: kind === 'function' && object(raw.parameters) ? raw.parameters : undefined };
    if (tools.has(name)) entry.forceable = false;
    tools.set(name, entry);
  };
  if (Array.isArray(request.tools)) request.tools.forEach(t => add(t));
  for (const item of items) if (item.type === 'additional_tools' && Array.isArray(item.tools)) item.tools.forEach(t => add(t));
  const messages = items.filter(i => typeof i.role === 'string');
  const recentContext = messages.slice(-8).map(i => ({ role: String(i.role), text: clip(text(i.content)) }));
  for (const item of items.slice(-8)) if (item.type === 'reasoning') {
    const summary = text(item.summary);
    if (summary) recentContext.push({ role: 'public_summary', text: clip(summary) });
  }
  const recentToolCalls = items.filter(i => typeof i.type === 'string' && (i.type.endsWith('_call') || i.type.endsWith('_call_output'))).slice(-8).map(i => ({
    type: String(i.type), name: typeof i.name === 'string' ? i.name : undefined, callId: typeof i.call_id === 'string' ? i.call_id : undefined,
    arguments: typeof (i.arguments ?? i.input) === 'string' ? clip(String(i.arguments ?? i.input)) : undefined,
    output: i.output !== undefined ? clip(text(i.output) || (object(i.output) ? JSON.stringify(i.output) : '')) : undefined,
  }));
  return {
    model: typeof request.model === 'string' ? request.model : '',
    userTask: clip(text(messages.findLast(i => i.role === 'user')?.content), 6000),
    instructions: clip(typeof request.instructions === 'string' ? request.instructions : '', 4000),
    recentContext, recentToolCalls, availableTools: [...tools.values()],
    currentEffort: object(request.reasoning) && typeof request.reasoning.effort === 'string' ? request.reasoning.effort : undefined,
    toolChoice: request.tool_choice ?? 'auto',
    incompleteHistory: Boolean(request.previous_response_id || request.conversation || items.some(i => i.type === 'item_reference')),
    nativeEffort: items.some(i => i.type === 'configuration_update'),
    truncated: truncated || messages.length > 8 || items.length > 16,
  };
}
