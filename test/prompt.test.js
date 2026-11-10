import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { assertDraftWording, generateDraft } from '../src/draft.js';
import { exampleConfig } from '../src/config.js';

const base = { ...exampleConfig, model: { ...exampleConfig.model, name: 'fixture-model' }, backlog: {} };
const env = { OPENAI_API_KEY: 'LOCAL_FIXTURE', BACKLOG_API_KEY: 'LOCAL_FIXTURE' };
const json = value => ({ ok: true, json: async () => value });
const response = (protocol, draft) => json(protocol === 'responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(draft) }] }] } : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(draft) } }] });

test('实际输出口吻检查拒绝转述句，不改写代码、引用、章节和验证来源', () => {
  for (const body of ['报告称，菜单显示异常。', '- 据用户反馈，按钮无响应。', '- 报告提到可能与缓存有关，但尚未确认。', '根据描述，菜单显示异常。', '1. 用户报告：页面空白。', 'The user reports that the page is blank.', 'ユーザーの報告によると、画面が表示されない。']) assert.throws(() => assertDraftWording(body), /转述开头/);
  for (const body of ['菜单显示异常。原因待确认。', 'QA 已在 Chrome 验证，Safari 未验证。', '> 报告称，菜单异常。', '```text\n报告称，菜单异常。\n```', '~~~\n报告称，菜单异常。\n~~~', '    报告称，菜单异常。', '## 用户报告：原模板章节\n页面空白。', '用户报告：原模板章节\n====\n页面空白。', '用户报告模块无法打开。']) assertDraftWording(body);
  assertDraftWording('*用户报告：原模板章节\n{code}\n报告称，菜单异常。\n{/code}\n菜单异常。', 'backlog');
});

test('正文拒绝笼统过程声明，保留具体QA验证范围、待确认项及引用原文', () => {
  for (const body of [
    '- 以上为代码阅读所得，尚未进行运行复现；截图仅为静态依据。',
    '说明：以上分析仅基于源码阅读，尚未进行运行复现。',
    '仅做静态分析，未运行验证。',
    '截图仅作为静态依据。',
    'The above is based on code review and has not been reproduced at runtime.',
    '上記はソースコードの読解に基づくもので、実行時の再現確認は行っていません。',
  ]) assert.throws(() => assertDraftWording(body), /生成过程或笼统验证声明/);
  for (const body of [
    'QA 已在 Chrome 复现；Safari 下是否受影响待确认。',
    '本次 QA 已在 Chrome 完成运行复现；Safari 尚待验证。',
    '本次运行验证确认菜单能正常展开。',
    '尚未进行运行复现；QA 将在 Safari 下核对。',
    '菜单折叠和展开时权限显示不一致。',
    '権限がないユーザーへの影響は確認が必要です。',
    'Whether Safari is affected still needs confirmation.',
    '```text\n以上为代码阅读所得，尚未进行运行复现；截图仅为静态依据。\n```',
    '> 以上为代码阅读所得，尚未进行运行复现；截图仅为静态依据。',
  ]) assertDraftWording(body);
  assertDraftWording('菜单异常。', 'markdown', { unknowns: ['本次 QA 已在 Chrome 复现；Safari 尚待验证。'] });
  assert.throws(() => assertDraftWording('菜单异常。', 'markdown', { unknowns: ['仅做静态分析，未运行验证。'] }), /笼统验证声明/);
});

test('生成提示词不写过程声明，坏输出被拒绝且原稿不变', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    const previous = { version: 1, summary: '旧标题', description: '菜单异常。Safari是否受影响待确认。', unknowns: ['Safari是否受影响'], attachments: [] };
    const original = structuredClone(previous);
    await assert.rejects(generateDraft({ ...base, model: { ...base.model, protocol } }, { request: '补充说明', previousDraft: previous }, { env, fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body), instructions = protocol === 'responses' ? request.instructions : request.messages[0].content;
      assert(instructions.includes('正文和unknowns不写生成过程或笼统验证声明'));
      assert(instructions.includes('具体待确认项'));
      return response(protocol, { summary: '标题', description: '菜单异常。\n\n- 以上为代码阅读所得，尚未进行运行复现；截图仅为静态依据。', unknowns: [] });
    } }), /生成过程或笼统验证声明/);
    assert.deepEqual(previous, original);
    const oldDisclaimer = { ...previous, description: '以上为代码阅读所得，尚未进行运行复现；截图仅为静态依据。' };
    await assert.rejects(generateDraft({ ...base, model: { ...base.model, protocol } }, { request: '只改标题', previousDraft: oldDisclaimer }, { env, fetchImpl: async () => response(protocol, { summary: '新标题', description: oldDisclaimer.description, unknowns: [] }) }), /生成过程或笼统验证声明/);
  }
});

test('两种协议提供图片原名与视觉对应，修改漏掉图片时恢复原位置、说明及顺序', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-prompt-images-')); t.after(() => rm(root, { recursive: true, force: true }));
  const files = ['现象.png', '期望.png', '说明.pdf'].map(name => path.join(root, name));
  for (const file of files) await writeFile(file, file.endsWith('.png') ? Buffer.from([137,80,78,71,13,10,26,10]) : Buffer.from('%PDF-1.4'));
  for (const protocol of ['responses', 'chat-completions']) for (const rule of ['markdown', 'backlog']) {
    const h = text => rule === 'markdown' ? `## ${text}` : `*${text}`;
    const tag = name => rule === 'markdown' ? `![image][${name}]` : `#image(${name})`;
    const placed = rule === 'markdown' ? '![对照画面][期望.png]' : tag('期望.png');
    const description = `${h('现状')}\n折叠时出现异常：\n\n${tag('现象.png')}\n\n${h('期望')}\n正确画面应为：\n\n${placed}\n\n权限应保持一致。\n\n${h('验收')}\n- [ ] 检查两种状态。`;
    const selected = { ...base, model: { ...base.model, protocol }, backlog: { origin: 'https://fixture.backlog.com', project: 'DEMO' } };
    let previous;
    const deps = { env, fetchImpl: async (url, options) => {
      if (options.method === 'GET') return url.pathname.endsWith('issueTypes') ? json([{ name: 'Task', templateDescription: `${h('现状')}\n\n${h('期望')}\n\n${h('验收')}` }]) : json({ projectKey: 'DEMO', textFormattingRule: rule });
      const body = JSON.parse(options.body), request = JSON.parse(protocol === 'responses' ? body.input[0].content[0].text : body.messages[1].content[0].text);
      assert.deepEqual(request.images, ['现象.png', '期望.png'].map(name => ({ name, sentToModel: !previous, reference: tag(name) })));
      const content = protocol === 'responses' ? body.input[0].content : body.messages[1].content;
      assert.equal(content.filter(item => item.type === (protocol === 'responses' ? 'input_image' : 'image_url')).length, previous ? 0 : 2);
      const instructions = protocol === 'responses' ? body.instructions : body.messages[0].content;
      assert(instructions.includes('对应的现象、复现步骤、预期效果等段落后'));
      if (previous) assert.equal(request.previousDraft.description, description);
      const omitted = description.replace(`${tag('现象.png')}\n\n`, '').replace(`${placed}\n\n`, '');
      return response(protocol, { summary: '菜单异常', description: previous ? omitted : description, unknowns: ['Safari是否受影响待确认'] });
    } };
    const first = await generateDraft(selected, { request: '根据截图整理', images: files.slice(0, 2), attachments: files.slice(2) }, deps);
    assert.equal(first.description, description); assert.equal(first.attachments.length, 3);
    previous = first;
    const next = await generateDraft(selected, { request: '缩短标题', previousDraft: previous, attachments: previous.attachments }, deps);
    assert.equal(next.description, description);
  }
});

test('修改旧稿时清理三种语言的旧版固定说明及待确认项，保留代码、用户引用和原稿', async () => {
  for (const [language, note, unknown] of [
    ['zh-CN', '本次模型未读取源码，以上技术分析未经源码核实。', '本次模型未读取源码，技术原因待研发确认'],
    ['ja', 'モデルはソースコードを確認していないため、上記の技術的な分析はソースコードに基づく検証を行っていません。', 'モデルはソースコードを確認していません。技術的な原因は開発者による確認が必要です。'],
    ['en', 'The model did not inspect the source code. The technical analysis above has not been verified against it.', 'The model did not inspect the source code. The technical cause needs developer confirmation.'],
  ]) {
    const description = `## 现状\n本次 QA 已在 Chrome 完成运行复现。\n\n> QA 提供的原话。\n\n\x60\x60\x60text\n\n> ${note}\n\n\x60\x60\x60`;
    const previous = { version: 1, summary: '旧标题', description: `${description}\n\n> ${note}`, unknowns: [unknown, 'Safari 是否受影响待确认'], attachments: [], language };
    const original = structuredClone(previous);
    const next = await generateDraft(base, { request: '只改标题', previousDraft: previous }, { env, fetchImpl: async (_url, options) => {
      const request = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
      assert.equal(request.previousDraft.description, description);
      assert.deepEqual(request.previousDraft.unknowns, ['Safari 是否受影响待确认']);
      return response('responses', { ...original, summary: '新标题' });
    } });
    assert.equal(next.description, description);
    assert.deepEqual(next.unknowns, ['Safari 是否受影响待确认']);
    assert.deepEqual(previous, original);
  }
});

test('两种协议的坏输出在生成结果返回之前拒绝，旧稿不被覆盖', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    const previous = { version: 1, summary: '旧标题', description: '菜单显示异常。', unknowns: [], attachments: [] }, original = structuredClone(previous);
    await assert.rejects(generateDraft({ ...base, model: { ...base.model, protocol } }, { request: '补充现象', previousDraft: previous }, { env, fetchImpl: async () => response(protocol, { summary: '新标题', description: '报告称，菜单显示异常。', unknowns: [] }) }), /转述开头/);
    assert.deepEqual(previous, original);
  }
});

test('修改校验原稿章节，不因线上模板更换或清空而迁移正文，已验证结果和勾选保留', async () => {
  for (const protocol of ['responses', 'chat-completions']) for (const rule of ['markdown', 'backlog']) {
    const description = rule === 'markdown' ? '## 現状\n菜单异常。\n\n## 验证\n- [x] QA 已在 Chrome 复现；Safari 待确认。' : '*現状\n菜单异常。\n\n*验证\n- [x] QA 已在 Chrome 复现；Safari 待确认。';
    const previous = { version: 1, summary: '旧标题', description, unknowns: ['Safari 待确认'], attachments: [], textFormattingRule: rule };
    for (const currentTemplate of ['## 背景\n\n## 验收', '']) {
      const result = await generateDraft({ ...base, model: { ...base.model, protocol }, backlog: { origin: 'https://fixture.backlog.com', project: 'DEMO' } }, { request: '只改标题', previousDraft: previous }, { env, fetchImpl: async (url, options) => {
        if (options.method === 'GET') return url.pathname.endsWith('issueTypes') ? json([{ name: 'Task', templateDescription: currentTemplate }]) : json({ projectKey: 'DEMO', textFormattingRule: rule });
        const body = JSON.parse(options.body), request = JSON.parse(protocol === 'responses' ? body.input[0].content[0].text : body.messages[1].content[0].text);
        assert.equal(request.template, undefined); assert.equal(request.textFormattingRule, rule);
        assert.equal(request.previousDraft.description, description);
        return response(protocol, { summary: '新标题', description, unknowns: previous.unknowns });
      } });
      assert.equal(result.description, description); assert.deepEqual(result.unknowns, previous.unknowns);
    }
    await assert.rejects(generateDraft({ ...base, model: { ...base.model, protocol } }, { request: '补充说明', previousDraft: previous }, { env, fetchImpl: async () => response(protocol, { summary: '标题', description: '## 背景\n替换原章节。', unknowns: [] }) }), /原稿的章节/);
  }
});

test('纯标题修改沿用原源码证据，不强加新的未调查声明或虚构新读取', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-prompt-revision-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.js'), 'export const value = 1;');
  const previous = { version: 1, summary: '旧标题', description: '## 现状\n菜单显示异常。', unknowns: [], attachments: [], source: { revision: 'old-revision', evidence: [{ path: 'app.js', start: 1, end: 1 }] } };
  const revised = await generateDraft(base, { request: '只改标题', repo: root, previousDraft: previous }, { env, fetchImpl: async () => response('responses', { summary: '新标题', description: previous.description, unknowns: [] }) });
  assert.equal(revised.description, previous.description); assert.deepEqual(revised.source, previous.source); assert.deepEqual(revised.unknowns, []);
});
