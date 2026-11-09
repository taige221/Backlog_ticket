import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.js';
import { generateDraft } from '../src/draft.js';
import { credentials, selectedProjectRepo, withProjectRepo } from '../src/config.js';

const config = {
  model: { baseUrl: 'https://aggregator.example/v1', name: 'provider/model-a', models: ['provider/model-a', 'provider/model-b'], apiKeyEnv: 'AGGREGATOR_KEY', protocol: 'chat-completions' },
};

function scripted(lines) {
  const answers = [...lines], logs = [];
  return { logs, log: message => logs.push(message), ask: async () => answers.length ? answers.shift() : null, list: async () => { throw new Error('模拟列表接口不可用'); },
    types: async () => [{ name: 'Task' }], selectType: async () => null };
}

test('/model编号与直接切换影响实际生成请求，保留服务/协议/密钥引用且不修改输入配置对象', async () => {
  const session = scripted(['/model', '2', '第一个问题', '/model other/model-c', '第二个问题', '/exit']);
  const original = structuredClone(config), requests = [];
  await runChat(config, { ...session, generate: async (selected, request) => {
    assert.equal(selected.model.baseUrl, config.model.baseUrl);
    assert.equal(selected.model.apiKeyEnv, config.model.apiKeyEnv);
    assert.equal(selected.model.protocol, config.model.protocol);
    await generateDraft(selected, { request }, { env: { AGGREGATOR_KEY: 'test-secret' }, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://aggregator.example/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: request, description: '待确认', unknowns: [] }) } }] }) };
    } });
  } });
  assert.deepEqual(requests.map(request => request.model), ['provider/model-b', 'other/model-c']);
  assert(session.logs.some(line => line.includes('2. provider/model-b')));
  assert(!session.logs.join('\n').includes('test-secret'));
  assert.deepEqual(config, original);
});

test('无候选模型时可输入模型ID，空选择取消，未配置模型时不生成', async () => {
  const session = scripted(['问题一', '/model', '', '/model', 'aggregate/model', '问题二', '/exit']);
  const generated = [];
  await runChat({ model: { name: '' } }, { ...session, generate: async (selected, request) => generated.push([selected.model.name, request]) });
  assert(session.logs.some(line => line.includes('请先输入 /model')));
  assert.deepEqual(generated, [['aggregate/model', '问题二']]);
});

test('错误编号、无效ID、未知命令和生成失败均不丢失当前选择', async () => {
  const session = scripted(['/model', '99', '/model bad model', '/unknown', '失败问题', '恢复问题', '/exit']);
  const selected = [];
  await runChat(config, { ...session, generate: async (next, request) => {
    selected.push(next.model.name);
    if (request === '失败问题') throw new Error('模拟调用失败');
  } });
  assert.deepEqual(selected, ['provider/model-a', 'provider/model-a']);
  assert(session.logs.some(line => line.includes('模型编号不存在')));
  assert(session.logs.some(line => line.includes('模型 ID 应为')));
  assert(session.logs.some(line => line.includes('未知命令')));
  assert(session.logs.some(line => line.includes('模拟调用失败')));
});

test('模型切换和帮助不触发生成；EOF/终端关闭可退出', async () => {
  for (const answers of [['/model provider/model-b', '/help', '/exit'], ['/model', null], []]) {
    await runChat(config, { ...scripted(answers), generate: async () => assert.fail('不应触发模型调用') });
  }
  await runChat(config, { ask: async () => { throw Object.assign(new Error(), { code: 'ABORT_ERR' }); }, log() {}, generate: async () => assert.fail() });
});

test('候选模型配置校验拒绝控制字符与错误类型', async () => {
  for (const models of ['invalid', ['bad\u001b[31m'], ['has whitespace'], [null]]) {
    await assert.rejects(runChat({ model: { models } }, { ...scripted([]), generate() {} }), /model.models/);
  }
});

test('/backlog 和 /repo 立即更新后续拟稿配置，保留会话内已选模型与原配置', async () => {
  const initial = { ...config, backlog: { project: 'OLD' }, repo: '/old/source' };
  const original = structuredClone(initial);
  const session = scripted(['/model provider/model-b', '/backlog', '/repo', '问题', '/exit']);
  const scopes = [], drafts = [];
  const auth = { backlog: { origin: 'https://new.backlog.com', key: 'fixture-secret' } };
  await runChat(initial, { ...session,
    configure: async scope => {
      scopes.push(scope);
      return { ...initial, backlog: { origin: 'https://new.backlog.com', project: 'NEW' }, repo: '/new/source', [credentials]: auth };
    },
    generate: async selected => drafts.push(selected),
  });
  assert.deepEqual(scopes, ['backlog', 'repo']);
  assert.equal(selectedProjectRepo(drafts[0]), '/new/source');
  assert.equal(drafts[0].backlog.project, 'NEW');
  assert.equal(drafts[0].model.name, 'provider/model-b');
  assert.equal(drafts[0][credentials], auth);
  assert.deepEqual(initial, original);
  assert(!session.logs.join('\n').includes('fixture-secret'));
});

test('/api 更换服务后自动读取新列表并弹窗，不沿用旧服务模型与候选', async () => {
  const session = scripted(['/api', '问题', '/exit']), drafts = [];
  const next = { model: { baseUrl: 'https://new.example/v1', protocol: 'responses', name: '', models: [] },
    [credentials]: { new: { key: 'fixture-new-secret' } } };
  await runChat(config, { ...session,
    configure: async scope => { assert.equal(scope, 'api'); return next; },
    list: async selected => { assert.equal(selected.model.baseUrl, next.model.baseUrl); return ['new/model']; },
    selectModel: async (choices, current) => { assert.deepEqual(choices, ['new/model']); assert.equal(current, ''); return 'new/model'; },
    generate: async selected => drafts.push(selected),
  });
  assert.equal(drafts[0].model.baseUrl, next.model.baseUrl);
  assert.equal(drafts[0].model.protocol, 'responses');
  assert.equal(drafts[0].model.name, 'new/model');
  assert.equal(drafts[0][credentials], next[credentials]);
  assert(!session.logs.join('\n').includes('fixture-new-secret'));

  const offline = scripted(['/api', 'new/direct-model', '问题', '/exit']);
  await runChat(config, { ...offline, configure: async () => next, generate() {} });
  assert(!offline.logs.some(line => /\d\. provider\/model/.test(line)));
});

test('重配 Backlog 或设置另一个项目的目录时保留本次会话的项目目录覆盖', async () => {
  const backlog = { origin: 'https://fixture.backlog.com', project: 'DEMO' };
  const saved = withProjectRepo({ ...config, backlog }, '/saved/source');
  const temporary = withProjectRepo(saved, '/session/source');
  const repos = [];
  await runChat(temporary, {
    ...scripted(['/backlog', '问题一', '/project OTHER', '/repo', '问题二', '/project DEMO', '问题三', '/exit']),
    projects: async () => [{ key: 'DEMO', name: '测试项目' }, { key: 'OTHER', name: '另一项目' }],
    configure: async (scope, target) => scope === 'backlog' ? saved : withProjectRepo(saved, '/other/source', target),
    generate: async selected => repos.push(selectedProjectRepo(selected)),
  });
  assert.deepEqual(repos, ['/session/source', '/other/source', '/session/source']);
});

test('/api 同一服务换 Key 时保留会话模型及其他会话设置', async () => {
  const session = scripted(['/model provider/model-b', '/api', '问题', '/exit']);
  const initial = { ...config, repo: '/session/source', backlog: { project: 'SESSION' } };
  await runChat(initial, { ...session,
    configure: async () => ({ ...config, repo: '/saved/source', backlog: { project: 'SAVED' }, [credentials]: { new: { key: 'new-key' } } }),
    generate: async selected => {
      assert.equal(selected.model.name, 'provider/model-b');
      assert.equal(selected.repo, '/session/source');
      assert.equal(selected.backlog.project, 'SESSION');
      assert.equal(selected[credentials].new.key, 'new-key');
    },
  });
});

test('配置失败或取消保留当前设置，拒绝把命令参数当作密钥', async () => {
  const session = scripted(['/api', '/repo', '/backlog', '/api secret-must-not-be-used', '/config api', '问题', '/exit']);
  const scopes = [], generated = [];
  await runChat(config, { ...session,
    configure: async scope => { scopes.push(scope); throw new Error(scope === 'api' ? '已取消配置' : '校验失败'); },
    generate: async selected => generated.push(selected.model.name),
  });
  assert.deepEqual(scopes, ['api', 'repo', 'backlog']);
  assert.deepEqual(generated, ['provider/model-a']);
  assert(!session.logs.join('\n').includes('secret-must-not-be-used'));
  assert(session.logs.some(line => line.includes('不接收参数')));
  assert(session.logs.some(line => line.includes('已取消配置')));
});
