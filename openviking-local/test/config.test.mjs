import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {buildConfig} from '../service.mjs';

test('local service uses absolute storage and the selected online model endpoints', () => {
  const directory = path.resolve('synthetic-openviking-data');
  const config = buildConfig({directory, embeddingKey: 'synthetic-embedding-key', vlmKey: 'synthetic-vlm-key'});
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.server.port, 1933);
  assert.equal(config.storage.workspace, path.join(directory, 'data'));
  assert.equal(config.embedding.dense.model, 'text-embedding-v4');
  assert.equal(config.embedding.dense.dimension, 1024);
  assert.equal(config.embedding.dense.encoding_format, 'float');
  assert.equal(config.vlm.model, 'deepseek-flash');
  assert.deepEqual(config.vlm.extra_request_body, {thinking: {type: 'disabled'}});
  assert.equal(config.server.root_api_key, undefined);
});

test('missing credentials and relative storage are rejected before model calls', () => {
  for (const value of ['', undefined, 'short', 'a key with spaces']) assert.throws(() => buildConfig({embeddingKey: value, vlmKey: 'synthetic-vlm-key'}));
  assert.throws(() => buildConfig({embeddingKey: 'synthetic-embedding-key', vlmKey: ''}));
  assert.throws(() => buildConfig({directory: 'relative', embeddingKey: 'synthetic-embedding-key', vlmKey: 'synthetic-vlm-key'}));
});
