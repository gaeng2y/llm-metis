import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec=promisify(execFile);
const dir=await mkdtemp(join(tmpdir(),'metis claude smoke '));
const calls=[];
const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:req.url,model:body.model,effort:body.output_config?.effort,hasAuth:!!req.headers['x-api-key'],questions:Object.keys(body.questions??{})});
  res.setHeader('content-type','application/json');
  if(req.url==='/evaluate'){res.end(JSON.stringify({answers:{tool:{type:'choice',choice:'passthrough',confidence:1},effort:{type:'choice',choice:'low',confidence:1}}}));return;}
  if(req.url?.startsWith('/v1/messages/count_tokens')){res.end(JSON.stringify({input_tokens:20}));return;}
  if(!req.url?.startsWith('/v1/messages')){res.writeHead(404);res.end('{}');return;}
  const message={id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0}};
  const events=[
    {type:'message_start',message},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'fixture complete'}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},
    {type:'message_stop'},
  ];
  res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const picker=createServer();picker.listen(0,'127.0.0.1');await once(picker,'listening');
const port=picker.address().port;await new Promise(r=>picker.close(r));
const upstream=`http://127.0.0.1:${server.address().port}`;
const env={PATH:process.env.PATH,HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'claude'),METIS_CONFIG:join(dir,'metis.json'),METIS_STATE_DIR:join(dir,'state'),METIS_PORT:String(port),
  METIS_ANTHROPIC_BASE_URL:upstream,ANTHROPIC_BASE_URL:upstream,ANTHROPIC_API_KEY:'test-not-real',
  OPENROUTER_API_KEY:'test-not-real',METIS_URL:`${upstream}/evaluate`,METIS_CLAUDE_BIN:process.env.METIS_CLAUDE_BIN??'claude',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
if(process.platform==='win32')Object.assign(env,{SystemRoot:process.env.SystemRoot,COMSPEC:process.env.COMSPEC,PATHEXT:process.env.PATHEXT,USERPROFILE:dir,LOCALAPPDATA:dir,APPDATA:dir,TEMP:dir,TMP:dir});
const bin=fileURLToPath(new URL('../bin/metis-claude.mjs',import.meta.url));
try{
  // Bare mode avoids user hooks, plugin setup, keychain reads, and background prefetches.
  const pending=exec(process.execPath,[bin,'--','--bare','-p','--no-session-persistence','--model','claude-sonnet-4-6','--effort','high','--tools','','--','Reply with fixture complete'],{env,cwd:dir,timeout:30000,maxBuffer:1000000});
  pending.child.stdin.end();
  const result=await pending;
  assert.ok(result.stdout.includes('fixture complete'));
  assert.equal(calls.filter(c=>c.path==='/evaluate').length,1);
  const modelCall=calls.find(c=>c.path?.startsWith('/v1/messages')&&!c.path.includes('count_tokens'));
  assert.equal(modelCall?.model,'claude-sonnet-4-6');
  assert.equal(modelCall?.effort,'low');assert.equal(modelCall?.hasAuth,true);
  console.log('Installed Claude Code: gateway selected, one Jev call, high -> low effort, SSE completed.');
}catch(e){console.log(JSON.stringify({ok:false,message:e.message,stdout:e.stdout?.slice(-500),stderr:e.stderr?.slice(-2000),calls},null,2));process.exitCode=1;}
finally{await exec(process.execPath,[bin,'--stop'],{env,cwd:dir,timeout:10000}).catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
