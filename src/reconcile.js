import { readFile } from 'node:fs/promises';
import { get } from './backlog.js';
import { replacePrivateJson } from './config.js';
import { previewTarget } from './preview.js';

const positiveId = value => Number.isSafeInteger(value) && value > 0;

async function pendingSubmission(draft, config, receiptFile) {
  const connection = { ...config, backlog: { ...config.backlog, project: draft.target?.project || config.backlog?.project } };
  const target = previewTarget(draft, connection);
  let original;
  try { original = await readFile(receiptFile, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('这份草稿没有待确认的提交记录，请刷新工作台');
    throw error;
  }
  let receipt;
  try { receipt = JSON.parse(original); } catch { /* A verified issue can repair a damaged receipt. */ }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) receipt = { state: 'unknown' };
  if (receipt.target && (receipt.target.origin !== target.origin || receipt.target.project !== target.project)) throw new Error('提交记录与草稿目标不同，请检查配置和本机记录');
  const keyPattern = new RegExp(`^${target.project}-[1-9][0-9]*$`);
  if (keyPattern.test(receipt.issueKey) && receipt.url === `${target.origin}/view/${receipt.issueKey}`) throw new Error('这份草稿已关联工单，请刷新工作台查看');
  return { connection, target, keyPattern, receipt, original };
}

function issueKey(value, context) {
  if (typeof value !== 'string') throw new Error('请输入工单编号或链接');
  let key = value.trim();
  if (/^https?:\/\//i.test(key)) {
    let url;
    try { url = new URL(key); } catch { throw new Error('工单链接格式无效'); }
    if (url.origin !== context.target.origin || url.username || url.password || url.search || url.hash || !/^\/view\/[^/]+$/.test(url.pathname)) throw new Error('请使用草稿对应站点的工单详情链接');
    key = url.pathname.slice('/view/'.length);
  }
  if (!context.keyPattern.test(key)) throw new Error('工单编号不属于草稿对应的项目');
  return key;
}

async function projectInfo(context, options) {
  const project = await get(context.connection, `projects/${context.target.project}`, options);
  if (!positiveId(project?.id) || project.projectKey !== context.target.project) throw new Error('Backlog 返回的项目不匹配');
  return project;
}

function issueView(issue, context, project) {
  if (!positiveId(issue?.id) || issue.projectId !== project.id || !context.keyPattern.test(issue.issueKey)
    || typeof issue.summary !== 'string' || !issue.summary.trim()) throw new Error('Backlog 返回的工单信息或所属项目无效');
  return {
    issueKey: issue.issueKey, summary: issue.summary, url: `${context.target.origin}/view/${issue.issueKey}`,
    created: typeof issue.created === 'string' ? issue.created : '',
    updated: typeof issue.updated === 'string' ? issue.updated : '',
    createdBy: typeof issue.createdUser?.name === 'string' ? issue.createdUser.name : '',
    status: typeof issue.status?.name === 'string' ? issue.status.name : '',
  };
}

async function issueDetail(key, context, project, options) {
  const issue = await get(context.connection, `issues/${encodeURIComponent(key)}`, options);
  const view = issueView(issue, context, project);
  if (view.issueKey !== key || typeof issue.description !== 'string') throw new Error('Backlog 返回的工单与查询编号不符');
  return { ...view, description: issue.description,
    attachments: Array.isArray(issue.attachments) ? issue.attachments.filter(file => typeof file?.name === 'string').map(file => file.name) : [] };
}

export async function checkSubmission(draft, config, { receiptFile, keyword, key, offset = 0, ...options } = {}) {
  const context = await pendingSubmission(draft, config, receiptFile);
  const project = await projectInfo(context, options);
  const summary = typeof context.receipt.summary === 'string' ? context.receipt.summary : draft.summary;
  if (key !== undefined) return { summary, issue: await issueDetail(issueKey(key, context), context, project, options) };
  const search = keyword === undefined ? summary : keyword;
  if (typeof search !== 'string' || !search.trim() || search.length > 255 || /[\x00-\x1f\x7f]/.test(search)) throw new Error('请输入 1 至 255 字的搜索词');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('搜索分页无效');
  const query = new URLSearchParams({ 'projectId[]': String(project.id), keyword: search.trim(), sort: 'created', order: 'desc', count: '20', offset: String(offset) });
  const issues = await get(context.connection, `issues?${query}`, options);
  if (!Array.isArray(issues) || issues.length > 20) throw new Error('Backlog 工单列表格式无效');
  return { summary, keyword: search.trim(), issues: issues.map(issue => issueView(issue, context, project)), nextOffset: issues.length === 20 ? offset + issues.length : null };
}

export async function linkSubmission(draft, config, { receiptFile, key, expectedSummary, expectedUpdated, ...options } = {}) {
  const context = await pendingSubmission(draft, config, receiptFile);
  const project = await projectInfo(context, options);
  const issue = await issueDetail(issueKey(key, context), context, project, options);
  if (issue.summary !== expectedSummary || issue.updated !== expectedUpdated) throw new Error('工单内容已更新，请重新读取后确认关联');
  try {
    await replacePrivateJson(receiptFile, {
      ...context.receipt, state: 'created', target: context.target,
      summary: typeof context.receipt.summary === 'string' ? context.receipt.summary : draft.summary,
      issueKey: issue.issueKey, url: issue.url, reconciledAt: new Date().toISOString(),
    }, context.original);
  } catch (error) {
    if (error.message.includes('发生变化')) throw new Error('提交记录在核对期间发生变化，请重新读取后确认');
    throw error;
  }
  return { issueKey: issue.issueKey, url: issue.url };
}
