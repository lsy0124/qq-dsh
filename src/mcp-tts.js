import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {synthesizeSpeech,ttsStatus} from './tts-core.js';
const server=new McpServer({name:'tts',version:'1.0.0'});
server.tool('tts_status','检查本机语音合成与参考音频是否就绪。',{},async()=>({content:[{type:'text',text:JSON.stringify(await ttsStatus())}]}));
server.tool('tts_synthesize','把要说的话合成为语音库中的 WAV，返回文件名。随后调用 qq_send_voice 发送；不接受任意路径，也不自动发送。',{text:z.string().min(1).max(600)},async({text})=>{
  try{return {content:[{type:'text',text:JSON.stringify(await synthesizeSpeech(text))}]};}
  catch(e){return {isError:true,content:[{type:'text',text:String(e.message)}]};}
});
await server.connect(new StdioServerTransport());
console.error('[tts-mcp] ready');
