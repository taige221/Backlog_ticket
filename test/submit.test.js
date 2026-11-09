import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { submitDraft } from '../src/submit.js';

const config = { backlog: { origin: 'https://example.backlog.com', project: 'DEMO' } };
const draft = { version: 1, summary: '标题', description: '## 現状\n正文', unknowns: [], attachments: [], target: { origin: config.backlog.origin, project: 'DEMO' }, issueType: 'Task', assignee: 'QA', startDate: '2026-11-04', dueDate: '2026-11-05' };
const json = data => ({ ok: true, status: 200, json: async () => data });
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-submit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  return { root, seen, receiptFile: path.join(root, 'submission.json'), env: { BACKLOG_API_KEY: 'PRIVATE-FIXTURE' },
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, config.backlog.origin);
      assert.equal(url.searchParams.get('apiKey'), 'PRIVATE-FIXTURE');
      assert.equal(options.redirect, 'error');
      seen.push({ path: url.pathname, ...options });
      if (url.pathname in overrides) return overrides[url.pathname](options);
      if (url.pathname.endsWith('/issueTypes')) return json([{ id: 81, name: 'Task' }]);
      if (url.pathname.endsWith('/priorities')) return json([{ id: 92, name: '中' }]);
      if (url.pathname.endsWith('/users')) return json([{ id: 63, name: 'QA' }]);
      if (url.pathname.endsWith('/attachment')) return json({ id: 74 });
      if (url.pathname.endsWith('/issues')) return json({ id: 55, issueKey: 'DEMO-55' });
      return json({ id: 17, projectKey: 'DEMO' });
    },
  };
}

test('实际查询项目、类型、优先级与负责人ID，上传附件后只创建一次并保存回执', async t => {
  const f = await fixture(t), file = path.join(f.root, 'fixture.txt');
  await writeFile(file, 'fixture data');
  const current = { ...draft, attachments: [file] };
  const result = await submitDraft(current, config, f);
  assert.equal(result.url, `${config.backlog.origin}/view/DEMO-55`);
  const post = f.seen.find(item => item.path === '/api/v2/issues');
  assert.deepEqual(Object.fromEntries(post.body), { projectId: '17', issueTypeId: '81', priorityId: '92', summary: draft.summary, description: draft.description, assigneeId: '63', startDate: draft.startDate, dueDate: draft.dueDate, 'attachmentId[]': '74' });
  const upload = f.seen.find(item => item.path.endsWith('/attachment'));
  assert.equal(upload.body.get('file').name, 'fixture.txt');
  assert.equal(await upload.body.get('file').text(), 'fixture data');
  assert(f.seen.indexOf(upload) < f.seen.indexOf(post));
  const receipt = await readFile(f.receiptFile, 'utf8');
  assert.equal(JSON.parse(receipt).state, 'created');
  assert(!receipt.includes('PRIVATE-FIXTURE'));
  assert.equal((await stat(f.receiptFile)).mode & 0o777, 0o600);
  const count = f.seen.length;
  await assert.rejects(submitDraft(current, config, f), /该草稿已处理/);
  assert.equal(f.seen.length, count);
});

test('目标不匹配、类型缺失、负责人重名或无普通优先级时绝不POST', async t => {
  for (const overrides of [
    { '/api/v2/projects/DEMO': async () => json({ id: 17, projectKey: 'OTHER' }) },
    { '/api/v2/projects/DEMO/issueTypes': async () => json([{ id: 1, name: 'Bug' }]) },
    { '/api/v2/projects/DEMO/users': async () => json([{ id: 1, name: 'QA' }, { id: 2, name: 'QA' }]) },
    { '/api/v2/priorities': async () => json([{ id: 1, name: 'High' }]) },
  ]) {
    const f = await fixture(t, overrides);
    await assert.rejects(submitDraft(draft, config, f));
    assert(!f.seen.some(item => item.method === 'POST'));
  }
  const f = await fixture(t);
  await assert.rejects(submitDraft({ ...draft, target: { ...draft.target, project: 'OTHER' } }, config, f), /草稿目标/);
  assert.equal(f.seen.length, 0);
});

test('旧稿提交去掉模块空值尾巴，回执记录实际提交标题，原草稿不被改写', async t => {
  const f = await fixture(t), summary = '通用设置菜单权限显示不一致/通用设置菜单/无';
  const current = { ...draft, summary };
  await submitDraft(current, config, f);
  assert.equal(f.seen.find(item => item.path.endsWith('/issues')).body.get('summary'), '通用设置菜单权限显示不一致');
  assert.equal(JSON.parse(await readFile(f.receiptFile, 'utf8')).summary, '通用设置菜单权限显示不一致');
  assert.equal(current.summary, summary);
});

test('图片正文引用与PDF附件一同提交，沿用项目当前格式；格式未知时在上传之前停止', async t => {
  for (const rule of ['markdown', 'backlog', undefined]) {
    const f = await fixture(t, { '/api/v2/projects/DEMO': async () => json({ id: 17, projectKey: 'DEMO', textFormattingRule: rule }) });
    const image = path.join(f.root, '中文截图.png'), pdf = path.join(f.root, '说明.pdf');
    await writeFile(image, Buffer.from([137,80,78,71,13,10,26,10])); await writeFile(pdf, '%PDF-1.4');
    const current = { ...draft, attachments: [image, pdf] };
    if (!rule) {
      await assert.rejects(submitDraft(current, config, f), /正文格式/);
      assert(!f.seen.some(item => item.method === 'POST')); continue;
    }
    await submitDraft(current, config, f);
    const uploads = f.seen.filter(item => item.path.endsWith('/attachment'));
    const post = f.seen.find(item => item.path.endsWith('/issues'));
    assert.deepEqual(uploads.map(item => item.body.get('file').name), ['中文截图.png', '说明.pdf']);
    assert.deepEqual(post.body.getAll('attachmentId[]'), ['74', '74']);
    assert.equal(post.body.get('description'), draft.description + (rule === 'markdown' ? '\n\n![image][中文截图.png]' : '\n\n#image(中文截图.png)'));
    assert.equal(current.description, draft.description);
  }
});

test('附件失败不创建工单，不泄露响应或含密钥URL', async t => {
  const f = await fixture(t, { '/api/v2/space/attachment': async () => { throw new Error('url?apiKey=PRIVATE-FIXTURE'); } });
  const file = path.join(f.root, 'fixture.txt'); await writeFile(file, 'fixture');
  await assert.rejects(submitDraft({ ...draft, attachments: [file] }, config, f), error => /尚未提交/.test(error.message) && !error.message.includes('PRIVATE-FIXTURE'));
  assert(!f.seen.some(item => item.path.endsWith('/issues')));
});

test('创建前解析项目分类实际ID并填categoryId[]，失效分类绝不POST', async t => {
  for (const name of ['frontend', 'removed']) {
    const f = await fixture(t, { '/api/v2/projects/DEMO/categories': async () => json([{ id: 902, name: 'frontend' }]) });
    const current = { ...draft, category: name };
    if (name === 'removed') { await assert.rejects(submitDraft(current, config, f), /不属于/); assert(!f.seen.some(item => item.method === 'POST')); continue; }
    await submitDraft(current, config, f);
    const post = f.seen.find(item => item.path.endsWith('/issues'));
    assert.deepEqual(post.body.getAll('categoryId[]'), ['902']); assert.equal(post.body.get('summary'), '【frontend】' + draft.summary);
  }
});

test('创建同时提交默认日期、可选负责人及多位通知对象，空选择不发送人员ID，失效成员不POST', async t => {
  const members = [{ id: 63, name: 'QA' }, { id: 64, name: 'Dev' }];
  const f = await fixture(t, { '/api/v2/projects/DEMO/users': async () => json(members) });
  const current = { ...draft, notifiedUsers: ['QA', 'Dev', 'QA'] }; delete current.startDate; delete current.dueDate;
  await submitDraft(current, config, f);
  const body = f.seen.find(item => item.path.endsWith('/issues')).body;
  assert.equal(body.get('assigneeId'), '63'); assert.deepEqual(body.getAll('notifiedUserId[]'), ['63', '64']);
  assert.match(body.get('startDate'), /^\d{4}-\d{2}-\d{2}$/); assert.equal(new Date(body.get('dueDate') + 'T12:00:00').getDay(), 5); assert(body.get('dueDate') > body.get('startDate'));
  assert.equal(f.seen.filter(item => item.path.endsWith('/users')).length, 1);
  const blank = await fixture(t), noPeople = { ...draft, notifiedUsers: [] }; delete noPeople.assignee;
  await submitDraft(noPeople, config, blank);
  const blankBody = blank.seen.find(item => item.path.endsWith('/issues')).body;
  assert.equal(blankBody.has('assigneeId'), false); assert.equal(blankBody.has('notifiedUserId[]'), false); assert(!blank.seen.some(item => item.path.endsWith('/users')));
  const bad = await fixture(t, { '/api/v2/projects/DEMO/users': async () => json(members) });
  await assert.rejects(submitDraft({ ...draft, notifiedUsers: ['Removed'] }, config, bad), /不存在/);
  assert(!bad.seen.some(item => item.method === 'POST'));
});

test('提交超时、5xx或成功响应无法解析时保留记录，不自动重试，修改后也阻止重复提交', async t => {
  for (const response of [
    () => { throw new Error('PRIVATE-FIXTURE'); },
    () => ({ ok: false, status: 500 }),
    () => ({ ok: true, json: async () => { throw new Error('PRIVATE-FIXTURE'); } }),
    () => json({ id: 1, issueKey: 'OTHER-1' }),
  ]) {
    const f = await fixture(t, { '/api/v2/issues': response });
    await assert.rejects(submitDraft(draft, config, f), error => /勿重复创建/.test(error.message) && !error.message.includes('PRIVATE-FIXTURE'));
    const count = f.seen.length;
    await assert.rejects(submitDraft({ ...draft, summary: '修改标题' }, config, f), /阻止重复创建/);
    assert.equal(f.seen.length, count);
    assert.equal(f.seen.filter(item => item.path.endsWith('/issues')).length, 1);
  }
});

test('明确4xx拒绝可修改后重试，不向模型或日志返回服务响应', async t => {
  let calls = 0;
  const f = await fixture(t, { '/api/v2/issues': () => ++calls === 1 ? { ok: false, status: 400 } : json({ id: 56, issueKey: 'DEMO-56' }) });
  await assert.rejects(submitDraft(draft, config, f), /拒绝创建/);
  const result = await submitDraft(draft, config, f);
  assert.equal(result.issueKey, 'DEMO-56');
  assert.equal(calls, 2);
});

test('并发创建同一草稿只有一个请求能提交', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([submitDraft(draft, config, f), submitDraft(draft, config, f)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(f.seen.filter(item => item.path.endsWith('/issues')).length, 1);
});
