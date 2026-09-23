import test from 'node:test';
import assert from 'node:assert/strict';
import { control } from '../dist/routing.js';
import { loadConfig } from '../dist/config.js';
import { extractState } from '../dist/state.js';

const config = loadConfig({});
const request = {
  model: 'gpt-6-astra', input: [{ role: 'user', content: 'Read the file' }],
  tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  reasoning: { effort: 'high', summary: 'auto' }, stream: true, store: false,
  metadata: { keep: 'unchanged' }, parallel_tool_calls: false,
};
const decision = (tc = .95, ec = .95) => ({ tool: { mode: 'forced', name: 'read', confidence: tc }, reasoning: { effort: 'low', confidence: ec } });
const engine = (d = decision()) => ({ decide: async () => d });

for (const [tc, ec, force, effort] of [[.95,.95,true,'low'], [.95,.1,true,'high'], [.1,.95,false,'low'], [.1,.1,false,'high']]) {
  test(`independent confidence gates: ${tc}/${ec}`, async () => {
    const before = structuredClone(request);
    const result = await control(request, engine(decision(tc, ec)), config);
    assert.equal(result.request.tool_choice?.name, force ? 'read' : undefined);
    assert.equal(result.request.reasoning.effort, effort);
    assert.deepEqual(request, before);
    assert.deepEqual(result.request.metadata, before.metadata);
    assert.deepEqual(result.request.tools, before.tools);
    assert.deepEqual(result.request.input, before.input);
    assert.equal(result.request.reasoning.summary, 'auto');
    assert.equal(result.request.parallel_tool_calls, false);
    if (!force && effort === 'high') assert.equal(result.request, request);
  });
}

test('Jev error or timeout returns original request', async () => {
  for (const decide of [async () => { throw Error('secret provider response'); }, () => new Promise(() => {})]) {
    const result = await control(request, { decide }, { ...config, timeoutMs: 15 });
    assert.equal(result.request, request);
    assert.match(result.reason, /^jev_(error|timeout)$/);
    assert.ok(!JSON.stringify(result).includes('secret provider response'));
  }
});

test('no tools still allows effort routing', async () => {
  const result = await control({ ...request, tools: [] }, engine(), config);
  assert.equal(result.mode, 'passthrough');
  assert.equal(result.request.reasoning.effort, 'low');
});

test('caller tool_choice is preserved independently of effort', async () => {
  for (const tool_choice of ['none', 'required', { type: 'function', name: 'read' }, { type: 'allowed_tools', mode: 'auto', tools: [] }]) {
    const result = await control({ ...request, tool_choice }, engine(), config);
    assert.deepEqual(result.request.tool_choice, tool_choice);
    assert.equal(result.request.reasoning.effort, 'low');
  }
});

test('disabled routing never calls Jev; independent flags work', async () => {
  let calls = 0;
  const e = { decide: async () => { calls++; return decision(); } };
  assert.equal((await control(request, e, { ...config, toolRouting: false, effortRouting: false })).request, request);
  assert.equal(calls, 0);
  assert.equal((await control(request, e, { ...config, toolRouting: false })).request.tool_choice, undefined);
  assert.equal((await control(request, e, { ...config, effortRouting: false })).request.reasoning.effort, 'high');
  assert.equal(calls, 2);
});

test('invalid decisions fail open and never invent a tool', async () => {
  for (const d of [null, {}, { ...decision(), tool: { mode: 'forced', name: 'missing', confidence: 1 } }, decision(NaN, NaN), decision(2, 2)]) {
    const result = await control(request, engine(d), config);
    assert.equal(result.request.tool_choice, undefined);
  }
});

test('none and passthrough decisions', async () => {
  for (const mode of ['none', 'passthrough']) {
    const result = await control(request, engine({ ...decision(), tool: { mode, confidence: .99 } }), config);
    assert.equal(result.request.tool_choice, mode === 'none' ? 'none' : undefined);
  }
});

test('opaque history bypasses the evaluator', async () => {
  const e = { decide: async () => { throw Error('must not call'); } };
  for (const extra of [{ previous_response_id: 'resp_x' }, { conversation: 'conv_x' }, { input: [{ type: 'item_reference', id: 'x' }] }]) {
    const req = { ...request, ...extra };
    const result = await control(req, e, config);
    assert.equal(result.request, req);
    assert.equal(result.jevCalled, false);
  }
});

test('extracts public state and additional_tools without encrypted/image payloads', () => {
  const state = extractState({ ...request, tools: [], input: [
    { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: request.tools }, { type: 'namespace', name: 'figma', tools: [{ type: 'custom', name: 'design' }] }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Check design' }, { type: 'input_image', image_url: 'IMAGE_SECRET' }] },
    { type: 'reasoning', encrypted_content: 'REASONING_SECRET', summary: [{ type: 'summary_text', text: 'Public summary' }] },
    { type: 'function_call', name: 'read', call_id: 'c', arguments: '{"path":"a"}' },
    { type: 'function_call_output', call_id: 'c', output: 'file data' },
  ] });
  assert.equal(state.userTask, 'Check design');
  assert.deepEqual(state.availableTools.map(t => t.name), ['read', 'figma.design']);
  assert.equal(state.recentToolCalls.at(-1).output, 'file data');
  assert.ok(JSON.stringify(state).includes('Public summary'));
  assert.ok(!JSON.stringify(state).includes('_SECRET'));
});

test('hosted/namespaced tools do not force unsupported tool choices', async () => {
  for (const tool of [{ type: 'web_search' }, { type: 'namespace', name: 'figma', tools: [{ type: 'function', name: 'read' }] }]) {
    const name = tool.type === 'web_search' ? 'web_search' : 'figma.read';
    const result = await control({ ...request, tools: [tool] }, engine({ ...decision(), tool: { mode: 'forced', name, confidence: 1 } }), config);
    assert.equal(result.request.tool_choice, undefined);
    assert.equal(result.request.reasoning.effort, 'low');
  }
});

test('direct requires opt-in, explicit store:false and fully finite validated arguments', async () => {
  const tools = [{ type: 'function', name: 'read', parameters: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['brief','full'] } }, required: ['mode'] } }];
  const req = { ...request, tools };
  const d = { ...decision(), tool: { mode: 'direct', name: 'read', confidence: .99, arguments: { mode: 'brief' } } };
  assert.equal((await control(req, engine(d), config)).mode, 'forced');
  const result = await control(req, engine(d), { ...config, directCalls: true });
  assert.equal(result.mode, 'direct');
  assert.equal(result.effortApplied, false);
  for (const bad of [{ ...req, store: true }, { ...req, store: undefined }, request]) {
    assert.equal((await control(bad, engine(d), { ...config, directCalls: true })).mode, 'forced');
  }
  for (const args of [{}, { mode: 'oops' }, { mode: 'brief', extra: true }]) {
    const bad = { ...d, tool: { ...d.tool, arguments: args } };
    assert.equal((await control(req, engine(bad), { ...config, directCalls: true })).mode, 'forced');
  }
});

test('configuration_update does not get contradicted by request effort rewrite', async () => {
  const req = { ...request, input: [...request.input, { type: 'configuration_update', reasoning: { effort: 'high' } }] };
  assert.equal((await control(req, engine(), config)).request.reasoning.effort, 'high');
});

test('contradictory finite schema cannot produce a direct call',async()=>{
  const req={...request,tools:[{type:'function',name:'read',parameters:{type:'object',additionalProperties:false,properties:{mode:{const:'a',enum:['b']}},required:['mode']}}]};
  const d={...decision(),tool:{mode:'direct',name:'read',confidence:1,arguments:{mode:'a'}}};
  assert.equal((await control(req,engine(d),{...config,directCalls:true})).mode,'forced');
});
