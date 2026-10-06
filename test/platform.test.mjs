import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { codexLaunch, dashboardLaunch, writePrivateFile } from '../dist/platform.js';

const args=['exec','-c','model_reasoning_effort="high"','파일 "읽기" & | %PATH% $(echo untouched)'];
const windowsFiles=(...paths)=>{
  const files=new Set(paths.map(path=>win32.normalize(path).toLowerCase()));
  return path=>files.has(win32.normalize(path).toLowerCase());
};

test('JavaScript entry points use Node and preserve arguments on every platform',()=>{
  for(const platform of ['darwin','linux','win32'])for(const extension of ['js','mjs','cjs']){
    const binary=platform==='win32'?String.raw`C:\Program Files\Codex\codex.${extension}`:`/opt/Codex CLI/codex.${extension}`;
    assert.deepEqual(codexLaunch(binary,args,{},platform),{file:process.execPath,args:[binary,...args]});
  }
  assert.deepEqual(codexLaunch('/opt/Codex CLI/codex',args,{},'linux'),{file:'/opt/Codex CLI/codex',args});
});

test('Windows finds global npm Codex through case-insensitive PATH and quoted directories',()=>{
  const dir=String.raw`C:\Users\Test User\AppData\Roaming\npm`;
  const shim=win32.join(dir,'codex.cmd');
  const entry=win32.join(dir,'node_modules/@openai/codex/bin/codex.js');
  const exists=windowsFiles(shim,entry);
  assert.deepEqual(codexLaunch('codex',args,{Path:`"${dir}"`},'win32',exists),{file:process.execPath,args:[entry,...args]});
  assert.deepEqual(codexLaunch(shim,args,{},'win32',exists),{file:process.execPath,args:[entry,...args]});
});

test('Windows resolves a local npm shim and native executables without a shell',()=>{
  const dir=String.raw`D:\work space\node_modules\.bin`;
  const shim=win32.join(dir,'codex.cmd');
  const entry=win32.join(dir,'../@openai/codex/bin/codex.js');
  assert.deepEqual(codexLaunch('codex',args,{PATH:dir},'win32',windowsFiles(shim,entry)),{file:process.execPath,args:[entry,...args]});
  const native=String.raw`C:\Program Files\Codex\codex.exe`;
  assert.deepEqual(codexLaunch(native,args,{},'win32',windowsFiles(native)),{file:native,args});
  assert.deepEqual(codexLaunch('codex',args,{PATH:win32.dirname(native)},'win32',windowsFiles(native)),{file:native,args});
});

test('Windows rejects unrecognized batch shims and missing executables',()=>{
  for(const binary of [String.raw`C:\tools\wrapper.cmd`,String.raw`C:\tools\codex.bat`]){
    assert.throws(()=>codexLaunch(binary,args,{},'win32',windowsFiles(binary)),/Unsupported Codex command shim/);
  }
  assert.throws(()=>codexLaunch('codex',args,{PATH:String.raw`C:\empty`},'win32',()=>false),/Codex executable not found/);
});

test('dashboard openers preserve the URL and use absolute Windows system paths',()=>{
  const url='http://127.0.0.1:8791/dashboard#token=test-token';
  assert.deepEqual(dashboardLaunch(url,'darwin'),{file:'open',args:[url]});
  assert.deepEqual(dashboardLaunch(url,'linux'),{file:'xdg-open',args:[url]});
  const launch=dashboardLaunch(url,'win32');
  assert.ok(win32.isAbsolute(launch.file));
  assert.equal(win32.basename(launch.file),'rundll32.exe');
  assert.equal(launch.args[0],`${win32.join(win32.dirname(launch.file),'url.dll')},FileProtocolHandler`);
  assert.equal(launch.args[1],url);
});

test('Windows grants only the current SID access before writing private contents',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'metis private '));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'instance.json');
  const sid='S-1-5-21-100-200-300-1001';
  const calls=[];
  await writePrivateFile(path,'private-test-token','win32',async(file,argv,options)=>{
    assert.equal(await readFile(path,'utf8'),'');
    assert.ok(win32.isAbsolute(file));
    assert.deepEqual(options,{windowsHide:true});
    calls.push({file:win32.basename(file),argv});
    return {stdout:`"test-user","${sid}"\r\n`,stderr:''};
  });
  assert.deepEqual(calls,[
    {file:'whoami.exe',argv:['/user','/fo','csv','/nh']},
    {file:'icacls.exe',argv:[path,'/inheritance:r','/grant:r',`*${sid}:F`]},
  ]);
  assert.equal(await readFile(path,'utf8'),'private-test-token');
});

test('Windows permission failures remove the empty file without writing private contents',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'metis private failure '));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const behavior of ['whoami-error','missing-sid','acl-error']){
    const path=join(dir,`${behavior}.json`);
    const calls=[];
    await assert.rejects(writePrivateFile(path,'private-test-token','win32',async(file)=>{
      assert.equal(await readFile(path,'utf8'),'');
      calls.push(win32.basename(file));
      if(behavior==='whoami-error'||win32.basename(file)==='icacls.exe')throw Error('permission setup failed');
      return {stdout:behavior==='missing-sid'?'no user SID':'S-1-5-21-100-200-300-1001',stderr:''};
    }),/permission setup failed|Cannot determine the current Windows user/);
    assert.deepEqual(calls,behavior==='acl-error'?['whoami.exe','icacls.exe']:['whoami.exe']);
    await assert.rejects(stat(path),{code:'ENOENT'});
  }
});

test('private file creation is exclusive and preserves existing contents',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'metis private existing '));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'instance.json');
  await writePrivateFile(path,'original','linux',async()=>{throw Error('POSIX must not run permission commands');});
  if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
  for(const platform of ['linux','win32']){
    await assert.rejects(writePrivateFile(path,'replacement',platform,async()=>{throw Error('must not run');}),{code:'EEXIST'});
    assert.equal(await readFile(path,'utf8'),'original');
  }
});
