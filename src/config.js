import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Symbols survive object spread but are omitted by JSON.stringify(config).
export const credentials = Symbol('credentials');
export const credentialFile = filename => path.join(path.dirname(path.resolve(filename)), 'credentials.json');

export const exampleConfig = {
  model: { baseUrl: 'https://api.openai.com/v1', protocol: 'responses', name: '', apiKeyEnv: 'OPENAI_API_KEY', modelsPath: 'models', models: [] },
  backlog: { origin: '', project: '', apiKeyEnv: 'BACKLOG_API_KEY' },
  repo: '', language: 'zh-CN',
};

export const ticketLanguages = { 'zh-CN': '简体中文', ja: '日本語', en: 'English' };

export function ticketLanguage(value) {
  if (typeof value !== 'string' || !Object.hasOwn(ticketLanguages, value)) throw new Error('请选择起票语言：简体中文、日文或英文');
  return value;
}

export async function rememberLanguage(filename, language) {
  ticketLanguage(language);
  const original = await readFile(filename, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  await replacePrivateJson(filename, { ...(original ? JSON.parse(original) : exampleConfig), language }, original);
}

export function resolveConfigFile(filename, env = process.env) {
  return path.resolve(filename || env.TICKET_CONFIG || path.join(homedir(), '.config', 'backlog-ticket', 'config.json'));
}

export function httpUrl(value, label, { originOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} 必须是有效 URL`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} 仅允许 HTTPS（本地服务可用 HTTP），不能含凭据、查询参数或片段`);
  }
  if (originOnly && !['', '/'].includes(url.pathname)) throw new Error(`${label} 只能包含站点域名`);
  return originOnly ? url.origin : url.href.replace(/\/$/, '');
}

export function projectKey(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value)) throw new Error('请配置有效的 Backlog 项目 key');
  return value;
}

function repoProject(backlog) {
  if (!backlog?.origin || !backlog.project) return undefined;
  try { return `${httpUrl(backlog.origin, 'Backlog 地址', { originOnly: true })}/${projectKey(backlog.project)}`; }
  catch { return undefined; }
}

export function migrateProjectRepo(config) {
  if (!config.repo || config.projectRepos !== undefined) return config;
  const project = repoProject(config.backlog);
  // Preserve a standalone directory without assigning it to a future Backlog project.
  if (!project) return { ...config, projectRepos: {} };
  const { repo, ...rest } = config;
  return { ...rest, projectRepos: { [project]: repo } };
}

export function selectedProjectRepo(config, target = config.backlog) {
  if (!target?.project) return config.repo;
  const project = repoProject(target);
  return project ? migrateProjectRepo(config).projectRepos?.[project] : undefined;
}

export function withProjectRepo(config, repo, target = config.backlog) {
  config = migrateProjectRepo(config);
  const project = repoProject(target);
  if (target?.project && !project) throw new Error('请先配置有效的 Backlog 站点与项目');
  const saved = config.projectRepos ?? {};
  if (typeof saved !== 'object' || Array.isArray(saved)) throw new Error('项目代码目录配置格式无效，未保存');
  const projectRepos = { ...saved };
  if (!project) return { ...config, repo, projectRepos };
  if (repo) projectRepos[project] = repo;
  else delete projectRepos[project];
  return { ...config, projectRepos };
}

export async function loadConfig(filename, { allowMissing = false } = {}) {
  let value;
  try { value = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return structuredClone(exampleConfig);
    if (error.code === 'ENOENT') throw new Error(`配置不存在：${filename}。先运行 ticket init`);
    throw new Error('配置不是有效 JSON 或无法读取');
  }
  value = migrateProjectRepo(value);
  const base = path.dirname(path.resolve(filename));
  if (value.repo) value.repo = path.resolve(base, value.repo);
  for (const [project, repo] of Object.entries(value.projectRepos ?? {})) {
    if (typeof repo === 'string' && repo) value.projectRepos[project] = path.resolve(base, repo);
  }
  try { value[credentials] = JSON.parse(await readFile(credentialFile(filename), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('本地凭据文件无法读取或不是有效 JSON');
  }
  return value;
}

export async function replacePrivateJson(filename, value, expected) {
  const current = await readFile(filename, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (current !== expected) throw new Error('配置在操作期间发生变化，已停止保存，请重试');
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

// Exclusive writes avoid losing an edited config or an earlier draft.
export async function saveJson(filename, value) {
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
  try { await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`文件已存在，未覆盖：${filename}`);
    throw error;
  }
}

export function modelConnection(config, env = process.env) {
  const model = config.model ?? {};
  const stored = config[credentials]?.[model.provider];
  const apiKey = stored?.key || env[model.apiKeyEnv || 'OPENAI_API_KEY'];
  if (!apiKey) throw new Error(`请运行 ticket init 输入 API Key，或设置环境变量 ${model.apiKeyEnv || 'OPENAI_API_KEY'}`);
  const baseUrl = httpUrl(model.baseUrl, '模型地址');
  if (stored?.key && stored.baseUrl !== baseUrl) throw new Error('已保存的密钥不能用于其他 API 地址，请运行 ticket init 重新配置');
  return { ...model, baseUrl, apiKey };
}

export function modelConfig(config, env = process.env) {
  const model = config.model ?? {};
  if (typeof model.name !== 'string' || !model.name.trim()) throw new Error('请设置 model.name');
  if (!['responses', 'chat-completions'].includes(model.protocol)) throw new Error('model.protocol 应为 responses 或 chat-completions');
  return modelConnection(config, env);
}

export function backlogConnection(config, env = process.env) {
  const backlog = config.backlog ?? {};
  const origin = httpUrl(backlog.origin, 'Backlog 地址', { originOnly: true });
  const stored = config[credentials]?.backlog;
  if (stored?.key && stored.origin !== origin) throw new Error('已保存的 Backlog 密钥不能用于其他站点，请运行 ticket init 重新配置');
  const apiKey = stored?.key || env[backlog.apiKeyEnv || 'BACKLOG_API_KEY'];
  if (!apiKey) throw new Error(`请运行 ticket init 输入 Backlog API Key，或设置环境变量 ${backlog.apiKeyEnv || 'BACKLOG_API_KEY'}`);
  return { ...backlog, origin, apiKey };
}
