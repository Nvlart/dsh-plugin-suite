import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const embeddingBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const vlmBase = 'https://api.deepseek.com/v1';

export function buildConfig({embeddingKey, vlmKey, directory = root}) {
  for (const [label, key] of [['Embedding', embeddingKey], ['DeepSeek', vlmKey]]) {
    if (typeof key !== 'string' || key.trim().length < 10 || /\s/.test(key)) throw Error(`${label} API Key is missing or invalid.`);
  }
  if (!path.isAbsolute(directory)) throw Error('Data directory must be absolute.');
  return {
    server: {host: '127.0.0.1', port: 1933},
    storage: {workspace: path.join(directory, 'data'), agfs: {backend: 'local'}, vectordb: {backend: 'local'}},
    embedding: {dense: {provider: 'openai', api_base: embeddingBase, api_key: embeddingKey, model: 'text-embedding-v4', dimension: 1024, encoding_format: 'float'}},
    vlm: {provider: 'openai', api_base: vlmBase, api_key: vlmKey, model: 'deepseek-flash', max_retries: 2, max_concurrent: 2, extra_request_body: {thinking: {type: 'disabled'}}},
  };
}

async function readDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim();
  const require = createRequire(path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'), 'npm/node_modules/@deepseek-ai/dsh/package.json'));
  const YAML = require('yaml');
  let credentials;
  try { credentials = YAML.parse(await fs.readFile(path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), '.credentials.yaml'), 'utf8'), {prettyErrors: false}); }
  catch { throw Error('Cannot read the DSH local credentials store.'); }
  const key = credentials?.refs?.DEEPSEEK_API_KEY;
  if (typeof key !== 'string' || !key.trim()) throw Error('No DEEPSEEK_API_KEY in the DSH credentials store. Configure the official DeepSeek API provider in DSH first.');
  return key.trim();
}

async function requestModel(label, url, key, body) {
  let response;
  try { response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${key}`}, body: JSON.stringify(body), signal: AbortSignal.timeout(90000)}); }
  catch { throw Error(`${label}: network request failed or timed out.`); }
  // Do not include upstream bodies: an upstream error could repeat credentials.
  if (!response.ok) throw Error(`${label}: HTTP ${response.status}. Check the API Key, region, model access and quota.`);
  try { return await response.json(); } catch { throw Error(`${label}: invalid JSON response.`); }
}

async function configure() {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  let value; try { value = JSON.parse(input); } catch { throw Error('Invalid configuration input.'); }
  const config = buildConfig({embeddingKey: value.embeddingKey?.trim(), vlmKey: await readDeepSeekKey()});
  const embedded = await requestModel('Embedding', `${embeddingBase}/embeddings`, config.embedding.dense.api_key, {model: 'text-embedding-v4', input: ['DSH memory setup connectivity test.'], dimensions: 1024, encoding_format: 'float'});
  const vector = embedded?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 1024 || !vector.every(Number.isFinite)) throw Error('Embedding: expected a 1024-dimensional float vector.');
  const chat = await requestModel('DeepSeek', `${vlmBase}/chat/completions`, config.vlm.api_key, {model: 'deepseek-flash', messages: [{role: 'user', content: 'Reply with OK only.'}], max_tokens: 16, thinking: {type: 'disabled'}});
  if (typeof chat?.choices?.[0]?.message?.content !== 'string' || !chat.choices[0].message.content.trim()) throw Error('DeepSeek: expected a text response.');
  // The PowerShell launcher protects this directory's DACL before calling us.
  const privateDir = path.join(root, 'runtime/private');
  await fs.mkdir(privateDir, {recursive: true});
  const filename = path.join(privateDir, 'ov.conf');
  try { await fs.copyFile(filename, path.join(privateDir, `ov.conf.backup-${Date.now()}`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = filename + '.tmp';
  await fs.writeFile(temp, JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
  await fs.rename(temp, filename);
  console.log(JSON.stringify({configured: true, embedding: 'text-embedding-v4', dimension: 1024, vlm: 'deepseek-flash', modelsReachable: true}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== 'configure') throw Error('Usage: node service.mjs configure (credentials through stdin).');
    await configure();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
