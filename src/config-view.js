import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { backlogConnection, credentials, httpUrl, modelConnection, projectKey, selectedProjectRepo } from './config.js';
import { validModel, selectedEffort, effortLabels } from './models.js';
import { selectedProjectType, selectedProjectCategory } from './backlog.js';
import { providers } from './setup.js';

const text = value => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');

function address(value, originOnly = false) {
  if (!value) return '未设置';
  try { return httpUrl(value, '地址', { originOnly }); }
  catch { return '无效地址（已隐藏，请重新配置）'; }
}

function keyStatus(config, kind, env) {
  const setting = kind === 'api' ? config.model : config.backlog;
  const saved = config[credentials]?.[kind === 'api' ? setting?.provider : 'backlog'];
  const fallback = kind === 'api' ? 'OPENAI_API_KEY' : 'BACKLOG_API_KEY';
  if (!saved?.key && !env[setting?.apiKeyEnv || fallback]) return '未设置';
  try {
    (kind === 'api' ? modelConnection : backlogConnection)(config, env);
    return saved?.key ? '已设置（本机凭据）' : '已设置（环境变量）';
  } catch { return '已设置，但地址无效或与本机凭据不匹配'; }
}

export async function describeConfig(config, { env = process.env, filename } = {}) {
  const model = config.model || {}, backlog = config.backlog || {};
  const apiAddress = address(model.baseUrl);
  const provider = Object.hasOwn(providers, model.provider) ? providers[model.provider].label
    : Object.values(providers).find(preset => preset.baseUrl && preset.baseUrl === apiAddress)?.label || '自定义／未设置';
  let project = '未设置';
  if (backlog.project) {
    try { project = projectKey(backlog.project); }
    catch { project = '无效（请用 /backlog 重新配置）'; }
  }
  let repo = '未配置（仅根据描述和截图拟稿）', repoStatus = '未启用源码读取';
  const directory = selectedProjectRepo(config);
  if (typeof directory === 'string' && directory) {
    repo = path.resolve(directory);
    try {
      if (!(await stat(repo)).isDirectory()) repoStatus = '不是目录';
      else { await access(repo, constants.R_OK | constants.X_OK); repoStatus = '目录可读取'; }
    } catch { repoStatus = '目录不存在或不可读取'; }
  } else if (directory) repoStatus = '目录配置无效，请用 /repo 重新配置';
  return [
    '当前会话配置（仅检查本地设置，未请求远端服务）',
    ...(filename ? [`配置文件：${text(path.resolve(filename))}`] : []),
    '', 'API', `  服务商：${provider}`, `  地址：${apiAddress}`,
    `  协议：${['responses', 'chat-completions'].includes(model.protocol) ? model.protocol : '未设置或无效'}`,
    `  当前模型：${validModel(model.name) ? model.name : '未选择（使用 /model）'}`,
    `  思考强度：${effortLabels[selectedEffort(model)]}`,
    `  API Key：${keyStatus(config, 'api', env)}`,
    '', 'Backlog', `  站点：${address(backlog.origin, true)}`, `  项目：${project}`,
    `  工单类型：${text(selectedProjectType(backlog) || '未选择（拟稿时默认 Task，使用 /type 修改）')}`,
    `  分类：${text(selectedProjectCategory(backlog) || '未选择（使用 /category 修改）')}`,
    `  API Key：${keyStatus(config, 'backlog', env)}`,
    '', 'Repo', `  目录：${text(repo)}`, `  状态：${repoStatus}`,
    '', '修改配置：/api、/backlog、/repo；切换项目：/project；选择类型：/type；选择分类：/category；切换模型：/model。',
  ].join('\n');
}
