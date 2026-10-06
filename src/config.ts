export const PROVIDERS = {
  openrouter: { key: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
  vercel: { key: 'AI_GATEWAY_API_KEY', url: 'https://ai-gateway.vercel.sh/v1/evaluate', model: 'typesafe-ai/jev' },
  typesafe: { key: 'TYPESAFE_API_KEY', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
} as const;
export type Provider = keyof typeof PROVIDERS;
export interface Config {
  port: number; upstreamBaseUrl: string; provider: Provider; jevUrl: string; jevModel: string; jevApiKey: string;
  toolMinConfidence: number; effortMinConfidence: number; timeoutMs: number;
  toolRouting: boolean; effortRouting: boolean; directCalls: boolean;
}
export function endpoint(value: string, name: string): string {
  const u = new URL(value);
  if (u.username || u.password || u.hash || u.search || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)))) {
    throw Error(`${name} must be HTTPS or loopback HTTP, without credentials, query or fragment`);
  }
  return u.href.replace(/\/+$/, '');
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (process.platform === 'win32') env = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  const toggle = (key: string, fallback: boolean) => {
    if (!env[key]) return fallback;
    if (!['on','off'].includes(env[key]!)) throw Error(`${key} must be on or off`);
    return env[key] === 'on';
  };
  const number = (key: string, fallback: number, min: number, max: number, integer = false) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw Error(`Invalid ${key}`);
    return value;
  };
  const provider = env.JEV_PROVIDER?.trim().toLowerCase() || 'openrouter';
  if (!Object.hasOwn(PROVIDERS, provider)) throw Error('JEV_PROVIDER must be openrouter, vercel, or typesafe');
  const p = PROVIDERS[provider as Provider];
  return {
    port: number('JEV_PORT', 8791, 1, 65535, true),
    upstreamBaseUrl: endpoint(env.UPSTREAM_BASE_URL ?? 'https://api.openai.com/v1', 'UPSTREAM_BASE_URL'),
    provider: provider as Provider, jevUrl: endpoint(env.JEV_URL ?? p.url, 'JEV_URL'),
    jevModel: env.JEV_MODEL ?? p.model, jevApiKey: env[p.key]?.trim() ?? '',
    toolMinConfidence: number('JEV_TOOL_MIN_CONFIDENCE', .85, 0, 1),
    effortMinConfidence: number('JEV_EFFORT_MIN_CONFIDENCE', .85, 0, 1),
    timeoutMs: number('JEV_TIMEOUT_MS', 2000, 1, 60000, true),
    toolRouting: toggle('JEV_ROUTING', true) && toggle('JEV_TOOL_ROUTING', true),
    effortRouting: toggle('JEV_ROUTING', true) && toggle('JEV_EFFORT_ROUTING', true),
    directCalls: toggle('JEV_DIRECT_CALLS', false),
  };
}
