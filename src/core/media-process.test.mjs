import test from 'node:test';
import assert from 'node:assert/strict';
import {runMediaProcess} from './media-process.mjs';

test('child output preserves a UTF-8 character split across chunks',async()=>{
  const result=await runMediaProcess(process.execPath,['-e',"const b=Buffer.from('你好');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)"]);
  assert.equal(result.code,0); assert.equal(result.stdout,'你好');
});
test('missing executable resolves with an actionable error',async()=>{
  const result=await runMediaProcess('qq-dsh-fixture-no-such-executable',[]);
  assert.equal(result.code,-1); assert.match(result.stderr,/executable/);
});
test('timed-out media child is stopped and returns partial diagnostics',async()=>{
  const result=await runMediaProcess(process.execPath,['-e',"console.log('started');setInterval(()=>{},1000)"],{timeoutMs:500});
  assert.equal(result.code,-1); assert.equal(result.timedOut,true); assert.match(result.stdout,/started/);
});
test('output cap stops an unbounded child',async()=>{
  const result=await runMediaProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"],{maxOutputBytes:1000,timeoutMs:5000});
  assert.equal(result.outputLimited,true); assert.ok(result.stdout.length<=1000);
});
test('cancellation works both before and during a child process',async()=>{
  const early=AbortSignal.abort(); assert.equal((await runMediaProcess(process.execPath,[],{signal:early})).cancelled,true);
  const controller=new AbortController(); const promise=runMediaProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});
  setTimeout(()=>controller.abort(),100); assert.equal((await promise).cancelled,true);
});
