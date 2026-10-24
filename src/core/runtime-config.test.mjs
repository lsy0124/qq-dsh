import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateConfig,readLocalConfig,resolveRuntimePaths} from './runtime-config.mjs';
import {buildLaunchSpec} from '../../launch-bridge.mjs';

test('configuration rejects malformed structures, ports, IDs and credential URLs',()=>{
  for(const config of [null,[],{dsh:[]},{paths:{ffmpeg:1}},{consolePort:'3100'},{consolePort:65536},{ownerQQ:-1},{allow:{private:['abc']}},{snowluma:{wsUrl:'http://localhost'}},{dsh:{baseUrl:['http:','/','/','user:','secret','@localhost'].join('')}}]) {
    assert.throws(()=>validateConfig(config));
  }
  assert.equal(validateConfig({consolePort:0,ownerQQ:null,allow:{private:['42']}}).consolePort,0);
});

test('malformed JSON is preserved and missing optional config uses defaults',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-dsh-config-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.deepEqual(readLocalConfig(root,{env:{}}),{});
  assert.throws(()=>readLocalConfig(root,{env:{},required:true}),/npm run init/);
  const original='{broken'; fs.writeFileSync(path.join(root,'config.json'),original);
  assert.throws(()=>readLocalConfig(root,{env:{}}),/not changed/);
  assert.equal(fs.readFileSync(path.join(root,'config.json'),'utf8'),original);
});

test('environment credentials override in memory and never rewrite the file',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-dsh-env-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const original='\uFEFF{"snowluma":{"accessToken":"old"}}'; fs.writeFileSync(path.join(root,'config.json'),original);
  const config=readLocalConfig(root,{env:{ONEBOT_ACCESS_TOKEN:'fixture-new',DSH_WEB_URL:'http://localhost:40123'}});
  assert.equal(config.snowluma.accessToken,'fixture-new'); assert.equal(config.dsh.baseUrl,'http://localhost:40123');
  assert.equal(fs.readFileSync(path.join(root,'config.json'),'utf8'),original);
});

test('runtime paths honor environment, configured paths, placeholders and PATH commands',()=>{
  const root=path.resolve('test project');
  const paths=resolveRuntimePaths({paths:{biliPython:'<PYTHON>',ffmpeg:'tools/ffmpeg',rvcDir:'rvc'}},{root,env:{FFMPEG_PATH:'ffmpeg'},platform:'linux'});
  assert.equal(paths.ffmpeg,'ffmpeg'); assert.equal(paths.biliPython,'python3'); assert.equal(paths.rvcDir,path.join(root,'rvc'));
  assert.equal(paths.rvcInferScript,path.resolve(root,'../RVC/rvc_infer.py'));
  assert.equal(resolveRuntimePaths({paths:{ffmpeg:'tools/ffmpeg'}},{root,env:{}}).ffmpeg,path.join(root,'tools/ffmpeg'));
});

test('launcher preserves Node, DSH_HOME and endpoint settings without fixed machine paths',()=>{
  const spec=buildLaunchSpec({root:path.resolve('fixture'),executable:process.execPath,config:{dsh:{baseUrl:'http://localhost:45678'}},env:{DSH_HOME:'custom-home',DSH_WEB_URL:'http://localhost:45678'},platform:'win32'});
  assert.equal(spec.command,process.execPath); assert.equal(spec.env.DSH_HOME,'custom-home');
  assert.equal(spec.env.DSH_WEB_URL,'http://localhost:45678'); assert.equal(spec.args[0],'--env-file-if-exists=.env');
  assert.ok(spec.args[1].endsWith(path.join('src','bridge.js')));
});
