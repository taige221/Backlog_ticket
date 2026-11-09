import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWebApp, trustedRequest } from '../src/web-server.js';
import { saveJson, exampleConfig } from '../src/config.js';

const json = data => ({ ok: true, status: 200, json: async () => data });
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-web-test-')), filename = path.join(root, 'config.json');
  const c = { ...exampleConfig, model: { ...exampleConfig.model, name: 'test-model' }, backlog: { origin: 'https://fixture.backlog.com', project: 'DEMO' } };
  await saveJson(filename, c);
  const seen = [];
  const app = await createWebApp({ filename, env: { OPENAI_API_KEY: 'MODEL_PRIVATE', BACKLOG_API_KEY: 'BACKLOG_PRIVATE' }, folder: async () => root,
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname; seen.push({ route, ...options });
      if (route.endsWith('/models')) return json({ data: [{ id: 'test-model' }, { id: 'other-model' }] });
      if (route.endsWith('/issueTypes')) return json([{ id: 18, name: 'Task', templateDescription: '## 現状\n\n## 期待' }, { id: 19, name: 'Bug', templateDescription: '## 現状\n\n## 期待' }]);
      if (route.endsWith('/projects')) return json([{ projectKey: 'DEMO', name: '测试项目' }, { projectKey: 'OTHER', name: '另一项目' }]);
      if (route.endsWith('/priorities')) return json([{ id: 8, name: 'Normal' }]);
      if (route.endsWith('/categories')) return json([{ id: 31, name: 'frontend' }, { id: 42, name: 'backend' }]);
      if (route.endsWith('/users')) return json([{ id: 63, name: 'QA', mailAddress: 'private@example.test' }, { id: 64, name: 'Dev' }]);
      if (route.endsWith('/attachment')) return json({ id: 9 });
      const foundIssue = { id: 51, projectId: 3, issueKey: 'DEMO-51', summary: '手机布局问题', description: '官网已创建的内容', updated: '2026-11-07T00:00:00Z' };
      if (route.endsWith('/issues') && options.method === 'GET') return json([foundIssue]);
      if (route.endsWith('/issues/DEMO-51')) return json(foundIssue);
      if (route.endsWith('/issues')) return json({ id: 51, issueKey: 'DEMO-51' });
      if (route.endsWith('/responses')) {
        const body = JSON.parse(options.body), request = JSON.parse(body.input[0].content[0].text);
        return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: request.previousDraft ? '修改后标题' : request.report, description: '## 現状\n\n用户报告待确认\n\n## 期待\n\n显示正常', unknowns: ['待研发确认'] }) }] }] });
      }
      return json({ id: 3, projectKey: route.split('/').at(-1), name: '测试项目', textFormattingRule: 'markdown' });
    }, ...overrides });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { ...app, root, filename, seen, get: route => app.dispatch('GET', `/api/${route}`), post: (route, body = {}) => app.dispatch('POST', `/api/${route}`, body) };
}

test('local HTTP authorization rejects foreign origins, DNS rebinding, bad or Unicode tokens', () => {
  const host = '127.0.0.1:1234', token = 'a'.repeat(64);
  const request = headers => ({ headers: { host, 'x-ticket-token': token, ...headers } });
  assert(trustedRequest(request({}), host, token));
  assert(trustedRequest(request({ origin: `http://${host}` }), host, token));
  for (const headers of [{ host: 'evil.test:1234' }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { 'x-ticket-token': 'wrong' }, { 'x-ticket-token': '中'.repeat(64) }, { 'x-ticket-token': undefined }]) assert.equal(trustedRequest(request(headers), host, token), false);
  assert(trustedRequest(request({ 'x-ticket-token': undefined }), host, token, false));
});

test('state is credential-free and project/model/type selections persist', async t => {
  const app = await fixture(t);
  const initial = await app.get('state');
  assert(initial.config.apiKeyConfigured && initial.config.backlogKeyConfigured);
  assert(!JSON.stringify(initial).includes('PRIVATE'));
  await app.post('model', { model: 'other-model' });
  await app.post('project', { project: 'OTHER' });
  await app.post('type', { type: 'Bug' });
  const state = await app.get('state');
  assert.equal(state.config.model, 'other-model'); assert.equal(state.config.project, 'OTHER'); assert.equal(state.config.issueType, 'Bug');
  await assert.rejects(app.post('project', { project: 'BAD' }), /可访问/);
  await assert.rejects(app.post('type', { type: 'Imaginary' }), /不属于/);
  const saved = JSON.parse(await readFile(app.filename, 'utf8'));
  assert.equal(saved.backlog.projectTypes['https://fixture.backlog.com'].OTHER, 'Bug');
});

test('web draft/revision/create preserves named attachments and locks every revision with one receipt', async t => {
  const app = await fixture(t);
  const { upload } = await app.post('upload', { name: '证据.txt', data: Buffer.from('fixture attachment').toString('base64'), image: false });
  const { draft } = await app.post('draft', { request: '手机布局问题', uploadIds: [upload.id] });
  assert.equal(draft.summary, '手机布局问题'); assert.deepEqual(draft.attachments, [{ name: '证据.txt' }]);
  assert.equal(draft.submission, null);
  assert(!app.seen.some(item => item.route.endsWith('/issues')));
  const next = (await app.post('revise', { id: draft.id, instruction: '缩短标题' })).draft;
  assert.equal(next.rootId, draft.rootId); assert.equal(next.revisionOf, draft.id); assert.equal(next.summary, '修改后标题');
  assert.deepEqual(next.target, draft.target); assert.deepEqual(next.attachments, draft.attachments);
  const created = await app.post('create', { id: next.id });
  assert.equal(created.issue.issueKey, 'DEMO-51');
  await assert.rejects(app.post('create', { id: draft.id }), /已处理/);
  await assert.rejects(app.post('revise', { id: draft.id, instruction: '继续改' }), /避免重复/);
  const state = await app.get('state');
  assert.equal(state.drafts.length, 2); assert(state.drafts.every(item => item.submission.state === 'created'));
  assert.equal(app.seen.filter(item => item.route.endsWith('/issues')).length, 1);
  assert.equal(app.seen.find(item => item.route.endsWith('/attachment')).body.get('file').name, '证据.txt');
  assert(!JSON.stringify(state).includes('PRIVATE'));
});

test('起票语言持久保存，修改保留原稿语言，显式切换保存新版本并保留其他字段', async t => {
  const app = await fixture(t);
  assert.deepEqual((await app.get('state')).languages, { 'zh-CN': '简体中文', ja: '日本語', en: 'English' });
  assert.equal((await app.get('state')).config.language, 'zh-CN');
  await app.post('config/language', { language: 'ja' });
  assert.equal(JSON.parse(await readFile(app.filename, 'utf8')).language, 'ja');
  const { upload } = await app.post('upload', { name: '证据.txt', data: Buffer.from('evidence').toString('base64') });
  const first = (await app.post('draft', { request: '中文报告', uploadIds: [upload.id], assignee: 'QA', notifiedUsers: ['Dev'], startDate: '2026-11-06', dueDate: '2026-11-13' })).draft;
  assert.equal(first.language, 'ja');
  await app.post('config/language', { language: 'en' });
  const revised = (await app.post('revise', { id: first.id, instruction: '补充说明' })).draft;
  assert.equal(revised.language, 'ja');
  const changed = (await app.post('revise', { id: revised.id, instruction: '统一使用英文', language: 'en' })).draft;
  assert.equal(changed.language, 'en');
  assert.equal(changed.rootId, first.rootId); assert.equal(changed.revisionOf, revised.id);
  for (const key of ['target', 'issueType', 'attachments', 'startDate', 'dueDate', 'assignee', 'notifiedUsers']) assert.deepEqual(changed[key], first[key]);
  const modelCalls = () => app.seen.filter(item => item.route.endsWith('/responses'));
  assert.deepEqual(modelCalls().map(item => JSON.parse(JSON.parse(item.body).input[0].content[0].text).language), ['ja', 'ja', 'en']);
  assert.equal((await app.get('state')).drafts.find(draft => draft.id === first.id).language, 'ja');
  const count = modelCalls().length;
  await assert.rejects(app.post('config/language', { language: 'invalid' }), /起票语言/);
  await assert.rejects(app.post('draft', { request: '问题', language: 'invalid', uploadIds: [] }), /起票语言/);
  assert.equal(modelCalls().length, count);
  assert.equal((await app.get('state')).config.language, 'en');
  assert(!app.seen.some(item => item.route.endsWith('/issues')));
  await app.post('create', { id: changed.id });
  await assert.rejects(app.post('revise', { id: first.id, instruction: '改为中文', language: 'zh-CN' }), /避免重复/);
});

test('工作台核对旧版提交记录并关联工单，所有草稿版本保持提交锁', async t => {
  const app = await fixture(t);
  const first = (await app.post('draft', { request: '手机布局问题', uploadIds: [] })).draft;
  const next = (await app.post('revise', { id: first.id, instruction: '改标题' })).draft;
  await saveJson(path.join(app.root, 'drafts', `${first.id}.json.submission.json`), { state: 'sending', summary: first.summary, target: first.target });
  const count = app.seen.length;
  const search = await app.post('submission/check', { id: next.id });
  assert.equal(search.keyword, first.summary);
  assert.equal(search.issues[0].issueKey, 'DEMO-51');
  await assert.rejects(app.post('create', { id: next.id }), /阻止重复/);
  const { issue } = await app.post('submission/check', { id: next.id, key: 'DEMO-51' });
  const result = await app.post('submission/link', { id: next.id, key: issue.issueKey, expectedSummary: issue.summary, expectedUpdated: issue.updated });
  assert.equal(result.draft.submission.state, 'created');
  assert.equal(result.draft.submission.url, 'https://fixture.backlog.com/view/DEMO-51');
  assert((await app.get('state')).drafts.every(draft => draft.submission.issueKey === 'DEMO-51'));
  assert(app.seen.slice(count).every(request => request.method === 'GET'));
  await assert.rejects(app.post('create', { id: first.id }), /已处理/);
  await assert.rejects(app.post('draft/edit', { id: first.id, summary: '改写', description: '正文' }), /避免重复/);
});

test('uploads and draft IDs reject traversal, fake images and invalid base64', async t => {
  const app = await fixture(t);
  await assert.rejects(app.post('revise', { id: '../config', instruction: '改' }), /编号无效/);
  await assert.rejects(app.post('upload', { name: '..', data: 'eA==', image: false }), /文件名无效/);
  await assert.rejects(app.post('upload', { name: 'x.png', data: 'eA==', image: true }), /仅支持/);
  assert.deepEqual(await readdir(path.join(app.root, 'uploads')), []);
  await assert.rejects(app.post('upload', { name: 'x.txt', data: 'not base64', image: false }), /内容无效/);
  await assert.rejects(app.post('draft', { request: '问题', uploadIds: ['../config'] }), /附件列表/);
  const { upload } = await app.post('upload', { name: '../../report.txt', data: 'eA==', image: false });
  assert.equal(upload.name, 'report.txt');
});

test('附件占用可见，移除实际删除文件与记录；清理保留当前待用附件、配置和外部文件', async t => {
  const app = await fixture(t);
  assert.equal((await app.get('storage')).storage.bytes, 0);
  const add = async name => (await app.post('upload', { name, data: Buffer.alloc(1024).toString('base64') })).upload;
  const removed = await add('移除.txt'), kept = await add('当前.txt'), orphan = await add('遗留.txt');
  const before = (await app.get('storage')).storage;
  assert.equal(before.directory, path.join(app.root, 'uploads')); assert.equal(before.files, 3);
  assert(before.bytes > 3072); assert.equal(before.unusedBytes, before.bytes); assert.equal(before.retainedBytes, 0);
  const configBefore = await readFile(app.filename, 'utf8');
  const external = path.join(app.root, '原始文件.txt'); await writeFile(external, '原始文件保留');
  await assert.rejects(app.post('uploads/remove', {}), /编号无效/);
  await assert.rejects(app.post('uploads/remove', { ids: ['../原始文件.txt'] }), /编号无效/);
  await assert.rejects(app.post('storage/cleanup', { keepIds: ['../config'] }), /编号无效/);
  await app.post('uploads/remove', { ids: [removed.id] });
  for (const file of [path.join(removed.id, removed.name), `${removed.id}.json`]) await assert.rejects(readFile(path.join(app.root, 'uploads', file)), { code: 'ENOENT' });
  const cleaned = await app.post('storage/cleanup', { keepIds: [kept.id] });
  assert.equal(cleaned.removedFiles, 1); assert(cleaned.freedBytes > 1024); assert.equal(cleaned.storage.files, 1);
  await assert.rejects(readFile(path.join(app.root, 'uploads', orphan.id, orphan.name)), { code: 'ENOENT' });
  assert.equal((await readFile(path.join(app.root, 'uploads', kept.id, kept.name))).length, 1024);
  assert.equal(await readFile(app.filename, 'utf8'), configBefore); assert.equal(await readFile(external, 'utf8'), '原始文件保留');
  await app.post('uploads/remove', { ids: [kept.id] });
  assert.equal((await app.get('storage')).storage.bytes, 0);
  assert(!JSON.stringify(cleaned).includes('PRIVATE'));
});

test('清理检查全部历史草稿，保留共享与相对路径附件，包括不在最近50项中的版本', async t => {
  const app = await fixture(t);
  const upload = (await app.post('upload', { name: '草稿证据.txt', data: 'eA==' })).upload;
  const draft = (await app.post('draft', { request: '问题', uploadIds: [upload.id] })).draft;
  const saved = JSON.parse(await readFile(path.join(app.root, 'drafts', `${draft.id}.json`), 'utf8'));
  saved.attachments = [path.join('..', 'uploads', upload.id, upload.name)];
  await writeFile(path.join(app.root, 'drafts', '000-旧版本.json'), JSON.stringify(saved));
  await rm(path.join(app.root, 'drafts', `${draft.id}.json`));
  for (let i = 0; i < 55; i++) await saveJson(path.join(app.root, 'drafts', `999-new-${i}.json`), { ...saved, attachments: [] });
  assert.equal((await app.get('state')).drafts.length, 50);
  const before = (await app.get('storage')).storage;
  assert(before.retainedBytes > 0); assert.equal(before.unusedBytes, 0);
  assert.equal((await app.post('storage/cleanup')).removedFiles, 0);
  await assert.rejects(app.post('uploads/remove', { ids: [upload.id] }), /仍被.*草稿引用/);
  assert.equal(await readFile(path.join(app.root, 'uploads', upload.id, upload.name), 'utf8'), 'x');
});

test('损坏草稿或目录中的符号链接会停止附件清理，不跟随外部文件', async t => {
  const app = await fixture(t);
  const upload = (await app.post('upload', { name: '未保存.txt', data: 'eA==' })).upload;
  const draft = (await app.post('draft', { request: '问题', uploadIds: [] })).draft;
  const file = path.join(app.root, 'drafts', `${draft.id}.json`), original = await readFile(file, 'utf8');
  await writeFile(file, 'broken-json');
  assert.equal((await app.get('storage')).storage.blocked, true);
  await assert.rejects(app.post('storage/cleanup'), /已停止清理/);
  await assert.rejects(app.post('uploads/remove', { ids: [upload.id] }), /已停止清理/);
  assert.equal(await readFile(path.join(app.root, 'uploads', upload.id, upload.name), 'utf8'), 'x');
  await writeFile(file, original);
  if (process.platform !== 'win32') {
    const external = path.join(app.root, '外部.txt'); await writeFile(external, '保留');
    await symlink(external, path.join(app.root, 'uploads', upload.id, 'link.txt'));
    assert.equal((await app.get('storage')).storage.blocked, true);
    await assert.rejects(app.post('storage/cleanup'), /已停止清理/);
    assert.equal(await readFile(external, 'utf8'), '保留');
  }
});

test('删除整份草稿的所有历史与分支，回收独用附件，保护共享、待用附件、原文件和用量记录', async t => {
  const app = await fixture(t);
  const add = async name => (await app.post('upload', { name, data: 'eA==' })).upload;
  const unique = await add('独用.txt'), shared = await add('共享.txt'), pending = await add('待用.txt');
  const first = (await app.post('draft', { request: '需要删除', conversationId: 'delete-family', uploadIds: [unique.id, shared.id] })).draft;
  const next = (await app.post('revise', { id: first.id, instruction: '修改' })).draft;
  const branch = (await app.post('revise', { id: first.id, instruction: '分支' })).draft;
  const other = (await app.post('draft', { request: '保留草稿', uploadIds: [shared.id] })).draft;
  const originalFile = path.join(app.root, '原始文件.txt'); await writeFile(originalFile, '保留原文件');
  const saved = JSON.parse(await readFile(path.join(app.root, 'drafts', `${first.id}.json`), 'utf8'));
  for (let i = 0; i < 52; i++) await saveJson(path.join(app.root, 'drafts', `old-${i}.json`), { ...saved, attachments: [...saved.attachments, originalFile] });
  const usageBefore = await app.get('usage/delete-family'), configBefore = await readFile(app.filename, 'utf8');
  const seenBefore = app.seen.length;
  const result = await app.post('draft/delete', { id: next.id });
  assert.equal(result.rootId, first.rootId); assert.equal(result.deletedIds.length, 55); assert.equal(result.removedFiles, 1, JSON.stringify(result)); assert(result.freedBytes > 0);
  assert(result.deletedIds.includes(branch.id)); assert.equal(app.seen.length, seenBefore);
  assert.deepEqual((await app.get('state')).drafts.map(draft => draft.id), [other.id]);
  await assert.rejects(readFile(path.join(app.root, 'uploads', unique.id, unique.name)), { code: 'ENOENT' });
  for (const upload of [shared, pending]) assert.equal(await readFile(path.join(app.root, 'uploads', upload.id, upload.name), 'utf8'), 'x');
  assert.equal(await readFile(originalFile, 'utf8'), '保留原文件'); assert.equal(await readFile(app.filename, 'utf8'), configBefore);
  assert.deepEqual((await app.get('usage/delete-family')).conversation, usageBefore.conversation);
  await assert.rejects(app.post('revise', { id: first.id, instruction: '不能再改' }), { code: 'ENOENT' });
});

test('删除已提交或结果待确认的本地草稿保留提交锁，恢复旧稿也不能重复创建', async t => {
  for (const state of ['created', 'sending']) {
    const app = await fixture(t);
    const draft = (await app.post('draft', { request: '有提交记录', uploadIds: [] })).draft;
    const file = path.join(app.root, 'drafts', `${draft.id}.json`), before = await readFile(file, 'utf8');
    const receiptFile = path.join(app.root, 'drafts', `${draft.rootId}.json.submission.json`);
    if (state === 'created') await app.post('create', { id: draft.id });
    else await saveJson(receiptFile, { state: 'sending', summary: draft.summary });
    const receipt = await readFile(receiptFile, 'utf8'), seen = app.seen.length;
    await app.post('draft/delete', { id: draft.id });
    assert.equal(await readFile(receiptFile, 'utf8'), receipt); assert.equal(app.seen.length, seen);
    assert.equal((await app.get('state')).drafts.length, 0);
    await writeFile(file, before);
    await assert.rejects(app.post('create', { id: draft.id }), /已处理|结果未确认/);
    assert.equal(app.seen.length, seen);
  }
});

test('删除拒绝越界、预览中与并发操作；损坏或成环的版本在任何删除前停止', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, { folder: async () => { await waiting; return app.root; }, preview: async (_draft, _config, { ask, signal }) => { try { await ask('确认已进入新建页', { signal }); } catch {} } });
  const first = (await app.post('draft', { request: '保留', uploadIds: [] })).draft;
  await assert.rejects(app.post('draft/delete', { id: '../config' }), /编号无效/);
  const working = app.post('folder');
  await assert.rejects(app.post('draft/delete', { id: first.id }), /上一项操作/);
  release(); await working;
  await app.post('preview', { id: first.id });
  await assert.rejects(app.post('draft/delete', { id: first.id }), /先关闭官网预览/);
  await app.post('preview/close');
  const broken = path.join(app.root, 'drafts', 'broken.json'); await writeFile(broken, 'bad-json');
  await assert.rejects(app.post('draft/delete', { id: first.id }), /版本无法检查/);
  const file = path.join(app.root, 'drafts', `${first.id}.json`), saved = JSON.parse(await readFile(file, 'utf8'));
  await rm(broken); await writeFile(file, JSON.stringify({ ...saved, revisionOf: file }));
  await assert.rejects(app.post('draft/delete', { id: first.id }), /关联成环/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).summary, '保留');
});

test('旧版没有webRootId的草稿与分支可一起删除，不留下失效父版本关联', async t => {
  const app = await fixture(t);
  const first = (await app.post('draft', { request: '旧版本', uploadIds: [] })).draft;
  const next = (await app.post('revise', { id: first.id, instruction: '修改' })).draft;
  const branch = (await app.post('revise', { id: first.id, instruction: '分支' })).draft;
  for (const draft of [first, next, branch]) {
    const file = path.join(app.root, 'drafts', `${draft.id}.json`), saved = JSON.parse(await readFile(file, 'utf8'));
    delete saved.webRootId; await writeFile(file, JSON.stringify(saved));
  }
  const result = await app.post('draft/delete', { id: branch.id });
  assert.equal(result.deletedIds.length, 3); assert.equal(result.rootId, first.id);
  assert.equal((await app.get('state')).drafts.length, 0);
});

test('草稿删除成功但附件清理失败时返回明确警告，不清理目录异常条目', async t => {
  const app = await fixture(t);
  const upload = (await app.post('upload', { name: '保留附件.txt', data: 'eA==' })).upload;
  const draft = (await app.post('draft', { request: '删除', uploadIds: [upload.id] })).draft;
  await writeFile(path.join(app.root, 'uploads', 'unexpected.txt'), '手工文件');
  const result = await app.post('draft/delete', { id: draft.id });
  assert.match(result.warning, /草稿已删除，但附件清理未完成/);
  assert.equal((await app.get('state')).drafts.length, 0);
  assert.equal(await readFile(path.join(app.root, 'uploads', upload.id, upload.name), 'utf8'), 'x');
  assert.equal(await readFile(path.join(app.root, 'uploads', 'unexpected.txt'), 'utf8'), '手工文件');
});

test('已有未提交草稿显示和创建时清理模块空值尾巴，保留原文件和正文', async t => {
  const app = await fixture(t);
  const draft = (await app.post('draft', { request: '通用设置菜单权限显示不一致', uploadIds: [] })).draft;
  const file = path.join(app.root, 'drafts', `${draft.id}.json`), saved = JSON.parse(await readFile(file, 'utf8'));
  saved.summary += '/通用设置菜单/无';
  await writeFile(file, JSON.stringify(saved));
  const before = await readFile(file, 'utf8');
  const displayed = (await app.get('state')).drafts.find(item => item.id === draft.id);
  assert.equal(displayed.summary, draft.summary); assert.equal(displayed.description, draft.description);
  assert.equal(await readFile(file, 'utf8'), before);
  const created = await app.post('create', { id: draft.id });
  assert.equal(app.seen.find(item => item.route.endsWith('/issues')).body.get('summary'), draft.summary);
  assert.equal(created.draft.summary, draft.summary);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('网页分类来自项目列表，保存默认、给已有草稿切换与清除分类，保留所有版本和提交锁', async t => {
  const app = await fixture(t);
  assert.deepEqual((await app.get('categories')).categories.map(item => item.name), ['frontend', 'backend']);
  await app.post('category', { category: 'frontend' });
  assert.equal((await app.get('state')).config.category, 'frontend');
  const first = (await app.post('draft', { request: '问题', uploadIds: [] })).draft;
  assert.equal(first.category, 'frontend'); assert.equal(first.summary, '【frontend】问题');
  const next = (await app.post('category', { id: first.id, category: 'backend' })).draft;
  assert.equal(next.rootId, first.rootId); assert.equal(next.summary, '【backend】问题'); assert.equal(next.description, first.description); assert.deepEqual(next.attachments, first.attachments);
  assert.equal((await app.get('state')).config.category, 'frontend');
  const revised = (await app.post('revise', { id: next.id, instruction: '改标题' })).draft;
  assert.equal(revised.category, 'backend'); assert.equal(revised.summary, '【backend】修改后标题');
  const cleared = (await app.post('category', { id: next.id, category: '' })).draft;
  assert.equal(cleared.category, undefined); assert.equal(cleared.summary, '问题');
  await assert.rejects(app.post('category', { id: first.id, category: 'invented' }), /不属于/);
  await app.post('create', { id: next.id });
  const post = app.seen.find(item => item.route.endsWith('/issues'));
  assert.deepEqual(post.body.getAll('categoryId[]'), ['42']);
  await assert.rejects(app.post('category', { id: first.id, category: 'frontend' }), /避免重复/);
  await assert.rejects(app.post('create', { id: cleared.id }), /已处理/);
  await app.post('project', { project: 'OTHER' });
  assert.equal((await app.get('state')).config.category, '');
});

test('手动编辑标题正文保存独立新版本，保留元数据、原稿和费用；预览创建使用编辑结果', async t => {
  const previews = [];
  const app = await fixture(t, { preview: async (draft, _config, { ask, signal }) => { previews.push(draft); try { await ask('确认已进入', { signal }); } catch {} } });
  await app.post('category', { category: 'frontend' });
  const { upload } = await app.post('upload', { name: '证据.txt', data: Buffer.from('evidence').toString('base64') });
  const first = (await app.post('draft', { request: '原标题', uploadIds: [upload.id], language: 'ja', startDate: '2027-01-04', dueDate: '2027-01-08', assignee: 'QA', notifiedUsers: ['Dev'] })).draft;
  const original = await readFile(path.join(app.root, 'drafts', `${first.id}.json`), 'utf8');
  const usage = await app.get(`usage/${first.rootId}`), calls = app.seen.length;
  const edit = { id: first.id, summary: '【Frontend】【frontend】手动标题', description: '\n## 自定义正文\n\n手动填写的内容。\n  保留缩进和末尾换行。\n' };
  const next = (await app.post('draft/edit', { ...edit, target: { project: 'OTHER' }, attachments: [], assignee: 'Other', unknowns: [] })).draft;
  assert.notEqual(next.id, first.id); assert.equal(next.rootId, first.rootId); assert.equal(next.revisionOf, first.id);
  assert.equal(next.summary, '【frontend】手动标题'); assert.equal(next.description, edit.description);
  for (const key of ['target', 'issueType', 'category', 'language', 'startDate', 'dueDate', 'assignee', 'notifiedUsers', 'unknowns', 'attachments', 'generationId']) assert.deepEqual(next[key], first[key]);
  assert.equal(app.seen.length, calls); assert.deepEqual(await app.get(`usage/${next.rootId}`), usage);
  assert.equal(await readFile(path.join(app.root, 'drafts', `${first.id}.json`), 'utf8'), original);
  assert.equal((await app.post('draft/edit', { id: next.id, summary: next.summary, description: next.description })).draft.id, next.id);
  assert.equal((await app.get('state')).drafts.length, 2);
  await app.post('preview', { id: next.id }); await app.get('preview');
  assert.equal(previews[0].summary, next.summary); assert.equal(previews[0].description, next.description);
  await assert.rejects(app.post('draft/edit', edit), /先关闭/);
  await app.post('preview/close'); await app.post('create', { id: next.id });
  const body = app.seen.find(item => item.route.endsWith('/issues')).body;
  assert.equal(body.get('summary'), next.summary); assert.equal(body.get('description'), next.description);
  for (const id of [first.id, next.id]) await assert.rejects(app.post('draft/edit', { ...edit, id }), /避免重复/);
});

test('手动编辑拒绝空内容、类型错误、标题超长与越界；失败保留原稿', async t => {
  const app = await fixture(t);
  const { draft } = await app.post('draft', { request: '原稿', uploadIds: [] });
  const edit = { id: draft.id, summary: draft.summary, description: draft.description };
  for (const fields of [{ summary: '' }, { summary: '  ' }, { summary: null }, { summary: 'a'.repeat(256) }, { description: '' }, { description: '\n  ' }, { description: {} }, { description: 'a'.repeat(40001) }, { id: '../config' }]) {
    await assert.rejects(app.post('draft/edit', { ...edit, ...fields }));
  }
  await app.post('category', { category: 'frontend' });
  const categorized = (await app.post('draft', { request: '分类草稿', uploadIds: [] })).draft;
  await assert.rejects(app.post('draft/edit', { ...edit, id: categorized.id, summary: 'a'.repeat(255) }), /255/);
  assert.equal((await app.get('state')).drafts.length, 2);
  assert.equal((await app.get('state')).drafts.find(item => item.id === draft.id).description, draft.description);
});

test('手动编辑可在默认项目已切换时离线保存，结果不明或损坏回执仍锁定全部版本', async t => {
  const app = await fixture(t);
  const { draft } = await app.post('draft', { request: '原稿', uploadIds: [] });
  await app.post('project', { project: 'OTHER' });
  await writeFile(app.filename, '{}');
  const calls = app.seen.length;
  const edit = { id: draft.id, summary: '人工调整', description: '自定义结构，无需模型或新项目模板。' };
  const next = (await app.post('draft/edit', edit)).draft;
  assert.deepEqual(next.target, draft.target); assert.equal(app.seen.length, calls);
  const receipt = path.join(app.root, 'drafts', `${draft.rootId}.json.submission.json`);
  for (const data of ['{"state":"unknown"}', 'invalid-json']) {
    await writeFile(receipt, data);
    for (const id of [draft.id, next.id]) await assert.rejects(app.post('draft/edit', { ...edit, id }), /避免重复/);
  }
});

test('网页日期及人员默认值、保存新版本、清空与修改保留；预览和创建沿用保存值', async t => {
  const previews = [];
  const app = await fixture(t, { preview: async (draft, _config, { ask, signal }) => { previews.push(draft); try { await ask('确认已进入', { signal }); } catch {} } });
  const users = await app.get('users'); assert.deepEqual(users.users, [{ id: 63, name: 'QA' }, { id: 64, name: 'Dev' }]);
  const defaults = (await app.get('state')).defaults;
  assert(defaults.dueDate > defaults.startDate); assert.equal(new Date(defaults.dueDate + 'T12:00:00').getDay(), 5);
  const first = (await app.post('draft', { request: '问题', uploadIds: [] })).draft;
  assert.equal(first.startDate, defaults.startDate); assert.equal(first.dueDate, defaults.dueDate); assert.equal(first.assignee, undefined); assert.deepEqual(first.notifiedUsers, []);
  const fields = { startDate: '2027-01-04', dueDate: '2027-01-08', assignee: 'QA', notifiedUsers: ['QA', 'Dev'] };
  const next = (await app.post('fields', { id: first.id, ...fields })).draft;
  assert.equal(next.rootId, first.rootId); assert.equal(next.description, first.description); assert.deepEqual(next.attachments, first.attachments);
  assert.equal(app.seen.filter(item => item.route.endsWith('/responses')).length, 1);
  const revised = (await app.post('revise', { id: next.id, instruction: '改标题' })).draft;
  for (const key of Object.keys(fields)) assert.deepEqual(revised[key], fields[key]);
  const cleared = (await app.post('fields', { id: next.id, ...fields, assignee: '', notifiedUsers: [] })).draft;
  assert.equal(cleared.assignee, undefined); assert.deepEqual(cleared.notifiedUsers, []);
  await assert.rejects(app.post('fields', { id: next.id, ...fields, dueDate: '2027-01-01' }), /早于/);
  await assert.rejects(app.post('fields', { id: next.id, ...fields, notifiedUsers: ['Removed'] }), /不存在/);
  await app.post('preview', { id: revised.id }); await app.get('preview');
  for (const key of Object.keys(fields)) assert.deepEqual(previews[0][key], fields[key]);
  await assert.rejects(app.post('fields', { id: revised.id, ...fields }), /先关闭/);
  await app.post('preview/close'); await app.post('create', { id: revised.id });
  const body = app.seen.find(item => item.route.endsWith('/issues')).body;
  assert.equal(body.get('startDate'), fields.startDate); assert.equal(body.get('dueDate'), fields.dueDate); assert.equal(body.get('assigneeId'), '63'); assert.deepEqual(body.getAll('notifiedUserId[]'), ['63', '64']);
  await assert.rejects(app.post('fields', { id: first.id, ...fields }), /避免重复/);
});

test('网页图片与其他附件在拟稿、修改及创建之间保持一致，模型遗漏图片引用时仍自动补齐', async t => {
  const app = await fixture(t);
  const image = (await app.post('upload', { name: '页面截图.png', data: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'), image: true })).upload;
  const pdf = (await app.post('upload', { name: '说明.pdf', data: Buffer.from('%PDF-1.4').toString('base64'), image: false })).upload;
  const { draft } = await app.post('draft', { request: '带截图的问题', uploadIds: [image.id, pdf.id] });
  assert(draft.description.includes('![image][页面截图.png]\n\n## 期待'));
  const next = (await app.post('revise', { id: draft.id, instruction: '缩短标题' })).draft;
  assert.equal(next.description, draft.description);
  assert.deepEqual(next.attachments, [{ name: '页面截图.png' }, { name: '说明.pdf' }]);
  await app.post('create', { id: next.id });
  const post = app.seen.find(item => item.route.endsWith('/issues'));
  assert.equal(post.body.get('description'), next.description);
  assert.deepEqual(post.body.getAll('attachmentId[]'), ['9', '9']);
  assert.deepEqual(app.seen.filter(item => item.route.endsWith('/attachment')).map(item => item.body.get('file').name), ['页面截图.png', '说明.pdf']);
  const model = app.seen.find(item => item.route.endsWith('/responses'));
  assert.equal(JSON.parse(model.body).input[0].content.filter(item => item.type === 'input_image').length, 1);
  assert(!model.body.includes('%PDF-1.4'));
});

test('手动将图片移到对应正文段落后，预览与创建保留位置、图片说明及其他附件', async t => {
  const previews = [];
  const app = await fixture(t, { preview: async (draft, _config, { ask, signal }) => { previews.push(draft); try { await ask('确认新建页', { signal }); } catch {} } });
  const image = (await app.post('upload', { name: '页面截图.png', data: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'), image: true })).upload;
  const pdf = (await app.post('upload', { name: '说明.pdf', data: Buffer.from('%PDF-1.4').toString('base64') })).upload;
  const { draft: first } = await app.post('draft', { request: '菜单异常', uploadIds: [image.id, pdf.id] });
  const description = '## 現状\n菜单折叠与展开的权限显示不一致。\n\n## 期待\n应显示相同菜单，对照画面如下：\n\n![对照画面][页面截图.png]\n\n验收时分别检查两种状态。';
  const { draft } = await app.post('draft/edit', { id: first.id, summary: first.summary, description });
  assert.equal(draft.description, description);
  assert.equal(app.seen.filter(item => item.route.endsWith('/responses')).length, 1);
  await app.post('preview', { id: draft.id }); await app.get('preview');
  assert.equal(previews[0].description, description);
  await app.post('preview/close'); await app.post('create', { id: draft.id });
  assert.equal(app.seen.find(item => item.route.endsWith('/issues')).body.get('description'), description);
  assert.deepEqual(app.seen.filter(item => item.route.endsWith('/attachment')).map(item => item.body.get('file').name), ['页面截图.png', '说明.pdf']);
  assert.equal((description.match(/页面截图\.png/g) || []).length, 1);
});

test('草稿附件可离线替换、移除和添加，正文位置和旧版本保留', async t => {
  const app = await fixture(t);
  const upload = async (name, image = true) => (await app.post('upload', {
    name, image, data: (image ? Buffer.from([137,80,78,71,13,10,26,10]) : Buffer.from('document')).toString('base64'),
  })).upload.id;
  const first = (await app.post('draft', { request: '附件维护', uploadIds: [await upload('旧图.png'), await upload('移除.png'), await upload('保留.pdf', false)] })).draft;
  const replacement = await upload('替换图.png'), added = await upload('新增图.png');
  const edit = { id: first.id, summary: first.summary,
    description: '## 現状\n这里新增对照。\n\n## 期待\n预期如下。\n![对照][旧图.png]\n\n![删除][移除.png]\n\n```md\n![示例][移除.png]\n```',
    files: [{ id: replacement, replaces: 0 }, { index: 2 }, { id: added }] };
  const calls = app.seen.length;
  await writeFile(app.filename, '{}');
  await assert.rejects(app.post('draft/edit', { ...edit, files: [{ index: 0 }, { id: replacement, replaces: 0 }] }), /附件位置无效/);
  const { draft } = await app.post('draft/edit', edit);
  assert.equal(app.seen.length, calls);
  assert.equal(draft.revisionOf, first.id);
  assert.deepEqual(draft.attachments.map(file => file.name), ['替换图.png', '保留.pdf', '新增图.png']);
  assert.match(draft.description, /新增图\.png\]\n\n## 期待\n预期如下。\n!\[对照\]\[替换图\.png\]/);
  assert.doesNotMatch(draft.description, /旧图\.png|!\[删除\]/);
  assert.match(draft.description, /```md\n!\[示例\]\[移除\.png\]\n```/);
  assert.deepEqual((await app.get('state')).drafts.find(item => item.id === first.id), first);
  await app.post('storage/cleanup');
  assert.equal((await app.get('storage')).storage.unusedBytes, 0);
});

test('选择 AI 补写时只发送新增截图，手动标题和选定附件随新版本保存', async t => {
  const app = await fixture(t);
  const upload = async name => (await app.post('upload', {
    name, image: true, data: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'),
  })).upload.id;
  const first = (await app.post('draft', { request: '附件维护', uploadIds: [await upload('保留.png')] })).draft;
  const screenshot = await upload('新增.png');
  const note = (await app.post('upload', { name: '说明.txt', data: Buffer.from('文档').toString('base64') })).upload.id;
  const request = { id: first.id, instruction: '根据新截图补充正文', edit: { summary: '手动修改的标题', description: first.description,
    files: [{ index: 0 }, { id: note }, { id: screenshot }] } };
  await app.post('config/repo', { repo: app.root });
  await assert.rejects(app.post('revise', { ...request, edit: { ...request.edit, files: [{ index: 0 }, { id: note }] } }), /1 至 5 张/);
  assert.equal((await app.get('state')).drafts.length, 1);
  const { draft } = await app.post('revise', request);
  assert.equal(draft.summary, '手动修改的标题');
  assert.equal(draft.revisionOf, first.id);
  assert.deepEqual(draft.attachments.map(file => file.name), ['保留.png', '说明.txt', '新增.png']);
  assert.match(draft.description, /!\[image\]\[新增\.png\]/);
  const modelRequest = JSON.parse(app.seen.filter(call => call.route.endsWith('/responses')).at(-1).body);
  assert.equal(modelRequest.tools, undefined);
  const content = modelRequest.input[0].content;
  assert.equal(content.filter(part => part.type === 'input_image').length, 1);
  assert.deepEqual(JSON.parse(content[0].text).images.map(image => [image.name, image.sentToModel]), [['新增.png', true], ['保留.png', false]]);
});

test('项目分别保存代码目录，切换后生成与修改草稿沿用目标项目配置', async t => {
  const app = await fixture(t);
  const origin = 'https://fixture.backlog.com';
  const firstRepo = path.join(app.root, 'demo-source'), otherRepo = path.join(app.root, 'other-source');
  await mkdir(firstRepo);
  await mkdir(otherRepo);
  await writeFile(path.join(firstRepo, 'demo.js'), 'export const source = "DEMO";');
  await writeFile(path.join(otherRepo, 'other.js'), 'export const source = "OTHER";');
  const legacy = JSON.parse(await readFile(app.filename, 'utf8'));
  await writeFile(app.filename, JSON.stringify({ ...legacy, repo: './demo-source' }));
  const lastTools = () => JSON.parse(app.seen.filter(call => call.route.endsWith('/responses')).at(-1).body).tools;
  assert.equal((await app.get('state')).config.repo, firstRepo);
  const { draft } = await app.post('draft', { request: '项目一的问题', uploadIds: [] });
  assert(lastTools()?.some(tool => tool.name === 'read_file'));

  assert.equal((await app.post('project', { project: 'OTHER' })).config.repo, '');
  await assert.rejects(app.post('config/repo', { repo: firstRepo, project: 'DEMO', origin }), /项目已切换/);
  await app.post('draft', { request: '项目二的问题', uploadIds: [] });
  assert.equal(lastTools(), undefined);
  await assert.rejects(app.post('revise', { id: draft.id, instruction: '请检查代码' }), /切回草稿对应/);
  assert.equal((await app.post('config/repo', { repo: otherRepo, project: 'OTHER', origin })).config.repo, await realpath(otherRepo));

  assert.equal((await app.post('project', { project: 'DEMO' })).config.repo, firstRepo);
  assert.equal((await app.post('revise', { id: draft.id, instruction: '请检查代码' })).draft.target.project, 'DEMO');
  assert(lastTools()?.some(tool => tool.name === 'read_file'));
  await app.post('config/repo', { repo: '', project: 'DEMO', origin });
  assert.equal((await app.get('state')).config.repo, '');
  assert.equal((await app.post('project', { project: 'OTHER' })).config.repo, await realpath(otherRepo));
});

test('independent repo and API configuration keeps credentials out of state', async t => {
  const app = await fixture(t);
  await app.post('config/repo', { repo: app.root });
  assert.equal((await app.get('state')).config.repo, await import('node:fs/promises').then(fs => fs.realpath(app.root)));
  await app.post('config/repo', { repo: '' });
  await app.post('config/api', { key: 'sk-proj-WEB_PRIVATE_KEY' });
  assert.equal((await app.get('state')).config.provider, 'openai');
  assert(!JSON.stringify(await app.get('state')).includes('WEB_PRIVATE_KEY'));
  await assert.rejects(app.post('config/api', { key: 'unknown-key' }), /请选择/);
});

test('saving Backlog retains a reachable selected project and first setup chooses an accessible project', async t => {
  const app = await fixture(t, { fetchImpl: async () => json([{ projectKey: 'OTHER', name: 'Other' }, { projectKey: 'DEMO', name: 'Demo' }]) });
  const first = await app.post('config/backlog', { origin: 'https://fixture.backlog.com', key: '' });
  assert.equal(first.config.project, 'DEMO');
  const saved = JSON.parse(await readFile(app.filename, 'utf8'));
  saved.backlog.project = '';
  await writeFile(app.filename, JSON.stringify(saved));
  const initial = await app.post('config/backlog', { origin: 'https://fixture.backlog.com', key: '' });
  assert.equal(initial.config.project, 'OTHER');
  assert.equal(initial.projects.length, 2);
});

test('preview login prompt is acknowledged in web UI, creation is blocked until preview closes', async t => {
  const app = await fixture(t, { preview: async (_draft, _config, { ask, log, signal }) => {
    try { await ask('确认已进入新建页', { signal }); log('已填入官网新建表单'); await ask('按回车关闭预览', { signal }); }
    catch { /* Simulate browser closed. */ }
  } });
  const draft = (await app.post('draft', { request: '问题', uploadIds: [] })).draft;
  assert.equal((await app.post('preview', { id: draft.id })).preview.state, 'waiting');
  await assert.rejects(app.post('create', { id: draft.id }), /先关闭/);
  await assert.rejects(app.post('revise', { id: draft.id, instruction: '改为日文', language: 'ja' }), /先关闭官网预览/);
  await app.post('preview/continue');
  assert.equal((await app.get('preview')).preview.state, 'ready');
  await assert.rejects(app.post('preview/continue'), /没有等待/);
  assert.equal((await app.post('preview/close')).preview.state, 'closed');
  assert.equal((await app.post('create', { id: draft.id })).issue.issueKey, 'DEMO-51');
});

test('web mutation concurrency cannot create duplicate requests during model generation', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, { folder: async () => { await waiting; return '/fixture'; } });
  const pending = app.post('folder');
  await assert.rejects(app.post('config/repo', { repo: '' }), /上一项操作/);
  release(); await pending;
});

test('网页生成详情在等待中可读，失败费用计入同一对话，恢复和字段编辑不重复计费', async t => {
  let release, started, bad = true;
  const gate = new Promise(resolve => { release = resolve; }), beginning = new Promise(resolve => { started = resolve; });
  const app = await fixture(t, { fetchImpl: async (url, options) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/issueTypes')) return json([{ name: 'Task', templateDescription: '## 現状\n\n## 期待' }]);
    if (options.method === 'POST') {
      started(); await gate;
      return json({ usage: { input_tokens: 10, output_tokens: 5, cost: bad ? 0.001 : 0.002 }, output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '服务商返回的摘要' }], encrypted_content: 'HIDDEN' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '测试工单', description: `## 現状\n${bad ? '报告称，' : ''}菜单显示异常。\n\n## 期待\n显示一致。`, unknowns: [] }) }] }] });
    }
    return json({ projectKey: 'DEMO', textFormattingRule: 'markdown' });
  } });
  const c = JSON.parse(await readFile(app.filename, 'utf8')); c.model.baseUrl = 'https://openrouter.ai/api/v1'; await writeFile(app.filename, JSON.stringify(c));
  const pending = app.post('draft', { request: '测试', uploadIds: [], conversationId: 'same-chat' });
  const rejected = assert.rejects(pending, /转述开头/);
  await beginning;
  const running = (await app.get('activity')).activity; assert.equal(running.state, 'running'); assert.equal(running.usage.missingCost, 1);
  release(); await rejected;
  assert.equal((await app.get('activity')).activity.state, 'error');
  assert.equal((await app.get('usage/same-chat')).conversation.costUsd, 0.001);
  bad = false;
  const result = await app.post('draft', { request: '测试', uploadIds: [], conversationId: 'same-chat' });
  assert.equal(result.draft.rootId, 'same-chat');
  const saved = (await app.get(`activity/${result.draft.generationId}`)).activity;
  assert.equal(saved.thoughts[0].text, '服务商返回的摘要'); assert(!JSON.stringify(saved).includes('HIDDEN'));
  assert.equal((await app.get('usage/same-chat')).conversation.costUsd, 0.003);
  await app.post('fields', { id: result.draft.id, startDate: '2026-11-06', dueDate: '2026-11-13', notifiedUsers: [] });
  assert.equal((await app.get('usage/same-chat')).conversation.requests, 2);
  const restored = await createWebApp({ filename: app.filename, env: { OPENAI_API_KEY: 'MODEL_PRIVATE' } });
  try { assert.equal((await restored.dispatch('GET', '/api/usage/same-chat')).conversation.costUsd, 0.003); }
  finally { await restored.close(); }
  assert(!JSON.stringify([await app.get('activity'), await app.get('usage/same-chat')]).includes('PRIVATE'));
});

test('生成忙碌时仍可停止，原稿保留、未知用量不记零，停止后可继续修改', async t => {
  let block = false, started;
  const beginning = new Promise(resolve => { started = resolve; });
  const app = await fixture(t, { fetchImpl: async (url, options) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/issueTypes')) return json([{ name: 'Task', templateDescription: '## 現状\n\n## 期待' }]);
    if (options.method === 'POST') {
      if (block) { started(); return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }); }
      return json({ usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '保留原稿', description: '## 現状\n菜单异常。\n\n## 期待\n显示一致。', unknowns: [] }) }] }] });
    }
    return json({ projectKey: 'DEMO', textFormattingRule: 'markdown' });
  } });
  assert.equal((await app.post('generation/stop')).stopping, false);
  const first = (await app.post('draft', { request: '问题', uploadIds: [] })).draft;
  block = true;
  const pending = app.post('revise', { id: first.id, instruction: '调查源码' });
  const stopped = assert.rejects(pending, /生成已停止，已有草稿保留/);
  await beginning;
  assert.equal((await app.post('generation/stop')).stopping, true);
  await stopped;
  assert.equal((await app.get('activity')).activity.state, 'cancelled');
  assert.deepEqual((await app.get('state')).drafts.map(draft => draft.id), [first.id]);
  const usage = (await app.get(`usage/${first.rootId}`)).conversation;
  assert.equal(usage.requests, 2); assert.equal(usage.totalTokens, 15); assert.equal(usage.missingTokens, 1);
  assert.equal((await app.post('generation/stop')).stopping, false);
  block = false;
  const next = (await app.post('revise', { id: first.id, instruction: '只改标题' })).draft;
  assert.equal(next.rootId, first.rootId); assert.equal((await app.get('activity')).activity.state, 'complete');
});

test('网页超时重试状态与费用独立记录，成功或失败均保留原稿且不重复保存半成品', async t => {
  let calls = 0, release, markRetry;
  const retryStarted = new Promise(resolve => { markRetry = resolve; });
  const result = () => json({ usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '测试草稿', description: '## 現状\n菜单异常。\n\n## 期待\n显示一致。', unknowns: [] }) }] }] });
  const app = await fixture(t, { fetchImpl: async (url, options) => {
    if (new URL(url).pathname.endsWith('/issueTypes')) return json([{ name: 'Task', templateDescription: '## 現状\n\n## 期待' }]);
    if (new URL(url).pathname.endsWith('/responses')) {
      if (++calls === 1) return result();
      if (calls === 3) return { ok: true, json: () => new Promise((resolve, reject) => {
        release = () => resolve(result().json()); markRetry();
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }) };
      return { ok: true, json: async () => { throw new DOMException('PRIVATE', 'TimeoutError'); } };
    }
    return json({ projectKey: 'DEMO', textFormattingRule: 'markdown' });
  } });
  const first = (await app.post('draft', { request: '问题', uploadIds: [] })).draft;
  const original = await readFile(path.join(app.root, 'drafts', `${first.id}.json`), 'utf8');
  const revising = app.post('revise', { id: first.id, instruction: '补充说明' });
  await retryStarted;
  const active = (await app.get('activity')).activity;
  assert.equal(active.state, 'running'); assert.equal(active.retrying, true);
  assert(active.events.some(event => event.text.startsWith('连接超时，正在重试')));
  assert.equal((await app.get('state')).drafts.length, 1);
  const inProgress = (await app.get(`usage/${first.rootId}`)).conversation;
  assert.equal(inProgress.requests, 3); assert.equal(inProgress.missingTokens, 2);
  release();
  const next = (await revising).draft;
  assert.equal(next.rootId, first.rootId); assert.notEqual(next.id, first.id);
  assert.equal((await app.get('activity')).activity.retrying, false);
  const usage = (await app.get(`usage/${first.rootId}`)).conversation;
  assert.equal(usage.requests, 3); assert.equal(usage.missingTokens, 1); assert.equal(usage.totalTokens, 30);
  await assert.rejects(app.post('revise', { id: next.id, instruction: '再修改' }), /连接超时.*重试一次/);
  const failed = (await app.get('activity')).activity;
  assert.equal(failed.state, 'error'); assert.equal(failed.retrying, false); assert.equal(failed.usage.requests, 2);
  assert.equal((await app.get('state')).drafts.length, 2); assert.equal(calls, 5);
  assert.equal(await readFile(path.join(app.root, 'drafts', `${first.id}.json`), 'utf8'), original);
});

test('preview startup retains the mutation lock until its session is registered', async t => {
  const app = await fixture(t, { preview: async (_draft, _config, { ask, signal }) => { try { await ask('确认新建页', { signal }); } catch {} } });
  const draft = (await app.post('draft', { request: '问题', uploadIds: [] })).draft;
  const opening = app.post('preview', { id: draft.id });
  await assert.rejects(app.post('create', { id: draft.id }), /上一项操作|先关闭/);
  await opening;
  await assert.rejects(app.post('preview', { id: draft.id }), /已有官网预览/);
  await app.post('preview/close');
  assert(!app.seen.some(item => item.route.endsWith('/issues')));
});
