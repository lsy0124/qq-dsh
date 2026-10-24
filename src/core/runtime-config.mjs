import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const configured = value => typeof value === 'string' && value.trim() && !/^<[^>]+>$/.test(value.trim());

function validateUrl(value, name, protocols) {
  if (value === undefined || value === '') return;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid URL (value redacted).`); }
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} has an unsupported protocol or embedded credentials (value redacted).`);
  }
}

export function validateConfig(config) {
  if (!object(config)) throw new Error('config.json must contain a JSON object.');
  for (const name of ['dsh','snowluma','allow','deny','paths','tts','comfyui']) {
    if (config[name] !== undefined && !object(config[name])) throw new Error(`${name} must be an object.`);
  }
  validateUrl(config.dsh?.baseUrl, 'dsh.baseUrl', ['http:','https:']);
  validateUrl(config.snowluma?.wsUrl, 'snowluma.wsUrl', ['ws:','wss:']);
  validateUrl(config.snowluma?.httpUrl, 'snowluma.httpUrl', ['http:','https:']);
  validateUrl(config.tts?.baseUrl, 'tts.baseUrl', ['http:','https:']);
  validateUrl(config.comfyui?.baseUrl, 'comfyui.baseUrl', ['http:','https:']);
  if (config.consolePort !== undefined && (!Number.isInteger(config.consolePort) || config.consolePort < 0 || config.consolePort > 65535)) {
    throw new Error('consolePort must be an integer from 0 to 65535.');
  }
  const validId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  if (config.ownerQQ !== undefined && config.ownerQQ !== null && config.ownerQQ !== '' && !validId(config.ownerQQ)) {
    throw new Error('ownerQQ must be a positive safe integer or null.');
  }
  for (const list of ['allow','deny']) for (const key of ['private','privates','groups','group']) {
    const values = config[list]?.[key];
    if (values !== undefined && (!Array.isArray(values) || !values.every(validId))) throw new Error(`${list}.${key} must contain positive QQ identifiers.`);
  }
  for (const [name, value] of Object.entries(config.paths ?? {})) {
    if (!name.startsWith('_') && typeof value !== 'string') throw new Error(`paths.${name} must be a string.`);
  }
  return config;
}

export function readLocalConfig(root = PROJECT_ROOT, { env = process.env, required = false } = {}) {
  const filename = path.join(root, 'config.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT' && !required) config = {};
    else if (error.code === 'ENOENT') throw new Error('config.json is missing. Run npm run init first.');
    else throw new Error('config.json could not be read as JSON. The original file was not changed.');
  }
  if (!object(config)) return validateConfig(config);
  config = structuredClone(config);
  const overrides = [
    ['DSH_WEB_URL','dsh','baseUrl'], ['DSH_AUTH_TOKEN','dsh','authToken'],
    ['ONEBOT_WS_URL','snowluma','wsUrl'], ['ONEBOT_HTTP_URL','snowluma','httpUrl'],
    ['ONEBOT_ACCESS_TOKEN','snowluma','accessToken'], ['COMFYUI_URL','comfyui','baseUrl'],
  ];
  for (const [variable, section, key] of overrides) {
    if (env[variable]) { if (config[section] !== undefined && !object(config[section])) throw new Error(`${section} must be an object.`); config[section] ??= {}; config[section][key] = env[variable]; }
  }
  if (env.QQ_BRIDGE_CONSOLE_TOKEN) config.consoleToken = env.QQ_BRIDGE_CONSOLE_TOKEN;
  return validateConfig(config);
}

export function resolveRuntimePaths(config = {}, { root = PROJECT_ROOT, env = process.env, platform = process.platform } = {}) {
  const paths = config.paths ?? {};
  const resolvePath = (key, variable, fallback, command = false) => {
    const value = configured(env[variable]) ? env[variable] : configured(paths[key]) ? paths[key] : fallback;
    if (command && !/[\\/]/.test(value)) return value;
    return path.resolve(root, value);
  };
  const executable = platform === 'win32' ? '.exe' : '';
  const rvcDir = resolvePath('rvcDir','RVC_DIR','../RVC');
  const rvcScriptsDir = resolvePath('rvcScriptsDir','RVC_SCRIPTS_DIR','../RVC');
  return {
    rvcDir, rvcScriptsDir,
    rvcPython: resolvePath('rvcPython','RVC_PYTHON',path.join(rvcDir,'runtime',`python${executable}`)),
    rvcInferScript: resolvePath('rvcInferScript','RVC_INFER_SCRIPT',path.join(rvcScriptsDir,'rvc_infer.py')),
    rvcOutputDir: resolvePath('rvcOutputDir','RVC_OUTPUT_DIR','state/sing-work'),
    biliPython: resolvePath('biliPython','BILI_PYTHON',platform === 'win32' ? 'python' : 'python3',true),
    asrPython: resolvePath('asrPython','ASR_PYTHON',platform === 'win32' ? 'python' : 'python3',true),
    asrScript: resolvePath('asrScript','ASR_SCRIPT','../douyin/douyin_transcribe.py'),
    douyinDir: resolvePath('douyinDir','DOUYIN_DIR','../douyin'),
    ffmpeg: resolvePath('ffmpeg','FFMPEG_PATH',`ffmpeg${executable}`,true),
    ffprobe: resolvePath('ffprobe','FFPROBE_PATH',`ffprobe${executable}`,true),
    voiceLibrary: resolvePath('voiceLibrary','QQ_VOICE_LIBRARY',config.socialV2?.voice?.dir || 'audio'),
  };
}

export function getRuntimePaths() { return resolveRuntimePaths(readLocalConfig()); }
