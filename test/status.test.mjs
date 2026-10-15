import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createGateway } from '../dist/gateway.js';
import { loadConfig } from '../dist/config.js';

const headers = { 'x-metis-token': 'status-token', 'content-type': 'application/json' };
const request = { model:'fixture', input:'private prompt', tools:[{type:'function',name:'read'}], reasoning:{effort:'high'} };
const choice = (value, confidence=.99) => ({type:'choice',choice:value,confidence});
async function fixture(t, options={}) {
  const calls = { evaluations:0, models:0 };
  const behavior = {
    evaluate: (_body,res) => res.end(JSON.stringify({answers:{tool:choice('passthrough'),effort:choice('high')}})),
    model: (_body,res) => res.end('{}'),
  };
  const upstream = createServer(async (req,res) => {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type','application/json');
    if(req.url==='/evaluate'){calls.evaluations++;behavior.evaluate(body,res);}
    else {calls.models++;behavior.model(body,res);}
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const base=`http://127.0.0.1:${upstream.address().port}`;
  const gateway=createGateway({token:headers['x-metis-token'],config:{...loadConfig({}),jevApiKey:'private-key',jevUrl:`${base}/evaluate`,upstreamBaseUrl:base,timeoutMs:500,...options}});
  gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');
  const url=`http://127.0.0.1:${gateway.server.address().port}`;
  t.after(async()=>{gateway.server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>gateway.server.close(r)),new Promise(r=>upstream.close(r))]);});
  const get=async path=>(await fetch(`${url}/control/${path}`,{headers})).json();
  const generate=async (body=request)=>{const response=await fetch(`${url}/v1/responses`,{method:'POST',headers,body:JSON.stringify(body)});await response.text();return response.status;};
  return {url,calls,behavior,get,generate};
}

test('status separates loaded credentials from untested evaluation without making probe calls',async t=>{
  for(const jevApiKey of ['private-key','']){
    const f=await fixture(t,{jevApiKey});
    const status=await f.get('status');
    assert.equal(status.jevConfigured,Boolean(jevApiKey));
    assert.equal(status.observations.evaluation.state,'not_evaluated');
    assert.equal(status.observations.evaluation.attempts,0);
    assert.equal(status.observations.evaluation.latest,null);
    assert.equal(status.observations.retainedRequests,0);
    assert.equal(status.observations.windowStartedAt,null);
    assert.equal(status.observations.routing.appliedDenominator,0);
    await f.get('status');
    assert.deepEqual(f.calls,{evaluations:0,models:0});
    assert.ok(!JSON.stringify(status).includes('private-key'));
  }
});

test('successful evaluations remain distinct from applied routing and rejected rewrites',async t=>{
  const f=await fixture(t);
  await f.generate();
  let observed=(await f.get('status')).observations;
  assert.equal(observed.evaluation.state,'succeeded');
  assert.equal(observed.evaluation.attempts,1);assert.equal(observed.evaluation.successes,1);
  assert.equal(observed.routing.toolApplied,0);assert.equal(observed.routing.effortApplied,0);
  assert.equal(observed.routing.passthrough,1);
  assert.deepEqual(observed.routing.passthroughReasons,{confidence_or_constraints:1});

  f.behavior.evaluate=(_body,res)=>res.end(JSON.stringify({answers:{tool:choice('no_tool'),effort:choice('low')}}));
  await f.generate();
  observed=(await f.get('status')).observations;
  assert.equal(observed.routing.toolApplied,1);assert.equal(observed.routing.effortApplied,1);
  assert.equal(observed.routing.appliedDenominator,2);

  f.behavior.model=(body,res)=>{res.statusCode=body.reasoning.effort==='low'?422:200;res.end('{}');};
  assert.equal(await f.generate(),200);
  observed=(await f.get('status')).observations;
  assert.equal(observed.evaluation.successes,3);assert.equal(observed.evaluation.failures,0);
  assert.equal(observed.routing.toolApplied,1);assert.equal(observed.routing.effortApplied,1);
  assert.equal(observed.routing.appliedDenominator,3);assert.equal(observed.routing.passthrough,2);
  assert.equal(observed.routing.rewriteRejections,1);
  assert.deepEqual(observed.routing.passthroughReasons,{confidence_or_constraints:1,upstream_rejected_rewrite:1});
  assert.ok(Date.parse(observed.evaluation.latest.time));
  assert.ok(Date.parse(observed.windowStartedAt));assert.ok(Date.parse(observed.windowEndedAt));
  const before={...f.calls};await f.get('status');assert.deepEqual(f.calls,before);
});

test('latest evaluator failure replaces an earlier success and exposes only safe categories',async t=>{
  const f=await fixture(t);
  await f.generate();
  for(const [category,respond] of [
    ['authentication',res=>{res.statusCode=401;res.end('private-key private prompt');}],
    ['rate_limit',res=>{res.statusCode=429;res.end('private provider body');}],
    ['provider_error',res=>{res.statusCode=503;res.end('private provider body');}],
    ['invalid_response',res=>res.end('not JSON private-key')],
    ['invalid_response',res=>res.end(JSON.stringify({answers:{tool:choice('invented'),effort:choice('high',2)}}))],
    ['transport',res=>res.destroy()],
    ['timeout',_res=>{}],
  ]){
    f.behavior.evaluate=(_body,res)=>respond(res);
    let forwarded;f.behavior.model=(body,res)=>{forwarded=body;res.end('{}');};
    assert.equal(await f.generate(),200);assert.deepEqual(forwarded,request);
    const status=await f.get('status');
    const evaluation=status.observations.evaluation;
    assert.equal(evaluation.state,'failed');assert.equal(evaluation.latest.failure,category);
    assert.equal(evaluation.successes,1);
    for(const secret of ['private-key','private prompt','private provider body']){
      assert.ok(!JSON.stringify(status).includes(secret));
      assert.ok(!JSON.stringify(await f.get('metrics')).includes(secret));
    }
  }
  const observed=(await f.get('status')).observations;
  assert.equal(observed.evaluation.attempts,8);assert.equal(observed.evaluation.failures,7);
  assert.deepEqual(observed.evaluation.failureReasons,{authentication:1,rate_limit:1,provider_error:1,invalid_response:2,transport:1,timeout:1});
  assert.equal(observed.routing.toolApplied,0);assert.equal(observed.routing.effortApplied,0);
});

test('client cancellation is reported separately from evaluator failure',async t=>{
  const f=await fixture(t);
  let started;const evaluating=new Promise(resolve=>{started=resolve;});
  f.behavior.evaluate=()=>started();
  const abort=new AbortController();
  const pending=fetch(`${f.url}/v1/responses`,{method:'POST',headers,body:JSON.stringify(request),signal:abort.signal}).catch(()=>{});
  await evaluating;abort.abort();await pending;
  let observed;
  for(let i=0;i<100;i++){
    observed=(await f.get('status')).observations;
    if(observed.retainedRequests)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(observed.evaluation.state,'cancelled');
  assert.equal(observed.evaluation.cancellations,1);assert.equal(observed.evaluation.failures,0);
  assert.deepEqual(observed.evaluation.failureReasons,{});
  assert.deepEqual(observed.routing.passthroughReasons,{jev_cancelled:1});
  assert.equal(f.calls.models,0);
});

test('intentional passthrough and local limits do not masquerade as provider outages',async t=>{
  const f=await fixture(t);
  f.behavior.evaluate=(_body,res)=>res.end(JSON.stringify({answers:{tool:choice('t0',.1),effort:choice('low',.1)}}));
  await f.generate();
  await f.generate({...request,previous_response_id:'opaque'});
  await f.generate({...request,tool_choice:'required',input:[{type:'configuration_update',reasoning:{effort:'high'}}]});
  let observed=(await f.get('status')).observations;
  assert.equal(observed.evaluation.state,'succeeded');assert.equal(observed.evaluation.attempts,1);
  assert.deepEqual(observed.routing.passthroughReasons,{confidence_or_constraints:1,incomplete_history:1,caller_constraints:1});
  await f.generate({...request,tools:[{...request.tools[0],parameters:{type:'object',description:'한'.repeat(30_000)}}]});
  observed=(await f.get('status')).observations;
  assert.equal(f.calls.evaluations,1);assert.equal(observed.evaluation.attempts,2);
  assert.equal(observed.evaluation.latest.failure,'context_limit');

  const missing=await fixture(t,{jevApiKey:''});await missing.generate();
  observed=(await missing.get('status')).observations;
  assert.equal(observed.evaluation.state,'not_evaluated');assert.equal(observed.evaluation.attempts,0);
  assert.deepEqual(observed.routing.passthroughReasons,{jev_credentials_missing:1});
  assert.equal(missing.calls.evaluations,0);
});

test('partial invalid answers can apply a valid dimension and disabled dimensions do not report failure',async t=>{
  const f=await fixture(t);
  f.behavior.evaluate=(_body,res)=>res.end(JSON.stringify({answers:{tool:choice('invented'),effort:choice('low')}}));
  await f.generate();
  let observed=(await f.get('status')).observations;
  assert.equal(observed.evaluation.latest.failure,'invalid_response');
  assert.equal(observed.routing.toolApplied,0);assert.equal(observed.routing.effortApplied,1);
  await fetch(`${f.url}/control/routing`,{method:'POST',headers,body:JSON.stringify({toolRouting:false})});
  await f.generate();
  observed=(await f.get('status')).observations;
  assert.equal(observed.evaluation.state,'succeeded');
  assert.equal(observed.evaluation.failures,1);assert.equal(observed.evaluation.successes,1);
  assert.equal(observed.routing.effortApplied,2);
});

test('latest evaluation is ordered by evaluation completion rather than model response completion',async t=>{
  t.mock.method(Date.prototype,'toISOString',()=> '2026-10-15T00:00:00.000Z');
  const f=await fixture(t);
  let started,release;
  const waiting=new Promise(resolve=>{started=resolve;});
  f.behavior.model=(_body,res)=>{release=()=>res.end('{}');started();};
  const first=f.generate();await waiting;
  f.behavior.model=(_body,res)=>res.end('{}');
  f.behavior.evaluate=(_body,res)=>{res.statusCode=429;res.end('{}');};
  await f.generate();release();await first;
  const observed=(await f.get('status')).observations;
  assert.equal(observed.evaluation.successes,1);assert.equal(observed.evaluation.failures,1);
  assert.equal(observed.evaluation.state,'failed');assert.equal(observed.evaluation.latest.failure,'rate_limit');
});

test('status uses the bounded retained window and a fresh gateway starts untested',async t=>{
  const f=await fixture(t);
  await f.generate();
  const first=(await f.get('metrics')).requests[0].id;
  await fetch(`${f.url}/control/routing`,{method:'POST',headers,body:JSON.stringify({toolRouting:false,effortRouting:false})});
  for(let i=0;i<2000;i++)await f.generate();
  const observed=(await f.get('status')).observations;
  const metrics=await f.get('metrics');
  assert.equal(observed.requestLimit,2000);assert.equal(observed.retainedRequests,2000);
  assert.equal(observed.evaluation.state,'not_evaluated');assert.equal(observed.evaluation.attempts,0);
  assert.equal(observed.routing.appliedDenominator,2000);assert.equal(observed.routing.passthrough,2000);
  assert.deepEqual(observed.routing.passthroughReasons,{routing_disabled:2000});
  assert.equal(observed.windowStartedAt,metrics.requests[0].time);assert.ok(metrics.requests.every(r=>r.id!==first));
  assert.equal(f.calls.evaluations,1);
  const restarted=await fixture(t);
  assert.equal((await restarted.get('status')).observations.evaluation.state,'not_evaluated');
  assert.equal((await restarted.get('status')).observations.retainedRequests,0);
});
