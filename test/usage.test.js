import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { responseUsage, sumUsage, responseThoughts, accountUsage } from '../src/usage.js';
import { startGeneration, savedGeneration, recordedUsage } from '../src/generation.js';
import { exampleConfig } from '../src/config.js';

const config = { ...exampleConfig, model: { ...exampleConfig.model, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'chat-completions', name: 'fixture-model', apiKeyEnv: 'FIXTURE_KEY' } };
const env = { FIXTURE_KEY: 'NEVER_PRINT_PRIVATE_KEY' };
const data = { usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0005, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 15 } } };

test('两种协议统一统计实际token，思考与缓存不重复加总，不推算缺失费用', () => {
  const chat = responseUsage(data, true);
  assert.deepEqual(chat, { inputTokens: 100, outputTokens: 40, totalTokens: 140, costUsd: 0.0005, cachedTokens: 20, reasoningTokens: 15 });
  assert.deepEqual(responseUsage({ usage: { input_tokens: 100, output_tokens: 40, cost: 0.0005, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 15 } } }, true), chat);
  assert.equal(responseUsage(data).costUsd, null);
  assert.equal(sumUsage([chat, {}]).costUsd, 0.0005); assert.equal(sumUsage([chat, {}]).missingCost, 1);
  assert.equal(sumUsage([{}]).costUsd, null); assert.equal(sumUsage([{}]).totalTokens, null);
  assert.equal(sumUsage([responseUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } }, true)]).costUsd, 0);
  assert.equal(sumUsage([]).requests, 0); assert.equal(sumUsage([]).costUsd, 0);
  assert.equal(sumUsage([null, { costUsd: -1, totalTokens: NaN }]).costUsd, null);
});

test('只展示可读服务商思考字段，不暴露签名和加密块，也不修改模型原响应', () => {
  const response = { choices: [{ message: { reasoning: '重复内容', reasoning_details: [{ type: 'reasoning.summary', summary: '摘要', signature: 'SIGNATURE' }, { type: 'reasoning.encrypted', data: 'ENCRYPTED' }] } }] }, before = structuredClone(response);
  assert.equal(responseThoughts(response), '摘要'); assert.deepEqual(response, before);
  assert.equal(responseThoughts({ choices: [{ message: { reasoning: '模型返回的可读思考' } }] }), '模型返回的可读思考');
  assert.equal(responseThoughts({ output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Responses 摘要' }], encrypted_content: 'ENCRYPTED' }] }), 'Responses 摘要');
  assert.equal(responseThoughts({ choices: [{ message: { reasoning_details: 'bad' } }], output: [{ type: 'reasoning', summary: {}, content: {} }] }), '');
});

test('账户只读查询限于OpenRouter，正确区分Key额度和账单，普通OpenAIKey不请求管理接口', async () => {
  const account = await accountUsage(config, { env, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + env.FIXTURE_KEY);
    return { ok: true, json: async () => ({ data: { usage: 12.5, usage_daily: 1, usage_monthly: 5, limit: 10, limit_remaining: -2.5, label: 'PRIVATE_LABEL', hash: 'PRIVATE_HASH' } }) };
  } });
  assert.equal(account.remainingUsd, -2.5); assert.equal(account.usageUsd, 12.5); assert(!JSON.stringify(account).includes('PRIVATE'));
  const unsupported = await accountUsage({ ...exampleConfig, model: { ...exampleConfig.model, name: 'fixture' } }, { env: { OPENAI_API_KEY: 'FIXTURE' }, fetchImpl: () => assert.fail('不请求OpenAI管理接口') });
  assert.equal(unsupported.supported, false);
  await assert.rejects(accountUsage(config, { env, fetchImpl: async () => { throw new Error('PRIVATE_KEY_IN_URL'); } }), error => /读取失败/.test(error.message) && !error.message.includes('PRIVATE_KEY'));
  await assert.rejects(accountUsage(config, { env, fetchImpl: async () => ({ ok: true, json: async () => ({ data: {} }) }) }), /格式无效/);
});

test('逐轮记录包括失败付费请求，重启可恢复，跨版本或分支累计且不重复计算字段编辑', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-usage-')); t.after(() => rm(root, { recursive: true, force: true }));
  const run = await startGeneration(root, 'run1', 'chat1', config, env);
  run.log('只读工具：read_file'); await run.onEvent({ type: 'request', round: 1 });
  assert.equal((await recordedUsage(root, 'chat1', config, env)).conversation.missingCost, 1);
  await run.onEvent({ type: 'response', round: 1, data: { ...data, choices: [{ message: { reasoning: '服务商返回内容' } }] } });
  await run.finish(new Error('模型正文校验失败'));
  const second = await startGeneration(root, 'run2', 'chat1', config, env); await second.onEvent({ type: 'request', round: 1 }); await second.onEvent({ type: 'response', round: 1, data }); await second.finish();
  const restored = await savedGeneration(root, 'run1'); assert.equal(restored.state, 'error'); assert.equal(restored.thoughts[0].text, '服务商返回内容');
  const result = await recordedUsage(root, 'chat1', config, env); assert.equal(result.conversation.costUsd, 0.001); assert.equal(result.conversation.totalTokens, 280); assert.equal(result.conversation.requests, 2);
  assert.equal((await recordedUsage(root, 'chat1', config, { FIXTURE_KEY: 'DIFFERENT_KEY' })).localAccount.requests, 0);
  assert.equal((await recordedUsage(root, 'other-chat', config, env)).conversation.requests, 0);
  const raw = await readFile(path.join(root, 'runs', 'run1.json'), 'utf8'); assert(!raw.includes(env.FIXTURE_KEY));
  assert.equal(await savedGeneration(root, '../config'), null); await assert.rejects(recordedUsage(root, '../config', config, env), /编号无效/);
  await writeFile(path.join(root, 'runs', 'broken.json'), 'broken'); assert.equal((await recordedUsage(root, 'chat1', config, env)).unreadableRuns, 1);
});
