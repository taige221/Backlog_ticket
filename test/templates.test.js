import test from 'node:test';
import assert from 'node:assert/strict';
import { selectIssueType, matchesTemplateStructure, cleanSummary } from '../src/templates.js';
import { generateDraft } from '../src/draft.js';
import { credentials, exampleConfig } from '../src/config.js';

const origin = 'https://fixture.backlog.com';
const config = { ...exampleConfig, model: { ...exampleConfig.model, provider: 'openai', name: 'fixture-model' },
  backlog: { origin, project: 'DEMO' }, [credentials]: {
    openai: { baseUrl: exampleConfig.model.baseUrl, key: 'model-test-secret' },
    backlog: { origin, key: 'backlog-test-secret' },
  } };
const task = { id: 999, name: 'タスク', templateSummary: '[改善] <対象と内容>', templateDescription: '## 現状\n記入例\n\n## 対応内容\n記入例\n\n## 確認事項\n- [ ] 実機確認' };
const completed = { summary: '[改善] モーダルを閉じた後のスクロールを復帰する',
  description: '## 現状\n閉じた後にスクロールできない。\n\n## 対応内容\n原因は待確認。\n\n## 確認事項\n- [ ] 実機確認', unknowns: ['原因待確認'] };
const json = value => ({ ok: true, json: async () => value });
const response = (draft, protocol = 'responses') => protocol === 'responses'
  ? json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(draft) }] }] })
  : json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(draft) } }] });

test('标题去除前后端模板占位与已重复的模块空值尾巴，保留问题中的斜线', () => {
  assert.equal(cleanSummary('【Frontend】问题/Frontend名/Backend名'), '【Frontend】问题');
  for (const none of ['无', 'なし', 'None', 'N/A']) {
    const title = `【frontend】通用设置菜单折叠与展开时权限显示不一致 / 通用设置菜单 / ${none}`;
    assert.equal(cleanSummary(title), '【frontend】通用设置菜单折叠与展开时权限显示不一致');
  }
  for (const title of ['【UI/Frontend】HTTP/HTTPS 跳转失败', '无法访问 https://example.test/foo/bar', '读取 /src/settings/menu.ts 失败', '菜单折叠/展开显示不一致', '显示值/后台值/无', 'foo 页面无法访问 https://example.test/foo/none', 'foo 读取 /tmp/foo/none 失败', 'foo 无法读取 /tmp/foo/none']) assert.equal(cleanSummary(title), title);
});

test('两种协议不再传标题的前后端占位，旧稿修改与模型输出都去掉重复元数据尾巴', async () => {
  const summary = '【frontend】通用设置菜单权限显示不一致/通用设置菜单/无';
  for (const protocol of ['responses', 'chat-completions']) {
    const selected = { ...config, model: { ...config.model, protocol } };
    const previous = { version: 1, summary, description: completed.description, unknowns: [], attachments: [] };
    const draft = await generateDraft(selected, { request: '整理标题', previousDraft: previous }, { env: {}, fetchImpl: async (url, options) => {
      if (options.method === 'GET') return url.pathname.endsWith('issueTypes')
        ? json([{ ...task, templateSummary: '【Frontend】問題の説明/Frontend名/Backend名' }])
        : json({ projectKey: 'DEMO', textFormattingRule: 'markdown' });
      const body = JSON.parse(options.body), request = JSON.parse(protocol === 'responses' ? body.input[0].content[0].text : body.messages[1].content[0].text);
      assert.equal(request.template, undefined);
      assert.equal(request.previousDraft.summary, '【frontend】通用设置菜单权限显示不一致');
      assert((body.instructions || body.messages[0].content).includes('不要在标题末尾附加 /Frontend名/Backend名'));
      return response({ ...completed, summary }, protocol);
    } });
    assert.equal(draft.summary, '【frontend】通用设置菜单权限显示不一致');
    assert.equal(previous.summary, summary);
  }
});

test('Task 别名只匹配实际可用类型，明确指定的类型优先，不硬编码 ID', () => {
  const bug = { name: 'Bug' };
  assert.equal(selectIssueType([bug, task]), task);
  for (const name of ['Task', 'task', 'TASK', 'タスク', '任务']) assert.equal(selectIssueType([task], name), task);
  assert.equal(selectIssueType([task, bug], 'Bug'), bug);
  assert.throws(() => selectIssueType([bug]), /没有 Task/);
  assert.throws(() => selectIssueType([task], 'Custom'), /指定类型/);
  const english = { name: 'Task' };
  assert.throws(() => selectIssueType([task, english]), /多个 Task/);
  assert.equal(selectIssueType([task, english], 'Task'), english);
});

test('Markdown 模板章节必须按原顺序保留，代码块里的假章节不能通过检查', () => {
  assert(matchesTemplateStructure(completed.description, task.templateDescription, 'markdown'));
  for (const description of ['## 現状\n问题', '## 確認事項\n## 対応内容\n## 現状', '```md\n## 現状\n## 対応内容\n## 確認事項\n```']) {
    assert.equal(matchesTemplateStructure(description, task.templateDescription, 'markdown'), false);
  }
  assert(matchesTemplateStructure('## 現状\n正文', '## 現状\n~~~\n## 示例而非章节\n~~~', 'markdown'));
  const setext = '现状\n====\n验收\n----';
  assert(matchesTemplateStructure('现状\n====\n用户报告\n验收\n----\n待确认', setext, 'markdown'));
  assert.equal(matchesTemplateStructure('正文', setext, 'markdown'), false);
});

test('Backlog 记法章节与代码块按其本身语法验证', () => {
  const template = '*現状\n** 対応内容\n{code:js}\n* 示例代码\n{/code}';
  assert(matchesTemplateStructure('*現状\n报告\n** 対応内容\n待确认', template, 'backlog'));
  assert.equal(matchesTemplateStructure('# 現状\n## 対応内容', template, 'backlog'), false);
});

test('配置项目后自动读取当前 Task 模板，只传所选模板给两种协议，草稿和预览类型一致', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    const calls = [], logs = [];
    const selectedConfig = { ...config, model: { ...config.model, protocol } };
    const draft = await generateDraft(selectedConfig, { request: '关闭弹窗后不能滚动' }, { env: {}, log: line => logs.push(line), fetchImpl: async (url, options) => {
      calls.push([String(url), options.method]);
      assert.equal(options.redirect, 'error');
      if (options.method === 'GET') {
        assert.equal(url.origin, origin);
        assert.equal(url.searchParams.get('apiKey'), 'backlog-test-secret');
        if (url.pathname.endsWith('issueTypes')) return json([{ name: 'Bug', templateDescription: 'OTHER_TYPE_SENTINEL' }, task]);
        assert.equal(url.pathname, '/api/v2/projects/DEMO');
        return json({ projectKey: 'DEMO', name: '测试项目', textFormattingRule: 'markdown' });
      }
      assert.equal(options.headers.Authorization, 'Bearer model-test-secret');
      const body = JSON.parse(options.body);
      const request = JSON.parse(protocol === 'responses' ? body.input[0].content[0].text : body.messages[1].content[0].text);
      assert.equal(request.issueType, 'タスク');
      assert.equal(request.template.summary, task.templateSummary);
      assert.equal(request.template.description, '## 現状\n\n## 対応内容\n\n## 確認事項\n- [ ] 実機確認');
      assert.equal(request.template.textFormattingRule, 'markdown');
      assert(!options.body.includes('OTHER_TYPE_SENTINEL'));
      assert(!options.body.includes('backlog-test-secret'));
      assert(!options.body.includes('model-test-secret'));
      assert((body.instructions || body.messages[0].content).includes('逐字保留章节标题及顺序'));
      return response(completed, protocol);
    } });
    assert.equal(calls.filter(([, method]) => method === 'GET').length, 2);
    assert.equal(calls.at(-1)[1], 'POST');
    assert.equal(draft.issueType, 'タスク');
    assert.equal(draft.description, completed.description);
    assert(!JSON.stringify(draft).includes('test-secret'));
    assert(logs.some(line => line.includes('タスク')));
  }
});

test('新草稿和修改稿省略模板填写提示，保留实际内容与固定检查项', async () => {
  const currentHint = '(現在はどんな状態なのか、どんな課題があるのか)';
  const expectedHint = '(どのような理想像になりたいか)';
  const approachHint = '(具体的な対応案・お願い事項の記述)';
  const check = '## チェックリスト\n- [ ] Safari で確認';
  const approach = '## 対応案/お願い事項(nice to have)';
  const template = `## 現状\n${currentHint}\n\n## 期待\n${expectedHint}\n\n${approach}\n${approachHint}\n\n${check}`;
  const leaked = `## 現状\n${currentHint}\n上限是58万円。\n\n## 期待 ${expectedHint} 改为62万円（仅适用于扶養追加）。\n\n${approach}\n${approachHint} 调整上限。\n\n${check}`;
  const cleaned = `## 現状\n上限是58万円。\n\n## 期待\n改为62万円（仅适用于扶養追加）。\n\n${approach}\n调整上限。\n\n${check}`;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return url.pathname.endsWith('issueTypes')
      ? json([{ ...task, templateDescription: template }]) : json({ projectKey: 'DEMO', textFormattingRule: 'markdown' });
    const sent = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    if (sent.previousDraft) assert.equal(sent.previousDraft.description, cleaned);
    else assert.equal(sent.template.description, `## 現状\n\n## 期待\n\n${approach}\n\n${check}`);
    return response({ summary: '调整上限', description: leaked, unknowns: [] });
  };
  const deps = { env: {}, fetchImpl, warn: message => assert.fail(message) };
  const draft = await generateDraft(config, { request: '调整上限' }, deps);
  assert.equal(draft.description, cleaned);
  const previousDraft = { ...draft, description: leaked };
  const revised = await generateDraft(config, { request: '整理票面', previousDraft }, deps);
  assert.equal(revised.description, cleaned);
  assert.equal(previousDraft.description, leaked);
});

test('切换语言可翻译无模板草稿的通用标题，但仍校验章节顺序和模板固定标题', async () => {
  const zh = '## 现象\n上限是58万円。\n\n## 预期\n改为62万円。\n\n## 待确认项\n生效时间。';
  const ja = '## 現象\n上限は58万円。\n\n## 期待\n62万円に変更する。\n\n## 要確認事項\n適用時期。';
  const run = ({ description, template = '## 現状\n\n## 期待', sentBody, ...options }) => generateDraft(config,
    { request: '切换起票语言，保留章节结构', ...options }, { env: {}, fetchImpl: async (url, request) => {
      if (request.method === 'GET') return url.pathname.endsWith('issueTypes')
        ? json([{ ...task, templateDescription: template }]) : json({ projectKey: 'DEMO', textFormattingRule: 'markdown' });
      const input = JSON.parse(JSON.parse(request.body).input[0].content[0].text);
      assert.equal(input.previousDraft?.description, sentBody);
      return response({ summary: '調整', description, unknowns: [] });
    } });
  const initial = await run({ noTemplate: true, language: 'zh-CN', description: zh });
  const { templateHeadings, ...legacy } = initial;
  assert.deepEqual(templateHeadings, []);
  const sentBody = zh.replace('现象', '現象').replace('预期', '期待').replace('待确认项', '要確認事項');
  for (const previousDraft of [initial, legacy]) {
    const revised = await run({ previousDraft, language: 'ja', sentBody, description: ja.replace('要確認事項', '待確認事項') });
    assert.equal(revised.description, ja);
    assert.deepEqual(revised.templateHeadings, []);
    assert.equal(previousDraft.description, zh);
  }
  const [observed, expected, pending] = ja.split('\n\n');
  await assert.rejects(run({ previousDraft: initial, language: 'ja', sentBody, description: [expected, observed, pending].join('\n\n') }), /原稿的章节/);

  const fixedBody = '## 现象\n上限是58万円。\n\n## 预期\n改为62万円。';
  const fixed = await run({ language: 'zh-CN', description: fixedBody, template: '## 现象\n\n## 预期' });
  assert.deepEqual(fixed.templateHeadings, ['## 现象', '## 预期']);
  const fixedTranslation = '## 现象\n上限は58万円。\n\n## 预期\n62万円に変更する。';
  assert.equal((await run({ previousDraft: fixed, language: 'ja', sentBody: fixedBody, description: fixedTranslation })).description, fixedTranslation);
  await assert.rejects(run({ previousDraft: fixed, language: 'ja', sentBody: fixedBody, description: [observed, expected].join('\n\n') }), /原稿的章节/);
});

test('读取失败、无 Task 或工单类型列表无效时停止生成', async () => {
  for (const types of [[{ name: 'Bug' }], [{ name: '' }], null]) {
    await assert.rejects(generateDraft(config, { request: '问题' }, { env: {}, fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      return url.pathname.endsWith('issueTypes') ? json(types) : json({ projectKey: 'DEMO' });
    } }), /类型/);
  }
  await assert.rejects(generateDraft(config, { request: '问题' }, { env: {}, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET'); return { ok: false, status: 401 };
  } }), /HTTP 401/);
});

test('模型漏掉模板章节时仍交付新草稿并提示，明确指定类型时使用其模板', async () => {
  const fetchDraft = output => async (url, options) => {
    if (options.method === 'POST') return response(output);
    return url.pathname.endsWith('issueTypes') ? json([task, { name: 'Bug', templateDescription: '## 原因' }]) : json({ projectKey: 'DEMO' });
  };
  const logs = [];
  const description = '## 现象\n关闭弹窗后无法滚动';
  const withoutHeadings = await generateDraft(config, { request: '问题' }, { env: {}, log: message => logs.push(message), fetchImpl: fetchDraft({ ...completed, description }) });
  assert.equal(withoutHeadings.description, description);
  assert(logs.some(message => message.includes('与工单模板不一致')));
  const draft = await generateDraft(config, { request: '问题', issueType: 'Bug' }, { env: {}, warn: message => assert.fail(message), fetchImpl: fetchDraft({ ...completed, description: '## 原因\n待确认' }) });
  assert.equal(draft.issueType, 'Bug');
});

test('显式不套模板或尚未配置 Backlog 时仍可只生成本地草稿', async () => {
  for (const [selected, options] of [[config, { metadata: false }], [{ ...config, backlog: {} }, {}]]) {
    const draft = await generateDraft(selected, { request: '问题', ...options }, { env: {}, fetchImpl: async (url, options) => {
      assert.equal(options.method, 'POST');
      return response(completed);
    } });
    assert.equal(draft.issueType, undefined);
  }
});
