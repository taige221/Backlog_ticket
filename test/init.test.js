import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupConfig, setupSection } from '../src/setup.js';
import { backlogConnection, credentials, credentialFile, exampleConfig, selectedProjectRepo } from '../src/config.js';
import { generateDraft } from '../src/draft.js';
import { runChat } from '../src/chat.js';
import { rememberModel } from '../src/models.js';

const json = value => ({ ok: true, json: async () => value });
const origin = 'https://fixture.backlog.com';
const projects = [{ projectKey: 'ONE', name: '第一个项目' }, { projectKey: 'TWO', name: '第二个项目' }];
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}
function ui(secrets, answers) {
  const logs = [];
  return {
    logs, env: {}, log: line => logs.push(line),
    askSecret: async () => { assert(secrets.length, '意外的密钥提问'); return secrets.shift(); },
    ask: async () => { assert(answers.length, '意外的配置提问'); return answers.shift(); },
  };
}
async function fetchSetup(url, options) {
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  if (String(url).startsWith('https://api.openai.com/')) {
    assert.equal(options.headers.Authorization, 'Bearer sk-proj-fixture');
    return json({ data: [{ id: 'fixture-model' }] });
  }
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, '/api/v2/projects');
  assert.equal(url.searchParams.get('apiKey'), 'backlog-fixture-secret');
  assert.equal(url.searchParams.get('archived'), 'false');
  return json(projects);
}
async function existing(root, repo = '') {
  const file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({ ...exampleConfig,
    model: { ...exampleConfig.model, provider: 'openai', name: 'fixture-model' },
    backlog: { origin, project: 'TWO' }, repo, extra: 'preserved' }));
  await writeFile(credentialFile(file), JSON.stringify({
    openai: { baseUrl: exampleConfig.model.baseUrl, key: 'sk-proj-fixture' },
    backlog: { origin, key: 'backlog-fixture-secret' },
  }));
  return file;
}

test('完整 init 配置两组密钥、可访问项目与代码目录，普通配置和日志不含密钥', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  const source = path.join(root, 'code with spaces');
  await mkdir(source);
  const terminal = ui(['sk-proj-fixture', 'backlog-fixture-secret'], ['openai', origin, '99', '2', `"${source}"`]);
  const config = await setupConfig(file, { ...terminal, fetchImpl: fetchSetup });
  assert.equal(config.backlog.project, 'TWO');
  assert.equal(selectedProjectRepo(config), source);
  assert.equal(backlogConnection({ ...config }, { BACKLOG_API_KEY: 'old-env' }).apiKey, 'backlog-fixture-secret');
  assert(terminal.logs.some(line => line.includes('请选择列表')));
  for (const secret of ['sk-proj-fixture', 'backlog-fixture-secret']) {
    assert(!(await readFile(file, 'utf8')).includes(secret));
    assert(!JSON.stringify(config).includes(secret));
    assert(!terminal.logs.join('\n').includes(secret));
  }
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(credentialFile(file))).mode & 0o777, 0o600);
});

test('已有配置全部回车保留，旧相对代码目录仍以配置位置为基准', async t => {
  const root = await directory(t);
  await mkdir(path.join(root, 'source'));
  const file = await existing(root, './source');
  const config = await setupConfig(file, { ...ui(['', ''], ['', '', '', '']), fetchImpl: fetchSetup });
  assert.equal(config.model.name, 'fixture-model');
  assert.equal(config.backlog.project, 'TWO');
  assert.equal(selectedProjectRepo(config), path.join(root, 'source'));
  assert.equal(config.extra, 'preserved');
  assert.equal(config[credentials].backlog.key, 'backlog-fixture-secret');
});

test('代码目录可跳过或用减号清除；唯一可访问项目自动选定', async t => {
  const root = await directory(t), file = await existing(root, '/previous/source');
  let config = await setupConfig(file, { ...ui(['', ''], ['', '', '-']), fetchImpl: async (url, options) => {
    const data = await fetchSetup(url, options);
    return url instanceof URL && url.origin === origin ? json([projects[0]]) : data;
  } });
  assert.equal(selectedProjectRepo(config), undefined); assert.equal(config.backlog.project, 'ONE');
  assert.equal(selectedProjectRepo(config, { origin, project: 'TWO' }), '/previous/source');
  config = await setupConfig(file, { ...ui(['', ''], ['', '', 'ONE', '']), fetchImpl: fetchSetup });
  assert.equal(selectedProjectRepo(config), undefined);
});

test('目录无效时不覆盖任何现有设置或新密钥', async t => {
  const root = await directory(t), file = await existing(root);
  const before = await readFile(file, 'utf8'), auth = await readFile(credentialFile(file), 'utf8');
  for (const invalid of [path.join(root, 'missing'), file]) {
    await assert.rejects(setupConfig(file, { ...ui(['sk-proj-new-key', ''], ['', '', '', invalid]), fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://api.openai.com/')) return json({ data: [] });
      return fetchSetup(url, options);
    } }), /代码目录/);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(await readFile(credentialFile(file), 'utf8'), auth);
  }
});

test('Backlog 鉴权失败、网络异常或无效项目列表均不保存，错误不泄露密钥', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  for (const response of [
    () => ({ ok: false, status: 401 }),
    () => { throw new Error('https://fixture.backlog.com/?apiKey=backlog-fixture-secret'); },
    () => json({ error: 'backlog-fixture-secret' }),
    () => json([]),
  ]) {
    await assert.rejects(setupConfig(file, { ...ui(['sk-proj-fixture', 'backlog-fixture-secret'], ['openai', origin]), fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://api.openai.com/')) return fetchSetup(url, options);
      return response();
    } }), error => !error.message.includes('backlog-fixture-secret'));
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    await assert.rejects(readFile(credentialFile(file)), { code: 'ENOENT' });
  }
});

test('更改 Backlog 站点时禁止沿用已存密钥，必须重新输入；验证前不会发送到新站点', async t => {
  const root = await directory(t), file = await existing(root);
  const before = await readFile(file, 'utf8');
  await assert.rejects(setupConfig(file, { ...ui(['', ''], ['', 'https://other.backlog.com']), fetchImpl: async (url, options) => {
    assert(String(url).startsWith('https://api.openai.com/'));
    return fetchSetup(url, options);
  } }), /其他站点/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.throws(() => backlogConnection({ backlog: { origin: 'https://other.backlog.com' },
    [credentials]: { backlog: { origin, key: 'backlog-fixture-secret' } } }), /其他站点/);
});

test('保留环境变量鉴权；取消代码目录输入不写配置', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({ ...exampleConfig, backlog: { origin, project: 'TWO' } }));
  const env = { OPENAI_API_KEY: 'sk-proj-fixture', BACKLOG_API_KEY: 'backlog-fixture-secret' };
  const before = await readFile(file, 'utf8');
  await assert.rejects(setupConfig(file, { ...ui(['', ''], ['', '', '', undefined]), env, fetchImpl: fetchSetup }), /取消/);
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(readFile(credentialFile(file)), { code: 'ENOENT' });
  const config = await setupConfig(file, { ...ui(['', ''], ['', '', '', '']), env, fetchImpl: fetchSetup });
  assert.equal(backlogConnection(config, env).apiKey, env.BACKLOG_API_KEY);
  assert.equal(config[credentials].backlog, undefined);
});

test('首次 init 可直接使用所选服务商的环境变量，且不保存其中的密钥', async t => {
  const file = path.join(await directory(t), 'config.json');
  const env = { OPENAI_API_KEY: 'sk-proj-fixture', BACKLOG_API_KEY: 'backlog-fixture-secret' };
  await assert.rejects(setupConfig(file, {
    ...ui([''], ['deepseek']), env, fetchImpl: async () => assert.fail('不能使用另一家服务商的 Key'),
  }), /取消/);
  await assert.rejects(readFile(file), { code: 'ENOENT' });

  const config = await setupConfig(file, { ...ui(['', ''], ['openai', origin, 'TWO', '']), env, fetchImpl: fetchSetup });
  assert.equal(config.model.provider, 'openai');
  assert.equal(config.model.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(config.backlog.project, 'TWO');
  assert.deepEqual(JSON.parse(await readFile(credentialFile(file), 'utf8')), {});
});

test('无环境变量时 metadata 拟稿使用 init 保存的 Backlog 密钥，模型仅收到元数据', async t => {
  const root = await directory(t), file = await existing(root);
  const config = await setupConfig(file, { ...ui(['', ''], ['', '', 'ONE', '']), fetchImpl: fetchSetup });
  let reads = 0;
  const draft = await generateDraft(config, { request: '拟稿测试', project: 'TWO', metadata: true }, { env: {}, fetchImpl: async (url, options) => {
    if (options.method === 'GET') {
      reads++;
      assert.equal(url.origin, origin);
      assert(url.pathname.startsWith('/api/v2/projects/TWO'));
      assert.equal(url.searchParams.get('apiKey'), 'backlog-fixture-secret');
      if (url.pathname.endsWith('users')) return json([{ name: '测试人' }]);
      if (url.pathname.endsWith('issueTypes')) return json([{ name: 'タスク', templateDescription: '## 現状' }]);
      return json({ projectKey: 'TWO', name: '第二个项目' });
    }
    assert.equal(options.headers.Authorization, 'Bearer sk-proj-fixture');
    assert(!options.body.includes('backlog-fixture-secret'));
    assert(!options.body.includes('sk-proj-fixture'));
    assert(options.body.includes('第二个项目'));
    return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: '测试', description: '## 現状\n待确认', unknowns: [] }) }] }] });
  } });
  assert.equal(reads, 3);
  assert.equal(draft.target.project, 'TWO');
  assert(!JSON.stringify(draft).includes('backlog-fixture-secret'));
});

test('单独配置 api 不校验 Backlog 或代码目录，保留其配置与凭据', async t => {
  const root = await directory(t), file = await existing(root, '/missing/source');
  const oldAuth = JSON.parse(await readFile(credentialFile(file), 'utf8'));
  const config = await setupSection(file, 'api', {
    ...ui(['sk-proj-updated'], ['']), fetchImpl: async (url, options) => {
      assert.equal(url.href, 'https://api.openai.com/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer sk-proj-updated');
      return json({ data: [] });
    },
  });
  assert.deepEqual(config.backlog, { origin, project: 'TWO' });
  assert.equal(selectedProjectRepo(config), '/missing/source');
  assert.deepEqual(config[credentials].backlog, oldAuth.backlog);
  assert.equal(config[credentials].openai.key, 'sk-proj-updated');
});

test('单独配置 backlog 无须模型密钥或代码目录，只请求 Backlog 项目列表', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  const config = await setupSection(file, 'backlog', {
    ...ui(['backlog-fixture-secret'], [origin, 'TWO']), fetchImpl: async (url, options) => {
      assert.equal(url.origin, origin);
      return fetchSetup(url, options);
    },
  });
  assert.equal(config.backlog.project, 'TWO');
  assert.deepEqual(config.model, exampleConfig.model);
  assert.equal(config.repo, '');
  assert.equal(config[credentials].openai, undefined);
});

test('单独配置 repo 无须两家服务就能初始化，不请求网络、不创建凭据文件', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  const config = await setupSection(file, 'repo', {
    ...ui([], [root]), fetchImpl: async () => assert.fail('代码目录配置不请求服务'),
  });
  assert.equal(config.repo, root);
  assert.deepEqual(config.model, exampleConfig.model);
  assert.deepEqual(config.backlog, exampleConfig.backlog);
  await assert.rejects(readFile(credentialFile(file)), { code: 'ENOENT' });
});

test('单独配置 repo 支持保留和清除，密钥文件字节保持不变', async t => {
  const root = await directory(t), file = await existing(root, root);
  const auth = await readFile(credentialFile(file), 'utf8');
  for (const [answer, expected] of [['', root], ['-', '']]) {
    const config = await setupSection(file, 'repo', { ...ui([], [answer]), fetchImpl: async () => assert.fail('不请求服务') });
    assert.equal(selectedProjectRepo(config) || '', expected);
    assert.equal(config.model.name, 'fixture-model');
    assert.equal(config.backlog.project, 'TWO');
    assert.equal(await readFile(credentialFile(file), 'utf8'), auth);
  }
});

test('单独配置 Backlog 鉴权失败不改写任意原配置或凭据', async t => {
  const root = await directory(t), file = await existing(root, '/unavailable/source');
  const before = await readFile(file, 'utf8'), auth = await readFile(credentialFile(file), 'utf8');
  await assert.rejects(setupSection(file, 'backlog', { ...ui(['new-backlog-secret'], ['']),
    fetchImpl: async url => {
      assert.equal(url.origin, origin);
      return { ok: false, status: 401 };
    },
  }), /HTTP 401/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(await readFile(credentialFile(file), 'utf8'), auth);
});

test('config 帮助可非交互查看，非法配置命令在任何输入和写文件前拒绝', async t => {
  const root = await directory(t), file = path.join(root, 'config.json');
  const run = args => spawnSync(process.execPath, ['bin/ticket.js', ...args, '--config', file], { encoding: 'utf8' });
  const help = run(['config']);
  assert.equal(help.status, 0);
  assert(help.stdout.includes('api|backlog|repo'));
  for (const args of [['config', 'invalid'], ['config', 'api', 'extra']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert(result.stderr.includes('用法：ticket config'));
  }
  await assert.rejects(setupSection(file, 'invalid', ui([], [])), /配置项/);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('对话 /api、/backlog、/repo 复用独立配置引导，持久化结果用于同次会话的拟稿', async t => {
  const root = await directory(t), file = await existing(root, '/old/source');
  const { loadConfig } = await import('../src/config.js');
  const terminal = ui(['sk-proj-fixture', 'backlog-fixture-secret'], ['', '', 'ONE', root]);
  const commands = ['/model fixture-session-model', '/api', '/backlog', '/repo', '问题', '/exit'];
  let generated = 0;
  await runChat(await loadConfig(file), {
    ask: async () => commands.shift(), log: terminal.log,
    types: async () => [{ name: 'Task' }], selectType: async () => null,
    persistModel: (selected, model) => rememberModel(file, model, selected),
    configure: scope => setupSection(file, scope, { ...terminal, fetchImpl: fetchSetup }),
    generate: async selected => {
      generated++;
      assert.equal(selected.model.name, 'fixture-session-model');
      assert.equal(selected.backlog.project, 'ONE');
      assert.equal(selectedProjectRepo(selected), root);
      assert.equal(backlogConnection(selected, {}).apiKey, 'backlog-fixture-secret');
    },
  });
  assert.equal(generated, 1);
  const saved = await loadConfig(file);
  assert.equal(saved.backlog.project, 'ONE');
  assert.equal(selectedProjectRepo(saved), root);
  assert.equal(saved.model.name, 'fixture-session-model');
  assert(!terminal.logs.join('\n').includes('backlog-fixture-secret'));
});
