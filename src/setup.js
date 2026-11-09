import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { credentials, credentialFile, exampleConfig, replacePrivateJson, loadConfig, modelConnection, httpUrl, migrateProjectRepo, selectedProjectRepo, withProjectRepo } from './config.js';
import { listModels } from './models.js';
import { listProjects } from './backlog.js';

export const providers = {
  openai: { baseUrl: 'https://api.openai.com/v1', protocol: 'responses', apiKeyEnv: 'OPENAI_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', protocol: 'chat-completions', apiKeyEnv: 'OPENROUTER_API_KEY' },
};

// Prefixes are routing hints, not proof that a credential is valid.
export function detectProvider(key) {
  if (key.startsWith('sk-or-v1-')) return 'openrouter';
  if (/^sk-(proj-|svcacct-)/.test(key)) return 'openai';
  return null;
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('无法读取现有配置或凭据文件'); }
}

function parse(text) {
  try { const value = JSON.parse(text); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new Error('现有配置或凭据文件不是有效 JSON，未覆盖'); }
}

function validateKey(key) {
  if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error('API Key 含空白或不支持的字符，未保存');
}

async function setup(filename, { ask, askSecret, log = console.log, fetchImpl = fetch, signal, env = process.env, scope = 'api', repoTarget } = {}) {
  if (!['all', 'api', 'backlog', 'repo'].includes(scope)) throw new Error('配置项应为 api、backlog 或 repo');
  const complete = scope === 'all';
  filename = path.resolve(filename);
  const original = await readOptional(filename);
  const config = original === null ? structuredClone(exampleConfig) : parse(original);
  const authPath = credentialFile(filename);
  if (authPath === filename) throw new Error('配置文件不能命名为 credentials.json');
  const oldAuth = await readOptional(authPath);
  const auth = oldAuth === null ? {} : parse(oldAuth);
  let next = { ...(scope === 'api' ? config : migrateProjectRepo(config)), [credentials]: auth };
  if (complete || scope === 'api') {
    const key = (await askSecret(`请输入 OpenAI 或 OpenRouter API Key（隐藏输入，${complete ? '回车保留已有配置' : '回车取消'}）：`))?.trim();
    if (key) {
      validateKey(key);
      let provider = detectProvider(key);
      if (!provider) {
        const answer = (await ask('无法仅凭密钥判断服务商。选择 1 OpenAI / 2 OpenRouter（回车取消）：'))?.trim().toLowerCase();
        provider = { '1': 'openai', '2': 'openrouter', openai: 'openai', openrouter: 'openrouter' }[answer];
        if (!provider) throw new Error('已取消配置，原设置未更改');
      }
      log(`已选择 ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'}，正在做只读鉴权检查…`);
      const preset = providers[provider];
      const sameProvider = config.model?.baseUrl === preset.baseUrl && config.model?.protocol === preset.protocol;
      next.model = { ...preset, provider, modelsPath: 'models', models: [], name: sameProvider ? config.model?.name || '' : '' };
      if (sameProvider && config.model?.reasoningByModel) next.model.reasoningByModel = config.model.reasoningByModel;
      next[credentials] = { ...auth, [provider]: { baseUrl: preset.baseUrl, key } };
    } else if (!complete) {
      throw new Error('已取消配置，原设置未更改');
    }
    const connection = modelConnection(next, env);
    // OpenRouter's public model catalog alone does not validate the supplied key.
    if (connection.baseUrl === providers.openrouter.baseUrl) {
      let response;
      try { response = await fetchImpl(`${connection.baseUrl}/key`, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${connection.apiKey}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }); }
      catch { throw new Error('OpenRouter 鉴权检查失败或已取消，未保存密钥'); }
      if (!response.ok) throw new Error(`OpenRouter 鉴权检查失败（HTTP ${response.status}），未保存密钥`);
      let data;
      try { data = await response.json(); } catch { throw new Error('OpenRouter 鉴权响应无效，未保存密钥'); }
      if (!data?.data || typeof data.data !== 'object' || Array.isArray(data.data)) throw new Error('OpenRouter 鉴权响应无效，未保存密钥');
    } else {
      await listModels(next, { fetchImpl, env, signal });
    }
  }

  if (complete || scope === 'backlog') {
    const currentOrigin = config.backlog?.origin || '';
    const origin = httpUrl((await ask(`Backlog 站点地址（例如 https://你的空间.backlog.com）${currentOrigin ? ` [${currentOrigin}]，回车保留` : ''}：`))?.trim() || currentOrigin, 'Backlog 地址', { originOnly: true });
    const backlogKey = (await askSecret('Backlog API Key（隐藏输入，回车保留已有密钥）：'))?.trim();
    next.backlog = { ...config.backlog, origin, apiKeyEnv: config.backlog?.apiKeyEnv || 'BACKLOG_API_KEY' };
    if (backlogKey) {
      validateKey(backlogKey);
      next[credentials] = { ...next[credentials], backlog: { origin, key: backlogKey } };
    }
    log('正在只读验证 Backlog 并读取可访问项目…');
    const projects = await listProjects(next, { fetchImpl, env, signal });
    if (!projects.length) throw new Error('Backlog 没有可访问的未归档项目，未保存配置');
    if (projects.length === 1) {
      next.backlog.project = projects[0].key;
      log(`已选择唯一项目：${projects[0].key}`);
    } else {
      projects.forEach((project, index) => log(`${index + 1}. ${project.key} — ${project.name.replace(/[\x00-\x1f\x7f-\x9f]/g, '')}`));
      const current = projects.find(project => project.key === config.backlog?.project)?.key;
      for (;;) {
        const answer = (await ask(`选择默认项目（输入序号或项目 KEY${current ? `，回车保留 ${current}` : ''}）：`))?.trim();
        if (answer == null) throw new Error('已取消配置，原设置未更改');
        const selected = projects.find(project => project.key === (answer || current)) || (/^[1-9]\d*$/.test(answer) ? projects[Number(answer) - 1] : undefined);
        if (selected) { next.backlog.project = selected.key; break; }
        log('请选择列表中的项目。');
      }
    }
  }
  if (complete || scope === 'repo') {
    const target = repoTarget ?? next.backlog;
    const saved = selectedProjectRepo(next, target);
    const currentRepo = saved ? path.resolve(path.dirname(filename), saved) : '';
    const directory = (await ask(`代码目录${target?.project ? `（项目 ${target.project}）` : ''}（可选，${currentRepo ? `回车保留 ${currentRepo}，输入 - 清除` : '回车跳过'}；相关源码会发给模型）：`))?.trim();
    if (directory == null) throw new Error('已取消配置，原设置未更改');
    let repo = directory === '-' ? '' : directory || currentRepo;
    if (repo) {
      const unquoted = repo.replace(/^(["'])(.*)\1$/, '$2');
      const expanded = unquoted.startsWith('~/') ? path.join(homedir(), unquoted.slice(2)) : unquoted;
      try {
        repo = await realpath(path.resolve(expanded));
        if (!(await stat(repo)).isDirectory()) throw new Error();
        await access(repo, constants.R_OK | constants.X_OK);
      } catch { throw new Error('代码目录不存在、不是目录或不可读取，未保存配置'); }
    }
    next = withProjectRepo(next, repo, target);
  }
  signal?.throwIfAborted();
  if (scope !== 'repo') await replacePrivateJson(authPath, next[credentials], oldAuth);
  try { await replacePrivateJson(filename, next, original); }
  catch (error) {
    if (scope !== 'repo') {
      try { await replacePrivateJson(authPath, auth, JSON.stringify(next[credentials], null, 2) + '\n'); }
      catch { throw new Error('配置保存失败，且凭据已被其他操作更改，未强制回滚；请重新检查配置'); }
    }
    throw error;
  }
  const label = { all: '模型 API、Backlog 和代码目录配置', api: '模型服务配置', backlog: 'Backlog 配置', repo: '代码目录配置' }[scope];
  log(`${label}已保存。${scope === 'repo' ? '' : '密钥仅写入本机 credentials.json（权限0600），输入不会回显。'}${complete || scope === 'api' ? '使用 /model 选择模型。' : ''}`);
  return loadConfig(filename);
}

export const setupModel = (filename, options) => setup(filename, options);
export const setupConfig = (filename, options) => setup(filename, { ...options, scope: 'all' });
export const setupSection = (filename, scope, options) => setup(filename, { ...options, scope });
