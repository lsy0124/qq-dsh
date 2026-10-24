import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export function terminateOwnedChild(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const fallback=()=>{ try { child.kill('SIGKILL'); } catch {} };
    const killer = spawn('taskkill', ['/PID',String(child.pid),'/T','/F'], {windowsHide:true,stdio:'ignore'});
    killer.on('error',fallback);
    killer.on('exit',code=>{if(code!==0) fallback();});
    // Closing the direct child is also necessary in restricted Windows runners
    // where taskkill can stall or report Access Denied without an error event.
    const retry=setTimeout(fallback,500); retry.unref();
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

/** No shell, bounded output, UTF-8 chunk decoding, and one terminal result. */
export function runMediaProcess(command, args, { cwd, env = {}, timeoutMs = 900000, maxOutputBytes = 4 * 1024 * 1024, signal } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({code:-1,stdout:'',stderr:'[cancelled]',cancelled:true}); return; }
    let child;
    try { child=spawn(command,args,{cwd,env:{...process.env,PYTHONUTF8:'1',...env},windowsHide:true,stdio:['ignore','pipe','pipe']}); }
    catch { resolve({code:-1,stdout:'',stderr:'[process could not start]'}); return; }
    const outDecoder=new StringDecoder('utf8'), errDecoder=new StringDecoder('utf8');
    let stdout='',stderr='',bytes=0,settled=false;
    const finish=(code,extra={}) => {
      if (settled) return;
      settled=true; clearTimeout(timer); signal?.removeEventListener('abort',cancel);
      stdout+=outDecoder.end(); stderr+=errDecoder.end();
      resolve({code,stdout,stderr,...extra});
    };
    const cancel=() => { terminateOwnedChild(child); stderr+='\n[cancelled]'; finish(-1,{cancelled:true}); };
    const timer=setTimeout(() => { terminateOwnedChild(child); stderr+='\n[process timed out]'; finish(-1,{timedOut:true}); },timeoutMs);
    const consume=(chunk,decoder,isError) => {
      if (settled) return;
      bytes+=chunk.length;
      if (bytes>maxOutputBytes) { terminateOwnedChild(child); stderr+='\n[output limit exceeded]'; finish(-1,{outputLimited:true}); return; }
      if (isError) stderr+=decoder.write(chunk); else stdout+=decoder.write(chunk);
    };
    child.stdout.on('data',chunk=>consume(chunk,outDecoder,false));
    child.stderr.on('data',chunk=>consume(chunk,errDecoder,true));
    child.on('close',code=>finish(code??-1));
    child.on('error',()=>{ stderr+='\n[executable missing or unable to start]'; finish(-1); });
    signal?.addEventListener('abort',cancel,{once:true});
    if (signal?.aborted) cancel();
  });
}
