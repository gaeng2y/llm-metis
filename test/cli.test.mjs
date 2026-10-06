import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { detectUpstream, codexArgs } from '../dist/cli.js';

const exec=promisify(execFile);
test('authentication selection and ephemeral Codex arguments',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'metis auth '));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'do-not-log'}}));
  assert.equal(await detectUpstream({CODEX_HOME:dir}),'https://chatgpt.com/backend-api/codex');
  assert.equal(await detectUpstream({CODEX_HOME:dir,UPSTREAM_BASE_URL:'https://custom.example/v1'}),'https://custom.example/v1');
  await writeFile(join(dir,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'do-not-log'}));
  assert.equal(await detectUpstream({CODEX_HOME:dir}),'https://api.openai.com/v1');
  const args=codexArgs('http://127.0.0.1:8791');
  assert.ok(args.includes('model_providers.metis.requires_openai_auth=true'));
  assert.ok(args.includes('model_providers.metis.supports_websockets=false'));
  assert.ok(!args.join(' ').includes('do-not-log'));
});

test('CLI lifecycle, flags, task metrics, and unchanged Codex config',async t=>{
  const dir=await mkdtemp(join(tmpdir(),"metis cli 한글 ' & "));
  const portServer=createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');
  const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const fake=join(dir,'fake-codex.mjs');
  const evaluatorKeys=['TYPESAFE_API_KEY','OPENROUTER_API_KEY','AI_GATEWAY_API_KEY'];
  await writeFile(fake,`import {writeFileSync} from "node:fs"; writeFileSync(process.env.METIS_TEST_CAPTURE,JSON.stringify({args:process.argv.slice(2),token:!!process.env.METIS_CONTROL_TOKEN,task:!!process.env.METIS_CONTROL_TASK_ID,evaluatorKeys:Object.fromEntries(${JSON.stringify(evaluatorKeys)}.map(key=>[key,Object.keys(process.env).some(name=>name.toUpperCase()===key)]))}));\n`,{mode:0o600});
  const original='# untouched normal config\nmodel = "gpt-6-astra"\n';await writeFile(join(dir,'config.toml'),original);
  const env={...process.env,METIS_CONFIG:join(dir,'metis.json'),METIS_PROVIDER:'typesafe',METIS_STATE_DIR:join(dir,'state'),CODEX_HOME:dir,METIS_PORT:String(port),METIS_CODEX_BIN:fake,METIS_TEST_CAPTURE:join(dir,'capture.json'),UPSTREAM_BASE_URL:'http://127.0.0.1:1/v1'};
  for(const key of Object.keys(env))if(evaluatorKeys.includes(key.toUpperCase()))delete env[key];
  for(const key of evaluatorKeys)env[process.platform==='win32'?key.toLowerCase():key]='fake-evaluator-key';
  const cli=(...args)=>exec(process.execPath,['bin/metis-codex.mjs',...args],{env,timeout:15000});
  t.after(async()=>{await cli('--stop').catch(()=>{});await rm(dir,{recursive:true,force:true});});
  assert.match((await cli('--status')).stdout,/stopped/);
  await cli('--start');
  const statePath=join(dir,'state','instance.json');
  const info=JSON.parse(await readFile(statePath,'utf8'));
  if(process.platform==='win32'){
    const powershell=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    // Windows PowerShell 5.1 must rebuild module paths inherited from PowerShell 7 via Node.
    const probeEnv=Object.fromEntries(Object.entries({...env,METIS_TEST_STATE:statePath}).filter(([key])=>key.toUpperCase()!=='PSMODULEPATH'));
    const command='$ErrorActionPreference="Stop"; $acl=Get-Acl -LiteralPath $env:METIS_TEST_STATE; [pscustomobject]@{protected=$acl.AreAccessRulesProtected; currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=@($acl.Access | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; inherited=$_.IsInherited; type=[string]$_.AccessControlType; rights=[string]$_.FileSystemRights} })} | ConvertTo-Json -Depth 4 -Compress';
    const acl=JSON.parse((await exec(powershell,['-NoProfile','-NonInteractive','-Command',command],{env:probeEnv,timeout:10000})).stdout);
    assert.equal(acl.protected,true);
    assert.deepEqual(acl.rules,[{sid:acl.currentSid,inherited:false,type:'Allow',rights:'FullControl'}]);
  }else assert.equal((await stat(statePath)).mode&0o777,0o600);
  assert.equal(JSON.parse((await cli('--status')).stdout).service,'llm-metis');
  await cli('--tool-routing','off');assert.equal(JSON.parse((await cli('--status')).stdout).toolRouting,false);
  await cli('--routing','off');assert.equal(JSON.parse((await cli('--status')).stdout).effortRouting,false);
  await cli('--effort-routing','on');assert.equal(JSON.parse((await cli('--status')).stdout).effortRouting,true);
  const prompt='파일 "읽기" & | %PATH% $(echo untouched)';
  await cli('--','exec','-c','model_reasoning_effort="high"',prompt);
  const capture=JSON.parse(await readFile(env.METIS_TEST_CAPTURE,'utf8'));
  assert.deepEqual(capture.args.slice(0,4),['exec','-c','model_reasoning_effort="high"',prompt]);
  assert.ok(capture.args.indexOf('model_provider="metis"')>capture.args.indexOf('exec'));
  assert.equal(capture.token,true);assert.equal(capture.task,true);
  assert.deepEqual(capture.evaluatorKeys,Object.fromEntries(evaluatorKeys.map(key=>[key,false])));
  assert.equal(await readFile(join(dir,'config.toml'),'utf8'),original);
  const metrics=await(await fetch(`http://127.0.0.1:${port}/control/metrics`,{headers:{'x-metis-token':info.token}})).json();
  assert.equal(metrics.tasks.length,1);assert.equal(metrics.tasks[0].cohort,'effort-only');
  assert.ok(metrics.tasks[0].durationMs>=0);assert.equal(metrics.tasks[0].exitCode,0);
  await cli('--stop');assert.match((await cli('--status')).stdout,/stopped/);
});

test('Metis recognizes and safely stops a legacy daemon before launching a new session',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'metis legacy daemon '));
  const state=join(dir,'state');await mkdir(state);
  const token='a'.repeat(64);
  const requests=[];
  let stopped=false;
  const server=createServer((req,res)=>{
    requests.push({path:req.url,method:req.method,token:req.headers['x-jev-token']});
    res.setHeader('content-type','application/json');
    if(stopped||req.headers['x-jev-token']!==token){res.writeHead(401);res.end('{}');return;}
    if(req.url==='/control/status'){res.end(JSON.stringify({service:'jev-control',pid:process.pid,toolRouting:true,effortRouting:true}));return;}
    if(req.url==='/control/stop'&&req.method==='POST'){stopped=true;res.end('{}');return;}
    res.writeHead(404);res.end('{}');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const port=server.address().port;
  await writeFile(join(state,'instance.json'),JSON.stringify({id:'legacy-fixture',token,port,pid:process.pid}),{mode:0o600});
  const capture=join(dir,'unexpected-codex-launch');
  const fakeCodex=join(dir,'fake-codex.mjs');
  await writeFile(fakeCodex,"import {writeFileSync} from 'node:fs'; writeFileSync(process.env.METIS_TEST_CAPTURE,'launched');\n");
  const env={...process.env,METIS_CONFIG:join(dir,'settings.json'),METIS_STATE_DIR:state,METIS_PORT:String(port),METIS_CODEX_BIN:fakeCodex,METIS_TEST_CAPTURE:capture};
  const cli=(...args)=>exec(process.execPath,['bin/metis-codex.mjs',...args],{env,timeout:15000});
  assert.equal(JSON.parse((await cli('--status')).stdout).service,'jev-control');
  for(const args of [['--start'],['--','exec','Fixture only']]){
    await assert.rejects(cli(...args),error=>{
      assert.match(error.stderr,/--stop/);
      assert.match(error.stderr,/--start/);
      return true;
    });
  }
  await assert.rejects(stat(capture),{code:'ENOENT'});
  assert.ok(requests.every(request=>request.path==='/control/status'));
  assert.match((await cli('--stop')).stdout,/stopped/);
  assert.deepEqual(requests.filter(request=>request.path==='/control/stop'),[{path:'/control/stop',method:'POST',token}]);
  assert.match((await cli('--status')).stdout,/stopped/);
});

test('default legacy discovery respects its port and stopping Metis does not stop a second daemon',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'metis default migration '));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('METIS_')&&!key.toUpperCase().startsWith('JEV_')&&!['HOME','USERPROFILE','CODEX_HOME'].includes(key.toUpperCase())));
  Object.assign(env,{HOME:dir,USERPROFILE:dir,CODEX_HOME:dir,METIS_CONFIG:join(dir,'settings.json')});
  const cli=(...args)=>exec(process.execPath,[fileURLToPath(new URL('../bin/metis-codex.mjs',import.meta.url)),...args],{env,cwd:dir,timeout:15000});
  const instances=[
    {service:'llm-metis',header:'x-metis-token',token:'b'.repeat(64),stopped:false,stops:0,requests:0},
    {service:'jev-control',header:'x-jev-token',token:'c'.repeat(64),stopped:false,stops:0,requests:0},
  ];
  t.after(async()=>{
    for(const instance of instances)if(instance.server){instance.server.closeAllConnections();await new Promise(resolve=>instance.server.close(resolve));}
    await rm(dir,{recursive:true,force:true});
  });
  for(const instance of instances){
    instance.server=createServer((req,res)=>{
      instance.requests++;
      res.setHeader('content-type','application/json');
      if(instance.stopped||req.headers[instance.header]!==instance.token){res.writeHead(401);res.end('{}');return;}
      if(req.url==='/control/status'){res.end(JSON.stringify({service:instance.service,pid:process.pid}));return;}
      if(req.url==='/control/stop'&&req.method==='POST'){instance.stopped=true;instance.stops++;res.end('{}');return;}
      res.writeHead(404);res.end('{}');
    });
    instance.server.listen(0,'127.0.0.1');await once(instance.server,'listening');
    instance.port=instance.server.address().port;
    instance.file=join(dir,'.local','state',instance.service,'instance.json');
    await mkdir(join(dir,'.local','state',instance.service),{recursive:true});
  }
  const [current,legacy]=instances;
  const save=instance=>writeFile(instance.file,JSON.stringify({id:instance.service,token:instance.token,port:instance.port,pid:process.pid}),{mode:0o600});
  await save(legacy);
  env.METIS_PORT=String(legacy.port);
  assert.equal(JSON.parse((await cli('--status')).stdout).service,'jev-control');
  const before=legacy.requests;
  env.METIS_PORT=String(current.port);
  assert.match((await cli('--status')).stdout,/stopped/);
  assert.equal(legacy.requests,before);
  env.METIS_PORT=String(legacy.port);
  await save(current);
  assert.equal(JSON.parse((await cli('--status')).stdout).service,'llm-metis');
  assert.match((await cli('--stop')).stdout,/stopped/);
  assert.equal(current.stops,1);
  assert.equal(legacy.stops,0);
  assert.equal(JSON.parse((await cli('--status')).stdout).service,'jev-control');
});
