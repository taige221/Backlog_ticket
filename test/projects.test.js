import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProjects, rememberProject, listIssueTypes } from '../src/backlog.js';
import { credentialFile, exampleConfig, loadConfig, selectedProjectRepo } from '../src/config.js';
import { generateDraft } from '../src/draft.js';
import { runChat } from '../src/chat.js';

const origin = 'https://fixture.backlog.com';
const config = { ...exampleConfig, model: { ...exampleConfig.model, provider: 'openai', name: 'remembered-model' },
  backlog: { origin, project: 'ONE' }, extra: true };
const available = [{ key: 'ONE', name: '第一个项目' }, { key: 'TWO', name: '第二个项目' }];
const json = value => ({ ok: true, json: async () => value });
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function session(lines) {
  const logs = [], generated = [];
  return { logs, generated, ask: async () => lines.shift(), log: line => logs.push(line), types: async () => [{ name: 'Task' }], selectType: async () => null,
    generate: async selected => generated.push(selected) };
}

test('/project 局部选择框显示项目名并高亮当前项目，保存后用于会话配置和拟稿', async () => {
  const state = session(['/project', '/config', '问题', '/exit']), saved = [];
  await runChat(config, { ...state, env: {}, projects: async () => available,
    selectProject: async (labels, current) => {
      assert.deepEqual(labels, ['ONE — 第一个项目', 'TWO — 第二个项目']);
      assert.equal(current, labels[0]);
      return labels[1];
    }, persistProject: async (key, backlog) => { saved.push(key); assert.equal(backlog.origin, origin); },
  });
  assert.deepEqual(saved, ['TWO']);
  assert.equal(state.generated[0].backlog.project, 'TWO');
  assert.equal(state.generated[0].model.name, 'remembered-model');
  assert.equal(config.backlog.project, 'ONE');
  assert(state.logs.some(line => line.startsWith('当前会话配置') && line.includes('项目：TWO')));
  assert(state.logs.some(line => line.includes('已保存，下次启动自动沿用')));
  assert(!state.logs.some(line => line.startsWith('1. ')));
});

test('编号回退与 /project KEY 均实时读取项目列表，直接切换也必须在可访问列表中', async () => {
  const state = session(['/project', '2', '/project ONE', '/project UNKNOWN', '问题', '/exit']);
  let reads = 0; const saved = [];
  await runChat(config, { ...state, projects: async () => { reads++; return available; },
    persistProject: async key => saved.push(key),
  });
  assert.equal(reads, 3);
  assert.deepEqual(saved, ['TWO', 'ONE']);
  assert.equal(state.generated[0].backlog.project, 'ONE');
  assert(state.logs.some(line => line.includes('请选择列表中的项目')));
});

test('取消、列表为空、网络失败和保存失败保留原项目，不生成额外请求', async () => {
  const cases = [
    { lines: ['/project', '', '问题', '/exit'], projects: async () => available },
    { lines: ['/project', '问题', '/exit'], projects: async () => available, selectProject: async () => null },
    { lines: ['/project', '问题', '/exit'], projects: async () => [] },
    { lines: ['/project', '问题', '/exit'], projects: async () => { throw new Error('读取失败'); } },
    { lines: ['/project TWO', '问题', '/exit'], projects: async () => available,
      persistProject: async () => { throw new Error('保存失败'); } },
  ];
  for (const { lines, ...options } of cases) {
    const state = session(lines);
    await runChat(config, { ...state, persistProject: async () => assert.fail('不应保存'), ...options });
    assert.equal(state.generated.length, 1);
    assert.equal(state.generated[0].backlog.project, 'ONE');
  }
  const unconfigured = session(['/project', '/exit']);
  await runChat({ ...config, backlog: {} }, { ...unconfigured, projects: async () => assert.fail('未配置不发请求') });
  assert(unconfigured.logs.some(line => line.includes('请先用 /backlog')));
});

test('保存默认项目时旧目录迁移到原项目，其他配置和凭据保持', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({ ...config, repo: './saved-source' }));
  const auth = '{"backlog":{"origin":"https://fixture.backlog.com","key":"PROJECT_SECRET"}}';
  await writeFile(credentialFile(file), auth);
  await rememberProject(file, config.backlog, 'TWO');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const { repo, ...expected } = config;
  assert.deepEqual(saved, { ...expected, projectRepos: { [`${origin}/ONE`]: './saved-source' }, backlog: { ...config.backlog, project: 'TWO' } });
  const loaded = await loadConfig(file);
  assert.equal(loaded.backlog.project, 'TWO');
  assert.equal(selectedProjectRepo(loaded), undefined);
  assert.equal(selectedProjectRepo(loaded, { origin, project: 'ONE' }), path.join(root, 'saved-source'));
  assert.equal(selectedProjectRepo(loaded, { origin: 'https://other.backlog.com', project: 'ONE' }), undefined);
  assert.equal(await readFile(credentialFile(file), 'utf8'), auth);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert(!(await readFile(file, 'utf8')).includes('PROJECT_SECRET'));
});

test('Backlog 站点或密钥引用已被其他进程修改时不保存；非法项目和坏配置不覆盖', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  for (const change of [{ origin: 'https://other.backlog.com' }, { apiKeyEnv: 'OTHER_KEY' }]) {
    const original = JSON.stringify({ ...config, backlog: { ...config.backlog, ...change } });
    await writeFile(file, original);
    await assert.rejects(rememberProject(file, config.backlog, 'TWO'), /服务配置已改变/);
    assert.equal(await readFile(file, 'utf8'), original);
  }
  await assert.rejects(rememberProject(file, config.backlog, 'invalid project'), /项目 key/);
  await writeFile(file, 'INVALID_CONFIG_SECRET');
  await assert.rejects(rememberProject(file, config.backlog, 'TWO'), error => error.message.includes('无法解析') && !error.message.includes('INVALID_CONFIG_SECRET'));
  assert.equal(await readFile(file, 'utf8'), 'INVALID_CONFIG_SECRET');
});

test('切项目后读取新项目的 Task 模板，不复用旧项目类型，也不更改模型', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify(config));
  await writeFile(credentialFile(file), JSON.stringify({ openai: { baseUrl: config.model.baseUrl, key: 'MODEL_SECRET' }, backlog: { origin, key: 'BACKLOG_SECRET' } }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    if (options.method === 'GET') {
      assert.equal(url.searchParams.get('apiKey'), 'BACKLOG_SECRET');
      if (url.pathname === '/api/v2/projects') return json(available.map(item => ({ projectKey: item.key, name: item.name })));
      assert(url.pathname.startsWith('/api/v2/projects/TWO'));
      if (url.pathname.endsWith('issueTypes')) return json([{ name: 'Task', templateDescription: '## 新项目模板' }]);
      return json({ projectKey: 'TWO', name: '第二个项目', textFormattingRule: 'markdown' });
    }
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'remembered-model');
    assert(options.body.includes('新项目模板'));
    assert(!options.body.includes('BACKLOG_SECRET'));
    return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '测试', description: '## 新项目模板\n待确认', unknowns: [] }) }] }] });
  };
  const lines = ['/project TWO', '问题', '/exit']; let draft;
  await runChat(await loadConfig(file), { ask: async () => lines.shift(), log() {}, env: {},
    projects: selected => listProjects(selected, { env: {}, fetchImpl }),
    types: selected => listIssueTypes(selected, { env: {}, fetchImpl }), selectType: async () => 'Task',
    persistProject: (key, backlog) => rememberProject(file, backlog, key),
    generate: async selected => { draft = await generateDraft(selected, { request: '问题' }, { env: {}, fetchImpl }); },
  });
  assert.equal(draft.target.project, 'TWO');
  assert.equal(draft.issueType, 'Task');
  assert.equal((await loadConfig(file)).model.name, 'remembered-model');
  assert.equal(calls.filter(url => url.includes('/projects/TWO')).length, 3);
});
