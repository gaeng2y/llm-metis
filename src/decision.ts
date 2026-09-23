export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
export const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export type Effort = 'low' | 'medium' | 'high';
export type Mode = 'direct' | 'forced' | 'none' | 'passthrough';

export interface ControlDecision {
  tool: { mode: Mode; name?: string; confidence: number; arguments?: JsonObject; reason?: string };
  reasoning: { effort: Effort; confidence: number; reason?: string };
  evaluator?: { model?: string; inputTokens?: number; outputTokens?: number };
}
export interface AvailableTool {
  name: string;
  kind: 'function' | 'custom' | 'hosted';
  description: string;
  parameters?: JsonObject;
  namespace?: string;
  forceable: boolean;
}
export interface AgentState {
  model: string;
  userTask: string;
  instructions: string;
  recentContext: { role: string; text: string }[];
  recentToolCalls: { type: string; name?: string; callId?: string; arguments?: string; output?: string }[];
  availableTools: AvailableTool[];
  currentEffort?: string;
  toolChoice: unknown;
  incompleteHistory: boolean;
  nativeEffort: boolean;
  truncated: boolean;
}
export interface DecisionEngine {
  decide(state: AgentState, signal?: AbortSignal): Promise<ControlDecision>;
}

/** Only this small, fully enumerable schema subset can safely bypass argument generation. */
export function finiteParameters(schema: unknown): Record<string, unknown[]> | undefined {
  if (!object(schema) || schema.type !== 'object' || schema.additionalProperties !== false || !object(schema.properties)) return;
  if (Object.keys(schema).some(k => !['type','properties','required','additionalProperties','description','title'].includes(k))) return;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(k => typeof k !== 'string' || !Object.hasOwn(schema.properties as object, k))) return;
  const entries: [string, unknown[]][] = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (!object(prop) || Object.keys(prop).some(k => !['type','enum','const','description','title'].includes(k))) return;
    const values = Object.hasOwn(prop, 'const') ? [prop.const] : Array.isArray(prop.enum) ? prop.enum : prop.type === 'boolean' ? [true, false] : [];
    if (Object.hasOwn(prop, 'const') && Object.hasOwn(prop, 'enum') && (!Array.isArray(prop.enum) || !prop.enum.includes(prop.const))) return;
    if (!values.length || values.length > 32 || values.some(v =>
      (v !== null && !['string','number','boolean'].includes(typeof v)) ||
      (typeof v === 'number' && !Number.isFinite(v)) ||
      (prop.type !== undefined && !(prop.type === 'null' ? v === null : prop.type === 'integer' ? Number.isInteger(v) : typeof v === prop.type))
    )) return;
    entries.push([name, values]);
  }
  return Object.fromEntries(entries);
}

export function validArguments(tool: AvailableTool, args: unknown): args is JsonObject {
  if (tool.kind !== 'function' || !object(args)) return false;
  const params = finiteParameters(tool.parameters);
  if (!params) return false;
  const required = tool.parameters?.required as string[] | undefined;
  return (required ?? []).every(k => Object.hasOwn(args, k)) &&
    Object.entries(args).every(([k, v]) => Object.hasOwn(params, k) && params[k]!.some(candidate => candidate === v));
}
