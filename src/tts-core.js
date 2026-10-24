import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireMediaLock} from './media-lock.js';
import {inspectSpeechWav} from './audio-quality.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function settings(){
  const cfg=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
  const t=cfg.tts??{};
  const base=new URL(t.baseUrl||'http://127.0.0.1:9880');
  if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw Error('TTS 仅允许本机服务');
  const voiceDir=path.resolve(root,cfg.socialV2?.voice?.dir||'audio');
  return {cfg,t,base:base.href.replace(/\/$/,''),voiceDir,ref:path.resolve(root,t.refAudio||'audio-ref/ref_5s.wav')};
}
export async function ttsStatus(){
  const s=settings();let online=false;
  try{online=(await fetch(`${s.base}/docs`,{signal:AbortSignal.timeout(5000)})).ok;}catch{}
  return {online,referenceExists:fs.existsSync(s.ref),voiceEnabled:s.cfg.socialV2?.voice?.enabled===true};
}
export async function synthesizeSpeech(text){
  if(typeof text!=='string'||!text.trim()||text.length>600)throw Error('语音文本应为 1～600 字符');
  const s=settings();
  if(s.cfg.socialV2?.voice?.enabled!==true||s.cfg.socialV2?.tools?.sendVoice!==true)throw Error('语音功能未启用');
  if(!fs.existsSync(s.ref))throw Error('参考音频不存在');
  const release=await acquireMediaLock();
  try{
    await fetch('http://127.0.0.1:8188/free',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({unload_models:true,free_memory:true}),signal:AbortSignal.timeout(10000)}).catch(()=>{});
    const res=await fetch(`${s.base}/tts`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,text_lang:s.t.textLang||'zh',ref_audio_path:s.ref,prompt_text:s.t.promptText??'',prompt_lang:s.t.promptLang||'zh',media_type:'wav',streaming_mode:false,seed:42,top_k:5,top_p:1,temperature:1}),signal:AbortSignal.timeout(300000)});
    if(!res.ok)throw Error(`语音合成失败 HTTP ${res.status}: ${(await res.text()).slice(0,300)}`);
    const wav=Buffer.from(await res.arrayBuffer());
    if(wav.length<1000||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw Error('语音服务没有返回有效 WAV');
    if(wav.length>(s.cfg.socialV2?.voice?.maxBytes??20971520))throw Error('语音超过发送体积上限');
    if(!inspectSpeechWav(wav).checked)throw Error('合成服务未返回可检查的单声道 PCM16 WAV');
    fs.mkdirSync(s.voiceDir,{recursive:true});
    const file=`tts-${Date.now()}-${process.pid}.wav`;
    fs.writeFileSync(path.join(s.voiceDir,file),wav);
    return {ok:true,file,bytes:wav.length,hint:'使用 qq_send_voice 将此文件名发送到当前获准的 QQ 会话；本工具仅合成，不发送。'};
  }finally{release();}
}
