import { readFile } from 'node:fs/promises';
import { exampleConfig, httpUrl, modelConnection, replacePrivateJson } from './config.js';

export function validModel(value) {
  return typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,200}$/u.test(value);
}

export const effortLabels = { auto: '默认', none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };

export function selectedEffort(model) {
  const settings = model?.reasoningByModel;
  const effort = settings && Object.hasOwn(settings, model.name) ? settings[model.name] : 'auto';
  if (!Object.hasOwn(effortLabels, effort)) throw new Error('思考强度配置无效，请重新选择');
  return effort;
}

export function withEffort(model, effort) {
  if (!validModel(model?.name) || !Object.hasOwn(effortLabels, effort)) throw new Error('思考强度无效');
  const reasoningByModel = { ...model.reasoningByModel, [model.name]: effort };
  if (effort === 'auto') delete reasoningByModel[model.name];
  return { ...model, reasoningByModel };
}

export function reasoningParameters(model) {
  const effort = selectedEffort(model);
  if (effort === 'auto') return {};
  const openrouter = model.provider === 'openrouter' || new URL(model.baseUrl).origin === 'https://openrouter.ai';
  return model.protocol === 'responses' || openrouter ? { reasoning: { effort } } : { reasoning_effort: effort };
}

async function saveModelSetting(filename, model, update) {
  const original = await readFile(filename, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  let saved;
  try {
    saved = original === null ? structuredClone(exampleConfig) : JSON.parse(original);
    if (!saved || Array.isArray(saved) || typeof saved !== 'object' || !saved.model) throw new Error();
  } catch { throw new Error('配置无法解析，未保存模型选择'); }
  if (httpUrl(saved.model.baseUrl, '模型地址') !== httpUrl(model.baseUrl, '模型地址') || saved.model.protocol !== model.protocol
    || (saved.model.apiKeyEnv || 'OPENAI_API_KEY') !== (model.apiKeyEnv || 'OPENAI_API_KEY')) {
    throw new Error('模型服务配置已改变，未保存选择，请重新启动后选择模型');
  }
  await replacePrivateJson(filename, { ...saved, model: update(saved.model) }, original);
}

export async function rememberModel(filename, model, name) {
  if (!validModel(name)) throw new Error('模型 ID 无效，未保存');
  await saveModelSetting(filename, model, saved => ({ ...saved, name }));
}

export async function rememberEffort(filename, model, effort) {
  withEffort(model, effort);
  await saveModelSetting(filename, model, saved => {
    if (saved.name !== model.name) throw new Error('当前模型已改变，请重新选择思考强度');
    return withEffort(saved, effort);
  });
}

function modelEfforts(model, item) {
  const reasoning = item.reasoning;
  if (reasoning && Object.hasOwn(reasoning, 'supported_efforts')) {
    const supported = reasoning.supported_efforts === null ? Object.keys(effortLabels) : reasoning.supported_efforts;
    return Array.isArray(supported) ? Object.keys(effortLabels).filter(level => level !== 'auto' && supported.includes(level) && !(level === 'none' && reasoning.mandatory === true)) : [];
  }
  if (new URL(model.baseUrl).origin !== 'https://api.openai.com') return [];
  // The OpenAI model list omits effort capabilities. Keep fallback profiles to documented aliases.
  const name = item.id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const profiles = {
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6.1-terra': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5': ['minimal', 'low', 'medium', 'high'],
    'gpt-5.1': ['none', 'low', 'medium', 'high'],
    'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-mini': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.2-pro': ['medium', 'high', 'xhigh'],
  };
  return Object.hasOwn(profiles, name) ? profiles[name] : [];
}

export async function listModelOptions(config, { fetchImpl = fetch, env = process.env, signal } = {}) {
  // Listing must work before the first model has been selected.
  const model = modelConnection(config, env);
  let url;
  try { url = new URL(model.modelsPath ?? 'models', `${model.baseUrl}/`); }
  catch { throw new Error('model.modelsPath 不是有效接口路径'); }
  if (url.origin !== new URL(model.baseUrl).origin || url.username || url.password || url.search || url.hash) {
    throw new Error('模型列表路径必须与模型 API 同站点，且不含凭据、查询参数或片段');
  }
  const timeout = AbortSignal.timeout(15_000);
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${model.apiKey}`, Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    if (signal?.aborted) throw Object.assign(new Error('已取消模型列表读取'), { code: 'ABORT_ERR' });
    throw new Error(timeout.aborted ? '模型列表请求超时' : '模型列表请求失败，请检查网络与接口配置');
  }
  if (!response.ok) throw new Error(`模型列表读取失败（HTTP ${response.status}），请检查授权或接口支持情况`);
  let data;
  try { data = await response.json(); }
  catch {
    if (signal?.aborted) throw Object.assign(new Error('已取消模型列表读取'), { code: 'ABORT_ERR' });
    throw new Error('模型列表未返回有效 JSON');
  }
  if (!Array.isArray(data?.data) || data.data.length > 10_000 || data.data.some(item => !validModel(item?.id))) {
    throw new Error('模型列表格式不兼容，需要 data: [{ id: "模型ID" }]');
  }
  if (data.has_more === true) throw new Error('该模型列表需要分页适配，目前不能把这一页当作完整列表');
  return [...new Map(data.data.map(item => [item.id, {
    id: item.id, efforts: modelEfforts(model, item),
    defaultEffort: Object.hasOwn(effortLabels, item.reasoning?.default_effort) ? item.reasoning.default_effort : undefined,
  }])).values()];
}

export async function listModels(config, options) {
  return (await listModelOptions(config, options)).map(model => model.id);
}

export async function validateEffort(config, effort, options) {
  if (typeof effort !== 'string' || !Object.hasOwn(effortLabels, effort)) throw new Error('请选择有效的思考强度');
  if (effort === 'auto') return;
  const models = await listModelOptions(config, options);
  if (!models.find(model => model.id === config.model?.name)?.efforts.includes(effort)) throw new Error('当前模型未提供该思考档位，请重新选择');
}
