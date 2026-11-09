import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { credentialFile, exampleConfig, loadConfig } from '../src/config.js';
import { rememberModel } from '../src/models.js';
import { setupSection } from '../src/setup.js';
import { runChat } from '../src/chat.js';

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-model-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const config = { ...exampleConfig, model: { ...exampleConfig.model, provider: 'openai', name: 'old-model' },
  backlog: { origin: 'https://fixture.backlog.com', project: 'DEMO' }, repo: './saved-source', extra: true };

test('保存模型仅更新所选配置的 model.name，保留其他字段及原有凭据文件，权限0600', async t => {
  const root = await directory(t), file = path.join(root, 'custom-config.json');
  await writeFile(file, JSON.stringify(config));
  const auth = '{"openai":{"baseUrl":"https://api.openai.com/v1","key":"LOCAL_SECRET"}}';
  await writeFile(credentialFile(file), auth);
  await rememberModel(file, config.model, 'new-model');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, { ...config, model: { ...config.model, name: 'new-model' } });
  assert.equal(saved.repo, './saved-source');
  assert.equal(await readFile(credentialFile(file), 'utf8'), auth);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert(!(await readFile(file, 'utf8')).includes('LOCAL_SECRET'));
});

test('弹窗确认保存模型，重启后直接使用已存模型，不再次读取列表或要求选择', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({ ...config, model: { ...config.model, name: '' } }));
  const first = await loadConfig(file), firstLines = ['/exit'], logs = [];
  await runChat(first, { initialCommand: first.model.name ? null : '/model', ask: async () => firstLines.shift(),
    list: async () => ['model-a', 'model-b'], selectModel: async () => 'model-b', log: line => logs.push(line),
    persistModel: (name, model) => rememberModel(file, model, name), generate: async () => assert.fail('选择不生成草稿'),
  });
  const restored = await loadConfig(file), secondLines = ['问题', '/exit'];
  assert.equal(restored.model.name, 'model-b');
  let generated = 0;
  await runChat(restored, { initialCommand: restored.model.name ? null : '/model', ask: async () => secondLines.shift(), log() {},
    list: async () => assert.fail('重启不自动读取模型列表'), selectModel: async () => assert.fail('重启不自动弹窗'),
    generate: async selected => { generated++; assert.equal(selected.model.name, 'model-b'); },
  });
  assert.equal(generated, 1);
  assert(logs.some(line => line.includes('已保存，下次启动自动沿用')));
});

test('编号及直接切换均保存；取消或无效选择不写文件，保存失败不切换当前模型', async () => {
  const lines = ['/model', '2', '/model direct-model', '/model', '', '/model bad model', '/model failed-model', '问题', '/exit'];
  const persisted = [], generated = [], logs = [];
  await runChat(config, { ask: async () => lines.shift(), list: async () => ['model-a', 'model-b'], log: line => logs.push(line),
    persistModel: async (name, model) => {
      assert.equal(model.baseUrl, config.model.baseUrl);
      if (name === 'failed-model') throw new Error('保存模型失败，原选择保留');
      persisted.push(name);
    }, generate: async selected => generated.push(selected.model.name),
  });
  assert.deepEqual(persisted, ['model-b', 'direct-model']);
  assert.deepEqual(generated, ['direct-model']);
  assert(logs.some(line => line.includes('保存模型失败')));
  assert.equal(config.model.name, 'old-model');
});

test('外部更换 API 地址、协议或密钥引用后拒绝写入旧会话选择，坏配置也不覆盖', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  for (const change of [{ baseUrl: 'https://other.example/v1' }, { protocol: 'chat-completions' }, { apiKeyEnv: 'OTHER_KEY' }]) {
    const original = JSON.stringify({ ...config, model: { ...config.model, ...change } });
    await writeFile(file, original);
    await assert.rejects(rememberModel(file, config.model, 'new-model'), /服务配置已改变/);
    assert.equal(await readFile(file, 'utf8'), original);
  }
  await writeFile(file, '{"model":INVALID_SECRET_JSON');
  await assert.rejects(rememberModel(file, config.model, 'new-model'), error => /无法解析/.test(error.message) && !error.message.includes('INVALID_SECRET_JSON'));
  await assert.rejects(rememberModel(file, config.model, 'invalid model'), /模型 ID 无效/);
  assert.equal(await readFile(file, 'utf8'), '{"model":INVALID_SECRET_JSON');
});

test('已有环境变量凭据但尚无配置文件时，首次选择可创建用户指定配置，不复制密钥', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  await rememberModel(file, exampleConfig.model, 'env-model');
  assert.equal((await loadConfig(file)).model.name, 'env-model');
  await assert.rejects(readFile(credentialFile(file)), { code: 'ENOENT' });
});

test('同一服务更换 Key 保留已记住的模型，切换服务或协议后清除旧模型', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  const setup = key => setupSection(file, 'api', { askSecret: async () => key, ask: async () => assert.fail('已知密钥不询问服务商'), log() {}, env: {},
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: String(url).endsWith('/key') ? {} : [] }) }),
  });
  await writeFile(file, JSON.stringify(config));
  assert.equal((await setup('sk-proj-new')).model.name, 'old-model');
  assert.equal((await setup('sk-or-v1-new')).model.name, '');
  await writeFile(file, JSON.stringify({ ...config, model: { ...config.model, protocol: 'chat-completions' } }));
  assert.equal((await setup('sk-proj-newer')).model.name, '');
});
