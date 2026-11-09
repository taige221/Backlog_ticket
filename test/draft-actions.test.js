import test from 'node:test';
import assert from 'node:assert/strict';
import { runDraftActions } from '../src/draft-actions.js';
import { runChat } from '../src/chat.js';
import { generateDraft } from '../src/draft.js';

const config = { model: { name: 'fixture-model', baseUrl: 'https://model.test/v1', protocol: 'responses' }, backlog: { project: 'DEMO' } };
const first = { filename: '/tmp/first.json', draft: { version: 1, summary: '原标题', description: '## 現状\n原正文', unknowns: ['待确认'], attachments: [], target: { origin: 'https://example.backlog.com', project: 'DEMO' }, issueType: 'Task' } };
function session(answers) {
  const logs = [];
  return { logs, log: message => logs.push(message), ask: async () => answers.length ? answers.shift() : null,
    preview: async () => assert.fail('意外预览'), create: async () => assert.fail('意外创建'), revise: async () => assert.fail('意外修改') };
}

test('对话生成后进入操作菜单，预览和多轮修改均沿用最新版，创建只执行一次', async () => {
  const s = session(['问题', '1', '3', '标题加上Bug', '补充复现步骤', '2', '/exit']);
  const revisions = [], previews = [], submissions = [];
  await runChat(config, { ...s, generate: async () => first,
    actOnDraft: (selected, draft) => runDraftActions(selected, draft, { ...s,
      preview: async current => { previews.push(current); },
      revise: async (current, instruction) => {
        revisions.push([current, instruction]);
        return { filename: `/tmp/revision-${revisions.length}.json`, draft: { ...current.draft, summary: instruction } };
      },
      create: async (current, selected, rootFile) => { submissions.push([current, rootFile]); return { issueKey: 'DEMO-5', url: 'https://example.backlog.com/view/DEMO-5' }; },
    }),
  });
  assert.equal(previews[0], first);
  assert.equal(revisions[0][0], first);
  assert.equal(revisions[1][0].draft.summary, '标题加上Bug');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0].draft.summary, '补充复现步骤');
  assert.equal(submissions[0][1], first.filename);
  assert.equal(first.draft.summary, '原标题');
  assert(s.logs.some(line => line.includes('已创建：DEMO-5')));
});

test('修改失败保留原稿，空输入与无效编号不创建，返回或退出不提交', async () => {
  const s = session(['', '9', '3', '', '修改失败', '1', '0']);
  let viewed;
  await runDraftActions(config, first, { ...s, revise: async () => { throw new Error('模拟模型失败'); }, preview: async current => { viewed = current; } });
  assert.equal(viewed, first);
  assert(s.logs.some(line => line.includes('模拟模型失败')));
  for (const answer of [null, '0', '/exit']) {
    const exit = session([answer]);
    assert.equal(await runDraftActions(config, first, exit), answer === '/exit' ? 'exit' : undefined);
  }
});

test('浏览器已打开目标工单时结束处理，不再提供直接创建', async () => {
  const s = session(['1', '2']);
  await runDraftActions(config, first, { ...s, preview: async () => ({ url: 'https://example.backlog.com/view/DEMO-5' }) });
  assert(s.logs.some(line => line.includes('避免重复创建')));
  assert.equal(await s.ask(), '2');
});

test('创建失败可返回菜单修改，Ctrl+C 直接结束对话', async () => {
  const s = session(['2', '3', '补充说明', '0']);
  let revised = false;
  await runDraftActions(config, first, { ...s, create: async () => { throw new Error('HTTP 400'); }, revise: async current => { revised = true; return current; } });
  assert(revised);
  const abort = session(['2']);
  await assert.rejects(runDraftActions(config, first, { ...abort, create: async () => { throw Object.assign(new Error(), { code: 'ABORT_ERR' }); } }), { code: 'ABORT_ERR' });
});

test('两种模型协议都发送当前草稿和修改指令，保留目标、类型、日期与附件', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    const previous = { ...first.draft, assignee: 'QA', startDate: '2026-11-04', dueDate: '2026-11-05' };
    const original = structuredClone(previous);
    const selected = { ...config, model: { ...config.model, protocol }, backlog: { ...config.backlog, origin: previous.target.origin } };
    const revised = await generateDraft(selected, { request: '标题改成手机布局问题', previousDraft: previous, metadata: false, issueType: previous.issueType, assignee: previous.assignee, startDate: previous.startDate, dueDate: previous.dueDate, attachments: previous.attachments }, {
      env: { OPENAI_API_KEY: 'model-fixture-key' }, fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const report = JSON.parse(protocol === 'responses' ? body.input[0].content[0].text : body.messages[1].content[0].text);
        assert.deepEqual(report.previousDraft, { summary: previous.summary, description: previous.description, unknowns: previous.unknowns });
        assert.equal(report.report, '标题改成手机布局问题');
        assert.match(protocol === 'responses' ? body.instructions : body.messages[0].content, /未涉及的事实与结构保留/);
        const text = JSON.stringify({ summary: '手机布局问题', description: previous.description, unknowns: previous.unknowns });
        return { ok: true, json: async () => protocol === 'responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] } };
      },
    });
    for (const field of ['target', 'issueType', 'assignee', 'startDate', 'dueDate', 'attachments']) assert.deepEqual(revised[field], previous[field]);
    assert.equal(revised.summary, '手机布局问题');
    assert.deepEqual(previous, original);
  }
});
