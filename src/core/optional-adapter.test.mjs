import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {PROJECT_ROOT} from './runtime-config.mjs';

test('Douyin MCP starts without its external adapter and rejects disabled writes before loading it', {timeout:15000}, async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-dsh-optional-'));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(PROJECT_ROOT,'src/mcp-douyin.js')],cwd:temp,env:{DOUYIN_DIR:path.join(temp,'not-installed'),DOUYIN_ALLOW_WRITES:'0'},stderr:'pipe'});
  const client=new Client({name:'qq-dsh-offline-fixture',version:'1.0.0'});
  t.after(async()=>{await client.close();await transport.close();fs.rmSync(temp,{recursive:true,force:true});});
  await client.connect(transport);
  const {tools}=await client.listTools();
  assert.ok(tools.some(tool=>tool.name==='douyin_send_message'));
  assert.ok(tools.some(tool=>tool.name==='douyin_status'));
  const result=await client.callTool({name:'douyin_send_message',arguments:{to:'fixture',text:'fixture-only'}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/disabled/);
});
