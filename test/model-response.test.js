import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDraft } from '../src/draft.js';
import { exampleConfig } from '../src/config.js';

const draft = { summary: '菜单显示异常', description: '菜单显示不一致，原因待确认。', unknowns: [] };
const selected = protocol => ({ ...exampleConfig, model: { ...exampleConfig.model, protocol, name: 'fixture-model' }, backlog: {} });
const reply = protocol => new Response(JSON.stringify(protocol === 'responses'
  ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(draft) }] }] }
  : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(draft) } }] }), { headers: { 'Content-Type': 'application/json' } });
const waitForAbort = signal => new Promise((_resolve, reject) => {
  if (signal.aborted) reject(new DOMException('PRIVATE', 'AbortError'));
  else signal.addEventListener('abort', () => reject(new DOMException('PRIVATE', 'AbortError')), { once: true });
});
const generate = (protocol, deps) => generateDraft(selected(protocol), { request: '测试', metadata: false }, { env: { OPENAI_API_KEY: 'PRIVATE' }, ...deps });

test('两种协议明确请求非流式 JSON，5分钟截止涵盖响应头与正文；超时仅重试一次相同请求', async t => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal), deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => { deadlines.push(ms); return originalTimeout(5); });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const protocol of ['responses', 'chat-completions']) for (const stage of ['headers', 'body']) {
      const bodies = [], events = [], logs = [];
      const result = await generate(protocol, { onEvent: async event => events.push(event), log: text => logs.push(text), fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); assert.equal(body.stream, false); assert.equal(options.headers.Accept, 'application/json');
        bodies.push(options.body);
        if (bodies.length > 1) return reply(protocol);
        if (stage === 'headers') return waitForAbort(options.signal);
        return { ok: true, json: () => waitForAbort(options.signal) };
      } });
      assert.equal(result.summary, draft.summary); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
      assert(logs.some(text => text.startsWith('连接超时，正在重试')));
      assert.equal(events.filter(event => event.type === 'retry').length, 1);
      assert.deepEqual(events.filter(event => event.type === 'request').map(event => event.round), [1, 2]);
      assert.deepEqual(events.filter(event => event.type === 'response').map(event => event.round), [2]);
    }
    assert.deepEqual(deadlines, Array(8).fill(300_000));
  } finally { clearInterval(keepAlive); }
});

test('连续超时只发送两次，不无限重试，也不把超时报成 JSON 错误', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    let calls = 0;
    await assert.rejects(generate(protocol, { fetchImpl: async () => { calls++; throw new DOMException('PRIVATE', 'TimeoutError'); } }), error => /连接超时.*重试一次.*5 分钟/.test(error.message) && !/JSON|PRIVATE/.test(error.message));
    assert.equal(calls, 2);
  }
});

test('底层网络超时、HTTP 408/504及HTTP 200内嵌超时都有限重试，已返回用量不丢失', async () => {
  for (const protocol of ['responses', 'chat-completions']) for (const failure of ['socket', 'http', 'envelope', 'choice']) {
    let calls = 0; const events = [];
    const result = await generate(protocol, { onEvent: async event => events.push(event), fetchImpl: async () => {
      if (++calls > 1) return reply(protocol);
      if (failure === 'socket') throw new TypeError('PRIVATE', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } });
      if (failure === 'http') return new Response('PRIVATE', { status: 504 });
      const error = { code: 408, message: 'PRIVATE' }, usage = { input_tokens: 10, output_tokens: 5 };
      return new Response(JSON.stringify(failure === 'envelope' ? { error, usage } : { choices: [{ error, finish_reason: 'error' }], usage }));
    } });
    assert.equal(result.summary, draft.summary); assert.equal(calls, 2);
    const responses = events.filter(event => event.type === 'response');
    if (['envelope', 'choice'].includes(failure)) { assert.equal(responses.length, 2); assert.equal(responses[0].data.usage.input_tokens, 10); }
    else assert.equal(responses.length, 1);
  }
});

test('手动停止可中止重试等待；取消不会再发请求或改报超时', async () => {
  for (const protocol of ['responses', 'chat-completions']) for (const when of ['before-retry', 'during-retry']) {
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(generate(protocol, { signal: controller.signal, onEvent: async event => {
      if (when === 'before-retry' && event.type === 'retry') controller.abort();
    }, fetchImpl: async (_url, options) => {
      if (++calls === 1) throw new DOMException('PRIVATE', 'TimeoutError');
      queueMicrotask(() => controller.abort());
      return { ok: true, json: () => waitForAbort(options.signal) };
    } }), { name: 'AbortError' });
    assert.equal(calls, when === 'before-retry' ? 1 : 2);
  }
});

test('HTML、意外事件流、无效JSON、读取中断及无效结构分别报错，不泄露原始响应或自动重试', async () => {
  const cases = [
    [() => new Response('<html>PRIVATE</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }), /网页内容/],
    [() => new Response(': PRIVATE\ndata: {}', { headers: { 'Content-Type': 'text/event-stream' } }), /事件流/],
    [() => new Response('{"PRIVATE":'), /JSON 格式无效或不完整/],
    [() => new Response(''), /JSON 格式无效或不完整/],
    [() => ({ ok: true, json: async () => { throw new TypeError('PRIVATE'); } }), /读取中断/],
    [() => new Response('null'), /应为 JSON 对象/],
    [() => new Response('[]'), /应为 JSON 对象/],
  ];
  for (const protocol of ['responses', 'chat-completions']) for (const [response, expected] of cases) {
    let calls = 0;
    await assert.rejects(generate(protocol, { fetchImpl: async () => { calls++; return response(); } }), error => expected.test(error.message) && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});

test('HTTP 200服务错误与工单JSON格式错误分开处理，保留服务返回用量，不回显服务原文', async () => {
  for (const protocol of ['responses', 'chat-completions']) for (const position of ['top', 'choice']) {
    const error = { code: 429, message: 'PRIVATE', metadata: { raw: 'PRIVATE' } }, events = [];
    const data = { usage: { prompt_tokens: 10, completion_tokens: 2 }, ...(position === 'top' ? { error } : { choices: [{ finish_reason: 'error', error }] }) };
    let calls = 0;
    await assert.rejects(generate(protocol, { onEvent: async event => events.push(event), fetchImpl: async () => { calls++; return new Response(JSON.stringify(data)); } }), value => /429.*限流/.test(value.message) && !value.message.includes('PRIVATE'));
    assert.equal(calls, 1); assert.equal(events.at(-1).data.usage.prompt_tokens, 10);
  }
  await assert.rejects(generate('chat-completions', { fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'PRIVATE' } }] })) }), /模型未返回有效草稿 JSON/);
});
