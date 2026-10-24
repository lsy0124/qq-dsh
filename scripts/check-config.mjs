import fs from 'node:fs';
import { readLocalConfig, resolveRuntimePaths } from '../src/core/runtime-config.mjs';
try {
  const config=readLocalConfig(undefined,{required:true});
  const paths=resolveRuntimePaths(config);
  console.log('Configuration structure and URL protocols are valid. Credentials were not printed.');
  if (!config.allowAllWhenEmpty && !config.allow?.private?.length && !config.allow?.groups?.length) console.log('NOTICE: allowlist is empty; QQ replies remain disabled.');
  for (const key of ['rvcInferScript','asrScript','douyinDir']) console.log(`${key}: ${fs.existsSync(paths[key])?'present':'optional dependency not installed'}`);
  console.log('This is a local configuration check, not a QQ/DSH connection test.');
} catch(error) { console.error(error.message); process.exitCode=1; }
