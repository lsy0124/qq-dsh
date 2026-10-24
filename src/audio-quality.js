// Detect the broad-band noise pattern observed in failed GPT-SoVITS output.
// This cannot certify pronunciation or voice style.
export function inspectSpeechWav(wav) {
  if (wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE') throw Error('无效 WAV 音频');
  let fmt,pcm;
  for(let p=12;p+8<=wav.length;){
    const n=wav.readUInt32LE(p+4),end=p+8+n;
    if(end>wav.length)throw Error('WAV 数据被截断');
    const name=wav.toString('ascii',p,p+4);
    if(name==='fmt ')fmt=wav.subarray(p+8,end);
    if(name==='data')pcm=wav.subarray(p+8,end);
    p=end+(n%2);
  }
  if(!fmt||fmt.length<16||!pcm)throw Error('WAV 缺少音频数据');
  if(fmt.readUInt16LE(0)!==1||fmt.readUInt16LE(2)!==1||fmt.readUInt16LE(14)!==16)return {checked:false};
  const count=Math.floor(pcm.length/2);let energy=0,crossings=0,last=0;
  for(let i=0;i<count;i++){const x=pcm.readInt16LE(i*2)/32768;energy+=x*x;if(i&&x*last<0)crossings++;last=x;}
  const rms=Math.sqrt(energy/Math.max(1,count)),zcr=crossings/Math.max(1,count-1);
  if(rms<0.0003)throw Error('语音几乎无声，已停止发送');
  if(zcr>0.18)throw Error('检测到疑似强烈高频杂音，已停止发送；请重新合成');
  return {checked:true,rms,zcr,seconds:count/fmt.readUInt32LE(4)};
}
