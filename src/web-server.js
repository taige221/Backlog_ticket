import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, rm, unlink, realpath, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveConfigFile, saveJson, modelConnection, backlogConnection, httpUrl, ticketLanguages, rememberLanguage, selectedProjectRepo } from './config.js';
import { configuredProvider, providers, setupSection } from './setup.js';
import { listModelOptions, rememberModel, rememberEffort, validateEffort, selectedEffort, effortLabels } from './models.js';
import { listProjects, listIssueTypes, rememberProject, rememberProjectType, selectedProjectType, listCategories, resolveCategory, selectedProjectCategory, rememberProjectCategory, categorySummary, listProjectUsers, resolveProjectUser } from './backlog.js';
import { generateDraft, readDraft, imageData, validateDraft, defaultSchedule, withDefaultSchedule } from './draft.js';
import { openPreview } from './preview.js';
import { submitDraft } from './submit.js';
import { checkSubmission, linkSubmission } from './reconcile.js';
import { startGeneration, savedGeneration, recordedUsage } from './generation.js';
import { accountUsage } from './usage.js';
import { uploadId, uploadStorage, cleanUploads } from './uploads.js';
import { attachmentImages, inlineImageDescription, inspectScreenshotReview, rewriteImageReferences } from './attachments.js';

const exec = promisify(execFile);
const assetRoot = fileURLToPath(new URL('../web/', import.meta.url));
const modelProviders = Object.entries(providers).map(([id, { label }]) => ({ id, label }));
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
const revisionParentId = value => {
  if (typeof value !== 'string' || !value.endsWith('.json')) return;
  const id = path.win32.basename(value, '.json');
  if (validId(id) && (value === `${id}.json` || (path.win32.isAbsolute(value) && path.win32.basename(path.win32.dirname(value)) === 'drafts'))) return id;
};
const historyReadWarning = '有对话记录无法读取，已保留可用记录。';
const historyCleanupSuffix = '.conversation-cleanup';
const userError = message => Object.assign(new Error(message), { status: 400 });
const conflict = message => Object.assign(userError(message), { status: 409 });
const maxGenerations = 2;
const text = (value, label, limit = 40_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw userError(`${label}不能为空，且不能超过 ${limit} 字符`);
  return value.trim();
};

export async function chooseFolder() {
  try {
    if (process.platform === 'darwin') return (await exec('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择代码目录")'])).stdout.trim();
    if (process.platform === 'win32') {
      const script = 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description="Select code directory"; if($d.ShowDialog() -eq "OK"){[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Write-Output $d.SelectedPath}';
      return (await exec('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])).stdout.trim() || null;
    }
  } catch (error) { if (process.platform === 'darwin' && error.stderr?.includes('-128')) return null; throw userError('无法打开目录选择窗口，请手动输入目录路径'); }
  throw userError('此系统请手动输入代码目录路径');
}

export async function createWebApp({ filename = resolveConfigFile(), fetchImpl = fetch, env = process.env, preview = openPreview, folder = chooseFolder, noTemplate = false } = {}) {
  filename = path.resolve(filename);
  const dataDir = path.dirname(filename), draftDir = path.join(dataDir, 'drafts'), uploadDir = path.join(dataDir, 'uploads');
  const lifecycle = new AbortController();
  const fetchSafe = (url, options = {}) => fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([lifecycle.signal, options.signal]) : lifecycle.signal });
  const deps = { fetchImpl: fetchSafe, env, signal: lifecycle.signal };
  let busy = false, previewSession = null, generation = null, generationStart = Promise.resolve();
  const jobs = new Map();
  const pinnedUploads = () => [...jobs.values()].flatMap(job => job.uploadIds);
  const ensureIdle = rootId => {
    if ([...jobs.values()].some(job => job.rootId.toLowerCase() === rootId.toLowerCase())) {
      throw conflict('这份对话正在生成，请等待完成或停止后再操作');
    }
  };
  const newId = () => `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const config = () => loadConfig(filename, { allowMissing: true });
  const safeUrl = (value, originOnly = false) => { try { return httpUrl(value, '地址', { originOnly }); } catch { return ''; } };
  const snapshot = async () => {
    const c = await config();
    let apiKeyConfigured = false, backlogKeyConfigured = false;
    try { modelConnection(c, env); apiKeyConfigured = true; } catch { /* Configuration is optional at startup. */ }
    try { backlogConnection(c, env); backlogKeyConfigured = true; } catch { /* Never return stored keys. */ }
    const provider = c.model?.provider || apiKeyConfigured ? configuredProvider(c.model) || '' : '';
    return { provider, modelProviders, model: c.model?.name || '', baseUrl: safeUrl(c.model?.baseUrl), protocol: c.model?.protocol, workspaceId: c.model?.workspaceId, reasoningEffort: selectedEffort(c.model), apiKeyConfigured,
      backlogOrigin: safeUrl(c.backlog?.origin, true), project: c.backlog?.project || '', issueType: selectedProjectType(c.backlog) || '', category: selectedProjectCategory(c.backlog) || '', backlogKeyConfigured, repo: selectedProjectRepo(c) || '', language: c.language || 'zh-CN' };
  };
  const draftFile = id => { if (!validId(id)) throw userError('草稿编号无效'); return path.join(draftDir, `${id}.json`); };
  const conversationDir = async rootId => {
    const parent = path.join(dataDir, 'conversations'), directory = path.join(parent, rootId);
    for (const location of [parent, directory]) {
      const entry = await lstat(location).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (entry && !entry.isDirectory()) throw userError('本机对话记录目录无效');
    }
    return directory;
  };
  const handle = async id => {
    const file = draftFile(id), draft = await readDraft(file);
    let rootId = id;
    if (validId(draft.webRootId)) rootId = draft.webRootId;
    else {
      const visited = new Set([id]);
      let parentId = revisionParentId(draft.revisionOf);
      while (parentId) {
        if (visited.has(parentId) || visited.size > 100) throw userError('草稿版本关联无效');
        visited.add(parentId);
        rootId = parentId;
        parentId = revisionParentId((await readDraft(draftFile(parentId))).revisionOf);
      }
    }
    return { id, rootId, filename: file, receiptFile: `${draftFile(rootId)}.submission.json`, draft };
  };
  const mutableDraft = async id => {
    const item = await handle(id);
    ensureIdle(item.rootId);
    return item;
  };
  const draftEntries = () => readdir(draftDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const checkedDrafts = async (entries, { ignoreInvalid = false } = {}) => {
    const drafts = [];
    for (const name of entries.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))) {
      try { drafts.push(await handle(name.slice(0, -5))); }
      catch {
        if (!ignoreInvalid) throw userError('有草稿版本无法检查，已停止删除，请先检查本机草稿记录');
      }
    }
    return drafts;
  };
  const pendingHistoryCleanup = entries => entries.filter(name => name.endsWith(historyCleanupSuffix))
    .map(name => name.slice(0, -historyCleanupSuffix.length)).filter(validId);
  const cleanupMarker = id => path.join(draftDir, id + historyCleanupSuffix);
  const directoryEntry = filename => lstat(filename, { bigint: true }).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const removeConversationHistory = async (rootId, deleted, liveDrafts) => {
    const directory = await conversationDir(rootId);
    const actual = await directoryEntry(directory);
    if (!actual) return { pending: false };
    const rootIds = new Set(liveDrafts.map(item => item.rootId));
    let shared = rootIds.has(rootId);
    if (!shared) {
      // Case variants can name the same directory on macOS and Windows.
      for (const other of rootIds) {
        if (other.toLowerCase() !== rootId.toLowerCase()) continue;
        const alias = await directoryEntry(path.join(path.dirname(directory), other));
        if (alias?.isDirectory() && (!actual.ino || !alias.ino || (alias.dev === actual.dev && alias.ino === actual.ino))) {
          shared = true;
          break;
        }
      }
    }
    if (!shared) {
      await rm(directory, { recursive: true, force: true });
      return { pending: false };
    }
    if (!deleted.size) return { pending: true };

    // In a shared directory, unreadable turns must not block known deletions.
    const live = new Set(liveDrafts.map(item => item.id));
    const pendingFiles = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const id = entry.name.slice(0, -5);
      if (!entry.isFile() || !entry.name.endsWith('.json') || !validId(id) || live.has(id)) continue;
      const file = path.join(directory, entry.name);
      try {
        if (deleted.has(id)) {
          await rm(file, { force: true });
        } else {
          const baseId = JSON.parse(await readFile(file, 'utf8'))?.baseId;
          if (deleted.has(baseId)) await rm(file, { force: true });
          else if (baseId !== null && !validId(baseId)) pendingFiles.push(`${rootId}/${entry.name}`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') pendingFiles.push(`${rootId}/${entry.name}`);
      }
    }
    return { pending: pendingFiles.length > 0, pendingFiles };
  };
  const finishDeletion = async (markerId, liveDrafts) => {
    const marker = cleanupMarker(markerId);
    if (!(await lstat(marker)).isFile()) throw userError('对话清理记录无效');
    const raw = await readFile(marker, 'utf8');
    // Old markers may omit the attachment IDs or only name the root.
    const { rootId, draftIds, attachmentIds = [] } = raw ? JSON.parse(raw) : { rootId: markerId, draftIds: [] };
    if (!validId(rootId) || !Array.isArray(draftIds) || draftIds.some(id => !validId(id))
      || !Array.isArray(attachmentIds) || attachmentIds.some(id => !uploadId(id))) throw userError('对话清理记录无效');
    const result = { historyPending: true, attachmentsPending: attachmentIds.length > 0, freedBytes: 0, removedFiles: 0 };
    const deleted = new Set(draftIds);
    if (liveDrafts.some(item => deleted.has(item.id))) return result;
    try {
      const { pending, pendingFiles } = await removeConversationHistory(rootId, deleted, liveDrafts);
      Object.assign(result, { historyPending: pending, pendingFiles });
    }
    catch { /* Keep this work pending while the history directory is unavailable. */ }
    if (attachmentIds.length) {
      try {
        const { freedBytes, removedFiles } = await cleanUploads(dataDir, { ids: attachmentIds, keepReferenced: true, pinnedIds: pinnedUploads() });
        Object.assign(result, { attachmentsPending: false, freedBytes, removedFiles });
      } catch { /* Retry with the same IDs and recheck references. */ }
    }
    if (!result.historyPending && !result.attachmentsPending) {
      try { await rm(marker, { force: true }); }
      catch { result.historyPending = true; }
    }
    return result;
  };
  const conversationHistory = async (selected, includeUnfinished = false) => {
    let directory, entries, warning;
    try {
      directory = await conversationDir(selected.rootId);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return { messages: [], warning: error.code === 'ENOENT' ? undefined : historyReadWarning };
    }
    const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
    if (!files.length) return { messages: [] };
    const versions = new Map();
    let version = selected;
    while (version.rootId === selected.rootId && !versions.has(version.id)) {
      versions.set(version.id, version.draft);
      const id = revisionParentId(version.draft.revisionOf);
      if (!id) break;
      try { version = await handle(id); }
      catch { warning = historyReadWarning; break; }
    }
    const until = new Map();
    let next = null;
    for (const [id, draft] of versions) {
      until.set(id, next);
      next = draft.createdAt;
    }
    const completed = new Map(), unfinished = new Map();
    for (const file of files.sort()) {
      const id = file.slice(0, -5);
      if (!file.endsWith('.json') || !validId(id) || (!includeUnfinished && !versions.has(id))) continue;
      let saved;
      try { saved = JSON.parse(await readFile(path.join(directory, file), 'utf8')); }
      catch { warning = historyReadWarning; continue; }
      const { request, baseId, createdAt } = saved ?? {};
      if (typeof request !== 'string' || typeof createdAt !== 'string' || (baseId !== null && !validId(baseId))) {
        warning = historyReadWarning; continue;
      }
      const turn = { request, baseId, createdAt };
      const draft = versions.get(id);
      if (draft) {
        completed.set(id, { ...turn, draftId: id, summary: draft.summary });
      } else if (until.has(baseId) && (until.get(baseId) === null || createdAt <= until.get(baseId))) {
        const hasDraft = await lstat(draftFile(id)).then(() => true, error => {
          if (error.code === 'ENOENT') return false;
          warning = historyReadWarning; return true;
        });
        if (!hasDraft) {
          if (!unfinished.has(baseId)) unfinished.set(baseId, []);
          unfinished.get(baseId).push(turn);
        }
      }
    }
    const messages = [];
    for (const id of [...versions.keys()].reverse()) {
      if (completed.has(id)) messages.push(completed.get(id));
      if (unfinished.has(id)) messages.push(...unfinished.get(id));
    }
    return { messages, warning };
  };
  const dto = async (item, { includeScreenshotReview = true } = {}) => {
    let submission = null, submittedSummary;
    try {
      const saved = JSON.parse(await readFile(item.receiptFile, 'utf8'));
      submission = { state: saved.state, issueKey: saved.issueKey };
      submittedSummary = saved.summary;
      if (typeof saved.url === 'string' && /^https?:\/\//.test(saved.url)) submission.url = saved.url;
    } catch (error) { if (error.code !== 'ENOENT') submission = { state: 'unknown' }; }
    const { summary: rawSummary, description, unknowns, target, issueType, category, language, assignee, startDate, dueDate, notifiedUsers = [], createdAt, revisionOf } = withDefaultSchedule(item.draft);
    const normalizedSummary = categorySummary(rawSummary, category);
    const summary = !submission || submittedSummary === normalizedSummary ? normalizedSummary : rawSummary;
    let screenshotReview;
    if (includeScreenshotReview && !submission && item.draft.attachments.length) {
      try {
        const { files, reason } = await inspectScreenshotReview(item.draft.attachments);
        if (files.length) screenshotReview = { reason: reason ?? null };
      } catch {
        screenshotReview = { reason: '无法检查已有附件，请确认文件仍可读取且图片名称唯一。' };
      }
    }
    return { id: item.id, rootId: item.rootId, summary, description, unknowns, target, issueType, category, language, assignee, startDate, dueDate, notifiedUsers, createdAt, generationId: validId(item.draft.generationId) ? item.draft.generationId : undefined, revisionOf: revisionParentId(revisionOf),
      attachments: item.draft.attachments.map(file => ({ name: path.basename(file) })), submission, ...(screenshotReview && { screenshotReview }) };
  };
  const recent = async () => {
    const files = await draftEntries();
    const result = [];
    for (const file of files.filter(file => /^[a-zA-Z0-9_-]+\.json$/.test(file)).sort().reverse().slice(0, 50)) {
      try { result.push(await dto(await handle(file.slice(0, -5)))); } catch { /* Skip unrelated or invalid drafts. */ }
    }
    return result.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  };
  const previewState = () => previewSession ? { id: previewSession.id, state: previewSession.state, prompt: previewSession.prompt, logs: previewSession.logs, error: previewSession.error, issue: previewSession.issue } : null;
  const saveDraft = async (draft, previous, id = newId(), rootId) => {
    draft.webRootId = previous?.rootId || rootId || id;
    if (previous) draft.revisionOf = `${previous.id}.json`;
    await saveJson(draftFile(id), draft);
    return dto(await handle(id));
  };
  const ensureUnsubmitted = async item => {
    if ((await dto(item, { includeScreenshotReview: false })).submission) throw userError('这份草稿已提交或结果未确认，请先核对工单，避免重复创建');
  };
  const readUploads = async ids => {
    if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => !uploadId(id))) throw userError('附件列表无效，最多 10 个新文件');
    if (!ids.length) return new Map();
    const directory = await realpath(uploadDir);
    const uploads = new Map();
    for (const id of new Set(ids)) {
      const record = path.join(directory, `${id}.json`);
      if (!(await lstat(record)).isFile()) throw userError('附件记录无效');
      const upload = JSON.parse(await readFile(record, 'utf8'));
      if (upload.id !== id || typeof upload.file !== 'string' || upload.file !== path.join(id, path.basename(upload.file))) throw userError('附件记录无效');
      const file = path.join(directory, upload.file);
      if (!(await lstat(path.dirname(file))).isDirectory() || !(await lstat(file)).isFile()) throw userError('附件不是普通文件');
      uploads.set(id, { file: await realpath(file), image: upload.image });
    }
    return uploads;
  };
  const editDraft = async (before, edit) => {
    const summary = categorySummary(text(edit.summary, '标题', 255), before.category);
    text(edit.description, '正文');
    const draft = { ...before, summary, description: edit.description };
    const removedReferences = new Map();
    if (edit.files === undefined) return { draft, images: [], removedReferences };

    const files = edit.files;
    if (!Array.isArray(files) || files.length > Math.max(10, before.attachments.length)
      || files.some(file => !file || typeof file !== 'object' || Array.isArray(file))) throw userError('草稿附件列表无效');
    const slots = new Map(), ids = new Set();
    for (const { id, index, replaces } of files) {
      const slot = id === undefined ? index : replaces;
      if (id === undefined ? replaces !== undefined || slot === undefined : index !== undefined || !uploadId(id) || ids.has(id)) throw userError('草稿附件列表无效');
      if (id !== undefined) ids.add(id);
      if (slot === undefined) continue;
      if (!Number.isInteger(slot) || slot < 0 || slot >= before.attachments.length || slots.has(slot)) throw userError('草稿附件位置无效');
      slots.set(slot, id);
    }
    const uploads = await readUploads([...ids]);
    const attachments = files.map(({ id, index }) => id === undefined ? before.attachments[index] : uploads.get(id).file);
    if (new Set(attachments).size !== attachments.length) throw userError('草稿包含重复附件');
    const inlineImages = await attachmentImages(attachments);
    const imageNames = new Set(inlineImages.map(file => path.basename(file)));
    const retainedNames = new Set(files.filter(file => file.id === undefined).map(file => path.basename(before.attachments[file.index])));
    const changes = new Map();
    for (const [index, file] of before.attachments.entries()) {
      const name = path.basename(file);
      if (retainedNames.has(name)) continue;
      const replacement = uploads.get(slots.get(index))?.file;
      if (inlineImages.includes(replacement)) changes.set(name, replacement);
      else if (!imageNames.has(name)) changes.set(name, null);
      if (!imageNames.has(name)) removedReferences.set(name, null);
    }
    const rule = before.textFormattingRule || (/^[ \t]*#image\(/m.test(edit.description) ? 'backlog' : 'markdown');
    draft.description = rewriteImageReferences(draft.description, changes, rule);
    draft.attachments = attachments;
    if (inlineImages.length) draft.textFormattingRule = rule;
    const images = [...uploads.values()].filter(upload => upload.image).map(upload => upload.file);
    return { draft, images, inlineImages, removedReferences };
  };
  const startPreview = async item => {
    if (previewSession?.active) throw userError('已有官网预览，请先关闭当前预览');
    await ensureUnsubmitted(item);
    const c = await config();
    const session = previewSession = { id: item.id, state: 'opening', logs: [], active: true, controller: new AbortController(), acknowledge: null };
    session.done = preview(item.draft, c, {
      ...deps, profileDir: path.join(dataDir, 'browser-profile'), signal: AbortSignal.any([lifecycle.signal, session.controller.signal]),
      log(message) {
        session.logs.push(String(message)); session.logs = session.logs.slice(-30);
        if (message.startsWith('将填入')) session.state = 'filling';
        if (message.startsWith('已填入官网')) session.state = 'ready';
        if (message.startsWith('填写失败')) { session.state = 'error'; session.error = message; }
      },
      ask(prompt, { signal } = {}) {
        session.prompt = prompt;
        if (!prompt.startsWith('按回车关闭')) session.state = 'waiting';
        return new Promise((resolve, reject) => {
          const abort = () => { session.acknowledge = null; reject(Object.assign(new Error('预览已关闭'), { code: 'ABORT_ERR' })); };
          session.acknowledge = () => { signal?.removeEventListener('abort', abort); session.acknowledge = null; resolve(''); };
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
        });
      },
    }).then(async issue => {
      if (issue?.url) { session.issue = issue; await saveJson(item.receiptFile, { state: 'browser-opened', ...issue }); }
      session.state = 'closed';
    }).catch(error => { session.state = 'error'; session.error = error.code === 'ABORT_ERR' ? '预览已关闭' : error.message; })
      .finally(() => { session.active = false; session.acknowledge = null; });
    return { preview: previewState() };
  };
  const route = async (method, route, body = {}) => {
    if (method === 'GET' && route === '/api/state') {
      await generationStart;
      // Take this snapshot before reading drafts so a finishing job is visible in at least one list.
      const generations = [...jobs.values()].map(job => ({ id: job.id, rootId: job.rootId, ...job.resume, stopping: job.controller?.signal.aborted ?? false }));
      return { config: await snapshot(), drafts: await recent(), generations, defaults: defaultSchedule(), languages: ticketLanguages, effortLabels, preview: previewState() };
    }
    if (method === 'GET' && route === '/api/preview') return { preview: previewState() };
    if (method === 'GET' && route === '/api/activity') return { activity: generation?.view() || null };
    if (method === 'GET' && route.startsWith('/api/history/')) {
      return conversationHistory(await handle(route.slice('/api/history/'.length)), true);
    }
    if (method === 'GET' && route.startsWith('/api/drafts/')) {
      const item = await handle(route.slice('/api/drafts/'.length)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      return { draft: item && await dto(item) };
    }
    if (method === 'GET' && route.startsWith('/api/activity/')) {
      const id = route.slice('/api/activity/'.length);
      const job = jobs.get(id);
      return { running: Boolean(job), activity: job?.activity?.view() || await savedGeneration(dataDir, id) };
    }
    if (method === 'GET' && route.startsWith('/api/usage/')) return recordedUsage(dataDir, route.slice('/api/usage/'.length), await config(), env);
    if (method === 'GET' && route === '/api/account') return { account: await accountUsage(await config(), deps) };
    if (method === 'GET' && route === '/api/storage') return { storage: await uploadStorage(dataDir), pendingHistoryCleanup: pendingHistoryCleanup(await draftEntries()).length };
    if (method === 'GET' && route === '/api/models') {
      const options = await listModelOptions(await config(), deps);
      return { models: options.map(model => model.id), options };
    }
    if (method === 'GET' && route === '/api/projects') return { projects: await listProjects(await config(), deps) };
    if (method === 'GET' && route === '/api/types') return { types: await listIssueTypes(await config(), deps) };
    if (method === 'GET' && route === '/api/categories') return { categories: await listCategories(await config(), deps) };
    if (method === 'GET' && route === '/api/users') return { users: await listProjectUsers(await config(), deps) };
    if (method !== 'POST') throw Object.assign(new Error('页面或操作不存在'), { status: 404 });
    if (route === '/api/generation/stop') {
      if (body.id != null && !validId(body.id)) throw userError('生成编号无效');
      if (body.id == null && jobs.size > 1) throw conflict('有多份草稿正在生成，请选择要停止的对话');
      const job = body.id == null ? jobs.values().next().value : jobs.get(body.id);
      job?.controller?.abort();
      return { stopping: Boolean(job?.controller) };
    }
    if (route === '/api/preview/continue') {
      if (previewSession?.state !== 'waiting' || !previewSession.acknowledge) throw userError('官网当前没有等待继续的填写操作');
      previewSession.state = 'filling'; previewSession.acknowledge(); return { preview: previewState() };
    }
    if (route === '/api/preview/close') {
      previewSession?.controller.abort(); await previewSession?.done;
      if (previewSession) previewSession.state = 'closed';
      return { preview: previewState() };
    }
    const generatingDraft = route === '/api/draft' || route === '/api/revise';
    let releaseStart, ownsLock = false, job;
    if (generatingDraft) {
      // Serialize only the setup that reserves a conversation and its attachments.
      const previousStart = generationStart;
      generationStart = new Promise(resolve => { releaseStart = resolve; });
      await previousStart;
    }
    try {
      lifecycle.signal.throwIfAborted();
      if (busy) throw conflict('上一项操作仍在进行，请稍候');
      busy = ownsLock = true;
      if (route === '/api/storage/cleanup') return await cleanUploads(dataDir, { keepIds: body.keepIds ?? [], pinnedIds: pinnedUploads() });
      if (route === '/api/history/cleanup') {
        const entries = await draftEntries(), pending = pendingHistoryCleanup(entries);
        if (!pending.length) return { removed: 0, remaining: 0 };
        const live = await checkedDrafts(entries);
        const pendingFiles = new Set();
        let removed = 0;
        for (const markerId of pending) {
          try {
            const { historyPending, attachmentsPending, pendingFiles: files } = await finishDeletion(markerId, live);
            for (const file of files || []) pendingFiles.add(file);
            if (!historyPending && !attachmentsPending) removed++;
          }
          catch { /* Keep the marker for the next cleanup attempt. */ }
        }
        return { removed, remaining: pending.length - removed, ...(pendingFiles.size && { pendingFiles: [...pendingFiles] }) };
      }
      if (route === '/api/uploads/remove') {
        if (!Array.isArray(body.ids) || body.ids.length > 10) throw userError('附件编号无效');
        const pinned = new Set(pinnedUploads());
        if (body.ids.some(id => typeof id === 'string' && pinned.has(id.toLowerCase()))) throw conflict('附件正在用于生成草稿，请稍后再移除');
        return await cleanUploads(dataDir, { ids: body.ids });
      }
      if (route === '/api/draft/delete') {
        if (previewSession?.active) throw userError('请先关闭官网预览，再删除草稿');
        const selected = await mutableDraft(body.id);
        const candidates = new Map((await checkedDrafts(await draftEntries())).filter(item => item.rootId === selected.rootId).map(item => [item.id, item]));
        let first = selected;
        const ancestors = new Set([first.id]);
        for (let parent; (parent = candidates.get(revisionParentId(first.draft.revisionOf))); first = parent) {
          if (ancestors.has(parent.id)) throw userError('草稿版本关联成环，已停止删除');
          ancestors.add(parent.id);
        }
        const children = new Map();
        for (const item of candidates.values()) {
          const parent = revisionParentId(item.draft.revisionOf);
          if (!parent) continue;
          if (!children.has(parent)) children.set(parent, []);
          children.get(parent).push(item);
        }
        const family = [first];
        for (const item of family) family.push(...(children.get(item.id) || []));
        const physicalUploadDir = await realpath(uploadDir).catch(error => { if (error.code === 'ENOENT') return uploadDir; throw error; });
        const attachmentIds = [...new Set(family.flatMap(item => item.draft.attachments).flatMap(file => [uploadDir, physicalUploadDir].map(directory => path.relative(directory, file).split(path.sep)[0])).filter(uploadId))];
        // Record cleanup before deleting versions so an interrupted deletion can be retried.
        const markerId = newId(), deletedIds = family.map(item => item.id);
        await saveJson(cleanupMarker(markerId), { rootId: selected.rootId, draftIds: deletedIds, attachmentIds });
        // Remove children first so an interrupted deletion leaves usable parents.
        for (const item of family.reverse()) await unlink(item.filename);
        const warnings = [];
        let cleanup = { historyPending: true, attachmentsPending: attachmentIds.length > 0, freedBytes: 0, removedFiles: 0 };
        try { cleanup = await finishDeletion(markerId, await checkedDrafts(await draftEntries())); }
        catch { /* Keep the marker for the next cleanup attempt. */ }
        if (cleanup.historyPending) warnings.push('草稿已删除，但对话记录清理未完成。可在配置工作台重试。');
        if (cleanup.attachmentsPending) warnings.push('草稿已删除，但附件清理未完成。可在配置工作台重试。');
        return { rootId: selected.rootId, deletedIds, freedBytes: cleanup.freedBytes, removedFiles: cleanup.removedFiles, warning: warnings.join(' ') || undefined, ...(cleanup.pendingFiles?.length && { pendingFiles: cleanup.pendingFiles }) };
      }
      if (route === '/api/folder') return { repo: await folder() };
      if (route === '/api/config/language') {
        await rememberLanguage(filename, body.language);
        return { config: await snapshot() };
      }
      if (route === '/api/config/api') {
        const key = text(body.key, 'API Key', 4096);
        await setupSection(filename, 'api', {
          ...deps, askSecret: async () => key, provider: body.provider, workspaceId: body.workspaceId, log() {},
          custom: { baseUrl: body.baseUrl, protocol: body.protocol, name: body.model },
        });
        return { config: await snapshot() };
      }
      if (route === '/api/config/backlog') {
        let projectAnswers = 0;
        await setupSection(filename, 'backlog', { ...deps, askSecret: async () => body.key || '', log() {}, ask: async question => {
          if (question.startsWith('Backlog 站点')) return text(body.origin, 'Backlog 站点', 500);
          if (projectAnswers++) throw userError('请选择可访问的项目');
          return body.project || (question.includes('回车保留') ? '' : '1');
        } });
        return { config: await snapshot(), projects: await listProjects(await config(), deps) };
      }
      if (route === '/api/config/repo') {
        if (typeof body.repo !== 'string' || body.repo.length > 4096) throw userError('代码目录无效');
        const { backlog } = await config();
        if (body.project !== undefined && (body.project !== (backlog?.project || '') || body.origin !== safeUrl(backlog?.origin, true))) {
          throw userError('Backlog 项目已切换，请刷新页面后再保存代码目录');
        }
        await setupSection(filename, 'repo', { ...deps, repoTarget: backlog, ask: async () => body.repo.trim() || '-', log() {} });
        return { config: await snapshot() };
      }
      if (route === '/api/model') { const c = await config(); await rememberModel(filename, c.model, body.model); return { config: await snapshot() }; }
      if (route === '/api/effort') {
        const c = await config();
        if (body.model !== c.model?.name) throw userError('当前模型已改变，请重新选择思考强度');
        await validateEffort(c, body.effort, deps);
        await rememberEffort(filename, c.model, body.effort);
        return { config: await snapshot() };
      }
      if (route === '/api/project') {
        const c = await config(), projects = await listProjects(c, deps);
        if (!projects.some(project => project.key === body.project)) throw userError('项目不在可访问列表中');
        await rememberProject(filename, c.backlog, body.project); return { config: await snapshot() };
      }
      if (route === '/api/type') {
        const c = await config(), types = await listIssueTypes(c, deps);
        if (!types.some(type => type.name === body.type)) throw userError('工单类型不属于当前项目');
        await rememberProjectType(filename, c.backlog, body.type); return { config: await snapshot() };
      }
      if (route === '/api/category') {
        if (typeof body.category !== 'string') throw userError('请选择项目列表中的分类');
        if (previewSession?.active && body.id) throw userError('请先关闭官网预览，再修改草稿分类');
        const c = await config();
        const item = body.id ? await mutableDraft(body.id) : null;
        if (item) {
          await ensureUnsubmitted(item);
          if (item.draft.target?.origin !== c.backlog?.origin || item.draft.target?.project !== c.backlog?.project) throw userError('请先切回草稿对应的 Backlog 站点与项目，再选择分类');
        }
        if (body.category) resolveCategory(await listCategories(c, deps), body.category);
        if (!item) {
          await rememberProjectCategory(filename, c.backlog, body.category);
          return { config: await snapshot() };
        }
        const draft = { ...item.draft, summary: categorySummary(item.draft.summary, body.category, item.draft.category), createdAt: new Date().toISOString() };
        delete draft.category;
        if (body.category) draft.category = body.category;
        validateDraft(draft);
        return { config: await snapshot(), draft: await saveDraft(draft, item) };
      }
      if (route === '/api/upload') {
        const name = path.basename(text(body.name, '附件文件名', 255).replaceAll('\\', '/'));
        if (['.', '..'].includes(name) || /[\x00-\x1f\x7f]/.test(name)) throw userError('附件文件名无效');
        if (typeof body.data !== 'string' || body.data.length > 14_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw userError('附件内容无效或超过 10 MiB');
        const bytes = Buffer.from(body.data, 'base64');
        if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== body.data) throw userError('附件内容无效或超过 10 MiB');
        const id = randomUUID();
        await mkdir(uploadDir, { recursive: true, mode: 0o700 });
        await mkdir(path.join(uploadDir, id), { mode: 0o700 });
        const file = path.join(id, name);
        try {
          await writeFile(path.join(uploadDir, file), bytes, { flag: 'wx', mode: 0o600 });
          if (body.image) await imageData(path.join(uploadDir, file));
          await saveJson(path.join(uploadDir, `${id}.json`), { id, name, file, image: Boolean(body.image) });
        } catch (error) {
          await rm(path.join(uploadDir, id), { recursive: true, force: true });
          await rm(path.join(uploadDir, `${id}.json`), { force: true });
          throw error;
        }
        return { upload: { id, name, image: Boolean(body.image) } };
      }
      if (route === '/api/draft/edit') {
        if (previewSession?.active) throw userError('请先关闭官网预览，再编辑草稿');
        const item = await mutableDraft(body.id); await ensureUnsubmitted(item);
        const { draft, inlineImages } = await editDraft(item.draft, body);
        if (inlineImages?.length) draft.description = inlineImageDescription(draft.description, inlineImages, draft.textFormattingRule);
        text(draft.description, '正文');
        validateDraft(draft);
        if (draft.summary === item.draft.summary && draft.description === item.draft.description
          && draft.attachments.length === item.draft.attachments.length
          && draft.attachments.every((file, index) => file === item.draft.attachments[index])) return { draft: await dto(item) };
        return { draft: await saveDraft({ ...draft, createdAt: new Date().toISOString() }, item) };
      }
      if (route === '/api/fields') {
        if (body.assignee != null && typeof body.assignee !== 'string') throw userError('负责人必须为项目成员姓名，或留空');
        if (previewSession?.active) throw userError('请先关闭官网预览，再修改日期和人员');
        const item = await mutableDraft(body.id); await ensureUnsubmitted(item);
        const c = await config();
        if (item.draft.target?.origin !== c.backlog?.origin || item.draft.target?.project !== c.backlog?.project) throw userError('请先切回草稿对应的 Backlog 站点与项目，再修改日期和人员');
        const draft = withDefaultSchedule({ ...item.draft, startDate: body.startDate, dueDate: body.dueDate, notifiedUsers: body.notifiedUsers ?? [], createdAt: new Date().toISOString() });
        delete draft.assignee;
        if (body.assignee) draft.assignee = body.assignee;
        validateDraft(draft);
        if (draft.assignee || draft.notifiedUsers.length) {
          const users = await listProjectUsers(c, deps);
          for (const name of new Set([draft.assignee, ...draft.notifiedUsers].filter(Boolean))) resolveProjectUser(users, name);
        }
        return { draft: await saveDraft(draft, item) };
      }
      if (generatingDraft) {
        if (jobs.size >= maxGenerations) throw conflict(`最多同时生成 ${maxGenerations} 份草稿，请等待其中一份完成`);
        const controller = new AbortController();
        const signal = AbortSignal.any([lifecycle.signal, controller.signal]);
        const c = await config();
        const previous = route === '/api/revise' ? await mutableDraft(body.id) : null;
        if (previous) await ensureUnsubmitted(previous);
        if (previous && previewSession?.active) throw userError('请先关闭官网预览，再修改草稿');
        let before = previous?.draft;
        let images = [], attachments = [];
        const newUploads = previous ? new Map() : await readUploads(body.uploadIds);
        if (!previous) {
          for (const upload of newUploads.values()) (upload.image ? images : attachments).push(upload.file);
        } else {
          attachments = before.attachments;
        }
        if (before?.target && (before.target.origin !== c.backlog?.origin || before.target.project !== c.backlog?.project)) throw userError('请先切回草稿对应的 Backlog 站点与项目，再修改');
        let attachmentEdit;
        if (previous && body.edit != null) {
          attachmentEdit = await editDraft(before, body.edit);
          ({ draft: before, images } = attachmentEdit);
          if (!images.length || images.length > 5) throw userError('请添加或替换 1 至 5 张 PNG、JPEG 或 WebP 截图');
          attachments = before.attachments;
        }
        const request = text(previous ? body.instruction : body.request, previous ? '修改要求' : '问题描述');
        const reviewScreenshots = !!previous && !attachmentEdit && body.reviewScreenshots === true;
        if (reviewScreenshots) {
          const { files, reason } = await inspectScreenshotReview(attachments);
          if (reason) throw userError(reason);
          if (!files.length) throw userError('草稿中没有可供模型复核的 PNG、JPEG 或 WebP 截图');
          images = files;
        }
        if (body.conversationId != null && !validId(body.conversationId)) throw userError('对话编号无效');
        const id = newId(), rootId = previous?.rootId || body.conversationId || id;
        const generationId = body.generationId ?? id;
        if (!validId(generationId)) throw userError('生成编号无效');
        ensureIdle(rootId);
        if (jobs.has(generationId)) throw conflict('这次生成已开始');
        if (!previous && body.conversationId) {
          const entries = await draftEntries();
          const drafts = await checkedDrafts(entries, { ignoreInvalid: true });
          if (drafts.some(item => item.rootId === rootId) || entries.includes(`${rootId}.json.submission.json`)) {
            throw Object.assign(userError('这次对话已有已保存的草稿或提交记录。请打开原草稿继续操作，或新建对话。'), { status: 409 });
          }
        }
        const turn = { request, baseId: previous?.id || null, createdAt: new Date().toISOString() };
        const { messages: history, warning: readWarning } = previous ? await conversationHistory(previous) : { messages: [] };
        let turnFile, writeWarning;
        const saveTurn = async () => {
          try {
            const file = path.join(await conversationDir(rootId), `${id}.json`);
            await saveJson(file, turn);
            turnFile = file;
          } catch { writeWarning = '本次对话未能保存，请检查本机对话记录目录。'; }
        };
        const originalReport = history.find(turn => turn.baseId === null)?.request.slice(0, 12_000);
        const recentRequests = history.filter(turn => turn.baseId !== null).slice(-4).map(turn => turn.request.slice(0, 2_000));
        const conversation = originalReport || recentRequests.length ? { originalReport, recentRequests } : undefined;
        signal.throwIfAborted();
        let resolveDone;
        const done = new Promise(resolve => { resolveDone = resolve; });
        const uploadIds = previous ? (body.edit?.files || []).map(file => file.id).filter(uploadId) : [...newUploads.keys()];
        const resume = {
          resultId: id, baseId: previous?.id, request,
          uploads: [...newUploads].map(([id, { file, image }]) => ({ id, name: path.basename(file), image })),
          issueFields: previous ? null : { startDate: body.startDate, dueDate: body.dueDate, assignee: body.assignee, notifiedUsers: body.notifiedUsers },
          edit: attachmentEdit ? { summary: body.edit.summary, description: body.edit.description } : undefined,
          editFiles: attachmentEdit ? body.edit.files.map(({ id, index, replaces }, position) => ({ id, index, replaces, name: path.basename(attachments[position]), image: images.includes(attachments[position]) })) : [],
        };
        job = { id: generationId, rootId, controller, uploadIds: uploadIds.map(id => id.toLowerCase()), resume, done, resolveDone };
        jobs.set(generationId, job);
        const active = job.activity = generation = await startGeneration(dataDir, generationId, rootId, c, env);
        busy = ownsLock = false;
        releaseStart();
        releaseStart = null;
        try {
          signal.throwIfAborted();
          if (previous) await saveTurn();
          let templateWarning;
          const generated = await generateDraft(c, { request, previousDraft: before, conversation, language: body.language, repo: attachmentEdit ? '' : undefined,
            reviewScreenshots, noTemplate,
            images, attachments, issueType: before?.issueType, assignee: before ? before.assignee : body.assignee || undefined, startDate: before ? before.startDate : body.startDate, dueDate: before ? before.dueDate : body.dueDate, notifiedUsers: before ? before.notifiedUsers : body.notifiedUsers }, {
            fetchImpl: fetchSafe, env, log: active.log, warn: message => { templateWarning = message; }, onEvent: active.onEvent, signal,
          });
          signal.throwIfAborted();
          let draft = generated;
          if (attachmentEdit) {
            const description = rewriteImageReferences(generated.description, attachmentEdit.removedReferences, before.textFormattingRule);
            text(description, '正文');
            draft = validateDraft({ ...before, description, unknowns: generated.unknowns, createdAt: generated.createdAt });
          }
          job.controller = null;
          draft.generationId = generationId;
          if (!previous) await saveTurn();
          const warning = [readWarning, writeWarning, templateWarning].filter(Boolean).join(' ') || undefined;
          await active.finish(undefined, warning);
          const saved = await saveDraft(draft, previous, id, rootId);
          return { draft: saved, activity: active.view(), warning };
        } catch (error) {
          if (!previous && turnFile) await rm(turnFile, { force: true }).catch(() => {});
          const failure = signal.aborted ? Object.assign(new Error('本次生成已停止，已有草稿保留。'), { name: 'AbortError' }) : error;
          await active.finish(failure); throw failure;
        }
      }
      if (route === '/api/submission/check' || route === '/api/submission/link') {
        if (previewSession?.active) throw userError('请先关闭官网浏览器，再核对创建结果');
        const item = await mutableDraft(body.id), c = await config();
        if (route === '/api/submission/check') return await checkSubmission(item.draft, c, {
          ...deps, receiptFile: item.receiptFile, keyword: body.keyword, key: body.key, offset: body.offset,
        });
        const issue = await linkSubmission(item.draft, c, {
          ...deps, receiptFile: item.receiptFile, key: body.key, expectedSummary: body.expectedSummary, expectedUpdated: body.expectedUpdated,
        });
        return { issue, draft: await dto(item) };
      }
      if (route === '/api/create') {
        if (previewSession?.active) throw userError('请先关闭官网预览，再选择直接创建');
        const item = await mutableDraft(body.id);
        const issue = await submitDraft(item.draft, await config(), { ...deps, receiptFile: item.receiptFile });
        return { issue, draft: await dto(item) };
      }
      if (route === '/api/preview') return await startPreview(await mutableDraft(body.id));
      throw Object.assign(new Error('操作不存在'), { status: 404 });
    } finally {
      if (job) {
        jobs.delete(job.id);
        job.resolveDone();
      }
      if (ownsLock) busy = false;
      releaseStart?.();
    }
  };
  return { dispatch: route, async close() {
    lifecycle.abort();
    previewSession?.controller.abort();
    await Promise.all([previewSession?.done, ...[...jobs.values()].map(job => job.done)]);
  } };
}

export function trustedRequest(request, host, token, api = true) {
  if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!api) return true;
  const supplied = request.headers['x-ticket-token'];
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied), expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startWebServer(options = {}) {
  const app = await createWebApp(options), token = randomBytes(32).toString('hex');
  let host;
  const server = createServer(async (request, response) => {
    const route = request.url?.split('?')[0], api = route?.startsWith('/api/');
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const send = (status, data, type = 'application/json; charset=utf-8') => { response.writeHead(status, { ...headers, 'Content-Type': type }); response.end(type.startsWith('application/json') ? JSON.stringify(data) : data); };
    if (!trustedRequest(request, host, token, api)) return send(403, { error: '此请求未获本机应用授权，请从启动器重新打开网页' });
    try {
      if (!api) {
        const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
        if (request.method !== 'GET' || !assets[route]) return send(404, { error: '页面不存在' });
        return send(200, await readFile(path.join(assetRoot, assets[route][0])), assets[route][1]);
      }
      let body = {};
      if (request.method === 'POST') {
        if (!request.headers['content-type']?.startsWith('application/json')) return send(415, { error: '请使用 JSON 请求' });
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 15 * 1024 * 1024) return send(413, { error: '请求内容过大，每个附件最多 10 MiB' }); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: '请求格式无效' }); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return send(400, { error: '请求格式无效' });
      }
      if (request.method === 'POST' && route === '/api/shutdown') { send(200, { ok: true }); setImmediate(() => { void close(); }); return; }
      send(200, await app.dispatch(request.method, route, body));
    } catch (error) {
      const safe = error.code ? '本地文件或操作无法完成，请检查目录权限和文件是否存在' : error.message;
      send(error.status || 400, { error: safe });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
  host = `127.0.0.1:${server.address().port}`;
  let closing;
  const close = () => closing ||= (async () => { await app.close(); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); })();
  return { server, url: `http://${host}/#token=${token}`, close };
}
