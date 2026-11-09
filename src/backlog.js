import { readFile } from 'node:fs/promises';
import { backlogConnection, httpUrl, projectKey, replacePrivateJson, migrateProjectRepo } from './config.js';
import { cleanSummary } from './templates.js';

export async function get(config, pathname, { fetchImpl = fetch, env = process.env, signal } = {}) {
  const { origin, apiKey } = backlogConnection(config, env);
  const url = new URL(`${origin}/api/v2/${pathname}`);
  url.searchParams.set('apiKey', apiKey);
  const timeout = AbortSignal.timeout(30_000);
  let response;
  try { response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
  catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('已取消 Backlog 读取'), { code: 'ABORT_ERR' });
    const code = error.cause?.code || error.code;
    if (timeout.aborted || error.name === 'TimeoutError' || ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code)) throw new Error('Backlog 请求超时，请检查网络后重试');
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new Error('Backlog 域名解析失败，请检查网络、DNS 与 /backlog 中的站点地址');
    throw new Error('Backlog 连接失败，请检查网络、代理与 /backlog 中的站点地址');
  }
  if (!response.ok) throw new Error(`Backlog 读取失败（HTTP ${response.status}），请检查授权与项目`);
  try { return await response.json(); }
  catch { throw new Error('Backlog 未返回有效 JSON，请核对站点地址'); }
}

export async function listProjects(config, options) {
  const projects = await get(config, 'projects?archived=false', options);
  if (!Array.isArray(projects) || projects.some(project => !project || typeof project.projectKey !== 'string' || typeof project.name !== 'string')) {
    throw new Error('Backlog 项目列表格式无效，未保存配置');
  }
  return projects.map(({ projectKey: key, name }) => ({ key: projectKey(key), name }));
}

async function savedBacklog(filename, backlog) {
  const original = await readFile(filename, 'utf8');
  let saved;
  try {
    saved = JSON.parse(original);
    if (!saved || Array.isArray(saved) || typeof saved !== 'object' || !saved.backlog) throw new Error();
  } catch { throw new Error('配置无法解析，未保存项目选择'); }
  if (httpUrl(saved.backlog.origin, 'Backlog 地址', { originOnly: true }) !== httpUrl(backlog.origin, 'Backlog 地址', { originOnly: true })
    || (saved.backlog.apiKeyEnv || 'BACKLOG_API_KEY') !== (backlog.apiKeyEnv || 'BACKLOG_API_KEY')) {
    throw new Error('Backlog 服务配置已改变，未保存选择，请重新启动后再选择');
  }
  return { original, saved };
}

export async function rememberProject(filename, backlog, selected) {
  projectKey(selected);
  const { original, saved } = await savedBacklog(filename, backlog);
  await replacePrivateJson(filename, { ...migrateProjectRepo(saved), backlog: { ...saved.backlog, project: selected } }, original);
}

export function selectedProjectType(backlog, project = backlog?.project) {
  if (!backlog?.origin || !project) return undefined;
  let origin;
  try { origin = httpUrl(backlog.origin, 'Backlog 地址', { originOnly: true }); } catch { return undefined; }
  const name = backlog.projectTypes?.[origin]?.[project];
  return typeof name === 'string' && name.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(name) ? name : undefined;
}

export function withProjectType(backlog, name, project = backlog?.project) {
  const origin = httpUrl(backlog?.origin, 'Backlog 地址', { originOnly: true });
  projectKey(project);
  if (typeof name !== 'string' || !name.trim() || /[\x00-\x1f\x7f-\x9f]/.test(name)) throw new Error('工单类型名称无效，未保存');
  const settings = backlog.projectTypes ?? {}, selections = settings[origin] ?? {};
  if ([settings, selections].some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('项目类型配置格式无效，未保存');
  return { ...backlog, projectTypes: { ...settings, [origin]: { ...selections, [project]: name } } };
}

export async function rememberProjectType(filename, backlog, name) {
  const { original, saved } = await savedBacklog(filename, backlog);
  await replacePrivateJson(filename, { ...saved, backlog: withProjectType(saved.backlog, name, backlog.project) }, original);
}

export function validCategoryName(name) {
  return typeof name === 'string' && !!name.trim() && name === name.trim() && !/[\x00-\x1f\x7f-\x9f【】]/.test(name);
}

export async function listCategories(config, options) {
  const categories = await get(config, `projects/${projectKey(config.backlog?.project)}/categories`, options);
  if (!Array.isArray(categories) || categories.some(item => !Number.isSafeInteger(item?.id) || item.id <= 0 || !validCategoryName(item.name))) throw new Error('Backlog 分类列表格式无效');
  return categories.map(({ id, name }) => ({ id, name }));
}

export function resolveCategory(categories, name) {
  const matches = categories.filter(item => item.name === name);
  if (matches.length !== 1) throw new Error('分类不属于当前项目或名称不唯一，请重新选择カテゴリー');
  return matches[0];
}

export async function listProjectUsers(config, options) {
  const users = await get(config, `projects/${projectKey(config.backlog?.project)}/users`, options);
  if (!Array.isArray(users) || users.some(user => !Number.isSafeInteger(user?.id) || user.id <= 0 || typeof user.name !== 'string' || !user.name.trim() || /[\x00-\x1f\x7f-\x9f]/.test(user.name))) throw new Error('Backlog 项目成员列表格式无效');
  return users.map(({ id, name }) => ({ id, name }));
}

export function resolveProjectUser(users, name) {
  const matches = users.filter(user => user.name === name);
  if (matches.length !== 1) throw new Error(`项目成员不存在或姓名不唯一：${name}，请重新选择`);
  return matches[0];
}

export function selectedProjectCategory(backlog, project = backlog?.project) {
  const name = selectedProjectType({ ...backlog, projectTypes: backlog?.projectCategories }, project);
  return validCategoryName(name) ? name : undefined;
}

export function withProjectCategory(backlog, name, project = backlog?.project) {
  const origin = httpUrl(backlog?.origin, 'Backlog 地址', { originOnly: true });
  projectKey(project);
  if (name !== '' && !validCategoryName(name)) throw new Error('分类名称无效，未保存');
  const settings = backlog.projectCategories ?? {}, selections = settings[origin] ?? {};
  if ([settings, selections].some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('项目分类配置格式无效，未保存');
  return { ...backlog, projectCategories: { ...settings, [origin]: { ...selections, [project]: name } } };
}

export async function rememberProjectCategory(filename, backlog, name) {
  const { original, saved } = await savedBacklog(filename, backlog);
  await replacePrivateJson(filename, { ...saved, backlog: withProjectCategory(saved.backlog, name, backlog.project) }, original);
}

export function categorySummary(summary, category, previousCategory) {
  summary = cleanSummary(summary);
  if (category || previousCategory) summary = summary.trimStart();
  if (category && !validCategoryName(category)) throw new Error('分类名称无效');
  const names = [category, previousCategory].filter(name => name && validCategoryName(name)).map(name => name.toLowerCase());
  let prefix;
  while ((prefix = /^【([^】]+)】\s*/.exec(summary)) && names.includes(prefix[1].toLowerCase())) {
    summary = summary.slice(prefix[0].length);
  }
  return category ? `【${category}】${summary}` : summary;
}

export async function listIssueTypes(config, options) {
  const project = projectKey(config.backlog?.project);
  const types = await get(config, `projects/${project}/issueTypes`, options);
  if (!Array.isArray(types) || types.some(type =>
    !type || typeof type.name !== 'string' || !type.name.trim() || /[\x00-\x1f\x7f-\x9f]/.test(type.name) ||
    [type.templateSummary, type.templateDescription].some(value => value != null && typeof value !== 'string'))) {
    throw new Error('Backlog 类型模板格式无效');
  }
  return types.map(({ name, templateSummary, templateDescription }) => ({ name, templateSummary: templateSummary || '', templateDescription: templateDescription || '' }));
}

// This adapter deliberately exposes GET only. Preview never calls add-issue.
export async function getProjectMetadata(config, { includeUsers = true, ...options } = {}) {
  const project = projectKey(config.backlog?.project);
  const [info, types, users] = await Promise.all([
    get(config, `projects/${project}`, options),
    listIssueTypes(config, options),
    includeUsers ? get(config, `projects/${project}/users`, options) : [],
  ]);
  if (!info || info.projectKey !== project || !Array.isArray(users) || users.some(user => !user || typeof user.name !== 'string')) {
    throw new Error('Backlog 项目或类型模板格式无效，未生成草稿');
  }
  return {
    project: { key: info.projectKey, name: info.name, textFormattingRule: info.textFormattingRule },
    types,
    users: users.map(({ name }) => ({ name })),
  };
}
