import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { checkSubmission, linkSubmission } from '../src/reconcile.js';
import { submitDraft } from '../src/submit.js';

const config = { backlog: { origin: 'https://example.backlog.com', project: 'DEMO' } };
const draft = { version: 1, summary: '当前版本标题', description: '正文', attachments: [], unknowns: [],
  target: { origin: config.backlog.origin, project: 'DEMO' } };
const issue = { id: 55, projectId: 17, issueKey: 'DEMO-55', summary: '提交时的标题', description: '已创建的正文',
  created: '2026-11-07T03:00:00Z', updated: '2026-11-07T03:00:00Z', createdUser: { name: 'QA', mailAddress: 'private' }, attachments: [{ name: '截图.png' }] };
const json = value => ({ ok: true, json: async () => value });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptFile = path.join(root, 'pending.json');
  await writeFile(receiptFile, JSON.stringify({ state: 'sending', summary: '提交时的标题', target: draft.target }));
  const state = { list: [issue], detail: issue, seen: [] };
  return { receiptFile, state, env: { BACKLOG_API_KEY: 'PRIVATE_KEY' }, fetchImpl: async (url, options) => {
    assert.equal(url.origin, config.backlog.origin);
    assert.equal(url.searchParams.get('apiKey'), 'PRIVATE_KEY');
    assert.equal(options.method, 'GET');
    state.seen.push(new URL(url));
    if (url.pathname === '/api/v2/projects/DEMO') return json({ id: 17, projectKey: 'DEMO' });
    if (url.pathname === '/api/v2/issues') return json(state.list);
    if (url.pathname === '/api/v2/issues/DEMO-55') return json(state.detail);
    assert.fail('Unexpected lookup');
  } };
}

test('核对按原提交标题限定项目搜索，分页返回白名单字段且不改写待确认记录', async t => {
  const f = await fixture(t), original = await readFile(f.receiptFile, 'utf8');
  const result = await checkSubmission(draft, { ...config, backlog: { ...config.backlog, project: 'OTHER' } }, f);
  assert.equal(result.keyword, '提交时的标题');
  assert.equal(f.state.seen[1].searchParams.get('projectId[]'), '17');
  assert.equal(f.state.seen[1].searchParams.get('count'), '20');
  assert.equal(result.issues[0].issueKey, 'DEMO-55');
  assert(!JSON.stringify(result).includes('private'));
  assert.equal(await readFile(f.receiptFile, 'utf8'), original);
  f.state.list = Array(20).fill(issue);
  const page = await checkSubmission(draft, config, { ...f, keyword: '标题 ?&+', offset: 20 });
  assert.equal(page.nextOffset, 40);
  assert.equal(f.state.seen.at(-1).searchParams.get('keyword'), '标题 ?&+');
  assert.equal(f.state.seen.at(-1).searchParams.get('offset'), '20');
});

test('没有搜索结果时仍保留提交锁，确认前只读取工单详情', async t => {
  const f = await fixture(t), original = await readFile(f.receiptFile, 'utf8');
  f.state.list = [];
  assert.deepEqual((await checkSubmission(draft, config, f)).issues, []);
  const result = await checkSubmission(draft, config, { ...f, key: 'https://example.backlog.com/view/DEMO-55' });
  assert.equal(result.issue.description, issue.description);
  assert.deepEqual(result.issue.attachments, ['截图.png']);
  assert.equal(await readFile(f.receiptFile, 'utf8'), original);
  await assert.rejects(submitDraft(draft, config, f), /阻止重复创建/);
});

test('确认关联前重新校验工单，成功后保留锁并记录可打开的链接', async t => {
  const f = await fixture(t);
  const selected = (await checkSubmission(draft, config, { ...f, key: 'DEMO-55' })).issue;
  const options = { ...f, key: selected.issueKey, expectedSummary: selected.summary, expectedUpdated: selected.updated };
  f.state.detail = { ...issue, updated: '2026-11-07T04:00:00Z' };
  await assert.rejects(linkSubmission(draft, config, options), /内容已更新/);
  assert.equal(JSON.parse(await readFile(f.receiptFile)).state, 'sending');
  f.state.detail = issue;
  const result = await linkSubmission(draft, config, options);
  assert.equal(result.url, 'https://example.backlog.com/view/DEMO-55');
  const saved = JSON.parse(await readFile(f.receiptFile));
  assert.equal(saved.state, 'created'); assert.equal(saved.summary, '提交时的标题'); assert(saved.reconciledAt);
  await assert.rejects(linkSubmission(draft, config, options), /已关联/);
  await assert.rejects(submitDraft(draft, config, f), /已处理/);
});

test('跨站点、跨项目或异常工单信息均不能关联，错误不回显密钥', async t => {
  const f = await fixture(t), original = await readFile(f.receiptFile, 'utf8');
  for (const key of ['OTHER-55', '../DEMO-55', 'https://evil.test/view/DEMO-55', 'https://example.backlog.com/view/DEMO-55?apiKey=secret']) {
    await assert.rejects(checkSubmission(draft, config, { ...f, key }));
  }
  for (const detail of [{ ...issue, projectId: 18 }, { ...issue, issueKey: 'DEMO-56' }, { ...issue, description: null }]) {
    f.state.detail = detail;
    await assert.rejects(linkSubmission(draft, config, { ...f, key: issue.issueKey, expectedSummary: issue.summary, expectedUpdated: issue.updated }));
  }
  await assert.rejects(checkSubmission(draft, { backlog: { ...config.backlog, origin: 'https://other.test' } }, f), /草稿目标/);
  assert.equal(await readFile(f.receiptFile, 'utf8'), original);
});

test('损坏记录可经核对修复，网络失败和记录并发变化时保留原状态', async t => {
  const f = await fixture(t);
  await writeFile(f.receiptFile, 'invalid json');
  const options = { ...f, key: issue.issueKey, expectedSummary: issue.summary, expectedUpdated: issue.updated };
  await assert.rejects(linkSubmission(draft, config, { ...options, fetchImpl: async () => { throw new Error('PRIVATE_KEY'); } }), error => /连接失败/.test(error.message) && !error.message.includes('PRIVATE_KEY'));
  assert.equal(await readFile(f.receiptFile, 'utf8'), 'invalid json');
  const concurrent = { state: 'sending', summary: '其他进程的记录' };
  await assert.rejects(linkSubmission(draft, config, { ...options, fetchImpl: async (url, request) => {
    const response = await f.fetchImpl(url, request);
    if (url.pathname.includes('/issues/')) await writeFile(f.receiptFile, JSON.stringify(concurrent));
    return response;
  } }), /发生变化/);
  assert.deepEqual(JSON.parse(await readFile(f.receiptFile)), concurrent);
  await writeFile(f.receiptFile, 'invalid json');
  await linkSubmission(draft, config, options);
  assert.equal(JSON.parse(await readFile(f.receiptFile)).issueKey, issue.issueKey);
});
