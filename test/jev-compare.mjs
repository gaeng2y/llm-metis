import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, PROVIDERS } from '../dist/config.js';
import { configuredEnv } from '../dist/configure.js';
import { JevDecisionEngine } from '../dist/jev.js';
import { control } from '../dist/routing.js';

export const models = ['typesafe/jev-1.13', 'typesafe/jev-1.14'];
const tool = (name, description) => ({ type: 'function', name, description, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } });
export const cases = ['en', 'ko'].flatMap(language => {
  const ko = language === 'ko';
  const tools = [tool('read_file', ko ? '정확한 경로의 파일 내용을 읽는다.' : 'Read a file at an exact path.'),
    tool('search_files', ko ? '여러 파일에서 문자열을 검색한다.' : 'Search for text across files.'),
    tool('edit_file', ko ? '파일 내용을 변경한다.' : 'Modify a file.')];
  const prompts = [
    ['no_tool', ko ? '도구를 사용하지 말고 다음 문장을 영어로 번역해 줘: 고양이가 의자 위에서 자고 있다.' : 'Without using tools, translate this sentence into English: 고양이가 의자 위에서 자고 있다.', { tool: 'none', effort: 'low' }],
    ['read', ko ? 'src/config.ts 파일의 현재 내용을 읽어 줘. 아직 검색하거나 수정하지 마.' : 'Read the current contents of src/config.ts. Do not search or edit yet.', { tool: 'read_file' }],
    ['high', (ko ? '아래 코드와 실행 기록만으로 중복 결제 가능성을 분석하고, 재시작과 지연된 재시도까지 안전한 최소 수정 및 반례를 설명해 줘. 도구를 호출하지 마. 결제가 실제로 한 번만 발생함을 보장하는지 엄밀히 판단해야 해.\n' : 'Using only the code and execution trace below, analyze duplicate charges and explain a minimal fix with counterexamples that remains safe across restarts and delayed retries. Do not call tools. Rigorously determine whether the charge happens exactly once.\n') +
      'async function pay(id) { if (await db.exists(id)) return; const receipt = await charge(id); await db.insert(id, receipt); }\n' +
      'Trace: A exists(order-7)=false; B exists(order-7)=false; A charge succeeds; A crashes before insert; B charge times out but its remote outcome is unknown; process restarts; C exists(order-7)=false; delayed B retry arrives.\n' +
      'Constraints: db.insert has a UNIQUE(id) constraint; charge is external and cannot share a DB transaction; provider idempotency keys expire after 24 hours; retries may arrive after 48 hours; permanent loss of a paid order is unacceptable.', { tool: 'none', effort: 'high' }],
    ['ambiguous', ko ? '문제가 생겼는데 어느 프로젝트인지, 어떤 증상인지 아직 정리하지 못했어. 무엇이 필요한지 먼저 물어봐 줘. 대상 파일이나 검색어를 추측해서 도구를 호출하지 마.' : 'Something is broken, but I have not identified the project or symptoms. Ask what information is needed first. Do not guess a target file or search term and call a tool.', { tool: 'defer' }],
    ['finite', ko ? '표시 모드를 full로 설정해 줘.' : 'Set the display mode to full.', { tool: 'set_mode', arguments: { mode: 'full' } }],
  ];
  return prompts.map(([scenario, input, expected]) => ({ id: `${scenario}-${language}`, scenario, language, expected,
    request: { model: 'gpt-6-astra', input, reasoning: { effort: 'high' }, store: false,
      tools: scenario === 'finite' ? [{ type: 'function', name: 'set_mode', description: ko ? '표시 모드를 설정한다.' : 'Set the display mode.',
        parameters: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['brief', 'full'] } }, required: ['mode'] } }] : tools } }));
});

export function classify(example, route) {
  let applied;
  if (example.scenario === 'high') applied = route.request.reasoning.effort === 'high' && ['none', 'passthrough'].includes(route.mode) ? 'pass' : 'unsafe';
  else if (example.scenario === 'ambiguous') applied = ['none', 'passthrough'].includes(route.mode) ? 'pass' : 'unsafe';
  else if (example.scenario === 'finite') applied = route.mode === 'direct'
    ? route.direct?.name === 'set_mode' && route.direct.arguments.mode === 'full' ? 'pass' : 'unsafe'
    : route.mode === 'passthrough' || (route.mode === 'forced' && route.request.tool_choice?.name === 'set_mode') ? 'abstained' : 'unsafe';
  else applied = (example.scenario === 'no_tool' ? route.mode === 'none' : route.mode === 'forced' && route.request.tool_choice?.name === 'read_file')
    ? 'pass' : route.mode === 'passthrough' ? 'abstained' : 'unsafe';
  if (route.jevOutcome !== 'succeeded') return { applied: applied === 'unsafe' ? 'unsafe' : 'unscored', rawToolCorrect: null, rawEffortCorrect: null };
  const decision = route.decision;
  const rawToolCorrect = example.expected.tool === 'none' ? decision.tool.mode === 'none'
    : example.expected.tool === 'defer' ? ['none', 'passthrough'].includes(decision.tool.mode)
      : decision.tool.name === example.expected.tool && (!example.expected.arguments || decision.tool.arguments?.mode === 'full');
  const rawEffortCorrect = example.expected.effort ? decision.reasoning.effort === example.expected.effort : null;
  return { applied, rawToolCorrect, rawEffortCorrect };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
export function summarize(rows) {
  return models.map(model => {
    const selected = rows.filter(row => row.requestedModel === model);
    const successful = selected.filter(row => row.route.outcome === 'succeeded');
    const usages = selected.map(row => row.usage?.usage ?? {});
    const cost = selected.map(row => row.rawCost.usage ?? row.rawCost.response).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    return { model, calls: selected.length, succeeded: successful.length,
      failures: selected.length - successful.length, timeouts: selected.filter(row => row.route.failure === 'timeout').length,
      classifications: Object.fromEntries(['pass', 'unsafe', 'abstained', 'unscored'].map(label => [label, selected.filter(row => row.quality.applied === label).length])),
      latencyMs: { p50: percentile(selected.map(row => row.latencyMs), .5), p95: percentile(selected.map(row => row.latencyMs), .95),
        successfulP50: percentile(successful.map(row => row.latencyMs), .5), successfulP95: percentile(successful.map(row => row.latencyMs), .95) },
      usageCompleteCalls: selected.filter(row => row.usage?.complete).length,
      inputReportedCalls: usages.filter(usage => usage.inputTokens !== undefined).length,
      knownInputTokens: usages.some(usage => usage.inputTokens !== undefined) ? usages.reduce((total, usage) => total + (usage.inputTokens ?? 0), 0) : null,
      cacheReportedCalls: usages.filter(usage => usage.cachedInputTokens !== undefined).length,
      knownCachedInputTokens: usages.some(usage => usage.cachedInputTokens !== undefined) ? usages.reduce((total, usage) => total + (usage.cachedInputTokens ?? 0), 0) : null,
      reportedCostCalls: cost.length, knownReportedCost: cost.length ? cost.reduce((total, value) => total + value, 0) : null };
  });
}

export async function compare({ env = process.env, repeats = 3, save = async () => {} } = {}) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw Error('repeats');
  const configured = await configuredEnv(env);
  const config = loadConfig({ ...configured, METIS_PROVIDER: 'openrouter', METIS_ROUTING: 'on', METIS_TOOL_ROUTING: 'on', METIS_EFFORT_ROUTING: 'on',
    METIS_TOOL_MIN_CONFIDENCE: '0.85', METIS_EFFORT_MIN_CONFIDENCE: '0.85', METIS_TIMEOUT_MS: '2000' });
  const url = new URL(config.jevUrl);
  if (config.jevUrl !== PROVIDERS.openrouter.url && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw Error('endpoint');
  if (!config.jevApiKey) throw Error('credentials_missing');
  const report = { format: 1, startedAt: new Date().toISOString(), provider: 'openrouter', models, repeats, maximumCalls: repeats * cases.length * models.length,
    settings: { timeoutMs: 2000, toolMinConfidence: .85, effortMinConfidence: .85, protocol: 'responses', syntheticOnly: true },
    limitations: ['Evaluator decisions only; no upstream generation or tool execution.', 'Small authored sample; no confidence calibration or end-to-end quality/cost claim.', 'Known usage/cost totals exclude missing fields; missing cache usage is unknown.', 'Non-2xx raw error bodies are not retained; production error-body usage accounting is preserved.'],
    cases, rows: [], summary: [], stopped: null };
  const secrets = Object.values(PROVIDERS).map(provider => configured[provider.key]?.trim()).filter(Boolean);
  const snapshot = () => {
    report.summary = summarize(report.rows);
    let serialized = JSON.stringify(report, null, 2);
    for (const secret of secrets) serialized = serialized.replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]');
    return serialized + '\n';
  };
  await save(snapshot());
  outer: for (let repeat = 0; repeat < repeats; repeat++) {
    for (const example of cases) {
      for (const model of repeat % 2 ? [...models].reverse() : models) {
        let raw, status;
        const engine = new JevDecisionEngine({ ...config, jevModel: model, directCalls: example.scenario === 'finite' }, async (endpoint, init) => {
          const response = await fetch(endpoint, init);
          status = response.status;
          const json = response.json.bind(response);
          response.json = async () => { raw = await json(); return raw; };
          return response;
        });
        const route = await control(example.request, engine, { ...config, jevModel: model, directCalls: example.scenario === 'finite' });
        const answers = object(raw?.answers) ? raw.answers : {};
        report.rows.push({ repeat: repeat + 1, case: example.id, requestedModel: model, returnedModel: typeof raw?.model === 'string' ? raw.model : null,
          status: status ?? null, rawAnswers: raw?.answers ?? null, rawUsage: raw?.usage ?? null, rawError: null,
          rawCost: { response: raw?.cost ?? null, usage: raw?.usage?.cost ?? null },
          answerEvidence: Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key, {
            choice: answer?.choice ?? null, confidence: answer?.confidence ?? null, selectedProbability: answer?.probabilities?.[answer?.choice] ?? null }])),
          decision: route.decision ?? null, route: { outcome: route.jevOutcome, failure: route.jevFailure ?? null, reason: route.reason, mode: route.mode,
            effortApplied: route.effortApplied, resultingEffort: route.request.reasoning?.effort ?? null, toolChoice: route.request.tool_choice ?? null, direct: route.direct ?? null },
          latencyMs: route.jevLatencyMs, usage: route.jevAttempt ?? null, quality: classify(example, route) });
        if (route.jevFailure === 'authentication') report.stopped = 'authentication';
        await save(snapshot());
        if (report.stopped) break outer;
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  await save(snapshot());
  return JSON.parse(snapshot());
}

async function main() {
  const { values } = parseArgs({ options: { live: { type: 'boolean' }, repeats: { type: 'string', default: '3' }, output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help || !values.live) {
    console.log('Build first. Then: node test/jev-compare.mjs --live --repeats 1 --output /path/to/new-results.json\nOpenRouter only; 10 synthetic cases × 2 pinned models × 1–3 repeats (default 60 calls). No upstream generation or tool execution.');
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (!values.output || !/^[1-3]$/.test(values.repeats)) throw Error('arguments');
  if (existsSync('.env')) process.loadEnvFile('.env');
  const output = resolve(values.output);
  await writeFile(output, '{}\n', { flag: 'wx', mode: 0o600 });
  const result = await compare({ repeats: Number(values.repeats), save: text => writeFile(output, text, { mode: 0o600 }) });
  console.log(`Saved ${result.rows.length} evaluator results. ${result.stopped ? 'Stopped after authentication failure.' : 'Comparison finished.'}`);
  if (result.stopped) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch { console.error('Jev comparison failed. Check --live, --repeats (1–3), a new --output path, the build, and local OpenRouter configuration. Provider errors and credentials are not printed.'); process.exitCode = 1; }
}
