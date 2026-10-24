import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/core/runtime-config.mjs';
const destination=path.join(PROJECT_ROOT,'config.json');
try {
  fs.copyFileSync(path.join(PROJECT_ROOT,'config.example.json'),destination,fs.constants.COPYFILE_EXCL);
  console.log('Created config.json. Set your DSH/OneBot endpoints and QQ allowlist before starting.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('config.json already exists; it was not overwritten.');
  else throw error;
}
