import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html=await readFile(new URL('../src/dashboard.html',import.meta.url),'utf8');

class Element {
  children=[];
  value='';
  _text='';
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join(' ');}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this._text='';this.children=children;}
  click(){this.clicked=true;}
}

async function dashboard(data){
  const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
  const calls=[],downloads=[];
  const context={
    document:{getElementById:id=>elements[id],createElement:()=>new Element(),hidden:false},
    location:{hash:'',pathname:'/dashboard'},sessionStorage:{getItem:()=>''},
    URLSearchParams,Blob,
    URL:{createObjectURL:blob=>{downloads.push(blob);return 'blob:fixture';},revokeObjectURL:()=>{}},
    setInterval:()=>{},setTimeout:callback=>callback(),
    fetch:async(path,options)=>{calls.push({path,options});return {ok:true,json:async()=>path.endsWith('/metrics')?data:{toolRouting:false,effortRouting:false,provider:'fixture'}};},
  };
  runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1],context);
  await new Promise(resolve=>setImmediate(resolve));
  return {elements,calls,downloads};
}

const summary=(usage,knownTotalTokens,{complete=true,attempts=1,reportedAttempts=attempts,completeAttempts=complete?attempts:0,reasons=[]}={})=>({usage,knownTotalTokens,complete,attempts,reportedAttempts,completeAttempts,reasons});
const empty=()=>summary({},0,{attempts:0});
const task=(id,cohort,model,extra={})=>({id,cohort,launchCohort:'baseline',ended:true,durationMs:100,exitCode:0,activeRequests:0,requestCount:1,complete:model.complete,reasons:model.reasons,model,evaluator:empty(),combined:model,...extra});
const snapshot=tasks=>({startedAt:new Date().toISOString(),requests:[],tasks:[],taskUsage:tasks,unassignedRequests:0,usage:{model:empty(),evaluator:empty(),combined:empty()}});
const cells=row=>row.children.map(cell=>cell.textContent);

test('dashboard preserves reported model/Jev totals, cache subsets and unknown coverage',async()=>{
  const model=summary({inputTokens:120,uncachedInputTokens:50,cachedInputTokens:40,cacheWriteInputTokens:30,cacheWrite5mInputTokens:20,cacheWrite1hInputTokens:10,outputTokens:12,reasoningTokens:4},132);
  const evaluator=summary({inputTokens:6,outputTokens:2},8,{complete:false,attempts:2,reportedAttempts:1,reasons:['usage_missing']});
  const combined=summary({inputTokens:126,uncachedInputTokens:50,cachedInputTokens:40,cacheWriteInputTokens:30,cacheWrite5mInputTokens:20,cacheWrite1hInputTokens:10,outputTokens:14,reasoningTokens:4},140,{complete:false,attempts:3,reportedAttempts:2,completeAttempts:1,reasons:['usage_missing']});
  const data=snapshot([task('partial-task','baseline',model,{evaluator,combined,complete:false,reasons:['usage_missing']})]);
  data.usage={model,evaluator,combined};data.unassignedRequests=2;
  const {elements}=await dashboard(data);
  assert.deepEqual(cells(elements.usage.children[0]),['Model','Complete','1 / 1 (1 reported)','132','120','50','40','30','20','10','12','4']);
  assert.equal(cells(elements.usage.children[1])[3],'8');
  assert.deepEqual(cells(elements.usage.children[2]).slice(0,4),['Combined','Partial · usage_missing','1 / 3 (2 reported)','140']);
  assert.match(elements['usage-window'].textContent,/2 requests without a task ID/);
  assert.match(elements.tasks.textContent,/Partial · usage_missing/);
  assert.match(elements.tasks.children[1].textContent,/Write 5m Write 1h/);
  assert.match(elements.tasks.children[1].textContent,/140 126 50 40 30 20 10 14 4/);
  assert.match(elements['task-comparison'].children[0].textContent,/140 · Partial/);
  assert.equal(elements.error.textContent,'');
});

test('dashboard excludes mixed and unknown modes, retains failed overhead, and shows unconfirmed ends',async()=>{
  const complete=summary({inputTokens:10,outputTokens:2},12);
  const unknown=summary({},undefined,{complete:false,reportedAttempts:0,reasons:['usage_missing']});
  const tasks=[task('failed','baseline',complete,{exitCode:1}),task('mixed','mixed',summary({inputTokens:90,outputTokens:9},99)),task('open','unknown',unknown,{ended:false,durationMs:undefined,exitCode:undefined,activeRequests:1,reasons:['task_end_missing','usage_missing']})];
  const {elements}=await dashboard(snapshot(tasks));
  const baseline=cells(elements['task-comparison'].children[0]);
  assert.deepEqual(baseline.slice(0,7),['Baseline','1','1','1','12 · Complete','0 · Complete','12 · Complete']);
  assert.equal(baseline.at(-1),'0 / 1');
  assert.match(elements['task-exclusions'].textContent,/1 mixed and 1 unknown-mode tasks/);
  assert.match(elements.tasks.textContent,/99 · Complete/);
  assert.match(elements.tasks.textContent,/End unconfirmed Unknown · task_end_missing, usage_missing/);
  assert.match(elements.tasks.textContent,/— · Unknown/);
  assert.doesNotMatch(elements['task-comparison'].textContent,/99/);
});

test('complete input/output totals still expose partial cache breakdown coverage and omit compaction decisions',async()=>{
  const model={...summary({inputTokens:200,cachedInputTokens:50,outputTokens:20},220,{attempts:2}),fieldCoverage:{inputTokens:{reported:2,attempts:2},cachedInputTokens:{reported:1,attempts:2},cacheWriteInputTokens:{reported:0,attempts:2},outputTokens:{reported:2,attempts:2}}};
  const data=snapshot([task('cache-partial','baseline',model)]);
  data.usage={model,evaluator:empty(),combined:model};
  const event={time:new Date().toISOString(),cohort:'baseline',mode:'passthrough',reason:'fixture',outcome:'completed',modelLatencyMs:1,jevLatencyMs:0,requestLatencyMs:1};
  data.requests=[event,{...event,kind:'compaction',reason:'compaction-fixture'}];
  const {elements}=await dashboard(data);
  const values=cells(elements.usage.children[0]);
  assert.equal(values[1],'Complete');assert.equal(values[3],'220');
  assert.equal(values[6],'50 · 1 / 2 reported');
  assert.equal(values[7],'— · 0 / 2 reported');
  assert.match(elements.tasks.children[1].textContent,/50 · 1 \/ 2 reported/);
  assert.equal(cells(elements.comparison.children[0])[1],'1');
  assert.equal(elements.recent.children.length,1);
  assert.doesNotMatch(elements.recent.textContent,/compaction-fixture/);
});

test('legacy snapshots stay explicitly unknown; JSON export uses the read-only snapshot',async()=>{
  const data={startedAt:new Date().toISOString(),requests:[],tasks:[{id:'legacy-task',cohort:'baseline',durationMs:50,exitCode:0}]};
  const {elements,calls,downloads}=await dashboard(data);
  assert.match(elements['usage-window'].textContent,/Usage accounting unavailable/);
  assert.match(elements.tasks.textContent,/Unknown · start and usage unconfirmed/);
  assert.equal(cells(elements.usage.children[0])[3],'—');
  assert.equal(elements.error.textContent,'');
  await elements.export.onclick();
  assert.equal(downloads.length,1);
  assert.deepEqual(JSON.parse(await downloads[0].text()),data);
  assert.equal(calls.at(-1).path,'/control/metrics');
  assert.equal(calls.at(-1).options.method,undefined);
});
