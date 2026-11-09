import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rememberProject, rememberProjectType, selectedProjectType, withProjectType, listIssueTypes } from '../src/backlog.js';
import { credentialFile, credentials, exampleConfig, loadConfig } from '../src/config.js';
import { generateDraft } from '../src/draft.js';
import { runChat } from '../src/chat.js';

const origin = 'https://fixture.backlog.com';
const config = { ...exampleConfig, model: { ...exampleConfig.model, name: 'fixture-model' }, backlog: { origin, project: 'ONE' } };
const types = [{ name: 'Task', templateDescription: '## Task 模板' }, { name: 'Bug', templateDescription: '## Bug 模板' }];
const json = value => ({ ok: true, json: async () => value });
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-project-type-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('类型按站点和项目保存，重载恢复，其他配置及凭据不变', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify(config));
  await writeFile(credentialFile(file), '{"key":"LOCAL_SECRET"}');
  const auth = await readFile(credentialFile(file), 'utf8');
  await rememberProjectType(file, config.backlog, 'Bug');
  await rememberProjectType(file, { ...config.backlog, project: 'TWO' }, 'Task');
  const saved = await loadConfig(file);
  assert.equal(selectedProjectType(saved.backlog), 'Bug');
  assert.equal(selectedProjectType(saved.backlog, 'TWO'), 'Task');
  assert.equal(selectedProjectType({ ...saved.backlog, origin: 'https://other.backlog.com' }), undefined);
  assert.equal(saved.backlog.project, 'ONE');
  assert.deepEqual(saved.model, config.model);
  assert.equal(await readFile(credentialFile(file), 'utf8'), auth);
  assert(!(await readFile(file, 'utf8')).includes('LOCAL_SECRET'));
  await assert.rejects(rememberProjectType(file, { ...config.backlog, origin: 'https://other.backlog.com' }, 'Bug'), /服务配置已改变/);
  await assert.rejects(rememberProjectType(file, config.backlog, 'Bad\nName'), /类型名称无效/);
  assert.throws(() => withProjectType({ ...config.backlog, projectTypes: [] }, 'Bug'), /配置格式无效/);
});

test('切项目后自动选择类型，切回时高亮该项目已保存类型，/config 与后续拟稿一致', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({ ...config, backlog: withProjectType(config.backlog, 'Task') }));
  const lines = ['/project TWO', '/config', '/project ONE', '问题', '/exit'], events = [], logs = [];
  let selections = 0, generated;
  await runChat(await loadConfig(file), { ask: async () => lines.shift(), log: line => logs.push(line), env: {},
    projects: async () => [{ key: 'ONE', name: '一' }, { key: 'TWO', name: '二' }],
    types: async selected => { events.push(`types:${selected.backlog.project}`); return types; },
    selectType: async (names, current) => {
      assert.deepEqual(names, ['Task', 'Bug']); assert.equal(current, 'Task');
      return selections++ === 0 ? 'Bug' : current;
    },
    persistProject: async (project, backlog) => { events.push(`project:${project}`); await rememberProject(file, backlog, project); },
    persistType: async (name, backlog) => { events.push(`type:${name}`); await rememberProjectType(file, backlog, name); },
    generate: async selected => { generated = selected; },
  });
  assert.deepEqual(events, ['project:TWO', 'types:TWO', 'type:Bug', 'project:ONE', 'types:ONE', 'type:Task']);
  assert(logs.some(line => line.startsWith('当前会话配置') && line.includes('工单类型：Bug')));
  assert.equal(generated.backlog.project, 'ONE');
  assert.equal(selectedProjectType(generated.backlog), 'Task');
  const restored = await loadConfig(file);
  assert.equal(selectedProjectType(restored.backlog, 'TWO'), 'Bug');
  assert.equal(selectedProjectType(restored.backlog), 'Task');
});

test('/type 支持编号、完整名称和带空格的类型，未知类型不保存', async () => {
  const lines = ['/type', '2', '/type Customer Support', '/type Unknown', '问题', '/exit'];
  const saved = [], logs = []; let generated;
  await runChat(config, { ask: async () => lines.shift(), log: line => logs.push(line), types: async () => [...types, { name: 'Customer Support' }],
    persistType: async name => saved.push(name), generate: async selected => { generated = selected; },
  });
  assert.deepEqual(saved, ['Bug', 'Customer Support']);
  assert.equal(selectedProjectType(generated.backlog), 'Customer Support');
  assert(logs.some(line => line.includes('请选择当前项目列表中的类型')));
});

test('取消类型选择、读取失败或保存失败不改变原类型；新项目没有旧项目类型', async () => {
  for (const mode of ['popup-cancel', 'text-cancel', 'empty', 'read-fail', 'save-fail']) {
    const initial = { ...config, backlog: withProjectType(config.backlog, 'Bug') };
    const lines = ['/type', ...(mode === 'text-cancel' ? [''] : []), '问题', '/exit'];
    let generated;
    await runChat(initial, { ask: async () => lines.shift(), log() {},
      types: async () => { if (mode === 'read-fail') throw new Error('读取失败'); return mode === 'empty' ? [] : types; },
      selectType: mode === 'text-cancel' ? undefined : async () => mode === 'save-fail' ? 'Task' : null,
      persistType: async () => { if (mode === 'save-fail') throw new Error('保存失败'); assert.fail('不应保存'); },
      generate: async selected => { generated = selected; },
    });
    assert.equal(selectedProjectType(generated.backlog), 'Bug');
    assert.equal(selectedProjectType(generated.backlog, 'TWO'), undefined);
  }
});

test('拟稿使用目标项目已选类型，显式 --type 覆盖；被删除类型不悄悄改成 Task', async () => {
  const selected = { ...config, backlog: withProjectType(withProjectType(config.backlog, 'Task'), 'Bug', 'TWO') };
  for (const override of [undefined, 'Task']) {
    const expected = override || 'Bug';
    const draft = await generateDraft(selected, { request: '问题', project: 'TWO', issueType: override }, { env: { OPENAI_API_KEY: 'MODEL_SECRET', BACKLOG_API_KEY: 'BACKLOG_SECRET' },
      fetchImpl: async (url, options) => {
        if (options.method === 'GET') {
          assert(url.pathname.startsWith('/api/v2/projects/TWO'));
          return url.pathname.endsWith('issueTypes') ? json(types) : json({ projectKey: 'TWO', textFormattingRule: 'markdown' });
        }
        const body = JSON.parse(options.body), request = JSON.parse(body.input[0].content[0].text);
        assert.equal(request.issueType, expected);
        assert.equal(request.template.description, `## ${expected} 模板`);
        return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '测试', description: `## ${expected} 模板\n待确认`, unknowns: [] }) }] }] });
      },
    });
    assert.equal(draft.issueType, expected); assert.equal(draft.target.project, 'TWO');
  }
  await assert.rejects(generateDraft({ ...config, backlog: withProjectType(config.backlog, 'Deleted') }, { request: '问题' }, {
    env: { OPENAI_API_KEY: 'MODEL_SECRET', BACKLOG_API_KEY: 'BACKLOG_SECRET' }, fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET'); return url.pathname.endsWith('issueTypes') ? json(types) : json({ projectKey: 'ONE' });
    },
  }), /指定类型不在/);
});

test('类型列表只读且不会输出密钥或服务返回的错误正文', async () => {
  const selected = { ...config, [credentials]: { backlog: { origin, key: 'LOCAL_SECRET' } } };
  const result = await listIssueTypes(selected, { env: {}, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/api/v2/projects/ONE/issueTypes'); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error'); assert.equal(url.searchParams.get('apiKey'), 'LOCAL_SECRET');
    return json(types);
  } });
  assert.equal(result[1].name, 'Bug');
  await assert.rejects(listIssueTypes(selected, { env: {}, fetchImpl: async () => { throw new Error('LOCAL_SECRET'); } }), error => !error.message.includes('LOCAL_SECRET'));
});
