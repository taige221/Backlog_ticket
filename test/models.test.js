import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels } from '../src/models.js';
import { runChat } from '../src/chat.js';

const config = { model: { baseUrl: 'https://aggregator.example/api/v1', name: '', apiKeyEnv: 'AGGREGATOR_KEY' } };
const env = { AGGREGATOR_KEY: 'test-secret' };
const ok = data => ({ ok: true, json: async () => data });
function session(lines) {
  const answers = [...lines], logs = [], generated = [];
  return { logs, generated, ask: async () => answers.length ? answers.shift() : null,
    log: line => logs.push(line), generate: async (selected, request) => generated.push([selected.model.name, request]) };
}

test('列表使用当前聚合服务的GET路径和密钥，未选模型亦可读取；去重且不返回供应商其他字段', async () => {
  const result = await listModels(config, { env, fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://aggregator.example/api/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert(options.signal instanceof AbortSignal);
    return ok({ data: [{ id: 'provider/b', other: 'discard' }, { id: 'provider/a' }, { id: 'provider/b' }] });
  } });
  assert.deepEqual(result, ['provider/b', 'provider/a']);
});

test('可自定义同站点列表路径，拒绝跨站、凭据、查询和片段，禁止发送请求', async () => {
  await listModels({ model: { ...config.model, modelsPath: '/catalog/models' } }, { env, fetchImpl: async url => {
    assert.equal(url.href, 'https://aggregator.example/catalog/models');
    return ok({ data: [] });
  } });
  for (const modelsPath of ['https://evil.example/models', '//evil.example/models', 'https://user:password@aggregator.example/models', '/models?key=private', '/models#fragment']) {
    await assert.rejects(listModels({ model: { ...config.model, modelsPath } }, { env, fetchImpl: async () => assert.fail('不应发送凭据') }), /同站点/);
  }
});

test('鉴权、网络和JSON错误不输出原始响应、密钥或底层请求URL', async () => {
  for (const status of [401, 403, 404, 429, 302]) {
    await assert.rejects(listModels(config, { env, fetchImpl: async () => ({ ok: false, status, text: async () => 'test-secret' }) }), error => error.message.includes(String(status)) && !error.message.includes('test-secret'));
  }
  for (const fetchImpl of [
    async () => { throw new Error('test-secret'); },
    async () => ({ ok: true, json: async () => { throw new Error('test-secret'); } }),
  ]) {
    await assert.rejects(listModels(config, { env, fetchImpl }), error => !error.message.includes('test-secret'));
  }
  await assert.rejects(listModels(config, { env: {}, fetchImpl: async () => assert.fail('缺少密钥不应请求') }), /AGGREGATOR_KEY/);
});

test('空列表有效，不兼容结构、恶意ID、过长列表和分页结果拒绝冒充完整列表', async () => {
  assert.deepEqual(await listModels(config, { env, fetchImpl: async () => ok({ data: [] }) }), []);
  for (const value of [null, [], { models: [] }, { data: [null] }, { data: [{ id: 'bad\u001b[31m' }] }, { data: [{ id: 'has space' }] }, { data: Array(10001).fill({ id: 'a' }) }, { data: [{ id: 'a' }], has_more: true }]) {
    await assert.rejects(listModels(config, { env, fetchImpl: async () => ok(value) }), /格式|分页/);
  }
});

test('退出信号可取消列表读取', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listModels(config, { env, signal: controller.signal, fetchImpl: async (url, options) => {
    assert(options.signal.aborted);
    throw new Error('aborted');
  } }), { code: 'ABORT_ERR' });
});

test('/model每次刷新接口列表，编号跟随本轮结果；不混入本地候选且选中后用于生成', async () => {
  const state = session(['/model', '2', '问题一', '/model', '1', '问题二', '/exit']);
  let reads = 0;
  await runChat({ model: { ...config.model, models: ['local-only'] } }, { ...state,
    list: (selected, options) => {
      assert.equal(selected.model.baseUrl, config.model.baseUrl);
      return listModels(selected, { ...options, env, fetchImpl: async () => ok({ data: (++reads === 1 ? ['remote/a', 'remote/b'] : ['remote/c']).map(id => ({ id })) }) });
    },
  });
  assert.equal(reads, 2);
  assert.deepEqual(state.generated, [['remote/b', '问题一'], ['remote/c', '问题二']]);
  assert(!state.logs.some(line => line.includes('local-only')));
  assert(!state.logs.some(line => line.includes('非实时')));
});

test('读取失败明确降级为本地候选；异常返回不破坏交互；直接切换跳过列表请求', async () => {
  const state = session(['/model', '1', '问题一', '/model remote/direct', '问题二', '/model', 'manual/new', '问题三', '/exit']);
  let reads = 0;
  await runChat({ model: { ...config.model, models: ['local/a'] } }, { ...state, list: async () => {
    if (++reads === 1) throw new Error('HTTP 404');
    return null;
  } });
  assert.equal(reads, 2);
  assert(state.logs.some(line => line.includes('HTTP 404') && line.includes('非实时')));
  assert(state.logs.some(line => line.includes('格式不兼容') && line.includes('非实时')));
  assert.deepEqual(state.generated, [['local/a', '问题一'], ['remote/direct', '问题二'], ['manual/new', '问题三']]);
});

test('成功返回空列表保持为空，仍可手动输入；列表取消退出会话', async () => {
  const state = session(['/model', 'manual/model', '问题', '/exit']);
  await runChat({ model: { ...config.model, models: ['local-only'] } }, { ...state, list: async () => [] });
  assert(!state.logs.some(line => line.includes('local-only')));
  assert.deepEqual(state.generated, [['manual/model', '问题']]);
  const cancel = session(['/model']);
  await runChat(config, { ...cancel, list: async () => { throw Object.assign(new Error(), { code: 'ABORT_ERR' }); } });
  assert(!cancel.logs.some(line => line.includes('非实时')));
});
