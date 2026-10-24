import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, readLocalConfig, resolveRuntimePaths } from './src/core/runtime-config.mjs';

export function buildLaunchSpec({ root=PROJECT_ROOT, env=process.env, executable=process.execPath, platform=process.platform, config }={}) {
  const settings=config ?? readLocalConfig(root,{env,required:true});
  const paths=resolveRuntimePaths(settings,{root,env,platform});
  const desktopHome=platform==='win32' && env.APPDATA ? path.join(env.APPDATA,'dsh-desktop','harness') : path.join(os.homedir(),'.dsh');
  return {command:executable,args:['--env-file-if-exists=.env',path.join(root,'src','bridge.js')],cwd:root,
    env:{...env,DSH_HOME:env.DSH_HOME||desktopHome,DSH_PROFILE:env.DSH_PROFILE||'web',FFMPEG_PATH:paths.ffmpeg,FFPROBE_PATH:paths.ffprobe}};
}

export async function launch({foreground=false}={}) {
  const spec=buildLaunchSpec();
  let output,error;
  if (!foreground) {
    const logs=path.join(PROJECT_ROOT,'state','logs'); fs.mkdirSync(logs,{recursive:true});
    output=fs.openSync(path.join(logs,'bridge-out.log'),'a',0o600);
    error=fs.openSync(path.join(logs,'bridge-err.log'),'a',0o600);
  }
  let child;
  try {
    child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,detached:!foreground,windowsHide:!foreground,stdio:foreground?'inherit':['ignore',output,error]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  } finally {
    if(output!==undefined) fs.closeSync(output);
    if(error!==undefined) fs.closeSync(error);
  }
  if (!foreground) {child.unref(); console.log(`Bridge process spawned: PID=${child.pid}. Check its log and console health before treating it as ready.`);}
  else child.once('exit',(code,signal)=>{process.exitCode=signal?1:(code??1);});
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  launch({foreground:process.argv.includes('--foreground')}).catch(error=>{console.error('[launcher]',error.message);process.exitCode=1;});
}
