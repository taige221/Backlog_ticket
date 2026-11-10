import { createHash } from 'node:crypto';
import { modelConnection } from './config.js';

const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const emptyUsage = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: 0, missingTokens: 0, missingCost: 0 });

export function responseUsage(data, allowCost = false) {
  const u = data?.usage || {}, input = tokens(u.input_tokens ?? u.prompt_tokens), output = tokens(u.output_tokens ?? u.completion_tokens);
  return { inputTokens: input, outputTokens: output, totalTokens: tokens(u.total_tokens) ?? (input != null && output != null ? input + output : null),
    cachedTokens: tokens((u.input_tokens_details ?? u.prompt_tokens_details)?.cached_tokens), reasoningTokens: tokens((u.output_tokens_details ?? u.completion_tokens_details)?.reasoning_tokens), costUsd: allowCost ? amount(u.cost) : null };
}

export function sumUsage(rounds) {
  rounds = rounds.map(round => round && typeof round === 'object' ? round : {});
  const result = emptyUsage(); result.requests = rounds.length;
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens', 'costUsd']) {
    const known = rounds.map(round => field === 'costUsd' ? amount(round[field]) : tokens(round[field])).filter(value => value !== null);
    result[field] = known.length ? known.reduce((sum, value) => sum + value, 0) : rounds.length ? null : 0;
  }
  result.missingTokens = rounds.filter(round => tokens(round.inputTokens) == null || tokens(round.outputTokens) == null).length;
  result.missingCost = rounds.filter(round => amount(round.costUsd) == null).length;
  return result;
}

export function modelAccount(config, env) {
  const model = modelConnection(config, env);
  const openrouter = model.baseUrl === 'https://openrouter.ai/api/v1';
  return { model, openrouter, id: createHash('sha256').update(model.baseUrl + '\0' + model.apiKey).digest('hex') };
}

export async function accountUsage(config, { fetchImpl = fetch, env = process.env, signal } = {}) {
  const { model, openrouter } = modelAccount(config, env);
  if (!openrouter) return { supported: false, provider: model.provider || 'openai', message: '账户账单请在服务商控制台查看。下方显示本机记录的调用用量。' };
  let response;
  try { response = await fetchImpl('https://openrouter.ai/api/v1/key', { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${model.apiKey}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }); }
  catch { throw new Error('账户用量读取失败或超时，请稍后重试'); }
  if (!response.ok) throw new Error(`账户用量读取失败（HTTP ${response.status}）`);
  let data;
  try { data = (await response.json()).data; } catch { throw new Error('账户用量响应格式无效'); }
  if (amount(data?.usage) == null) throw new Error('账户用量响应格式无效');
  return { supported: true, provider: 'openrouter', usageUsd: data.usage, dailyUsd: amount(data.usage_daily), monthlyUsd: amount(data.usage_monthly), limitUsd: amount(data.limit), remainingUsd: typeof data.limit_remaining === 'number' && Number.isFinite(data.limit_remaining) ? data.limit_remaining : null, at: new Date().toISOString() };
}

export function responseThoughts(data) {
  const message = data?.choices?.[0]?.message;
  const details = (Array.isArray(message?.reasoning_details) ? message.reasoning_details : []).filter(item => item && ['reasoning.summary', 'reasoning.text'].includes(item.type)).map(item => item.summary || item.text).filter(value => typeof value === 'string');
  const chat = details.length ? details : [message?.reasoning || message?.reasoning_content].filter(value => typeof value === 'string' && value);
  const responses = (Array.isArray(data?.output) ? data.output : []).filter(item => item?.type === 'reasoning').flatMap(item => [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]).filter(item => item && ['summary_text', 'reasoning_text'].includes(item.type) && typeof item.text === 'string').map(item => item.text);
  return [...chat, ...responses].join('\n\n');
}
