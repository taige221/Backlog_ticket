import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, readFile, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTerminal } from '../src/terminal.js';
import { exampleConfig, saveJson, httpUrl, resolveConfigFile, loadConfig } from '../src/config.js';
import { homedir } from 'node:os';
import { openSource } from '../src/source.js';
import { generateDraft, validateDraft, readDraft, imageData } from '../src/draft.js';
import { previewTarget, fillDraftForm, openPreview } from '../src/preview.js';
import { getProjectMetadata } from '../src/backlog.js';

const fixture = { version: 1, summary: '测试标题', description: '## 现状\n仅预览', unknowns: [], attachments: [] };
const config = { ...exampleConfig, model: { ...exampleConfig.model, name: 'configured-model' }, backlog: { ...exampleConfig.backlog, origin: 'https://example.backlog.com', project: 'DEMO' } };
async function temp(t) { const directory = await mkdtemp(path.join(tmpdir(), 'ticket-test-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
const json = value => ({ ok: true, json: async () => value });

test('配置和草稿不覆盖已有文件，保存权限为0600', async t => {
  const directory = await temp(t), file = path.join(directory, 'draft.json');
  await saveJson(file, fixture);
  await assert.rejects(saveJson(file, { ...fixture, summary: '覆盖' }), /未覆盖/);
  assert.equal(JSON.parse(await readFile(file)).summary, fixture.summary);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('全局配置与cwd无关，显式路径优先于环境配置，源码相对配置定位', async t => {
  assert.equal(resolveConfigFile(undefined, {}), path.join(homedir(), '.config', 'backlog-ticket', 'config.json'));
  assert.equal(resolveConfigFile(undefined, { TICKET_CONFIG: '/tmp/ticket-config.json' }), '/tmp/ticket-config.json');
  assert.equal(resolveConfigFile('/tmp/explicit.json', { TICKET_CONFIG: '/tmp/env.json' }), '/tmp/explicit.json');
  const root = await temp(t), file = path.join(root, 'config.json');
  await saveJson(file, { ...exampleConfig, repo: './source' });
  assert.equal((await loadConfig(file)).repo, path.join(root, 'source'));
});

test('边界校验拒绝凭据URL、无效日期和目标错配', () => {
  assert.throws(() => httpUrl('https://user:secret@host.test', '地址'), /凭据/);
  assert.throws(() => httpUrl('https://host.test/?apiKey=secret', '地址'), /凭据/);
  assert.throws(() => validateDraft({ ...fixture, dueDate: '2026-02-30' }), /有效/);
  assert.throws(() => validateDraft({ ...fixture, startDate: '2026-11-30', dueDate: '2026-11-04' }), /早于/);
  assert.throws(() => previewTarget({ ...fixture, target: { origin: 'https://else.backlog.com', project: 'DEMO' } }, config), /目标/);
  assert.equal(previewTarget(fixture, config).url, 'https://example.backlog.com/add/DEMO');
});

test('代码工具拒绝越界、凭据文件、忽略文件及软链逃逸', async t => {
  const directory = await temp(t), root = path.join(directory, 'repo');
  await mkdir(root);
  await writeFile(path.join(root, 'app.js'), 'const bug = true;\nreturn bug;\n');
  await writeFile(path.join(root, '.env'), 'SECRET=needle');
  await writeFile(path.join(root, '.npmrc'), 'SECRET=needle');
  await writeFile(path.join(root, 'private.local.json'), '{"secret":"needle"}');
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'ignored.txt'), 'SECRET=needle');
  await writeFile(path.join(directory, 'outside.txt'), 'outside');
  await symlink(path.join(directory, 'outside.txt'), path.join(root, 'link.txt'));
  const source = await openSource(root);
  const files = await source.call('list_files', {});
  assert(files.includes('app.js'));
  for (const file of ['.env', '.npmrc', 'private.local.json', 'ignored.txt']) assert(!files.includes(file));
  await assert.rejects(source.call('read_file', { path: '../outside.txt' }));
  await assert.rejects(source.call('read_file', { path: '.env' }));
  await assert.rejects(source.call('read_file', { path: 'link.txt' }));
  assert.deepEqual(await source.call('search_code', { query: 'needle' }), []);
  assert.match(await source.call('read_file', { path: 'app.js', start: 1, end: 2 }), /1: const bug/);
  assert.equal(source.evidence.length, 1);
  assert.equal((await source.call('search_code', { query: 'bug' }))[0].path, 'app.js');
  assert.match(await source.call('read_file', { path: 'app.js', start: 1, end: 999 }), /nextStart: EOF/);
});

test('Responses多轮调查保留reasoning输出与真实读取证据', async t => {
  const root = await temp(t);
  await writeFile(path.join(root, 'app.js'), 'const bug = true;');
  const requests = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body); requests.push(request);
    if (requests.length === 1) return json({ status: 'completed', output: [
      { type: 'reasoning', id: 'reason', summary: [] },
      { type: 'function_call', call_id: 'read', name: 'read_file', arguments: '{"path":"app.js"}' },
    ] });
    assert(request.input.some(item => item.type === 'reasoning'));
    assert(request.input.some(item => item.type === 'function_call_output' && item.call_id === 'read' && item.output.includes('bug')));
    return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(fixture) }] }] });
  };
  const draft = await generateDraft(config, { request: '按钮无反应', repo: root, metadata: false }, { fetchImpl, env: { OPENAI_API_KEY: 'test-token' } });
  assert.equal(requests.length, 2);
  assert.equal(draft.source.evidence[0].path, 'app.js');
  assert(!JSON.stringify(draft).includes('test-token'));
  assert.equal(draft.target.project, 'DEMO');
});

test('Chat Completions多轮只读工具与图片消息转换', async t => {
  const root = await temp(t);
  await writeFile(path.join(root, 'app.js'), 'export const value = 1;');
  const image = path.join(root, 'shot.png');
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=', 'base64'));
  let rounds = 0;
  const fetchImpl = async (url, options) => {
    assert(url.endsWith('/chat/completions'));
    const body = JSON.parse(options.body);
    assert.equal(body.messages[1].content[1].type, 'image_url');
    assert.equal(body.tools[0].type, 'function');
    if (++rounds === 1) return json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":"app.js"}' } }] } }] });
    assert.equal(body.messages.at(-1).tool_call_id, 'call');
    return json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(fixture) } }] });
  };
  const draft = await generateDraft({ ...config, model: { ...config.model, protocol: 'chat-completions' } }, { request: '测试', repo: root, images: [image], metadata: false }, { fetchImpl, env: { OPENAI_API_KEY: 'token' } });
  assert.deepEqual(draft.attachments, [await realpath(image)]);
  assert.equal(draft.source.evidence.length, 1);
  const invalidImage = path.join(root, 'fake.png');
  await writeFile(invalidImage, 'not an image');
  await assert.rejects(imageData(invalidImage), /仅支持/);
});

test('模型异常不泄露服务响应或密钥，不接受伪造元数据字段', async () => {
  await assert.rejects(generateDraft(config, { request: 'test', metadata: false }, { env: { OPENAI_API_KEY: 'SECRET' }, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'SECRET' }) }), error => !error.message.includes('SECRET') && /401/.test(error.message));
  const draft = await generateDraft(config, { request: 'test', metadata: false }, { env: { OPENAI_API_KEY: 'token' }, fetchImpl: async () => json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...fixture, assignee: 'model-invented', target: { origin: 'https://evil.test' } }) }] }] }) });
  assert.equal(draft.assignee, undefined);
  assert.equal(draft.target.origin, config.backlog.origin);
});

test('无效日期和过多截图在任何模型调用之前拒绝', async () => {
  const dependencies = { env: { OPENAI_API_KEY: 'token' }, fetchImpl: async () => { assert.fail('不应调用模型'); } };
  await assert.rejects(generateDraft(config, { request: 'test', dueDate: '2026-02-30' }, dependencies), /有效/);
  await assert.rejects(generateDraft(config, { request: 'test', images: Array(6).fill('/not/read') }, dependencies), /5张/);
});

test('Backlog元数据只做GET，请求失败不输出带密钥的URL', async () => {
  const seen = [];
  const result = await getProjectMetadata(config, { env: { BACKLOG_API_KEY: 'SECRET' }, fetchImpl: async (url, options) => {
    seen.push(options.method);
    assert.equal(url.searchParams.get('apiKey'), 'SECRET');
    if (url.pathname.endsWith('issueTypes')) return json([{ name: 'タスク', templateDescription: '## 現状' }]);
    if (url.pathname.endsWith('users')) return json([{ name: 'test user', mailAddress: 'private' }]);
    return json({ projectKey: 'DEMO', name: 'Demo' });
  } });
  assert.deepEqual(seen, ['GET', 'GET', 'GET']);
  assert.equal(result.types[0].templateDescription, '## 現状');
  assert(!JSON.stringify(result).includes('private'));
  await assert.rejects(getProjectMetadata(config, { env: { BACKLOG_API_KEY: 'SECRET' }, fetchImpl: async () => { throw new Error('https://url?apiKey=SECRET'); } }), error => !error.message.includes('SECRET'));
});

test('读取手工草稿时附件相对于草稿文件解析', async t => {
  const root = await temp(t), file = path.join(root, 'draft.json');
  await saveJson(file, { ...fixture, attachments: ['shot.png'] });
  assert.deepEqual((await readDraft(file)).attachments, [path.join(root, 'shot.png')]);
});

function fakePage({ backup = false, contentEditable = false, proseMirror = false, rewriteDescription, lateImageTags = '', repeatLateInsert = false, autoInsertUploads = false, uploadInsertDelay = 5, staleImageTags = '', currentType, templatePrompt = false, multipleFiles = true, uploadFailure = false, notifyFailure = false, dropPreviousNotify = false } = {}) {
  const actions = [], values = new Map(), notified = new Set();
  let fileChooser, lateInserted = false, bodyWrites = 0;
  const locator = (key) => ({
    first() { return this; }, last() { return this; }, filter(options) { assert.equal(options.visible, true); return this; }, or(other) { return key.startsWith('notify-option:') ? this : other; },
    getByText(name) { return locator(`notify-option:${name}`); },
    async isVisible() {
      if (key.startsWith('notify-chip:')) return notified.has(key.slice('notify-chip:'.length));
      return key.includes('種別のみ変更する') ? templatePrompt : backup;
    },
    async fill(value) {
      if (value && key.includes('description text area')) bodyWrites++;
      values.set(key, value); actions.push(['fill', key, value]);
    },
    async inputValue() {
      if (contentEditable && key.includes('description text area')) throw new Error('Node is not an <input>, <textarea> or <select> element');
      return values.get(key);
    },
    async press(keyName) { actions.push(['press', key, keyName]); },
    async blur() { actions.push(['blur', key]); },
    async click() {
      actions.push(['click', key]);
      if (key.includes('ファイルを選択')) {
        assert(fileChooser, '先注册 filechooser，再点击文件选择按钮');
        fileChooser({ isMultiple: () => multipleFiles, async setFiles(files) {
          if (uploadFailure) throw new Error('附件上传失败');
          actions.push(['upload', ...files]);
          if (autoInsertUploads) setTimeout(() => {
            const field = [...values.keys()].find(name => name.includes('description text area'));
            if (!field) return;
            const tags = files.filter(file => file.endsWith('.png')).map(file => `![image][${path.basename(file)}]`).join('\n\n');
            const body = values.get(field);
            values.set(field, body ? body.replace('remove()', `remove(\n${tags}\n)`) : tags);
            actions.push(['auto-insert', field, values.get(field)]);
          }, uploadInsertDelay);
        } });
        fileChooser = null;
      }
      if (key.startsWith('notify-option:')) {
        if (notifyFailure) throw new Error('通知列表不可用');
        if (lateImageTags) {
          lateInserted = true;
          for (const [field, value] of values) if (field.includes('description text area')) values.set(field, value.replace('remove()', `remove(\n${lateImageTags}\n)`));
        }
        if (dropPreviousNotify) notified.clear();
        notified.add(key.slice('notify-option:'.length));
        for (const input of values.keys()) if (input.includes('Users to notify')) values.set(input, '');
      }
    },
    locator(selector) { assert.equal(selector, '..'); const scope = { locator: () => scope, getByText: name => locator(`notify-chip:${name}`), getByRole: role => ({ count: async () => role === 'textbox' ? 1 : 0 }) }; return scope; },
    async waitFor() {
      if (key.startsWith('notify-chip:')) assert(await this.isVisible());
      actions.push(['wait', key]);
    },
    async evaluate(fn, args) {
      if (Array.isArray(args)) {
        return fn({ isContentEditable: contentEditable, get textContent() { return values.get(key); }, get value() { return values.get(key); } }, args);
      }
      const stored = values.get(key) ?? (key.includes('種別|Issue type') ? currentType : undefined);
      let value = key.includes('description text area') && rewriteDescription ? rewriteDescription(stored) : stored;
      if (lateInserted && repeatLateInsert && key.includes('description text area')) value = value.replace('remove()', `remove(\n${lateImageTags}\n)`);
      const doc = proseMirror && staleImageTags && key.includes('description text area') ? { type: { name: 'doc' }, forEach(callback) {
        const state = bodyWrites === 1 ? value.replace('remove()', `remove(\n${staleImageTags}\n)`) : value;
        for (const textContent of state.split('\n')) callback({ type: { name: 'paragraph' }, textContent });
      } } : undefined;
      return fn({ tagName: 'SELECT', selectedOptions: [{ textContent: value }], isContentEditable: contentEditable, classList: { contains: name => proseMirror && name === 'ProseMirror' }, children: proseMirror ? (value ?? '').split('\n').map(textContent => ({ tagName: 'P', textContent })) : [], innerText: proseMirror ? value?.replaceAll('\n', '\n\n') : value, value, pmViewDesc: { node: doc } }, args);
    },
    async selectOption({ label }) { values.set(key, label); actions.push(['select', key, label]); },
  });
  return { actions, values, getByRole(role, options) {
    assert(role !== 'button' || !/プレビュー|Preview|追加|Add|Submit/.test(String(options.name)), '填写流程不能操作预览或提交按钮');
    return locator(`${role}:${options.name}`);
  }, getByText: text => locator(`text:${text}`),
    waitForEvent(event) { assert.equal(event, 'filechooser'); return new Promise(resolve => { fileChooser = resolve; }); },
    locator(selector) { assert.notEqual(selector, 'input[type="file"]', '上传不依赖预先存在的文件输入框'); return locator(selector); } };
}

test('填写字段和上传附件后停留在编辑页', async () => {
  const page = fakePage();
  await fillDraftForm(page, { ...fixture, issueType: 'タスク', assignee: 'test user', startDate: '2026-11-04', dueDate: '2026-11-30', attachments: ['/tmp/fixture.txt'] });
  assert.equal(page.actions.filter(([action]) => action === 'click').length, 1);
  assert(page.actions.some(([action]) => action === 'upload'));
  assert(page.actions.some(([action, key]) => action === 'wait' && key === 'button:fixture.txt'));
  assert(!page.actions.some(([action, key]) => action === 'wait' && key === 'text:fixture.txt'));
});

test('动态附件选择器支持批量和单文件入口，上传失败则中止填写', async () => {
  const attachments = ['/tmp/截图一.png', '/tmp/截图二.png'];
  for (const multipleFiles of [true, false]) {
    const page = fakePage({ multipleFiles });
    await fillDraftForm(page, { ...fixture, attachments });
    assert.deepEqual(page.actions.filter(([action]) => action === 'upload').flatMap(([, ...files]) => files), attachments);
    assert.equal(page.actions.filter(([action, key]) => action === 'click' && key.includes('ファイルを選択')).length, multipleFiles ? 1 : 2);
  }
  const failed = fakePage({ uploadFailure: true });
  await assert.rejects(fillDraftForm(failed, { ...fixture, attachments }), /附件上传失败/);
});

test('发现旧备份时在任何填写动作前停止', async () => {
  const page = fakePage({ backup: true });
  await assert.rejects(fillDraftForm(page, fixture), /自动备份/);
  assert.deepEqual(page.actions, []);
});

test('可编辑正文保留空行和 Markdown，内容被持续改写时报错', async () => {
  const draft = { ...fixture, description: '## 現状\n\n- [ ] 检查  \n\n## 期待\n保留正文\n' };
  for (const proseMirror of [false, true]) {
    const page = fakePage({ contentEditable: true, proseMirror });
    await fillDraftForm(page, draft);
    assert.equal(page.values.get('textbox:/^(description text area|Description)$/i'), draft.description);
  }
  for (const contentEditable of [false, true]) {
    const changed = fakePage({ contentEditable, rewriteDescription: value => value.replaceAll('\n\n', '\n') });
    await assert.rejects(fillDraftForm(changed, draft), /正文被模板或页面改写/);
    assert(!changed.actions.some(([action]) => action === 'click'));
  }
});

test('附件延迟插图后编辑页保留图片原位置和检查项 remove()', async () => {
  const attachments = ['/tmp/截图一.png', '/tmp/截图二.png'];
  const tags = '![image][截图一.png]\n\n![image][截图二.png]';
  const description = `## 現状\n折叠时显示异常。\n\n${tags}\n\n## チェックリスト\n- [ ] ThreadLocal / InheritableThreadLocalの場合、必ずremove()`;
  const draft = { ...fixture, attachments, description, notifiedUsers: ['QA'] };
  for (const contentEditable of [false, true]) {
    const page = fakePage({ lateImageTags: tags, contentEditable, proseMirror: contentEditable });
    await fillDraftForm(page, draft);
    assert.equal(page.values.get('textbox:/^(description text area|Description)$/i'), description);
    assert.equal(page.actions.filter(([action]) => action === 'upload').length, 1);
  }
  const changed = fakePage({ lateImageTags: tags, repeatLateInsert: true });
  await assert.rejects(fillDraftForm(changed, draft), /正文被页面再次改写/);
});

test('先让图片上传在空编辑框完成，再填写正文并确认编辑器模型已同步', async () => {
  const attachments = ['/tmp/截图一.png', '/tmp/截图二.png'];
  const tags = '![image][截图一.png]\n\n![image][截图二.png]';
  const description = `## 現状\n${tags}\n\n## チェックリスト\n- [ ] 必ずremove()`;
  const page = fakePage({ autoInsertUploads: true, uploadInsertDelay: 2_800, contentEditable: true, proseMirror: true, staleImageTags: tags });
  await fillDraftForm(page, { ...fixture, attachments, description }, { imageNames: attachments.map(file => path.basename(file)) });
  const upload = page.actions.findIndex(([action]) => action === 'upload');
  const inserted = page.actions.findIndex(([action]) => action === 'auto-insert');
  const body = page.actions.filter(([action, key]) => action === 'fill' && key.includes('description text area'));
  assert.deepEqual(body.map(([, , value]) => value), ['', description, description]);
  assert(page.actions.indexOf(body[0]) < upload && upload < inserted && inserted < page.actions.indexOf(body[1]));
  assert.equal(page.actions[inserted][2], tags);
  assert(page.actions.some(([action, key]) => action === 'blur' && key.includes('description text area')));
  assert(!page.actions.some(([action, key]) => action === 'press' && key.includes('description text area')));
  assert.equal(page.values.get('textbox:/^(description text area|Description)$/i'), description);
});

test('相同类型不重复选择，切换类型的模板提示在填写正文前关闭', async () => {
  const same = fakePage({ currentType: 'タスク' });
  await fillDraftForm(same, { ...fixture, issueType: 'タスク' });
  assert(!same.actions.some(([action]) => action === 'select'));
  const changed = fakePage({ currentType: 'Bug', templatePrompt: true });
  await fillDraftForm(changed, { ...fixture, issueType: 'タスク' });
  assert(changed.actions.findIndex(([action, key]) => action === 'click' && key.includes('種別のみ変更する')) < changed.actions.findIndex(([action]) => action === 'fill'));
});

test('官网预览选择カテゴリー并填分类标题，不重复前缀，保持正文', async () => {
  const page = fakePage();
  await fillDraftForm(page, { ...fixture, summary: '【frontend】 【Frontend】' + fixture.summary + '/' + fixture.summary + '/无', category: 'frontend' });
  assert(page.actions.some(([action, key, value]) => action === 'select' && key.includes('カテゴリー') && value === 'frontend'));
  assert(page.actions.some(([action, key, value]) => action === 'fill' && key.includes('件名') && value === '【frontend】' + fixture.summary));
  assert(page.actions.some(([action, key, value]) => action === 'fill' && key.includes('description text area') && value === fixture.description));
});

test('官网预览填入日期、可选负责人和多位通知对象，未选择通知不操作人员控件', async () => {
  const page = fakePage();
  await fillDraftForm(page, { ...fixture, startDate: '2026-11-06', dueDate: '2026-11-13', assignee: 'QA', notifiedUsers: ['QA', 'Dev', 'Support', 'Design', 'QA'] });
  assert(page.actions.some(([action, key, value]) => action === 'select' && key.includes('担当者') && value === 'QA'));
  assert.deepEqual(page.actions.filter(([action, key]) => action === 'click' && key.startsWith('notify-option:')).map(([,key]) => key), ['notify-option:QA', 'notify-option:Dev', 'notify-option:Support', 'notify-option:Design']);
  assert(page.actions.some(([action, key, value]) => action === 'fill' && key.includes('startDate') && value === '2026/11/06'));
  assert(page.actions.some(([action, key, value]) => action === 'fill' && key.includes('dueDate') && value === '2026/11/13'));
  const blank = fakePage(); await fillDraftForm(blank, fixture);
  assert(!blank.actions.some(([,key]) => key.includes('Users to notify')));
});

test('后续选择导致之前的通知人消失时提示缺少的人员', async () => {
  const page = fakePage({ dropPreviousNotify: true });
  await assert.rejects(fillDraftForm(page, { ...fixture, notifiedUsers: ['QA', 'Dev', 'Support', 'Design'] }), /只保留了 1\/4 位，缺少：QA、Dev、Support/);
});

test('通知人选择失败时保留已经填入的正文', async () => {
  const page = fakePage({ notifyFailure: true });
  await assert.rejects(fillDraftForm(page, { ...fixture, notifiedUsers: ['Dev'] }), /通知列表不可用/);
  const body = page.actions.findIndex(([action, key, value]) => action === 'fill' && key.includes('description text area') && value === fixture.description);
  const notification = page.actions.findIndex(([action, key]) => action === 'click' && key.startsWith('notify-option:'));
  assert(body >= 0 && body < notification);
});

test('自动导航失败后可手动恢复，确认目标页之前不填写', async t => {
  const profileDir = await temp(t), page = fakePage(), logs = [];
  let closeBrowser;
  Object.assign(page, { setDefaultTimeout() {}, async goto() { throw new Error('connection reset'); }, url: () => previewTarget(fixture, config).url });
  await openPreview(fixture, config, {
    profileDir,
    chromium: { async launchPersistentContext() { return { once(event, listener) { closeBrowser = listener; }, pages: () => [page], async close() { closeBrowser(); } }; } },
    async ask() { assert.deepEqual(page.actions, []); },
    log(message) { logs.push(message); if (message.startsWith('已填入官网')) closeBrowser(); },
  });
  assert(logs.some(message => message.includes('重新加载目标地址')));
  assert(page.actions.some(([action, key, value]) => action === 'fill' && key.includes('件名') && value === fixture.summary));
});

test('官网预览为旧草稿按当前项目格式补图，先上传再填写正文，图片与PDF都保留', async t => {
  for (const rule of ['markdown', 'backlog']) {
    const profileDir = await temp(t), page = fakePage({ autoInsertUploads: true }), image = path.join(profileDir, '截图.png'), pdf = path.join(profileDir, '说明.pdf');
    await writeFile(image, Buffer.from([137,80,78,71,13,10,26,10])); await writeFile(pdf, '%PDF-1.4');
    const draft = { ...fixture, attachments: [image, pdf] };
    Object.assign(page, { setDefaultTimeout() {}, async goto() {}, url: () => previewTarget(draft, config).url });
    const gets = [];
    await openPreview(draft, config, {
      profileDir, ask: async () => {}, log() {}, env: { BACKLOG_API_KEY: 'test' },
      fetchImpl: async (url, options) => { gets.push([url.pathname, options.method]); return json({ projectKey: 'DEMO', textFormattingRule: rule }); },
      chromium: { async launchPersistentContext() { return { once() {}, pages: () => [page], async close() {} }; } },
    });
    assert.deepEqual(gets, [['/api/v2/projects/DEMO', 'GET']]);
    const bodyIndex = page.actions.findIndex(([action, key, value]) => action === 'fill' && key.includes('description text area') && value);
    assert(bodyIndex > page.actions.findIndex(([action]) => action === 'upload'));
    assert.equal(page.actions[bodyIndex][2], fixture.description + (rule === 'markdown' ? '\n\n![image][截图.png]' : '\n\n#image(截图.png)'));
    assert.deepEqual(page.actions.find(([action]) => action === 'upload').slice(1), [image, pdf]);
    assert.equal(draft.description, fixture.description);
  }
});

test('浏览器转到当前项目工单后返回链接，其他站点或项目不算已处理', async t => {
  for (const destination of ['https://example.backlog.com/view/DEMO-7', 'https://else.test/view/DEMO-7', 'https://example.backlog.com/view/OTHER-7']) {
    const profileDir = await temp(t), page = fakePage();
    let closeBrowser, navigated;
    const frame = { url: () => destination };
    Object.assign(page, { setDefaultTimeout() {}, async goto() {}, url: () => previewTarget(fixture, config).url, mainFrame: () => frame, on(event, listener) { navigated = listener; } });
    const result = await openPreview(fixture, config, {
      profileDir, ask: async () => {},
      chromium: { async launchPersistentContext() { return { once(event, listener) { closeBrowser = listener; }, pages: () => [page], async close() { closeBrowser(); } }; } },
      log(message) { if (message.startsWith('已填入官网')) { navigated({ url: () => 'https://example.backlog.com/view/DEMO-99' }); navigated(frame); closeBrowser(); } },
    });
    assert.deepEqual(result, destination.endsWith('/DEMO-7') && destination.startsWith(config.backlog.origin) ? { issueKey: 'DEMO-7', url: destination } : undefined);
  }
});

for (const action of ['enter', 'browser-close', 'page-close', 'ctrl-c']) {
  for (const fail of [false, true]) {
    test(`Preview exits via ${action} after ${fail ? 'a fill failure' : 'a successful fill'}`, { timeout: 3000 }, async t => {
      const profileDir = await temp(t);
      const page = fakePage(fail ? { rewriteDescription: () => '' } : {});
      Object.assign(page, { setDefaultTimeout() {}, async goto() {}, url: () => previewTarget(fixture, config).url });
      const pageEvents = new EventEmitter();
      page.once = (event, listener) => pageEvents.once(event, listener);
      const context = new EventEmitter();
      let closed = false;
      context.pages = () => [page];
      context.close = async () => { if (!closed) { closed = true; context.emit('close'); } };
      const input = new PassThrough(), output = new PassThrough();
      input.isTTY = true; input.setRawMode = () => {};
      output.isTTY = true;
      const terminal = createTerminal(input, output);
      t.after(() => terminal.close());
      output.on('data', chunk => {
        const text = chunk.toString();
        if (text.includes('确认已进入')) setImmediate(() => input.write('\r'));
        if (text.includes('按回车关闭预览')) setImmediate(() => {
          if (action === 'browser-close') void context.close();
          else if (action === 'page-close') pageEvents.emit('close');
          else input.write(action === 'ctrl-c' ? '\x03' : '\r');
        });
      });
      const pending = openPreview(fixture, config, {
        profileDir, ask: terminal.ask, signal: terminal.signal, log() {},
        chromium: { async launchPersistentContext() { return context; } },
      });
      if (fail) await assert.rejects(pending, /正文被模板或页面改写/);
      else assert.equal(await pending, undefined);
      assert.equal(closed, true);
      assert.equal(terminal.signal.aborted, action === 'ctrl-c');
      if (action !== 'ctrl-c') {
        const next = terminal.ask('操作> ');
        input.write('0\r');
        assert.equal(await next, '0');
      }
      assert(!page.actions.some(([, key]) => /追加|Submit/.test(key)));
    });
  }
}

test('Closing the browser during login cancels its prompt and restores terminal input', { timeout: 3000 }, async t => {
  const profileDir = await temp(t), page = fakePage();
  Object.assign(page, { setDefaultTimeout() {}, async goto() {}, url: () => previewTarget(fixture, config).url });
  const context = new EventEmitter();
  context.pages = () => [page];
  context.close = async () => { context.emit('close'); };
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; input.setRawMode = () => {};
  output.isTTY = true;
  const terminal = createTerminal(input, output);
  t.after(() => terminal.close());
  output.on('data', chunk => {
    if (chunk.toString().includes('确认已进入')) setImmediate(() => { void context.close(); });
  });
  await openPreview(fixture, config, {
    profileDir, ask: terminal.ask, signal: terminal.signal, log() {},
    chromium: { async launchPersistentContext() { return context; } },
  });
  assert.deepEqual(page.actions, []);
  assert.equal(terminal.signal.aborted, false);
  const next = terminal.ask('操作> ');
  input.write('0\r');
  assert.equal(await next, '0');
});

test('CLI help、init、不覆盖配置和离线show可实际执行', async t => {
  const root = await temp(t), cli = path.resolve('bin/ticket.js');
  const env = { ...process.env, TICKET_CONFIG: path.join(root, 'global-config.json') };
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });
  assert.match(run(['--help']).stdout, /仅草稿|不创建工单/);
  assert.equal(run(['init', '--template']).status, 0);
  assert.equal(run(['init', '--template']).status, 1);
  assert.equal(JSON.parse(await readFile(env.TICKET_CONFIG, 'utf8')).model.name, '');
  const elsewhere = path.join(root, 'another-directory');
  await mkdir(elsewhere);
  const initializedElsewhere = spawnSync(process.execPath, [cli, 'init', '--template'], { cwd: elsewhere, env, encoding: 'utf8' });
  assert.equal(initializedElsewhere.status, 1);
  assert.match(initializedElsewhere.stderr, /未覆盖/);
  assert.equal(run(['init', '--template', '--config', path.join(root, 'explicit.json')]).status, 0);
  await saveJson(path.join(root, 'demo.json'), fixture);
  const shown = run(['show', 'demo.json']);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /尚未创建/);
  assert.equal(run(['create']).status, 1);
});
