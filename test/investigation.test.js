import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSource } from '../src/source.js';
import { generateDraft } from '../src/draft.js';
import { exampleConfig } from '../src/config.js';

const json = data => ({ ok: true, json: async () => data });
const completed = { summary: '菜单权限显示不一致', description: '菜单折叠和展开时显示不同。根因待确认。', unknowns: ['触发条件待确认'] };
async function repo(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-investigation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  return root;
}
const sourceReply = (protocol, round, args) => json(protocol === 'responses'
  ? { status: 'completed', output: [{ type: 'function_call', call_id: `read-${round}`, name: 'read_file', arguments: JSON.stringify(args) }] }
  : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `read-${round}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify(args) } }] } }] });
const draftReply = protocol => json(protocol === 'responses'
  ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(completed) }] }] }
  : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(completed) } }] });

test('源码按实际范围分页，闭区间稍超旧上限不报错，目录搜索不区分大小写', async t => {
  const root = await repo(t, { 'src/AdminLayout.tsx': Array.from({ length: 1000 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') });
  const source = await openSource(root);
  assert.deepEqual(await source.call('list_files', { query: 'src\\adminlayout' }), ['src/AdminLayout.tsx']);
  const args = { path: 'src/AdminLayout.tsx' };
  const first = await source.call('read_file', args);
  assert.match(first, /totalLines: 1000\nreturned: 1-400\nnextStart: 401/);
  const inclusive = await source.call('read_file', { ...args, start: 200, end: 400 });
  assert.match(inclusive, /returned: 200-400/); assert.match(inclusive, /400: const line400/);
  const large = await source.call('read_file', { ...args, start: 401, end: 999 });
  assert.match(large, /returned: 401-800\nnextStart: 801/);
  const last = await source.call('read_file', { ...args, start: 801, end: 5000 });
  assert.match(last, /returned: 801-1000\nnextStart: EOF/);
  assert.deepEqual(source.evidence.at(-1), { path: args.path, start: 801, end: 1000 });
  await assert.rejects(source.call('read_file', { ...args, start_line: 200 }), /仅支持 path、start、end/);
  await assert.rejects(source.call('read_file', { ...args, start: 0 }), /正整数/);
  await assert.rejects(source.call('read_file', { ...args, start: 10, end: 1 }), /end >= start/);
});

test('字符分段不截断源码行，不把未返回的行计入读取证据，过长单行有明确反馈', async t => {
  const root = await repo(t, { 'rows.ts': Array.from({ length: 400 }, () => 'x'.repeat(200)).join('\n'), 'minified.js': 'x'.repeat(25_000) });
  const source = await openSource(root);
  const text = await source.call('read_file', { path: 'rows.ts' });
  const actualEnd = source.evidence[0].end;
  assert(actualEnd > 1 && actualEnd < 400);
  assert.match(text, new RegExp(`nextStart: ${actualEnd + 1}`));
  assert.equal(text.split('\n').at(-1), `${actualEnd}: ${'x'.repeat(200)}`);
  assert(text.length < 24_200);
  await assert.rejects(source.call('read_file', { path: 'minified.js' }), /search_code/);
  assert.equal(source.evidence.length, 1);
});

test('两种协议连续调查55轮后仍能生成草稿，没有12或40轮截止，逐轮事件与工具结果完整', async t => {
  const root = await repo(t, { 'AdminLayout.tsx': Array.from({ length: 60 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') });
  for (const protocol of ['responses', 'chat-completions']) {
    let calls = 0; const events = [], logs = [];
    const selected = { ...exampleConfig, model: { ...exampleConfig.model, name: 'fixture-model', protocol }, backlog: {} };
    const draft = await generateDraft(selected, { request: '根据本地代码判断问题位置', repo: root, metadata: false }, { env: { OPENAI_API_KEY: 'FIXTURE' }, log: text => logs.push(text), onEvent: event => events.push(event), fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body), round = ++calls;
      assert.notEqual(body.tool_choice, 'none');
      if (round <= 55) return sourceReply(protocol, round, { path: 'AdminLayout.tsx', start: round, end: round });
      const results = protocol === 'responses' ? body.input.filter(item => item.type === 'function_call_output') : body.messages.filter(item => item.role === 'tool');
      assert.equal(results.length, 55);
      assert.match(protocol === 'responses' ? results.at(-1).output : results.at(-1).content, /55: const line55/);
      return draftReply(protocol);
    } });
    assert.equal(calls, 56); assert.equal(draft.source.evidence.length, 55);
    assert.equal(events.filter(event => event.type === 'request').at(-1).round, 56);
    assert.equal(events.filter(event => event.type === 'response').length, 56);
    assert(logs.includes('模型调查 56')); assert.equal(draft.summary, completed.summary);
  }
});

test('超时重发当前调查请求，保留已读源码和工具结果；成功后下一步仍可独立重试', async t => {
  const root = await repo(t, { 'AdminLayout.tsx': 'const first = true;\nconst second = true;' });
  for (const protocol of ['responses', 'chat-completions']) {
    const selected = { ...exampleConfig, model: { ...exampleConfig.model, name: 'fixture-model', protocol }, backlog: {} };
    const bodies = [], logs = [];
    const draft = await generateDraft(selected, { request: '核对相关代码', repo: root, metadata: false }, { env: { OPENAI_API_KEY: 'FIXTURE' }, log: text => logs.push(text), fetchImpl: async (_url, options) => {
      bodies.push(options.body);
      if ([2, 4].includes(bodies.length)) throw new DOMException('fixture timeout', 'TimeoutError');
      if (bodies.length === 1) return sourceReply(protocol, 1, { path: 'AdminLayout.tsx', start: 1, end: 1 });
      if (bodies.length === 3) return sourceReply(protocol, 2, { path: 'AdminLayout.tsx', start: 2, end: 2 });
      return draftReply(protocol);
    } });
    assert.equal(bodies.length, 5); assert.equal(bodies[1], bodies[2]); assert.equal(bodies[3], bodies[4]);
    assert.equal(draft.source.evidence.length, 2);
    assert.equal(logs.filter(text => text.startsWith('连接超时，正在重试')).length, 2);
  }
});

test('停止信号可在请求前及模型请求期间中止，不自动重试或虚构最终草稿', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    const selected = { ...exampleConfig, model: { ...exampleConfig.model, name: 'fixture-model', protocol }, backlog: {} };
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(generateDraft(selected, { request: '问题', metadata: false }, { env: { OPENAI_API_KEY: 'FIXTURE' }, signal: controller.signal, fetchImpl: async (_url, options) => {
      calls++;
      return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); controller.abort(); });
    } }), { name: 'AbortError' });
    assert.equal(calls, 1);
    await assert.rejects(generateDraft(selected, { request: '问题', metadata: false }, { signal: controller.signal, fetchImpl: async () => assert.fail('停止后不得调用模型') }), { name: 'AbortError' });
    const afterResponse = new AbortController(); let recorded = false;
    await assert.rejects(generateDraft(selected, { request: '问题', metadata: false }, { env: { OPENAI_API_KEY: 'FIXTURE' }, signal: afterResponse.signal, fetchImpl: async () => draftReply(protocol), onEvent: async event => {
      if (event.type === 'response') { recorded = true; afterResponse.abort(); }
    } }), { name: 'AbortError' });
    assert(recorded, '停止前已收到的响应仍须交给用量记录');
  }
});
