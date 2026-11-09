import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { detectProvider, setupModel } from '../src/setup.js';
import { credentials, credentialFile, loadConfig, modelConnection, replacePrivateJson, selectedProjectRepo } from '../src/config.js';
import { createTerminal } from '../src/terminal.js';
import { generateDraft } from '../src/draft.js';
import { runChat } from '../src/chat.js';

async function directory(t) { const root = await mkdtemp(path.join(tmpdir(), 'ticket-setup-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function ui(key, answer = '') { const logs = []; return { logs, askSecret: async () => key, ask: async () => answer, log: line => logs.push(line) }; }
const json = data => ({ ok: true, json: async () => data });

test('只对已知格式做路由提示，未知格式不自动试探服务', () => {
  assert.equal(detectProvider('sk-or-v1-fixture'), 'openrouter');
  assert.equal(detectProvider('sk-proj-fixture'), 'openai');
  assert.equal(detectProvider('sk-svcacct-fixture'), 'openai');
  assert.equal(detectProvider('sk-legacy-fixture'), null);
});

test('输入一次OpenRouter密钥即自动配置，验证专用鉴权接口，密钥独立保存且无日志回显', async t => {
  const root = await directory(t), filename = path.join(root, 'config.json');
  const initial = { backlog: { project: 'DEMO', origin: 'https://example.backlog.com' }, language: 'ja', repo: './source', extraSetting: true };
  await writeFile(filename, JSON.stringify(initial));
  const terminal = ui('sk-or-v1-fixture-secret');
  const next = await setupModel(filename, { ...terminal, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer sk-or-v1-fixture-secret');
    return json({ data: { label: 'test' } });
  } });
  assert.equal(next.model.provider, 'openrouter');
  assert.equal(next.model.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(next.model.protocol, 'chat-completions');
  assert.equal(next.language, 'ja'); assert.equal(next.extraSetting, true);
  assert.deepEqual(next.backlog, initial.backlog);
  assert.equal(selectedProjectRepo(next), path.join(root, 'source'));
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await stat(credentialFile(filename))).mode & 0o777, 0o600);
  assert((await readFile(credentialFile(filename), 'utf8')).includes('sk-or-v1-fixture-secret'));
  assert(!(await readFile(filename, 'utf8')).includes('fixture-secret'));
  assert(!terminal.logs.join('\n').includes('fixture-secret'));
  assert(!JSON.stringify({ ...next }).includes('fixture-secret'));
  assert.equal(modelConnection(next, {}).apiKey, 'sk-or-v1-fixture-secret');
  assert.equal(modelConnection({ ...next, model: { ...next.model } }, { OPENROUTER_API_KEY: 'stale-env' }).apiKey, 'sk-or-v1-fixture-secret');
  assert.throws(() => modelConnection({ ...next, model: { ...next.model, baseUrl: 'https://other.example/v1' } }, {}), /其他 API/);
});

test('OpenAI密钥只向OpenAI校验，保留另一家已存凭据，并可在无环境变量时生成', async t => {
  const root = await directory(t), filename = path.join(root, 'config.json');
  await writeFile(credentialFile(filename), JSON.stringify({ openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: 'router-preserved' } }));
  const next = await setupModel(filename, { ...ui('sk-proj-fixture-secret'), fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://api.openai.com/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer sk-proj-fixture-secret');
    return json({ data: [{ id: 'model-for-test' }] });
  } });
  assert.equal(next.model.provider, 'openai'); assert.equal(next.model.protocol, 'responses');
  assert.equal(next[credentials].openrouter.key, 'router-preserved');
  const selected = { ...next, model: { ...next.model, name: 'model-for-test' } };
  const draft = await generateDraft(selected, { request: '测试' }, { env: {}, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer sk-proj-fixture-secret');
    assert(!options.body.includes('fixture-secret'));
    return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '测试', description: '待确认', unknowns: [] }) }] }] });
  } });
  assert(!JSON.stringify(draft).includes('fixture-secret'));
  assert.equal((await loadConfig(filename)).model.provider, 'openai');
});

test('未知格式只在用户选择后发送给对应服务，取消不请求不写文件', async t => {
  const root = await directory(t), filename = path.join(root, 'config.json');
  await setupModel(filename, { ...ui('legacy-fixture', '2'), fetchImpl: async url => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key');
    return json({ data: {} });
  } });
  const original = await readFile(filename, 'utf8'), auth = await readFile(credentialFile(filename), 'utf8');
  for (const key of ['', 'unknown-fixture']) {
    await assert.rejects(setupModel(filename, { ...ui(key), fetchImpl: async () => assert.fail('取消不请求') }), /取消/);
  }
  assert.equal(await readFile(filename, 'utf8'), original);
  assert.equal(await readFile(credentialFile(filename), 'utf8'), auth);
});

test('鉴权失败或异常不保存密钥，也不输出服务返回的敏感正文', async t => {
  const root = await directory(t), filename = path.join(root, 'config.json');
  for (const fetchImpl of [
    async () => ({ ok: false, status: 401, text: async () => 'fixture-secret' }),
    async () => { throw new Error('fixture-secret'); },
    async () => json({ error: 'fixture-secret' }),
  ]) {
    await assert.rejects(setupModel(filename, { ...ui('sk-or-v1-fixture-secret'), fetchImpl }), error => !error.message.includes('fixture-secret'));
  }
  await assert.rejects(readFile(filename), { code: 'ENOENT' });
  await assert.rejects(readFile(credentialFile(filename)), { code: 'ENOENT' });
});

test('保存时检查外部更改；原配置保持；首次缺少文件可在内存初始化', async t => {
  const root = await directory(t), filename = path.join(root, 'config.json');
  assert.equal((await loadConfig(filename, { allowMissing: true })).model.name, '');
  await writeFile(filename, '{"changed":true}');
  await assert.rejects(replacePrivateJson(filename, {}, null), /发生变化/);
  assert.equal(await readFile(filename, 'utf8'), '{"changed":true}');
});

test('配置被外部修改导致保存失败时，已写入的新密钥回滚，保留外部配置和原凭据', async t => {
  const root = await directory(t), filename = path.join(root, 'config.json'), initial = { language: 'zh-CN', extraSetting: true };
  await writeFile(filename, JSON.stringify(initial));
  const auth = { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: 'old-key' } };
  await writeFile(credentialFile(filename), JSON.stringify(auth));
  await assert.rejects(setupModel(filename, { ...ui('sk-or-v1-new-key'), fetchImpl: async () => {
    await writeFile(filename, JSON.stringify({ ...initial, language: 'ja' }));
    return json({ data: {} });
  } }), /发生变化/);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).language, 'ja');
  assert.deepEqual(JSON.parse(await readFile(credentialFile(filename), 'utf8')), auth);
});

test('首次模型未设置时可直接展示列表，不消费第一条用户描述', async () => {
  const answers = ['1', '问题', '/exit'], generated = [];
  await runChat({ model: { name: '' } }, { initialCommand: '/model', ask: async () => answers.shift(), list: async () => ['model-a'], log() {}, generate: async (config, text) => generated.push([config.model.name, text]) });
  assert.deepEqual(generated, [['model-a', '问题']]);
});

test('终端隐藏密钥输入，普通提示仍显示，关闭后恢复raw模式', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const modes = []; let text = '';
  input.isTTY = true; input.setRawMode = enabled => modes.push(enabled);
  output.isTTY = true; output.columns = 80; output.on('data', chunk => { text += chunk; });
  const terminal = createTerminal(input, output);
  try {
    const secret = terminal.askSecret('API Key: ');
    input.write('synthetic-hidden-key\r');
    assert.equal(await secret, 'synthetic-hidden-key');
    assert(!text.includes('synthetic-hidden-key'));
    const normal = terminal.ask('选择模型: '); input.write('1\r'); assert.equal(await normal, '1');
    assert(text.includes('选择模型'));
  } finally { terminal.close(); }
  assert.equal(modes.at(-1), false);
});
