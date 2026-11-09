import { openAsBlob } from 'node:fs';
import { readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { backlogConnection, saveJson, replacePrivateJson } from './config.js';
import { get, listCategories, resolveCategory, categorySummary, listProjectUsers, resolveProjectUser } from './backlog.js';
import { validateDraft, withDefaultSchedule } from './draft.js';
import { previewTarget } from './preview.js';
import { selectIssueType } from './templates.js';
import { attachmentImages, inlineImageDescription } from './attachments.js';

const id = value => Number.isSafeInteger(value) && value > 0;
function unique(items, name, label) {
  if (!Array.isArray(items)) throw new Error(`${label}列表无效`);
  const matches = items.filter(item => item?.name === name);
  if (matches.length !== 1 || !id(matches[0].id)) throw new Error(`${label}不存在或名称不唯一：${name}`);
  return matches[0].id;
}

export async function submitDraft(draft, config, { receiptFile, fetchImpl = fetch, env = process.env, signal } = {}) {
  draft = withDefaultSchedule(draft);
  validateDraft(draft);
  const target = previewTarget(draft, config);
  const { apiKey } = backlogConnection(config, env);
  if (!receiptFile) throw new Error('缺少提交记录路径，已停止');
  try {
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    throw new Error(receipt.url ? `该草稿已处理：${receipt.url}` : '该草稿有结果未确认的提交，请先在 Backlog 检查，已阻止重复创建');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of draft.attachments) if (!(await stat(file)).isFile()) throw new Error(`附件不是文件：${file}`);
  const options = { fetchImpl, env, signal };
  const [project, types, priorities, users, categories] = await Promise.all([
    get(config, `projects/${target.project}`, options), get(config, `projects/${target.project}/issueTypes`, options),
    get(config, 'priorities', options), draft.assignee || draft.notifiedUsers?.length ? listProjectUsers(config, options) : [],
    draft.category ? listCategories(config, options) : [],
  ]);
  if (!id(project?.id) || project.projectKey !== target.project) throw new Error('Backlog 项目不匹配，未提交');
  const typeId = unique(types, selectIssueType(types, draft.issueType).name, '工单类型');
  const normal = Array.isArray(priorities) && priorities.filter(item => /^(Normal|中|通常|普通)$/i.test(item?.name));
  if (!normal || normal.length !== 1 || !id(normal[0].id)) throw new Error('无法确定普通优先级，请使用浏览器预览创建');
  const description = inlineImageDescription(draft.description, await attachmentImages(draft.attachments), project.textFormattingRule);
  const summary = categorySummary(draft.summary, draft.category);
  validateDraft({ ...draft, summary });
  const body = new URLSearchParams({ projectId: String(project.id), issueTypeId: String(typeId), priorityId: String(normal[0].id), summary, description });
  if (draft.category) body.append('categoryId[]', String(resolveCategory(categories, draft.category).id));
  if (draft.assignee) body.set('assigneeId', String(resolveProjectUser(users, draft.assignee).id));
  for (const name of new Set(draft.notifiedUsers || [])) body.append('notifiedUserId[]', String(resolveProjectUser(users, name).id));
  for (const field of ['startDate', 'dueDate']) if (draft[field]) body.set(field, draft[field]);
  const post = (pathname, payload) => {
    const url = new URL(`${target.origin}/api/v2/${pathname}`);
    url.searchParams.set('apiKey', apiKey);
    return fetchImpl(url, { method: 'POST', redirect: 'error', body: payload, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
  };
  for (const file of draft.attachments) {
    const form = new FormData();
    form.set('file', await openAsBlob(file), path.basename(file));
    let response, attachment;
    try { response = await post('space/attachment', form); }
    catch { throw new Error('附件上传失败或已取消，尚未提交工单'); }
    if (!response.ok) throw new Error(`附件上传失败（HTTP ${response.status}），尚未提交工单`);
    try { attachment = await response.json(); } catch { /* Validate below. */ }
    if (!id(attachment?.id)) throw new Error('附件上传响应无效，尚未提交工单');
    body.append('attachmentId[]', String(attachment.id));
  }
  const receipt = { state: 'sending', target, summary, at: new Date().toISOString() };
  await saveJson(receiptFile, receipt);
  let response;
  try { response = await post('issues', body); }
  catch { throw new Error('提交连接中断或已取消，创建结果未确认；请先在 Backlog 检查，勿重复创建'); }
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      await rm(receiptFile);
      throw new Error(`Backlog 拒绝创建（HTTP ${response.status}）；请检查必填字段或权限，可修改后重试或改用预览`);
    }
    throw new Error(`提交返回 HTTP ${response.status}，创建结果未确认；请先在 Backlog 检查，勿重复创建`);
  }
  let issue;
  try { issue = await response.json(); } catch { /* A successful POST must never be retried automatically. */ }
  if (!id(issue?.id) || typeof issue.issueKey !== 'string' || !new RegExp(`^${target.project}-[0-9]+$`).test(issue.issueKey)) throw new Error('提交响应无法确认工单编号；请先在 Backlog 检查，勿重复创建');
  const result = { issueKey: issue.issueKey, url: `${target.origin}/view/${issue.issueKey}` };
  try { await replacePrivateJson(receiptFile, { ...receipt, ...result, state: 'created' }, JSON.stringify(receipt, null, 2) + '\n'); }
  catch { result.warning = '已创建，但提交记录更新失败；保留原记录以防重复，请保存工单链接。'; }
  return result;
}
