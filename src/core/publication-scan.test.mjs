import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {findSecretLiterals} from './publication-scan.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));

test('literal detection reports positions without leaking the matched value',()=>{
  const secret='gh'+'p_'+'A'.repeat(36);
  const findings=findSecretLiterals(`line one\nconst token='${secret}';`);
  assert.equal(findings[0].line,2); assert.equal(findings[0].rule,'github-token'); assert.ok(!JSON.stringify(findings).includes(secret));
});
test('privacy allowlisted core files still undergo high-confidence credential checks',t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-dsh-publication-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  for(const file of ['scripts/privacy-scan.mjs','src/core/publication-scan.mjs']) {fs.mkdirSync(path.dirname(path.join(temp,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(temp,file));}
  const secret='gh'+'p_'+'B'.repeat(36);fs.writeFileSync(path.join(temp,'src/bridge.js'),`const secret='${secret}';`);
  const result=spawnSync(process.execPath,[path.join(temp,'scripts/privacy-scan.mjs'),'--json'],{encoding:'utf8',cwd:temp});
  assert.equal(result.status,1); const report=JSON.parse(result.stdout); assert.ok(report.findings.some(f=>f.rule==='github-token'&&f.file==='src/bridge.js'));
  assert.ok(!result.stdout.includes(secret));
});
