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
/** Keep existing installations working; explicit Metis values always win. */
export function normalizedEnv(env: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
  const result = Object.fromEntries(Object.entries(env).map(([key, value]) => [platform === 'win32' ? key.toUpperCase() : key, value]));
  for (const [key, value] of Object.entries(result)) {
    if (key.startsWith('JEV_')) {
      const canonical = `METIS_${key.slice(4)}`;
      if (result[canonical] === undefined) result[canonical] = value;
    }
  }
  return result;
}
export function endpoint(value: string, name: string): string {
  const u = new URL(value);
  if (u.username || u.password || u.hash || u.search || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)))) {
    throw Error(`${name} must be HTTPS or loopback HTTP, without credentials, query or fragment`);
  }
  return u.href.replace(/\/+$/, '');
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  env = normalizedEnv(env);
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
  const provider = env.METIS_PROVIDER?.trim().toLowerCase() || 'openrouter';
  if (!Object.hasOwn(PROVIDERS, provider)) throw Error('METIS_PROVIDER must be openrouter, vercel, or typesafe');
  const p = PROVIDERS[provider as Provider];
  return {
    port: number('METIS_PORT', 8791, 1, 65535, true),
    upstreamBaseUrl: endpoint(env.UPSTREAM_BASE_URL ?? 'https://api.openai.com/v1', 'UPSTREAM_BASE_URL'),
    provider: provider as Provider, jevUrl: endpoint(env.METIS_URL ?? p.url, 'METIS_URL'),
    jevModel: env.METIS_MODEL ?? p.model, jevApiKey: env[p.key]?.trim() ?? '',
    toolMinConfidence: number('METIS_TOOL_MIN_CONFIDENCE', .85, 0, 1),
    effortMinConfidence: number('METIS_EFFORT_MIN_CONFIDENCE', .85, 0, 1),
    timeoutMs: number('METIS_TIMEOUT_MS', 2000, 1, 60000, true),
    toolRouting: toggle('METIS_ROUTING', true) && toggle('METIS_TOOL_ROUTING', true),
    effortRouting: toggle('METIS_ROUTING', true) && toggle('METIS_EFFORT_ROUTING', true),
    directCalls: toggle('METIS_DIRECT_CALLS', false),
  };
}
