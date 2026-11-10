import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { credentials, credentialFile, exampleConfig, replacePrivateJson, loadConfig, modelConnection, httpUrl, migrateProjectRepo, selectedProjectRepo, withProjectRepo } from './config.js';
import { listModels, validModel } from './models.js';
import { listProjects } from './backlog.js';

export const providers = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'responses', apiKeyEnv: 'OPENAI_API_KEY' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'chat-completions', apiKeyEnv: 'OPENROUTER_API_KEY' },
  anthropic: { label: 'Claude（Anthropic）', baseUrl: 'https://api.anthropic.com/v1', protocol: 'chat-completions', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  kimi: { label: 'Kimi（月之暗面国内站）', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'chat-completions', apiKeyEnv: 'MOONSHOT_API_KEY' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'chat-completions', apiKeyEnv: 'GEMINI_API_KEY' },
  qwen: { label: '阿里云百炼（北京）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'chat-completions', apiKeyEnv: 'DASHSCOPE_API_KEY', defaultModel: 'qwen-plus' },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'chat-completions', apiKeyEnv: 'ZHIPU_API_KEY', defaultModel: 'glm-5.3' },
  siliconflow: { label: '硅基流动（国内站）', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'chat-completions', apiKeyEnv: 'SILICONFLOW_API_KEY' },
  ark: { label: '火山方舟（按量计费）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'chat-completions', apiKeyEnv: 'ARK_API_KEY' },
  custom: { label: '自定义 API' },
};

export function configuredProvider(model) {
  if (!model?.baseUrl) return undefined;
  if (model.provider === 'custom') return 'custom';
  let baseUrl;
  try { baseUrl = httpUrl(model.baseUrl, '模型 API 地址'); } catch { return undefined; }
  return Object.keys(providers).find(id => providers[id].baseUrl === baseUrl) || 'custom';
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

async function promptCustomModel(ask, current) {
  const answer = async question => {
    const value = await ask(question);
    if (value == null) throw new Error('已取消配置，原设置未更改');
    return value.trim();
  };
  const baseUrl = httpUrl(await answer(`模型 API 地址（例如 https://gateway.example.com/v1${current?.baseUrl ? '，回车保留现有地址' : ''}）：`) || current?.baseUrl, '模型 API 地址');
  const sameAddress = current?.baseUrl === baseUrl;
  const defaultProtocol = sameAddress ? current.protocol : 'chat-completions';
  const protocol = await answer(`接口协议 chat-completions / responses [${defaultProtocol}]：`) || defaultProtocol;
  const previousName = sameAddress && current.protocol === protocol ? current.name : '';
  const name = await answer(`模型 ID（${previousName ? `回车保留 ${previousName}` : '可留空，从模型列表选择'}）：`) || previousName;
  return { baseUrl, protocol, name };
}

async function setup(filename, { ask, askSecret, log = console.log, fetchImpl = fetch, signal, env = process.env, scope = 'api', repoTarget, provider: requestedProvider, custom, workspaceId } = {}) {
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
    const current = config.model;
    const currentProvider = original === null ? undefined : configuredProvider(current);
    let provider = requestedProvider;
    if (provider === undefined && ask) {
      const choices = Object.entries(providers);
      const menu = choices.map(([id, { label }], i) => `${i + 1}. ${label} (${id})`).join('\n');
      const hint = currentProvider ? `回车选择 ${providers[currentProvider].label}` : '回车取消';
      const answer = (await ask(`请选择服务商（${hint}）：\n${menu}\n输入编号或名称：`))?.trim().toLowerCase();
      if (answer == null || (!answer && !currentProvider)) throw new Error('已取消配置，原设置未更改');
      provider = answer ? choices[Number(answer) - 1]?.[0] ?? answer : currentProvider;
    }
    if (typeof provider !== 'string' || !Object.hasOwn(providers, provider)) throw new Error('请选择 API 服务商');
    const selectedPreset = providers[provider];
    const canKeepKey = complete && provider === currentProvider;
    const presetKeyEnv = selectedPreset.apiKeyEnv;
    const canUseEnv = complete && !canKeepKey && presetKeyEnv && env[presetKeyEnv] && !auth[provider]?.key;
    const onEnter = canKeepKey ? '回车保留已有配置' : canUseEnv ? `回车使用环境变量 ${presetKeyEnv}` : '回车取消';
    const key = (await askSecret(`请输入 ${selectedPreset.label} API Key（隐藏输入，${onEnter}）：`))?.trim();
    if (key == null || (!key && !canKeepKey && !canUseEnv)) throw new Error('已取消配置，原设置未更改');
    if (key || canUseEnv) {
      if (key) validateKey(key);
      let { label, baseUrl, protocol, apiKeyEnv, defaultModel } = selectedPreset;
      let name;
      if (provider === 'custom') {
        const settings = custom ?? await promptCustomModel(ask, currentProvider === 'custom' ? current : undefined);
        if (typeof settings.baseUrl !== 'string' || settings.baseUrl.length > 2048) throw new Error('请输入有效的模型 API 地址');
        baseUrl = httpUrl(settings.baseUrl, '模型 API 地址');
        protocol = settings.protocol ?? 'chat-completions';
        if (!['responses', 'chat-completions'].includes(protocol)) throw new Error('请选择有效的模型 API 协议');
        name = settings.name ?? '';
        if (name !== '' && !validModel(name)) throw new Error('模型 ID 无效，未保存');
        apiKeyEnv = 'MODEL_API_KEY';
      }
      const sameEndpoint = current?.baseUrl === baseUrl && current?.protocol === protocol;
      const previousName = sameEndpoint ? current.name : '';
      next.model = { baseUrl, protocol, apiKeyEnv, provider, modelsPath: 'models', models: [], name: name ?? (previousName || defaultModel || '') };
      if (provider === 'anthropic') {
        const savedWorkspace = sameEndpoint ? current.workspaceId : '';
        const value = workspaceId ?? (ask ? (await ask(`Claude Workspace ID（${savedWorkspace ? '回车保留，输入 - 清除' : '非工作区专用 Key 需要，可留空'}）：`))?.trim() : '');
        if (value == null) throw new Error('已取消配置，原设置未更改');
        const workspace = workspaceId === undefined && value === '' ? savedWorkspace : value;
        if (workspace && workspace !== '-') {
          if (typeof workspace !== 'string' || !/^wrkspc_[a-z0-9]{1,120}$/i.test(workspace)) throw new Error('Claude Workspace ID 无效，未保存');
          next.model.workspaceId = workspace;
        }
      }
      if (sameEndpoint && current.reasoningByModel) next.model.reasoningByModel = current.reasoningByModel;
      if (key) next[credentials] = { ...auth, [provider]: { baseUrl, key } };
      log(`已选择 ${label}。`);
    }
    const connection = modelConnection(next, env);
    const preset = Object.hasOwn(providers, connection.provider) ? providers[connection.provider] : undefined;
    if ((connection.provider === 'custom' && connection.name) || preset?.defaultModel) {
      log('将在首次生成草稿时验证 API 密钥和模型。');
    } else if (connection.baseUrl === providers.openrouter.baseUrl) {
      // OpenRouter's public model catalog alone does not validate the supplied key.
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
