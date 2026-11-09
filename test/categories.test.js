import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { listCategories, resolveCategory, categorySummary, selectedProjectCategory, withProjectCategory, rememberProjectCategory } from '../src/backlog.js';
import { exampleConfig, loadConfig, credentialFile } from '../src/config.js';
import { generateDraft, validateDraft } from '../src/draft.js';
import { runChat } from '../src/chat.js';

const config = { ...exampleConfig, model: { ...exampleConfig.model, name: 'fixture-model' }, backlog: { origin: 'https://fixture.backlog.com', project: 'ONE' } };
const categories = [{ id: 41, name: 'frontend' }, { id: 72, name: 'backend' }, { id: 98, name: 'UI・UX' }];
const json = data => ({ ok: true, json: async () => data });
const env = { OPENAI_API_KEY: 'MODEL_FIXTURE_SECRET', BACKLOG_API_KEY: 'BACKLOG_FIXTURE_SECRET' };
async function directory(t) { const root = await mkdtemp(path.join(tmpdir(), 'ticket-categories-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('分类直接读取项目カテゴリー，只接受有效ID和名称，拒绝伪造或重名选择', async () => {
  const actual = await listCategories(config, { env, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/api/v2/projects/ONE/categories'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    return json(categories.map(item => ({ ...item, projectId: 123 })));
  } });
  assert.deepEqual(actual, categories);
  assert.equal(resolveCategory(actual, 'backend').id, 72);
  assert.throws(() => resolveCategory(actual, 'invented'), /不属于/);
  assert.throws(() => resolveCategory([categories[0], categories[0]], 'frontend'), /不唯一/);
  for (const value of [null, [{ id: 0, name: 'frontend' }], [{ id: 1, name: 'bad\nname' }]]) {
    await assert.rejects(listCategories(config, { env, fetchImpl: async () => json(value) }), /列表格式/);
  }
});

test('分类按站点项目保存、清除与恢复，不影响工单类型或凭据', async t => {
  const root = await directory(t), filename = path.join(root, 'config.json');
  await writeFile(filename, JSON.stringify(config)); await writeFile(credentialFile(filename), '{"secret":"KEEP"}');
  await rememberProjectCategory(filename, config.backlog, 'frontend');
  await rememberProjectCategory(filename, { ...config.backlog, project: 'TWO' }, 'backend');
  let saved = await loadConfig(filename);
  assert.equal(selectedProjectCategory(saved.backlog), 'frontend'); assert.equal(selectedProjectCategory(saved.backlog, 'TWO'), 'backend');
  assert.equal(selectedProjectCategory({ ...saved.backlog, origin: 'https://other.backlog.com' }), undefined);
  assert.equal(selectedProjectCategory(saved.backlog, 'THREE'), undefined);
  await rememberProjectCategory(filename, config.backlog, ''); saved = await loadConfig(filename);
  assert.equal(selectedProjectCategory(saved.backlog), undefined); assert.equal(selectedProjectCategory(saved.backlog, 'TWO'), 'backend');
  assert.equal(await readFile(credentialFile(filename), 'utf8'), '{"secret":"KEEP"}');
  await assert.rejects(rememberProjectCategory(filename, { ...config.backlog, origin: 'https://other.backlog.com' }, 'backend'), /服务配置已改变/);
});

test('分类前缀不重复，切换或清除仅移除原分类，保留模板标签，超长标题停止', () => {
  assert.equal(categorySummary('【UI】标题', 'frontend'), '【frontend】【UI】标题');
  assert.equal(categorySummary(' 【frontend】【frontend】【UI】标题', 'frontend'), '【frontend】【UI】标题');
  assert.equal(categorySummary('【frontend】 【Frontend】 标题', 'frontend'), '【frontend】标题');
  assert.equal(categorySummary('【FRONTEND】【UI】标题', 'backend', 'frontend'), '【backend】【UI】标题');
  assert.equal(categorySummary('【Frontend】【frontend】标题', '', 'frontend'), '标题');
  assert.equal(categorySummary('【Frontend/脆弱性】标题', 'frontend'), '【frontend】【Frontend/脆弱性】标题');
  assert.equal(categorySummary('【frontend】【UI】标题', 'backend', 'frontend'), '【backend】【UI】标题');
  assert.equal(categorySummary('【backend】【UI】标题', '', 'backend'), '【UI】标题');
  assert.throws(() => validateDraft({ version: 1, summary: categorySummary('x'.repeat(250), 'frontend'), description: '正文', unknowns: [], attachments: [] }), /255/);
  assert.throws(() => validateDraft({ version: 1, summary: '标题', description: '正文', unknowns: [], attachments: [], category: ['frontend'] }), /category/);
});

test('两种协议拟稿校验真实分类，修改保留原分类、不受新默认影响，未选择分类的旧稿不被重分类', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    const selected = { ...config, model: { ...config.model, protocol }, backlog: withProjectCategory(config.backlog, 'frontend') };
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push([String(url), options.method]);
      if (options.method === 'GET') return json(categories);
      const body = JSON.parse(options.body), report = JSON.parse(protocol === 'responses' ? body.input[0].content[0].text : body.messages[1].content[0].text);
      const result = JSON.stringify({ summary: '【frontend】【UI】标题', description: '正文', unknowns: [] });
      assert.equal(report.category, 'frontend');
      return protocol === 'responses' ? json({ output: [{ type: 'message', content: [{ type: 'output_text', text: result }] }] }) : json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: result } }] });
    };
    const first = await generateDraft(selected, { request: '问题', metadata: false }, { env, fetchImpl });
    assert.equal(first.summary, '【frontend】【UI】标题'); assert.equal(first.category, 'frontend');
    const next = await generateDraft({ ...selected, backlog: withProjectCategory(config.backlog, 'backend') }, { request: '修改', metadata: false, previousDraft: first }, { env, fetchImpl });
    assert.equal(next.category, 'frontend'); assert.equal(next.summary, first.summary);
    assert.equal(calls.filter(([,method]) => method === 'GET').length, 2);
  }
  let posts = 0;
  await assert.rejects(generateDraft(config, { request: '问题', category: 'invented', metadata: false }, { env, fetchImpl: async (_url, options) => { if (options.method === 'POST') posts++; return json(categories); } }), /不属于/);
  assert.equal(posts, 0);
  const oldDraft = { version: 1, summary: '旧稿', description: '正文', unknowns: [], attachments: [] };
  const revised = await generateDraft({ ...config, backlog: withProjectCategory(config.backlog, 'backend') }, { request: '修改', metadata: false, previousDraft: oldDraft }, { env, fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(JSON.parse(options.body).input[0].content[0].text).category, undefined);
    return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '旧稿修改', description: '正文', unknowns: [] }) }] }] });
  } });
  assert.equal(revised.category, undefined); assert.equal(revised.summary, '旧稿修改');
});

test('/category 支持局部选择、直接名称和清除；失败不改变原选择，切项目无跨项目沿用', async () => {
  const lines = ['/category', '问题一', '/category backend', '/category invented', '问题二', '/project TWO', '问题三', '/category -', '问题四', '/exit'];
  const saved = [], used = [], logs = [];
  await runChat(config, { env, ask: async () => lines.shift(), log: value => logs.push(value),
    categories: async () => categories,
    selectCategory: async (names, current) => { assert.equal(current, '（不指定分类）'); assert.deepEqual(names.slice(1), categories.map(item => item.name)); return 'frontend'; },
    persistCategory: async value => saved.push(value),
    projects: async () => [{ key: 'ONE', name: '一' }, { key: 'TWO', name: '二' }], types: async () => [{ name: 'Task' }], selectType: async () => null,
    generate: async selected => used.push(selectedProjectCategory(selected.backlog)),
  });
  assert.deepEqual(saved, ['frontend', 'backend', '']); assert.deepEqual(used, ['frontend', 'backend', undefined, undefined]);
  assert(logs.some(line => line.includes('不属于')));
});
