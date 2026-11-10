import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { listModelOptions, rememberModel, rememberEffort, selectedEffort, withEffort, validateEffort } from '../src/models.js';
import { generateDraft } from '../src/draft.js';
import { loadConfig, saveJson } from '../src/config.js';
import { setupSection } from '../src/setup.js';
import { runChat } from '../src/chat.js';
import { createWebApp } from '../src/web-server.js';

const config = { model: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'chat-completions', name: 'vendor/thinking' }, backlog: {} };
const env = { OPENAI_API_KEY: 'PRIVATE' };
const catalog = [
  { id: 'vendor/thinking', reasoning: { supported_efforts: ['max', 'high', 'low', 'none'], default_effort: 'high' } },
  { id: 'vendor/mandatory', reasoning: { supported_efforts: null, mandatory: true } },
  { id: 'vendor/plain', supported_parameters: [] },
];
const json = value => ({ ok: true, json: async () => value });
const response = protocol => json(protocol === 'responses'
  ? { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '标题', description: '正文', unknowns: [] }) }] }] }
  : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: '标题', description: '正文', unknowns: [] }) } }] });
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ticket-effort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('模型公布的思考档位限制选择，必需思考的模型没有关闭档位', async () => {
  const deps = { env, fetchImpl: async () => json({ data: catalog }) };
  const options = await listModelOptions(config, deps);
  assert.deepEqual(options[0].efforts, ['none', 'low', 'high', 'max']);
  assert.equal(options[0].defaultEffort, 'high');
  assert(!options[1].efforts.includes('none'));
  assert.deepEqual(options[2].efforts, []);
  await assert.rejects(validateEffort(config, 'medium', deps), /未提供/);
  await assert.rejects(validateEffort(config, '__proto__', deps), /有效/);
  await validateEffort(config, 'high', deps);
  await validateEffort(config, 'auto', { fetchImpl: async () => assert.fail('恢复默认无需远端读取') });
  const nativeIds = ['gpt-6.1-sol-2026-11-01', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-6-luna', 'gpt-4.1', 'unknown'];
  const native = await listModelOptions({ model: { ...config.model, provider: 'openai', baseUrl: 'https://api.openai.com/v1' } },
    { env, fetchImpl: async () => json({ data: nativeIds.map(id => ({ id })) }) });
  assert.deepEqual(native.map(model => model.efforts), [
    ['low', 'medium', 'high', 'xhigh', 'max'],
    ['none', 'low', 'medium', 'high', 'xhigh'],
    ['none', 'low', 'medium', 'high', 'xhigh'],
    ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    [],
    [],
  ]);
});

test('思考强度按模型持久保存，切换及同服务更换密钥后保留，默认设置删除覆盖值', async t => {
  const directory = await temporary(t), file = path.join(directory, 'config.json');
  await saveJson(file, config);
  await rememberEffort(file, config.model, 'high');
  await rememberModel(file, config.model, 'vendor/plain');
  assert.equal(selectedEffort((await loadConfig(file)).model), 'auto');
  await rememberModel(file, config.model, config.model.name);
  const restored = (await loadConfig(file)).model;
  assert.equal(selectedEffort(restored), 'high');
  await assert.rejects(rememberEffort(file, { ...restored, name: 'vendor/plain' }, 'low'), /模型已改变/);
  const updated = await setupSection(file, 'api', { provider: 'openrouter', askSecret: async () => 'sk-or-v1-test', ask: async () => assert.fail(), env: {}, log() {}, fetchImpl: async () => json({ data: {} }) });
  assert.equal(selectedEffort(updated.model), 'high');
  await rememberEffort(file, updated.model, 'auto');
  assert.equal(selectedEffort((await loadConfig(file)).model), 'auto');
  assert.deepEqual(JSON.parse(await readFile(file)).model.reasoningByModel, {});
  const unusual = withEffort({ ...config.model, name: '__proto__' }, 'low');
  assert.equal(selectedEffort(unusual), 'low');
  assert.equal(selectedEffort({ ...config.model, name: 'toString' }), 'auto');
});

test('两种服务的两种协议按实际选择发参数，默认省略，源码多轮调查持续沿用同一强度', async t => {
  const directory = await temporary(t);
  await writeFile(path.join(directory, 'fixture.js'), 'export const value = 1;');
  for (const provider of ['openai', 'openrouter']) for (const protocol of ['responses', 'chat-completions']) {
    const model = withEffort({ ...config.model, provider, protocol, baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : config.model.baseUrl }, 'high');
    let rounds = 0;
    await generateDraft({ model, backlog: {} }, { request: '检查源码', repo: directory, metadata: false }, { env, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (provider === 'openai' && protocol === 'chat-completions') {
        assert.equal(body.reasoning_effort, 'high'); assert.equal(body.reasoning, undefined);
      } else { assert.deepEqual(body.reasoning, { effort: 'high' }); assert.equal(body.reasoning_effort, undefined); }
      if (++rounds === 1) return json(protocol === 'responses'
        ? { output: [{ type: 'function_call', call_id: 'read', name: 'read_file', arguments: '{"path":"fixture.js"}' }] }
        : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.js"}' } }] } }] });
      return response(protocol);
    } });
    assert.equal(rounds, 2);
    await generateDraft({ model: withEffort(model, 'auto'), backlog: {} }, { request: '问题', metadata: false }, { env, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.reasoning, undefined); assert.equal(body.reasoning_effort, undefined);
      return response(protocol);
    } });
  }
});

test('网页和 CLI 切换强度均影响后续生成，服务拒绝的档位不改写配置', async t => {
  const directory = await temporary(t), filename = path.join(directory, 'config.json');
  await saveJson(filename, config);
  const app = await createWebApp({ filename, env, fetchImpl: async (url, options) => {
    if (String(url).endsWith('/models')) return json({ data: catalog });
    assert.deepEqual(JSON.parse(options.body).reasoning, { effort: 'high' });
    return response('chat-completions');
  } });
  t.after(() => app.close());
  await app.dispatch('POST', '/api/effort', { model: config.model.name, effort: 'high' });
  await assert.rejects(app.dispatch('POST', '/api/effort', { model: config.model.name, effort: 'medium' }), /未提供/);
  await assert.rejects(app.dispatch('POST', '/api/effort', { model: 'vendor/plain', effort: 'high' }), /模型已改变/);
  const state = await app.dispatch('GET', '/api/state');
  assert.equal(state.config.reasoningEffort, 'high');
  const result = await app.dispatch('POST', '/api/draft', { request: '问题', uploadIds: [] });
  assert.equal(result.activity.reasoningEffort, 'high');
  await app.dispatch('POST', '/api/model', { model: 'vendor/plain' });
  assert.equal((await app.dispatch('GET', '/api/state')).config.reasoningEffort, 'auto');
  await app.dispatch('POST', '/api/model', { model: config.model.name });
  assert.equal((await app.dispatch('GET', '/api/state')).config.reasoningEffort, 'high');

  const lines = ['/effort high', '问题', '/model vendor/plain', '问题', '/model vendor/thinking', '/effort medium', '问题', '/effort auto', '问题', '/exit'];
  const levels = [], saved = [];
  await runChat(config, { env, ask: async () => lines.shift(), log() {},
    modelOptions: () => listModelOptions(config, { env, fetchImpl: async () => json({ data: catalog }) }),
    persistEffort: async level => saved.push(level),
    generate: async selected => levels.push(selectedEffort(selected.model)),
  });
  assert.deepEqual(levels, ['high', 'auto', 'high', 'auto']);
  assert.deepEqual(saved, ['high', 'auto']);
});

test('CLI 重新配置同一 API 后不会把会话模型的档位保存到其他模型', async t => {
  const file = path.join(await temporary(t), 'config.json');
  const initial = { ...config, model: withEffort(config.model, 'low') };
  await saveJson(file, initial);
  const lines = ['/api', '/effort', '问题', '/exit'];
  const logs = [];
  const generated = [];
  await runChat(initial, {
    env, ask: async () => lines.shift(), log: line => logs.push(line),
    configure: async () => {
      await rememberModel(file, initial.model, 'vendor/plain');
      return setupSection(file, 'api', { provider: 'openrouter', askSecret: async () => 'sk-or-v1-test', ask: async () => assert.fail(), env, log() {}, fetchImpl: async () => json({ data: {} }) });
    },
    modelOptions: async ({ model }) => {
      assert.equal(model.name, config.model.name);
      return [{ id: model.name, efforts: ['high', 'low'] }];
    },
    selectEffort: async (_choices, previous) => {
      assert.equal(previous, '低 (low)');
      return '高 (high)';
    },
    persistEffort: (level, model) => rememberEffort(file, model, level),
    generate: async ({ model }) => generated.push([model.name, selectedEffort(model)]),
  });
  const saved = (await loadConfig(file)).model;
  assert.equal(saved.name, 'vendor/plain');
  assert.deepEqual(saved.reasoningByModel, initial.model.reasoningByModel);
  assert(logs.some(line => line.includes('当前模型已改变')));
  assert.deepEqual(generated, [[config.model.name, 'low']]);
});
