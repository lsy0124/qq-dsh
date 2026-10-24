import {spawnSync} from 'node:child_process';
import {PROJECT_ROOT} from '../src/core/runtime-config.mjs';
for(const args of [['--test','src/core/*.test.mjs'],['scripts/test-audit.mjs']]) {
  const result=spawnSync(process.execPath,args,{cwd:PROJECT_ROOT,stdio:'inherit',env:{...process.env,QQ_BRIDGE_TEST_LIVE:'0'}});
  if(result.error||result.status!==0) {process.exitCode=1;break;}
}
