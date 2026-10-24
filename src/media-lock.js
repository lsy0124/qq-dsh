import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const lock=path.join(root,'state','media-generation.lock');
export async function acquireMediaLock(timeoutMs=360000){
  fs.mkdirSync(path.dirname(lock),{recursive:true});
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    try{
      const fd=fs.openSync(lock,'wx');
      fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:Date.now()}));fs.closeSync(fd);
      return ()=>{try{if(JSON.parse(fs.readFileSync(lock,'utf8')).pid===process.pid)fs.unlinkSync(lock);}catch{}};
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      try{
        const info=JSON.parse(fs.readFileSync(lock,'utf8'));
        try{process.kill(info.pid,0);}catch(e){if(e.code==='ESRCH')fs.unlinkSync(lock);}
      }catch{}
      await new Promise(r=>setTimeout(r,500));
    }
  }
  throw Error('画图或语音任务正在运行，等待超时，请稍后重试。');
}
