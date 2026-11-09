import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeConfig } from '../src/config-view.js';
import { credentials, exampleConfig } from '../src/config.js';
import { runChat } from '../src/chat.js';

const config = { ...exampleConfig, model: { ...exampleConfig.model, provider: 'openai', name: 'fixture-model' },
  backlog: { origin: 'https://fixture.backlog.com', project: 'DEMO' },
  [credentials]: { openai: { baseUrl: exampleConfig.model.baseUrl, key: 'LOCAL_MODEL_SECRET' },
    backlog: { origin: 'https://fixture.backlog.com', key: 'LOCAL_BACKLOG_SECRET' } },
};
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-config-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('配置查看只显示白名单字段、实际配置文件与可读目录，不输出本机或环境密钥', async t => {
  const root = await directory(t), filename = path.join(root, 'config.json');
  const selected = { ...config, repo: root, apiKey: 'OTHER_SECRET', extra: { password: 'EXTRA_SECRET' } };
  const before = JSON.stringify(selected), auth = selected[credentials];
  const text = await describeConfig(selected, { filename, env: { OPENAI_API_KEY: 'ENV_MODEL_SECRET', BACKLOG_API_KEY: 'ENV_BACKLOG_SECRET' } });
  for (const value of [filename, config.model.baseUrl, 'responses', 'fixture-model', config.backlog.origin, 'DEMO', root, '目录可读取']) assert(text.includes(value));
  assert.equal((text.match(/已设置（本机凭据）/g) || []).length, 2);
  for (const secret of ['LOCAL_MODEL_SECRET', 'LOCAL_BACKLOG_SECRET', 'ENV_MODEL_SECRET', 'ENV_BACKLOG_SECRET', 'OTHER_SECRET', 'EXTRA_SECRET']) assert(!text.includes(secret));
  assert.equal(JSON.stringify(selected), before);
  assert.equal(selected[credentials], auth);
});

test('环境变量与缺少配置的状态可分别识别，无须有效连接即可查看', async () => {
  const selected = { ...config, [credentials]: undefined };
  const text = await describeConfig(selected, { env: { OPENAI_API_KEY: 'ENV_MODEL_SECRET', BACKLOG_API_KEY: 'ENV_BACKLOG_SECRET' } });
  assert.equal((text.match(/已设置（环境变量）/g) || []).length, 2);
  assert(!text.includes('ENV_MODEL_SECRET')); assert(!text.includes('ENV_BACKLOG_SECRET'));
  const missing = await describeConfig({}, { env: {} });
  assert.equal((missing.match(/API Key：未设置/g) || []).length, 2);
  assert(missing.includes('未选择（使用 /model）'));
  assert(missing.includes('未启用源码读取'));
});

test('无效地址与密钥绑定冲突明确提示，URL 中误写的凭据也不会输出', async () => {
  const mismatch = await describeConfig({ ...config, model: { ...config.model, baseUrl: 'https://else.example/v1' },
    backlog: { ...config.backlog, origin: 'https://else.backlog.com' } }, { env: {} });
  assert.equal((mismatch.match(/与本机凭据不匹配/g) || []).length, 2);
  const invalid = await describeConfig({ ...config, model: { ...config.model, baseUrl: 'https://user:URL_MODEL_SECRET@fixture.example/v1' },
    backlog: { origin: 'https://fixture.backlog.com/?apiKey=URL_BACKLOG_SECRET', project: 'invalid key' } }, { env: {} });
  assert.equal((invalid.match(/无效地址（已隐藏/g) || []).length, 2);
  assert(invalid.includes('项目：无效'));
  for (const value of ['URL_MODEL_SECRET', 'URL_BACKLOG_SECRET', 'LOCAL_MODEL_SECRET', 'LOCAL_BACKLOG_SECRET']) assert(!invalid.includes(value));
});

test('不存在的路径或普通文件会报告目录状态，不读取文件正文', async t => {
  const root = await directory(t), file = path.join(root, 'source.txt');
  await writeFile(file, 'SOURCE_CONTENT_SECRET');
  const missing = await describeConfig({ ...config, repo: path.join(root, 'missing') }, { env: {} });
  assert(missing.includes('目录不存在或不可读取'));
  const invalid = await describeConfig({ ...config, repo: file }, { env: {} });
  assert(invalid.includes('状态：不是目录'));
  assert(!invalid.includes('SOURCE_CONTENT_SECRET'));
});

test('/config 只读展示当前会话，跟随模型切换和三项配置修改，不调用列表或生成', async t => {
  const root = await directory(t), logs = [];
  const lines = ['/model session-model', '/config', '/api', '/backlog', '/repo', '/config', '/exit'];
  const selected = { ...config, repo: '/old/source' };
  const original = JSON.stringify(selected);
  const updated = { ...config, model: { ...config.model, name: 'new-model', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'chat-completions' },
    backlog: { origin: 'https://new.backlog.com', project: 'NEW' }, repo: root,
    [credentials]: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: 'NEW_MODEL_SECRET' }, backlog: { origin: 'https://new.backlog.com', key: 'NEW_BACKLOG_SECRET' } } };
  const scopes = [];
  await runChat(selected, { ask: async () => lines.shift(), env: {}, filename: path.join(root, 'config.json'), log: line => logs.push(line),
    types: async () => [{ name: 'Task' }], selectType: async () => null,
    configure: async scope => { scopes.push(scope); return updated; },
    list: async () => assert.fail('查看配置不读取模型列表'),
    generate: async () => assert.fail('查看配置不生成草稿'),
  });
  const snapshots = logs.filter(line => line.startsWith('当前会话配置'));
  assert.equal(snapshots.length, 2);
  assert(snapshots[0].includes('当前模型：session-model'));
  assert(snapshots[0].includes('项目：DEMO'));
  for (const value of ['OpenRouter', 'new-model', 'https://new.backlog.com', '项目：NEW', root, '目录可读取']) assert(snapshots[1].includes(value));
  assert.deepEqual(scopes, ['api', 'backlog', 'repo']);
  assert.equal(JSON.stringify(selected), original);
  assert(!logs.join('\n').includes('NEW_MODEL_SECRET')); assert(!logs.join('\n').includes('NEW_BACKLOG_SECRET'));
});

test('/config 参数被拒绝，不回显输入或触发配置引导', async () => {
  const lines = ['/config SECRET_ARGUMENT', '/exit'], logs = [];
  await runChat(config, { ask: async () => lines.shift(), env: {}, log: line => logs.push(line),
    configure: async () => assert.fail('查看配置不启动配置引导'), generate: async () => assert.fail('不生成草稿'),
  });
  assert(logs.some(line => line.includes('/config 不接收参数')));
  assert(!logs.join('\n').includes('SECRET_ARGUMENT'));
});
