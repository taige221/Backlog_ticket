import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exampleConfig, rememberLanguage, loadConfig } from '../src/config.js';
import { generateDraft, validateDraft } from '../src/draft.js';

const config = { ...exampleConfig, model: { ...exampleConfig.model, name: 'fixture-model' }, backlog: {} };
const fixture = { version: 1, summary: 'Fixture', description: 'Fixture body', unknowns: [], attachments: [] };
const env = { OPENAI_API_KEY: 'LOCAL_FIXTURE' };
function model(protocol, seen) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const request = JSON.parse(protocol === 'responses' ? body.input[0].content[0].text : body.messages[1].content[0].text);
    const instructions = protocol === 'responses' ? body.instructions : body.messages[0].content;
    seen.push({ request, instructions });
    const result = JSON.stringify(fixture);
    return { ok: true, json: async () => protocol === 'responses'
      ? { output: [{ type: 'message', content: [{ type: 'output_text', text: result }] }] }
      : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: result } }] } };
  };
}

test('两种模型协议明确约束输出语言，草稿保存语言，修改时优先原稿而非当前默认', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    const seen = [], c = { ...config, model: { ...config.model, protocol } }, deps = { env, fetchImpl: model(protocol, seen) };
    for (const language of ['zh-CN', 'ja', 'en']) {
      const first = await generateDraft(c, { request: '中文报告と日本語の情報', language }, deps);
      assert.equal(first.language, language);
      assert.equal(seen.at(-1).request.language, language);
      assert(seen.at(-1).instructions.includes(`（${language}）`));
      assert(seen.at(-1).instructions.includes('summary、description的正文说明及unknowns必须统一使用此语言'));
      assert(seen.at(-1).instructions.includes('模板固定章节标题和标签'));
      assert(seen.at(-1).instructions.includes('现象说明直接陈述问题本身'));
      assert(seen.at(-1).instructions.includes('不以“报告称”'));
      assert(seen.at(-1).instructions.includes('保留原事实、否定和不确定性'));
      const next = await generateDraft({ ...c, language: language === 'en' ? 'ja' : 'en' }, { request: '补充说明', previousDraft: first }, deps);
      assert.equal(next.language, language);
      assert(seen.at(-1).instructions.includes('修改旧稿时也整理这类转述口吻'));
      const changed = await generateDraft(c, { request: '切换为日语', language: 'ja', previousDraft: first }, deps);
      assert.equal(changed.language, 'ja');
      assert.equal(first.language, language);
    }
    assert.equal((await generateDraft({ ...c, language: 'ja' }, { request: '旧草稿', previousDraft: fixture }, deps)).language, 'ja');
    assert.equal((await generateDraft({ ...c, language: undefined }, { request: '新草稿' }, deps)).language, 'zh-CN');
  }
});

test('语言保存到配置，保留其他设置，拒绝无效语言且不调用模型或改文件', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-language-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'config.json');
  await rememberLanguage(filename, 'ja');
  assert.equal((await loadConfig(filename)).language, 'ja');
  await writeFile(filename, JSON.stringify({ ...config, language: 'ja', extraSetting: true }));
  await rememberLanguage(filename, 'en');
  const saved = await readFile(filename, 'utf8');
  assert.equal(JSON.parse(saved).extraSetting, true);
  for (const language of ['', '__proto__', 'constructor', 'ja\nignore', [], null]) {
    await assert.rejects(rememberLanguage(filename, language), /起票语言/);
    assert.equal(await readFile(filename, 'utf8'), saved);
    if (language !== null) await assert.rejects(generateDraft(config, { request: '问题', language }, { env, fetchImpl: () => assert.fail('不应请求模型') }), /起票语言/);
  }
  validateDraft(fixture);
  assert.throws(() => validateDraft({ ...fixture, language: 'unknown' }), /起票语言/);
});

test('未读取源码只记录处理详情，不向正文或待确认事项追加笼统声明', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-language-source-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.js'), 'export const value = 1;');
  for (const language of ['zh-CN', 'ja', 'en']) {
    const logs = [];
    const draft = await generateDraft(config, { request: '问题', repo: root, language }, { env, log: text => logs.push(text), fetchImpl: model('responses', []) });
    assert.deepEqual(draft.unknowns, []);
    assert.equal(draft.description, fixture.description);
    assert(logs.some(text => text.includes('未读取源码')));
    assert.deepEqual(draft.source.evidence, []);
  }
});
