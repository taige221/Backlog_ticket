import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from '../src/backlog.js';

const config = { backlog: { origin: 'https://fixture.backlog.com' } };
const env = { BACKLOG_API_KEY: 'PRIVATE_NETWORK_TEST_KEY' };

for (const [code, expected] of [
  ['ENOTFOUND', /域名解析失败/],
  ['EAI_AGAIN', /域名解析失败/],
  ['UND_ERR_CONNECT_TIMEOUT', /请求超时/],
  ['ETIMEDOUT', /请求超时/],
  ['ECONNRESET', /连接失败/],
]) {
  test(`Backlog read reports ${code} without exposing credentials`, async () => {
    await assert.rejects(get(config, 'projects', {
      env,
      fetchImpl: async () => {
        throw new TypeError('https://fixture.backlog.com/?apiKey=PRIVATE_NETWORK_TEST_KEY', {
          cause: Object.assign(new Error('PRIVATE_NETWORK_TEST_KEY'), { code }),
        });
      },
    }), error => expected.test(error.message) && !error.message.includes(env.BACKLOG_API_KEY));
  });
}

test('Backlog read distinguishes request timeout from cancellation', async () => {
  await assert.rejects(get(config, 'projects', {
    env,
    fetchImpl: async () => { throw new DOMException('PRIVATE_NETWORK_TEST_KEY', 'TimeoutError'); },
  }), /请求超时/);
  const controller = new AbortController();
  controller.abort(new Error('PRIVATE_NETWORK_TEST_KEY'));
  await assert.rejects(get(config, 'projects', {
    env,
    signal: controller.signal,
    fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); },
  }), error => error.code === 'ABORT_ERR' && !error.message.includes(env.BACKLOG_API_KEY));
});

test('Backlog read keeps HTTP authorization failures distinct', async () => {
  await assert.rejects(get(config, 'projects', {
    env,
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }), /HTTP 401/);
});
