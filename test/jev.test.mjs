import test from 'node:test';
import assert from 'node:assert/strict';
import { JevDecisionEngine } from '../dist/jev.js';
import { loadConfig } from '../dist/config.js';
import { extractState } from '../dist/state.js';
import { control } from '../dist/routing.js';
import { UsageObserver } from '../dist/metrics.js';

const state = extractState({ model:'gpt-6-astra', input:'Pick a mode', tools:[{ type:'function', name:'select', parameters:{ type:'object', additionalProperties:false, properties:{ mode:{ type:'string', enum:['a','b'] } }, required:['mode'] } }] });
const choice = (value, confidence=.99) => ({ type:'choice', choice:value, confidence });
for (const [provider, key, endpoint] of [['typesafe','TYPESAFE_API_KEY','https://api.typesafe.ai/v1/systemone'],['openrouter','OPENROUTER_API_KEY','https://openrouter.ai/api/alpha/decisions'],['vercel','AI_GATEWAY_API_KEY','https://ai-gateway.vercel.sh/v1/evaluate']]) {
  test(`${provider}: exactly one typed request decides tool, effort, finite arguments`, async () => {
    const calls=[];
    const cfg=loadConfig({JEV_PROVIDER:provider,[key]:'jev-test-key',JEV_DIRECT_CALLS:'on'});
    const e=new JevDecisionEngine(cfg,async(url,options)=>{
      calls.push({url,options}); return Response.json({answers:{tool:choice('t0'),effort:choice('medium'),a0_0:choice('v1')},usage:{input_tokens:31,output_tokens:2}});
    });
    const decision=await e.decide(state);
    assert.equal(calls.length,1); assert.equal(calls[0].url,endpoint);
    assert.equal(calls[0].options.headers.authorization,'Bearer jev-test-key');
    const sent=JSON.parse(calls[0].options.body);
    assert.deepEqual(Object.keys(sent.questions),['tool','effort','a0_0']);
    assert.equal(sent.state.model,'gpt-6-astra');
    assert.equal(calls[0].options.redirect,'error');
    assert.equal(decision.reasoning.effort,'medium');
    assert.equal(decision.tool.mode,'direct');
    assert.deepEqual(decision.tool.arguments,{mode:'b'});
    assert.equal(decision.evaluator.inputTokens,31);
  });
}

test('confidence fallback uses selected probability, not maximum probability',async()=>{
  const e=new JevDecisionEngine(loadConfig({TYPESAFE_API_KEY:'fake'}),async()=>Response.json({answers:{tool:{type:'choice',choice:'t0',probabilities:{t0:.1,no_tool:.9}},effort:choice('low')}}));
  assert.equal((await e.decide(state)).tool.confidence,.1);
});

test('unknown choices and malformed answers cannot become confident decisions',async()=>{
  for(const answers of [{},{tool:choice('invented'),effort:choice('ultra')},{tool:choice('t0',10),effort:choice('low',-1)}]){
    const d=await new JevDecisionEngine(loadConfig({TYPESAFE_API_KEY:'fake'}),async()=>Response.json({answers})).decide(state);
    assert.ok(Number.isNaN(d.reasoning.confidence));
    assert.ok(d.tool.mode==='passthrough'||Number.isNaN(d.tool.confidence));
  }
});

test('uncertain arguments retain confident forcing; optional arguments may be omitted',async()=>{
  const cfg=loadConfig({TYPESAFE_API_KEY:'fake',JEV_DIRECT_CALLS:'on'});
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
    const cfg=loadConfig({TYPESAFE_API_KEY:'secret-key',JEV_TIMEOUT_MS:'20'});
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
  await assert.rejects(new JevDecisionEngine(loadConfig({TYPESAFE_API_KEY:'fake'}),f).decide({...state,userTask:'x'.repeat(100000)}));
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

test('invalid config values are rejected; all provider keys are supported',()=>{
  for(const env of [{JEV_TIMEOUT_MS:'NaN'},{JEV_PORT:'0'},{JEV_TOOL_MIN_CONFIDENCE:'1.1'},{JEV_EFFORT_ROUTING:'yes'},{JEV_PROVIDER:'__proto__'},{UPSTREAM_BASE_URL:'http://remote.example/v1'},{UPSTREAM_BASE_URL:'https://user:secret@example.com'}])assert.throws(()=>loadConfig(env));
  assert.equal(loadConfig({OPENROUTER_API_KEY:'k'}).provider,'openrouter');
  assert.equal(loadConfig({AI_GATEWAY_API_KEY:'k'}).provider,'vercel');
});

test('invalid confidence cannot pass even when threshold is zero',async()=>{
  const cfg=loadConfig({TYPESAFE_API_KEY:'fake',JEV_TOOL_MIN_CONFIDENCE:'0',JEV_EFFORT_MIN_CONFIDENCE:'0'});
  const e=new JevDecisionEngine(cfg,async()=>Response.json({answers:{tool:{type:'choice',choice:'no_tool'},effort:choice('low',-1)}}));
  const request={model:'gpt-6-astra',input:'test',tools:[{type:'function',name:'read'}],reasoning:{effort:'high'}};
  assert.equal((await control(request,e,cfg)).request,request);
});
