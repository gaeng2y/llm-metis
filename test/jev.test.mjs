import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { evaluate, JevDecisionEngine, parseChoiceAnswer } from '../dist/jev.js';
import { loadConfig, normalizedEnv } from '../dist/config.js';
import { extractState } from '../dist/state.js';
import { control } from '../dist/routing.js';
import { UsageObserver } from '../dist/metrics.js';

const state = extractState({ model:'gpt-6-astra', input:'Pick a mode', tools:[{ type:'function', name:'select', parameters:{ type:'object', additionalProperties:false, properties:{ mode:{ type:'string', enum:['a','b'] } }, required:['mode'] } }] });
const choice = (value, confidence=.99) => ({ type:'choice', choice:value, confidence });
const providers=[
  ['typesafe','TYPESAFE_API_KEY','https://api.typesafe.ai/v1/systemone','jev-latest'],
  ['openrouter','OPENROUTER_API_KEY','https://openrouter.ai/api/alpha/decisions','typesafe/jev-1.13'],
  ['vercel','AI_GATEWAY_API_KEY','https://ai-gateway.vercel.sh/v1/evaluate','typesafe-ai/jev'],
];
for (const [provider, key, endpoint, model] of providers) {
  test(`${provider}: shared evaluator preserves pruning question IDs, provider hints, and usage`, async () => {
    const config=loadConfig({METIS_PROVIDER:provider,[key]:'pruning-test-key'});
    const publicState={userTask:'Compare the changed files',candidates:[{id:'r3',text:'An old read result'},{id:'r8',text:'An unresolved error'}]};
    const questions=Object.fromEntries(publicState.candidates.map(({id})=>[id,{type:'choice',instructions:`Keep or prune candidate ${id}?`,criteria:{keep:'Required or uncertain.',prune:'Redundant and no longer needed.'}}]));
    const raw={model:'jev-fixture',answers:{r3:{type:'choice',choice:'prune',probabilities:{keep:.01,prune:.99}},r8:choice('keep')},usage:provider==='vercel'?{inputTokens:45,outputTokens:2}:{input_tokens:45,output_tokens:2}};
    const signal=new AbortController().signal;
    let calls=0;
    const response=await evaluate(config,publicState,questions,signal,async(url,init)=>{
      calls++;
      assert.equal(url,endpoint);assert.equal(init.method,'POST');assert.equal(init.signal,signal);assert.equal(init.redirect,'error');
      assert.deepEqual(init.headers,{authorization:'Bearer pruning-test-key','content-type':'application/json'});
      assert.deepEqual(JSON.parse(init.body),{model,state:publicState,questions,
        ...(provider==='openrouter'?{provider:{only:['typesafe'],allow_fallbacks:false}}:{}),
        ...(provider==='vercel'?{providerOptions:{gateway:{only:['typesafe-ai']}}}:{}),
      });
      return Response.json(raw);
    });
    assert.equal(calls,1);assert.deepEqual(response,raw);
    assert.deepEqual(parseChoiceAnswer(response.answers.r3),{choice:'prune',confidence:.99});
    assert.deepEqual(parseChoiceAnswer(response.answers.r8),{choice:'keep',confidence:.99});
  });

  test(`${provider}: exactly one typed request decides tool, effort, finite arguments`, async () => {
    const calls=[];
    const cfg=loadConfig({METIS_PROVIDER:provider,[key]:'jev-test-key',METIS_DIRECT_CALLS:'on'});
    const e=new JevDecisionEngine(cfg,async(url,options)=>{
      calls.push({url,options}); return Response.json({answers:{tool:choice('t0'),effort:choice('medium'),a0_0:choice('v1')},usage:{input_tokens:31,output_tokens:2}});
    });
    const decision=await e.decide(state);
    assert.equal(calls.length,1); assert.equal(calls[0].url,endpoint);
    assert.equal(calls[0].options.headers.authorization,'Bearer jev-test-key');
    const sent=JSON.parse(calls[0].options.body);
    assert.equal(sent.model,model);
    assert.deepEqual(Object.keys(sent.questions),['tool','effort','a0_0']);
    assert.equal(sent.state.model,'gpt-6-astra');
    assert.equal(sent.input,undefined);
    assert.deepEqual(sent.provider,provider==='openrouter'?{only:['typesafe'],allow_fallbacks:false}:undefined);
    assert.deepEqual(sent.providerOptions,provider==='vercel'?{gateway:{only:['typesafe-ai']}}:undefined);
    assert.equal(calls[0].options.redirect,'error');
    assert.equal(decision.reasoning.effort,'medium');
    assert.equal(decision.tool.mode,'direct');
    assert.deepEqual(decision.tool.arguments,{mode:'b'});
    assert.equal(decision.evaluator.inputTokens,31);
  });
}

test('shared evaluator rejects malformed envelopes and protects credentials and the byte budget',async()=>{
  const config=loadConfig({METIS_PROVIDER:'typesafe',TYPESAFE_API_KEY:'fake'});
  const questions={r3:{type:'choice',instructions:'Keep or prune r3?',criteria:{keep:null,prune:null}}};
  for(const raw of ['invalid JSON','null','[]','{}','{"answers":[]}','{"answers":null}']){
    await assert.rejects(evaluate(config,{},questions,undefined,async()=>new Response(raw)));
  }
  let calls=0;const unused=async()=>{calls++;return Response.json({answers:{}});};
  await assert.rejects(evaluate({...config,jevApiKey:''},{},questions,undefined,unused),/jev_credentials_missing/);
  await assert.rejects(evaluate(config,'한'.repeat(30_000),questions,undefined,unused),/jev_context_limit/);
  assert.equal(calls,0);
});

test('shared choice parser rejects invalid confidence and uses only the selected probability',()=>{
  for(const raw of [null,[],{},choice(1),{type:'noul',noul:.99}])assert.equal(parseChoiceAnswer(raw),undefined);
  for(const confidence of [-.2,1.1,NaN,Infinity,'0.99',null,undefined]){
    assert.ok(Number.isNaN(parseChoiceAnswer({type:'choice',choice:'prune',confidence}).confidence));
  }
  assert.deepEqual(parseChoiceAnswer({type:'choice',choice:'prune',probabilities:{keep:.99,prune:.01}}),{choice:'prune',confidence:.01});
  assert.ok(Number.isNaN(parseChoiceAnswer({type:'choice',choice:'prune',probabilities:{keep:.99}}).confidence));
  assert.equal(parseChoiceAnswer({type:'choice',choice:'prune',confidence:.8,probabilities:{prune:.9}}).confidence,.8);
});

test('confidence fallback uses selected probability, not maximum probability',async()=>{
  const e=new JevDecisionEngine(loadConfig({METIS_PROVIDER:'typesafe',TYPESAFE_API_KEY:'fake'}),async()=>Response.json({answers:{tool:{type:'choice',choice:'t0',probabilities:{t0:.1,no_tool:.9}},effort:choice('low')}}));
  assert.equal((await e.decide(state)).tool.confidence,.1);
});

test('unknown choices and malformed answers cannot become confident decisions',async()=>{
  for(const answers of [{},{tool:choice('invented'),effort:choice('ultra')},{tool:choice('t0',10),effort:choice('low',-1)}]){
    const d=await new JevDecisionEngine(loadConfig({METIS_PROVIDER:'typesafe',TYPESAFE_API_KEY:'fake'}),async()=>Response.json({answers})).decide(state);
    assert.ok(Number.isNaN(d.reasoning.confidence));
    assert.ok(d.tool.mode==='passthrough'||Number.isNaN(d.tool.confidence));
  }
});

test('uncertain arguments retain confident forcing; optional arguments may be omitted',async()=>{
  const cfg=loadConfig({METIS_PROVIDER:'typesafe',TYPESAFE_API_KEY:'fake',METIS_DIRECT_CALLS:'on'});
  const reply={answers:{tool:choice('t0'),effort:choice('high'),a0_0:choice('v0',.2)}};
  const e=new JevDecisionEngine(cfg,async()=>Response.json(reply));
  assert.equal((await e.decide(state)).tool.mode,'forced');
  const optional=structuredClone(state);optional.availableTools[0].parameters.required=[];
  reply.answers.a0_0=choice('omit');
  assert.deepEqual((await e.decide(optional)).tool.arguments,{});
});

test('provider failure and cancellation preserve request and do not retry',async()=>{
  const req={model:'gpt-6-astra',input:'secret prompt',reasoning:{effort:'high'}};
  for(const behavior of ['http','timeout','bad-json']){
    let calls=0;let aborted=false;
    const cfg=loadConfig({METIS_PROVIDER:'typesafe',TYPESAFE_API_KEY:'secret-key',METIS_TIMEOUT_MS:'20'});
    const e=new JevDecisionEngine(cfg,async(_url,init)=>{
      calls++;
      if(behavior==='http')return new Response('secret error details',{status:503});
      if(behavior==='bad-json')return new Response('not json');
      return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true}));
    });
    const result=await control(req,e,cfg);
    assert.equal(result.request,req);assert.equal(calls,1);
    assert.ok(!JSON.stringify(result).includes('secret-key'));
    if(behavior==='timeout')assert.equal(aborted,true);
  }
});

test('no credentials and oversized context never make a provider call',async()=>{
  let calls=0;const f=async()=>{calls++;return Response.json({});};
  await assert.rejects(new JevDecisionEngine(loadConfig({}),f).decide(state));
  await assert.rejects(new JevDecisionEngine(loadConfig({METIS_PROVIDER:'typesafe',TYPESAFE_API_KEY:'fake'}),f).decide({...state,userTask:'x'.repeat(100000)}));
  assert.equal(calls,0);
});

test('usage parser handles multiline SSE and unknown/missing usage',()=>{
  const observer=new UsageObserver(true);
  const value='event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"usage":{"input_tokens":12,"output_tokens":3}}}\r\n\r\n';
  for(const byte of Buffer.from(value))observer.write(Uint8Array.of(byte));
  observer.finish();assert.equal(observer.usage.inputTokens,12);assert.equal(observer.usage.cachedInputTokens,undefined);
  assert.equal(observer.outcome,'completed');
  const empty=new UsageObserver(false);empty.write(Buffer.from('{"usage":{}}'));empty.finish();assert.deepEqual(empty.usage,{});
});

test('invalid config values are rejected',()=>{
  for(const env of [{METIS_TIMEOUT_MS:'NaN'},{METIS_PORT:'0'},{METIS_TOOL_MIN_CONFIDENCE:'1.1'},{METIS_EFFORT_ROUTING:'yes'},{METIS_PROVIDER:'__proto__'},{UPSTREAM_BASE_URL:'http://remote.example/v1'},{UPSTREAM_BASE_URL:'https://user:secret@example.com'}])assert.throws(()=>loadConfig(env));
  assert.throws(()=>loadConfig({METIS_PROVIDER:'cloudflare'}),/METIS_PROVIDER/);
});

test('legacy gateway environment remains compatible while Metis values take precedence',()=>{
  const canonical={METIS_PROVIDER:'typesafe',TYPESAFE_API_KEY:'fake',METIS_PORT:'8793',METIS_URL:'https://evaluate.example/v1',METIS_MODEL:'fixture-model',METIS_TOOL_MIN_CONFIDENCE:'.7',METIS_EFFORT_MIN_CONFIDENCE:'.8',METIS_TIMEOUT_MS:'500',METIS_ROUTING:'on',METIS_TOOL_ROUTING:'off',METIS_EFFORT_ROUTING:'on',METIS_DIRECT_CALLS:'on'};
  const legacy=Object.fromEntries(Object.entries(canonical).map(([key,value])=>[key.replace(/^METIS_/,'JEV_'),value]));
  assert.deepEqual(loadConfig(legacy),loadConfig(canonical));
  assert.equal(loadConfig({...legacy,METIS_PROVIDER:'openrouter',OPENROUTER_API_KEY:'openrouter-fake'}).provider,'openrouter');
  assert.equal(loadConfig({...legacy,METIS_PROVIDER:''}).provider,'openrouter');
  assert.equal(loadConfig({JEV_ROUTING:'off',METIS_ROUTING:''}).toolRouting,true);
  const input={JEV_STATE_DIR:'/legacy',METIS_STATE_DIR:'',JEV_CODEX_BIN:'legacy-codex',METIS_CODEX_BIN:'metis-codex-bin'};
  const normalized=normalizedEnv(input);
  assert.equal(normalized.METIS_STATE_DIR,'');
  assert.equal(normalized.METIS_CODEX_BIN,'metis-codex-bin');
  assert.equal(normalizedEnv({JEV_STATE_DIR:'/legacy'}).METIS_STATE_DIR,'/legacy');
  assert.deepEqual(input,{JEV_STATE_DIR:'/legacy',METIS_STATE_DIR:'',JEV_CODEX_BIN:'legacy-codex',METIS_CODEX_BIN:'metis-codex-bin'});
});

test('Windows normalizes legacy and Metis environment names before resolving precedence',()=>{
  const env=normalizedEnv({jev_provider:'typesafe',Metis_Provider:'vercel',jev_state_dir:'legacy-state',Metis_State_Dir:'',Ai_Gateway_Api_Key:'fake-vercel',Path:'keep-path'},'win32');
  assert.equal(env.METIS_PROVIDER,'vercel');
  assert.equal(env.METIS_STATE_DIR,'');
  assert.equal(env.PATH,'keep-path');
  assert.equal(loadConfig(env).jevApiKey,'fake-vercel');
  assert.equal(normalizedEnv({jev_state_dir:'legacy-state'},'win32').METIS_STATE_DIR,'legacy-state');
});

test('omitted or blank provider defaults to OpenRouter without switching to available keys',()=>{
  for(const selection of [undefined,'',' \t ']){
    for(const value of [undefined,' \t ',' openrouter-key ']){
      const cfg=loadConfig({METIS_PROVIDER:selection,OPENROUTER_API_KEY:value,TYPESAFE_API_KEY:'typesafe-key',AI_GATEWAY_API_KEY:'vercel-key'});
      assert.equal(cfg.provider,'openrouter');
      assert.equal(cfg.jevApiKey,value?.trim()??'');
    }
  }
  assert.equal(loadConfig({}).provider,'openrouter');
});

test('explicit provider selects only its own key and does not fall back',()=>{
  const allKeys=Object.fromEntries(providers.map(([provider,key])=>[key,`${provider}-key`]));
  for(const [provider,key] of providers){
    for(const value of [undefined,' \t ',` ${allKeys[key]} `]){
      const cfg=loadConfig({...allKeys,METIS_PROVIDER:provider,[key]:value});
      assert.equal(cfg.provider,provider);
      assert.equal(cfg.jevApiKey,value?.trim()??'');
    }
  }
});

test('example environment supports all three providers without overriding their defaults',async()=>{
  const example=parseEnv(await readFile(new URL('../.env.example',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(example).filter(key=>/(?:API_KEY|API_TOKEN)$/.test(key)).sort(),providers.map(([,key])=>key).sort());
  assert.equal(loadConfig(example).provider,'openrouter');
  assert.equal(loadConfig(example).jevApiKey,'');
  for(const [provider,key,endpoint,model] of providers){
    assert.equal(example[key],'');
    const cfg=loadConfig({...example,METIS_PROVIDER:provider,[key]:'example-fake-key'});
    assert.equal(cfg.provider,provider);
    assert.equal(cfg.jevApiKey,'example-fake-key');
    assert.equal(cfg.jevUrl,endpoint);
    assert.equal(cfg.jevModel,model);
  }
});

test('invalid confidence cannot pass even when threshold is zero',async()=>{
  const cfg=loadConfig({METIS_PROVIDER:'typesafe',TYPESAFE_API_KEY:'fake',METIS_TOOL_MIN_CONFIDENCE:'0',METIS_EFFORT_MIN_CONFIDENCE:'0'});
  const e=new JevDecisionEngine(cfg,async()=>Response.json({answers:{tool:{type:'choice',choice:'no_tool'},effort:choice('low',-1)}}));
  const request={model:'gpt-6-astra',input:'test',tools:[{type:'function',name:'read'}],reasoning:{effort:'high'}};
  assert.equal((await control(request,e,cfg)).request,request);
});
