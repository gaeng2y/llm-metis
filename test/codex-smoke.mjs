import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const dir=await mkdtemp(join(tmpdir(),'metis codex smoke '));
const calls=[];
const usage={input_tokens:20,output_tokens:3,total_tokens:23,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}};
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
 calls.push({path:req.url,model:body.model,effort:body.reasoning?.effort,hasAuth:!!req.headers.authorization,questions:Object.keys(body.questions??{}),toolTypes:(body.tools??[]).map(t=>t.type),inputTypes:Array.isArray(body.input)?[...new Set(body.input.map(i=>i.type??i.role))]:[]});
 if(req.url==='/evaluate'){res.setHeader('content-type','application/json');res.end(JSON.stringify({answers:{tool:{type:'choice',choice:'passthrough',confidence:1},effort:{type:'choice',choice:'low',confidence:1}}}));return;}
 if(req.url?.includes('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[]}));return;}
 const item={id:'msg_fixture',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'fixture complete',annotations:[]}]};
 const response={id:'resp_fixture',object:'response',created_at:1,status:'completed',model:body.model,output:[item],usage};
 const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'fixture complete'},{type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:'fixture complete'},{type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
 res.setHeader('content-type','text/event-stream');res.end(events.map((e,i)=>`event: ${e.type}\ndata: ${JSON.stringify({...e,sequence_number:i})}\n\n`).join(''));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const picker=createServer();picker.listen(0,'127.0.0.1');await once(picker,'listening');const port=picker.address().port;await new Promise(r=>picker.close(r));
const env={PATH:process.env.PATH,HOME:dir,CODEX_HOME:dir,JEV_STATE_DIR:join(dir,'state'),JEV_PORT:String(port),UPSTREAM_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,OPENAI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,OPENROUTER_API_KEY:'test-not-real',JEV_URL:`http://127.0.0.1:${server.address().port}/evaluate`,JEV_CODEX_BIN:process.env.JEV_CODEX_BIN??'codex'};
if(process.platform==='win32')Object.assign(env,{SystemRoot:process.env.SystemRoot,COMSPEC:process.env.COMSPEC,PATHEXT:process.env.PATHEXT,USERPROFILE:dir,LOCALAPPDATA:dir,APPDATA:dir,TEMP:dir,TMP:dir});
await writeFile(join(dir,'config.toml'),`openai_base_url = "http://127.0.0.1:${server.address().port}/v1"\nchatgpt_base_url = "http://127.0.0.1:${server.address().port}"\n`);
await writeFile(join(dir,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'test-not-real'}),{mode:0o600});
const bin=fileURLToPath(new URL('../bin/jev-codex.mjs',import.meta.url));
try{
 const pending=exec(process.execPath,[bin,'--','exec','--skip-git-repo-check','--model','gpt-6-astra','-c','model_reasoning_effort="high"','Reply with fixture complete'],{env,cwd:dir,timeout:30000,maxBuffer:1000000});
 pending.child.stdin.end();
 const result=await pending;
 assert.ok(result.stdout.includes('fixture complete'));
 assert.equal(calls.filter(c=>c.path==='/evaluate').length,1);
 assert.equal(calls.find(c=>c.path==='/evaluate')?.model,'typesafe/jev-1.13');
 const modelCall=calls.find(c=>c.path==='/v1/responses');
 assert.equal(modelCall?.model,'gpt-6-astra');
 assert.equal(modelCall?.effort,'low');
 assert.equal(modelCall?.hasAuth,true);
 console.log('Installed Codex: gateway selected, one Jev call, high -> low effort, SSE completed.');
}catch(e){console.log(JSON.stringify({ok:false,message:e.message,stdout:e.stdout?.slice(-500),stderr:e.stderr?.slice(-2000),calls},null,2));process.exitCode=1;}
finally{await exec(process.execPath,[bin,'--stop'],{env,cwd:dir,timeout:10000}).catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
