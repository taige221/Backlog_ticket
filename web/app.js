'use strict';

const $ = id => document.getElementById(id);
const sessionKey = 'ticket-local-token';
const hash = new URLSearchParams(location.hash.slice(1));
const providedToken = hash.get('token');
let token = providedToken || sessionStorage.getItem(sessionKey);
if (providedToken) {
  sessionStorage.setItem(sessionKey, providedToken);
  history.replaceState(null, '', location.pathname + location.search);
}

let config = {};
let drafts = [];
let current = null;
let uploads = [];
let busy = false;
let stopped = false;
let preview = null;
let previewTimer = null;
let polling = false;
let activeMenu = null;
let dateDefaults = {};
let issueFields = null;
let languages = {};
let effortLevels = { auto: '默认' };
let conversationId = crypto.randomUUID();
let draftListVersion = 0;
const generationTasks = new Map();
const draftWarnings = new Map();
let languageChoice = 0;
let accountLoading = false;
let accountVersion = 0;
let editing = false;
let editFiles = [];
let replaceFileIndex;
let checkedIssue = null;
let checkedKeyword = '';
let nextCheckOffset = null;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function notify(message, error = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('error', error);
}

function pendingHistoryText(files) {
  return files?.length ? ` 待处理的对话文件位于 conversations 目录下（${files.join('、')}）。` : '';
}

async function api(path, body) {
  if (!token || stopped) throw new Error('请双击启动程序，重新打开工作台。');
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Ticket-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('工作台连接中断，请确认启动程序仍在运行。'); }
  if (!response.ok) throw Object.assign(new Error(result.error || '操作未完成，请检查配置后重试。'), { status: response.status });
  return result;
}

function locked() { return !!current?.submission; }
function previewActive() { return preview && !['closed'].includes(preview.state); }
function activeGeneration() {
  const task = generationTasks.get(conversationId);
  return task?.running ? task : null;
}

function updateControls() {
  const task = activeGeneration();
  document.querySelectorAll('[data-mutation]').forEach(button => { button.disabled = busy || stopped || !token || editing; });
  document.querySelectorAll('[data-edit-control]').forEach(control => { control.disabled = busy || stopped || !token; });
  $('send').disabled ||= locked();
  $('send').hidden = !!task;
  $('stop-generation').hidden = !task;
  $('stop-generation').disabled = !task || task.stopping || stopped;
  $('stop-generation').textContent = task?.stopping ? '正在停止…' : '停止生成';
  $('request').disabled = busy || stopped || !token || locked() || editing || !!task;
  $('files').disabled = busy || stopped || !token || !!current || !!task;
  $('attach-label').hidden = !!current;
  $('attach-label').setAttribute('aria-disabled', String($('files').disabled));
  $('open-preview').disabled ||= locked() || !!previewActive() || !!task;
  $('create').disabled ||= locked() || !!previewActive() || !!task;
  $('create-confirm').disabled ||= locked() || !!task;
  $('edit-draft').disabled ||= !current || locked() || !!previewActive() || !!task;
  $('check-submission').disabled ||= !!previewActive();
  $('submission-link').disabled ||= !checkedIssue;
  $('category-picker').disabled ||= !!task || !!current && (locked() || !!previewActive());
  $('category-picker').replaceChildren(document.createTextNode((current ? current.category : config.category) || '分类（可选）'), el('span', '⌄'));
  for (const id of ['start-date', 'due-date', 'assignee-picker', 'notify-picker']) $(id).disabled ||= !!task || !!current && (locked() || !!previewActive());
  $('language').disabled ||= locked() || !!previewActive() || !!task;
  $('preview-continue').disabled ||= preview?.state !== 'waiting';
  $('preview-close').disabled = busy || stopped;
  document.querySelectorAll('[data-draft-delete]').forEach(button => {
    button.disabled ||= !!previewActive() || !!generationTasks.get(button.dataset.draftDelete || current?.rootId)?.running;
  });
  $('upload-list').querySelectorAll('button').forEach(button => { button.disabled ||= !!task; });
  $('shutdown').disabled = busy || stopped || editing;
  $('send').firstChild.textContent = current ? '更新草稿 ' : '整理草稿 ';
  $('composer-mode').textContent = locked() ? '这份草稿已提交或状态待确认，请新建对话' : current ? '修改这份草稿 · 内容会保存为新版本' : '描述一个需要处理的问题';
  $('request').placeholder = current ? '直接输入修改要求，例如：补充手机端的验收条件…' : '例如：手机上查看书类配付详情时，按钮被挤到了画面外…';
  $('composer-hint').textContent = current ? '修改会保留原有附件和目标项目' : '可拖入文件，或粘贴截图';
}

async function run(action, settingsError = false, allowEditing = false) {
  if (busy || stopped) return;
  if (editing && !allowEditing) { notify('请先保存修改或取消编辑。'); return; }
  busy = true;
  updateControls();
  notify('');
  $('settings-error').hidden = true;
  try { await action(); }
  catch (error) {
    if (settingsError) {
      $('settings-error').textContent = error.message;
      $('settings-error').hidden = false;
    } else notify(error.message, true);
  } finally {
    busy = false;
    updateControls();
  }
}

function renderConfig() {
  $('project-picker').replaceChildren(document.createTextNode(config.project || '选择项目'), el('span', '⌄'));
  $('type-picker').replaceChildren(document.createTextNode(config.issueType || '工单类型'), el('span', '⌄'));
  $('model-name').textContent = config.model || '配置模型';
  $('model-effort').textContent = effortLevels[config.reasoningEffort] || '';
  $('model-effort').hidden = !config.model || !config.reasoningEffort || config.reasoningEffort === 'auto';
  $('model-picker').title = config.model ? `${config.model} · 思考强度 ${effortLevels[config.reasoningEffort] || '默认'}` : '配置模型';
  $('api-status').textContent = config.apiKeyConfigured ? `${config.provider === 'openrouter' ? 'OpenRouter' : config.provider === 'openai' ? 'OpenAI' : '已配置'} · 密钥已保存` : '尚未配置';
  $('backlog-status').textContent = config.backlogKeyConfigured ? '密钥已保存' : '尚未配置';
  $('provider').value = ['openai', 'openrouter'].includes(config.provider) ? config.provider : 'auto';
  $('backlog-origin').value = config.backlogOrigin || '';
  $('repo-label').textContent = config.project ? `${config.project} 的本机代码目录` : '本机代码目录（未选项目）';
  $('repo').value = config.repo || '';
}

function renderRecents() {
  $('draft-count').textContent = String(drafts.length);
  const list = $('draft-list');
  list.replaceChildren();
  for (const task of generationTasks.values()) {
    const button = el('button', undefined, `recent-draft${conversationId === task.rootId ? ' active' : ''}`);
    button.type = 'button'; button.dataset.mutation = '';
    button.setAttribute('aria-pressed', String(conversationId === task.rootId));
    button.append(el('strong', task.draft?.summary || task.request.slice(0, 80)), el('small', task.running ? '生成中' : '生成未完成'));
    button.addEventListener('click', () => openGeneration(task));
    list.append(button);
  }
  if (!drafts.length && !generationTasks.size) list.append(el('p', '还没有草稿。先描述一个问题吧。', 'no-drafts'));
  [...drafts].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).forEach(draft => {
    const row = el('div', undefined, 'recent-draft-row');
    const selected = current?.id === draft.id && !activeGeneration();
    const button = el('button', undefined, `recent-draft${selected ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.mutation = '';
    button.setAttribute('aria-pressed', String(selected));
    button.append(el('strong', draft.summary || '未命名草稿'));
    const date = new Date(draft.createdAt);
    button.append(el('small', `${draft.target?.project || '草稿'} · ${Number.isNaN(date.valueOf()) ? '' : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}${draft.submission ? ' · 已锁定' : ''}${draftWarnings.has(draft.id) ? ' · 有提示' : ''}`));
    button.addEventListener('click', () => {
      const task = generationTasks.get(draft.rootId);
      if (task?.running) { void openGeneration(task); return; }
      void run(async () => {
        await discardUploads();
        current = draft;
        conversationId = draft.rootId;
        issueFields = null;
        $('chat-log').replaceChildren();
        const warning = draftWarnings.get(draft.id);
        draftWarnings.delete(draft.id);
        try {
          const { messages, warning: historyWarning } = await api(`history/${draft.id}`);
          for (const entry of messages) {
            message('user', entry.request);
            message('assistant', entry.draftId ? `已保存草稿「${entry.summary}」。` : '这条修改没有对应的草稿版本。');
          }
          if (warning || historyWarning) notify([warning, historyWarning].filter(Boolean).join(' '), true);
        } catch {
          notify([warning, '对话记录暂时无法读取，仍可继续检查和修改草稿。'].filter(Boolean).join(' '), true);
        }
        message('assistant', '已打开这份草稿。你可以预览、创建，或直接输入修改要求。');
        $('request').value = '';
        renderUploads();
        renderDraft();
        renderRecents();
        updateControls();
        void refreshUsage();
        void restoreActivity(draft);
        workspaceView('document');
        closeRecents();
      });
    });
    const remove = el('button', '删除', 'recent-draft-delete');
    remove.type = 'button'; remove.dataset.mutation = ''; remove.dataset.draftDelete = draft.rootId;
    remove.setAttribute('aria-label', `删除草稿：${draft.summary || '未命名草稿'}`);
    remove.addEventListener('click', () => deleteDraft(draft));
    row.append(button, remove); list.append(row);
  });
}

function safeIssueUrl(value) {
  try {
    const url = new URL(value);
    const origin = current?.target?.origin || config.backlogOrigin;
    return url.protocol === 'https:' && url.origin === new URL(origin).origin ? url.href : null;
  } catch { return null; }
}

function renderDraft() {
  if (current) conversationId = current.rootId;
  renderIssueFields();
  renderLanguage();
  $('document-empty').hidden = !!current;
  $('document').hidden = !current || editing;
  $('draft-actions').hidden = !current || editing;
  $('draft-editor').hidden = !editing;
  $('draft-edit-actions').hidden = !editing;
  $('document-status').textContent = activeGeneration() ? 'AI 正在整理' : editing ? '编辑中 · 尚未保存' : current ? locked() ? '提交状态已记录' : '已保存 · 待确认' : '等待整理';
  $('document-status').classList.toggle('ready', !!current);
  if (!current) { updateControls(); return; }
  $('document-meta').textContent = [current.target?.project, current.issueType, current.category, languages[current.language] || '语言未记录'].filter(Boolean).join(' / ');
  $('draft-title').textContent = current.summary;
  $('draft-body').textContent = current.description;
  $('draft-fields').textContent = [current.assignee && `负责人：${current.assignee}`, current.startDate && `开始日期：${current.startDate}`, current.dueDate && `截止日期：${current.dueDate}`, current.notifiedUsers?.length && `通知：${current.notifiedUsers.join('、')}`].filter(Boolean).join('\n');
  $('unknowns').hidden = !current.unknowns?.length;
  $('unknown-list').replaceChildren(...(current.unknowns || []).map(item => el('li', typeof item === 'string' ? item : JSON.stringify(item))));
  $('document-files').textContent = current.attachments?.length ? `附件 · ${current.attachments.length} 个\n${current.attachments.map(file => file.name).join('\n')}` : '';
  const issue = current.submission;
  const href = safeIssueUrl(issue?.url);
  $('check-submission').hidden = !issue || !!href;
  if (issue && !href) $('document-status').textContent = '创建结果待确认';
  $('issue-link').hidden = !href;
  if (href) {
    $('issue-link').href = href;
    $('issue-link').textContent = `已创建 ${issue.issueKey || '工单'} · 在 Backlog 查看 ↗`;
  } else $('issue-link').removeAttribute('href');
  $('draft-action-note').textContent = issue ? href ? '工单已创建。需要报告其他问题时，请新建对话。' : '创建结果待确认，请点击「核对创建结果」查找并关联工单。' : '直接输入修改要求，即可继续调整草稿。';
  updateControls();
}

for (const [id, field, label] of [['copy-title', 'summary', '标题'], ['copy-body', 'description', '正文']]) {
  $(id).addEventListener('click', async () => {
    if (!current || editing) return;
    try {
      await navigator.clipboard.writeText(current[field]);
      notify(`已复制${label}。`);
    } catch {
      notify(`无法访问剪贴板，请选中草稿中的${label}后手动复制。`, true);
    }
  });
}

$('edit-draft').addEventListener('click', () => {
  if (!current || busy || stopped || locked() || previewActive()) return;
  closeMenus();
  $('edit-title').value = current.summary;
  $('edit-body').value = current.description;
  editFiles = current.attachments.map((file, index) => ({ ...file, index }));
  $('edit-ai').checked = false;
  editing = true;
  renderEditFiles();
  renderDraft();
  $('edit-title').focus();
});
$('cancel-edit').addEventListener('click', () => {
  run(async () => {
    const ids = editFiles.filter(file => file.id).map(file => file.id);
    editFiles = [];
    editing = false;
    renderDraft();
    $('edit-draft').focus();
    if (ids.length) await api('uploads/remove', { ids });
  }, false, true);
});
function editFilesChanged() {
  return editFiles.length !== current.attachments.length || editFiles.some((file, index) => file.index !== index);
}
$('draft-editor').addEventListener('submit', event => {
  event.preventDefault();
  if (!editing || !current || locked() || busy) return;
  const edit = { summary: $('edit-title').value, description: $('edit-body').value };
  if (editFilesChanged()) edit.files = editFiles.map(({ id, index, replaces }) => id ? { id, replaces } : { index });
  if ($('edit-ai').checked) {
    if (!config.apiKeyConfigured) { notify('请先配置模型 API，或取消勾选 AI 补充后直接保存。', true); return; }
    void generate('根据本次传入的新截图补充对应段落，只写截图中可确认的内容。保留原标题、章节、已有事实和图片引用位置。没有引用的新截图放到对应段落。', current.language || config.language, edit);
    return;
  }
  run(async () => {
    const { draft } = await api('draft/edit', { id: current.id, ...edit });
    current = draft;
    editFiles = [];
    editing = false;
    renderDraft();
    await refresh();
    notify('草稿修改已保存，未调用模型。');
    $('edit-draft').focus();
  }, false, true);
});
window.addEventListener('beforeunload', event => {
  if (editing && (busy || editFilesChanged() || $('edit-title').value !== current.summary || $('edit-body').value !== current.description)) {
    event.preventDefault(); event.returnValue = '';
  }
});

async function refresh(resumeActive = false) {
  let state, version;
  do {
    version = draftListVersion;
    state = await api('state');
  } while (version !== draftListVersion);
  config = state.config;
  languages = state.languages || languages;
  effortLevels = state.effortLabels || effortLevels;
  dateDefaults = state.defaults || dateDefaults;
  drafts = state.drafts || [];
  if (current) current = drafts.find(draft => draft.id === current.id) || current;
  if (state.preview !== undefined) preview = state.preview;
  if (resumeActive) await resumeGenerations(state.generations || []);
  renderConfig(); renderRecents(); renderDraft(); renderPreview();
  await refreshUsage();
}

function messageNode(kind, text, pending = false) {
  const item = el('div', undefined, `message ${kind}${pending ? ' pending' : ''}`);
  item.append(el('div', kind === 'user' ? '你' : 'TICKET', 'message-label'), el('div', text, 'message-text'));
  return item;
}

function message(kind, text) {
  $('welcome')?.remove();
  const item = messageNode(kind, text);
  $('chat-log').append(item);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return item;
}

function renderUploads() {
  $('upload-list').replaceChildren(...uploads.map(upload => {
    const chip = el('div', undefined, 'upload-chip');
    chip.append(el('span', upload.name));
    const remove = el('button', '×');
    remove.type = 'button'; remove.dataset.mutation = '';
    remove.setAttribute('aria-label', `移除 ${upload.name}`);
    remove.addEventListener('click', () => run(async () => {
      await api('uploads/remove', { ids: [upload.id] });
      uploads = uploads.filter(item => item.id !== upload.id); renderUploads();
    }));
    chip.append(remove); return chip;
  }));
  updateControls();
}

async function discardUploads() {
  if (activeGeneration()) { uploads = []; return; }
  if (!uploads.length) return;
  await api('uploads/remove', { ids: uploads.map(upload => upload.id) });
  uploads = [];
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
    reader.readAsDataURL(file);
  });
}

const modelImage = file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);

function availableAttachmentName(name, attachments) {
  const key = value => value.trim().normalize('NFC').toLowerCase();
  const used = new Set(attachments.map(file => key(file.name)));
  if (!used.has(key(name))) return name;

  const filename = name.trim();
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot) : '';
  const stem = filename.slice(0, filename.length - extension.length);
  const encoder = new TextEncoder();
  for (let number = 2; ; number++) {
    const suffix = `-${number}${extension}`;
    let candidate = stem + suffix;
    if (encoder.encode(candidate).length > 255) candidate = `attachment${suffix}`;
    if (encoder.encode(candidate).length > 255) candidate = `attachment-${number}`;
    if (!used.has(key(candidate))) return candidate;
  }
}

async function uploadFile(file, attachments) {
  if (file.size > 10 * 1024 * 1024) throw new Error(`“${file.name}”超过 10 MB，请压缩后重试。`);
  const name = availableAttachmentName(file.name, attachments);
  const { upload } = await api('upload', { name, data: await readFile(file), image: modelImage(file) });
  return upload;
}

function pickEditFiles(index) {
  replaceFileIndex = index;
  const input = $('edit-file-input');
  input.multiple = index === undefined;
  input.click();
}

function renderEditFiles() {
  $('edit-files-list').replaceChildren(...editFiles.map((file, index) => {
    const chip = el('div', undefined, 'upload-chip');
    const name = el('span', file.name); name.title = file.name;
    const replace = el('button', '替换');
    const remove = el('button', '移除');
    for (const button of [replace, remove]) {
      button.type = 'button';
      button.dataset.editControl = '';
      button.setAttribute('aria-label', `${button.textContent} ${file.name}`);
    }
    replace.onclick = () => pickEditFiles(index);
    remove.onclick = () => run(async () => {
      editFiles.splice(index, 1);
      renderEditFiles();
      if (file.id) await api('uploads/remove', { ids: [file.id] });
    }, false, true);
    chip.append(name, replace, remove);
    return chip;
  }));
  const images = editFiles.filter(file => file.id && file.image).length;
  $('edit-ai-option').hidden = !images || images > 5;
  $('edit-ai-limit').hidden = images <= 5;
  if ($('edit-ai-option').hidden) $('edit-ai').checked = false;
  updateControls();
}

function addEditFiles(files, index) {
  if (!editing || !files.length) return;
  return run(async () => {
    if (index !== undefined) {
      const old = editFiles[index];
      const upload = await uploadFile(files[0], editFiles.filter((_, position) => position !== index));
      editFiles[index] = { ...upload, replaces: old.index ?? old.replaces };
      renderEditFiles();
      if (old.id) await api('uploads/remove', { ids: [old.id] });
      return;
    }
    if (files.length + editFiles.length > Math.max(10, current.attachments.length)) throw new Error('每份草稿最多使用 10 个附件，请先移除多余文件。');
    for (const file of files) {
      editFiles.push(await uploadFile(file, editFiles));
      renderEditFiles();
    }
  }, false, true);
}

$('add-edit-files').onclick = () => pickEditFiles();
$('edit-file-input').onchange = event => {
  void addEditFiles([...event.target.files], replaceFileIndex);
  event.target.value = '';
};
$('draft-editor').addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
$('draft-editor').addEventListener('drop', event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  void addEditFiles([...event.dataTransfer.files]);
});
$('edit-body').addEventListener('paste', event => {
  if (!event.clipboardData.files.length) return;
  event.preventDefault();
  void addEditFiles([...event.clipboardData.files]);
});

async function addFiles(files) {
  if (current || activeGeneration() || !files.length) return;
  await run(async () => {
    for (const file of files) {
      if (uploads.length >= 10) throw new Error('每份草稿最多使用 10 个附件，请先移除多余文件。');
      if (modelImage(file) && uploads.filter(item => item.image).length >= 5) throw new Error('每次最多使用 5 张截图，请先移除多余图片。');
      uploads.push(await uploadFile(file, uploads));
      renderUploads();
    }
  });
}

$('files').addEventListener('change', async event => { await addFiles([...event.target.files]); event.target.value = ''; });
$('attach-label').setAttribute('role', 'button');
$('attach-label').tabIndex = 0;
$('attach-label').addEventListener('keydown', event => {
  if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!busy && !stopped && token) $('files').click(); }
});
$('composer').addEventListener('dragover', event => { event.preventDefault(); if (!current && !busy) $('composer').classList.add('dragover'); });
$('composer').addEventListener('dragleave', event => { if (!$('composer').contains(event.relatedTarget)) $('composer').classList.remove('dragover'); });
$('composer').addEventListener('drop', event => { event.preventDefault(); $('composer').classList.remove('dragover'); if (!busy) addFiles([...event.dataTransfer.files]); });
$('request').addEventListener('paste', event => {
  const files = [...event.clipboardData.files];
  if (files.length) { event.preventDefault(); if (!busy) addFiles(files); }
});
$('request').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('composer').requestSubmit(); } });

$('composer').addEventListener('submit', event => {
  event.preventDefault();
  if (locked() || editing) return;
  const request = $('request').value.trim();
  if (!request) { $('request').focus(); return; }
  if (!config.apiKeyConfigured) { notify('先配置模型 API，即可开始整理草稿。'); $('settings').showModal(); return; }
  void generate(request);
});

function restoreGenerationEdit(task) {
  if (!task.edit || !task.draft) return;
  editing = true;
  editFiles = task.editFiles;
  $('edit-title').value = task.edit.summary;
  $('edit-body').value = task.edit.description;
  $('edit-ai').checked = true;
  renderEditFiles();
  workspaceView('document');
}

async function openGeneration(task) {
  await run(async () => {
    if (conversationId === task.rootId && task.running) { workspaceView('chat'); closeRecents(); return; }
    const baseId = task.baseId || task.draft?.id;
    if (!task.running && task.error && baseId) {
      const { draft } = await api(`drafts/${baseId}`);
      if (!draft) {
        generationTasks.delete(task.rootId);
        renderRecents();
        notify('这份草稿已删除。', true);
        return;
      }
      task.draft = draft;
    }
    await discardUploads();
    conversationId = task.rootId;
    current = task.draft;
    issueFields = task.issueFields;
    uploads = task.uploads;
    $('request').value = task.input;
    $('chat-log').replaceChildren(...task.messages);
    workspaceView(task.running || !task.draft ? 'chat' : 'document');
    if (!task.running) {
      generationTasks.delete(task.rootId);
      if (task.error) { restoreGenerationEdit(task); notify(task.error, true); }
      else if (task.warning) notify(task.warning, true);
    }
    renderUploads();
    renderDraft();
    renderRecents();
    updateControls();
    void refreshUsage();
    closeRecents();
  });
}

function prepareGeneration(task, transcript = []) {
  const label = task.revising ? '正在更新草稿…' : '正在整理草稿…';
  const fileNames = task.uploads.map(file => file.name);
  const report = task.request + (fileNames.length ? `\n\n附件：${fileNames.join('、')}` : '');
  task.pending = messageNode('assistant', label, true);
  task.progressText = task.pending.querySelector('.message-text');
  task.details = activityPanel();
  task.pending.append(task.details.node);
  task.messages = [...transcript, messageNode('user', report), task.pending];
}

function finishGeneration(task, { draft, activity, warning, error }) {
  task.running = false;
  clearTimeout(task.timer);
  task.pending.classList.remove('pending');
  task.details.render(activity);
  const selected = conversationId === task.rootId;
  if (draft) {
    task.draft = draft;
    task.uploads = [];
    task.warning = warning;
    if (warning && !selected) draftWarnings.set(draft.id, warning);
    if (task.input.trim() === task.request) task.input = '';
    drafts = [draft, ...drafts.filter(item => item.id !== draft.id)];
    draftListVersion++;
    task.progressText.textContent = (task.revising ? '草稿已更新并保存为新版本。' : '草稿已整理好。') + '检查「当前草稿」后，可以预览、创建，或继续输入修改要求。';
  } else {
    task.error = error;
    task.progressText.textContent = error;
  }
  if (!task.error || selected) generationTasks.delete(task.rootId);
  if (selected) {
    current = task.draft;
    uploads = task.uploads;
    $('request').value = task.revising && !current ? '' : task.input;
    if (task.error) { restoreGenerationEdit(task); notify(task.error, true); }
    else {
      if (task.edit) workspaceView('document');
      if (warning) notify(warning, true);
    }
    renderUploads();
    renderDraft();
    void refreshUsage();
  }
  renderRecents();
  updateControls();
}

function watchGeneration(task, resumed = false) {
  const poll = async () => {
    try {
      const { activity, running } = await api(`activity/${task.id}`);
      if (!task.running) return;
      const ownActivity = activity?.rootId === task.rootId ? activity : null;
      if (ownActivity?.state === 'running') {
        task.details.render(ownActivity);
        task.progressText.textContent = ownActivity.retrying ? '连接超时，正在重试…' : task.revising ? '正在更新草稿…' : '正在整理草稿…';
      }
      if (resumed && !running) {
        const { draft } = await api(`drafts/${task.resultId}`);
        if (draft?.generationId === task.id && draft.rootId === task.rootId) {
          finishGeneration(task, { draft, activity: ownActivity, warning: ownActivity?.warning });
        } else {
          finishGeneration(task, { activity: ownActivity, error: ownActivity?.error || '本次生成未保存草稿。' });
        }
      }
    } catch { /* A progress lookup must not interrupt generation. */ }
    finally { if (task.running && !stopped) task.timer = setTimeout(poll, 900); }
  };
  void poll();
}

async function resumeGenerations(active) {
  for (const entry of active) {
    if (generationTasks.has(entry.rootId) || drafts.some(draft => draft.generationId === entry.id)) continue;
    const draft = entry.baseId ? drafts.find(draft => draft.id === entry.baseId)
      || (await api(`drafts/${entry.baseId}`).catch(() => ({}))).draft : null;
    const task = { ...entry, draft, input: entry.edit ? '' : entry.request, revising: !!entry.baseId, running: true };
    prepareGeneration(task);
    generationTasks.set(task.rootId, task);
    watchGeneration(task, true);
  }
}

async function generate(request, language = current?.language || config.language, edit) {
  if (busy || stopped || locked() || activeGeneration()) return;
  if ([...generationTasks.values()].filter(task => task.running).length >= 2) {
    notify('最多同时生成 2 份草稿，请等待其中一份完成。', true);
    renderLanguage();
    return;
  }
  closeMenus();
  notify('');
  const id = crypto.randomUUID(), rootId = conversationId, revising = !!current;
  const input = $('request').value;
  const task = { id, rootId, request, input, draft: current, uploads, issueFields, edit, editFiles, revising, running: true };
  const body = revising ? { id: current.id, instruction: request, language, edit, generationId: id }
    : { request, uploadIds: uploads.map(file => file.id), ...pickedFields(), language, conversationId: rootId, generationId: id };
  generationTasks.set(rootId, task);
  if (edit) { editing = false; editFiles = []; workspaceView('chat'); }
  $('welcome')?.remove();
  const log = $('chat-log');
  prepareGeneration(task, [...log.childNodes]);
  log.append(...task.messages.slice(-2));
  log.scrollTop = log.scrollHeight;
  renderRecents();
  renderDraft();
  watchGeneration(task);
  let result;
  try {
    result = await api(revising ? 'revise' : 'draft', body);
  } catch (error) {
    const { activity } = await api(`activity/${id}`).catch(() => ({}));
    result = { activity: activity?.rootId === rootId ? activity : null, error: error.message };
    if (!revising && error.status === 409) void refresh().catch(() => {});
  }
  finishGeneration(task, result);
  return !task.error;
}

async function stopGeneration() {
  const task = activeGeneration();
  if (!task || task.stopping || stopped) return;
  task.stopping = true; updateControls();
  try {
    const { stopping } = await api('generation/stop', { id: task.id });
    if (!stopping) task.stopping = false;
    if (task === activeGeneration()) {
      notify(stopping ? '正在停止生成，已有草稿会保留。' : '当前没有可停止的生成操作，正在等待结果。');
      updateControls();
    }
  } catch (error) {
    task.stopping = false; updateControls();
    if (task === activeGeneration()) notify(error.message, true);
  }
}
$('stop-generation').addEventListener('click', stopGeneration);

function activityPanel() {
  const node = el('details', undefined, 'ai-activity'), summary = el('summary', 'AI 思考与处理详情 · 正在处理'), content = el('div', undefined, 'ai-activity-content');
  node.append(summary, content);
  const render = activity => {
    if (!activity) return;
    summary.textContent = `AI 思考与处理详情 · ${activity.state === 'complete' ? '已完成' : activity.state === 'cancelled' ? '已停止' : activity.state === 'error' ? '未完成' : '正在处理'}`;
    content.replaceChildren();
    const effort = activity.reasoningEffort && activity.reasoningEffort !== 'auto' ? ` · 思考强度 ${effortLevels[activity.reasoningEffort] || activity.reasoningEffort}` : '';
    content.append(el('p', `${activity.model || '当前模型'}${effort} · ${usageText(activity.usage)}`, 'activity-meta'));
    const list = el('ol', undefined, 'activity-events');
    const tools = { read_file: '读取源码片段', search_code: '搜索相关代码', list_files: '查找源码文件' };
    for (const event of activity.events || []) list.append(el('li', event.text.replace(/^只读工具：(.+)$/, (_, name) => tools[name.trim()] || '查询相关资料').replace(/^模型调查 (\d+)(?:\/\d+)?$/, '模型处理 · 第 $1 轮')));
    content.append(list);
    if (activity.thoughts?.length) {
      content.append(el('strong', '服务商返回的思考内容 / 摘要'));
      for (const item of activity.thoughts) content.append(el('pre', `第 ${item.round} 轮\n${item.text}`, 'activity-thought'));
      if (activity.thoughtsTruncated) content.append(el('p', '内容较长，仅展示前 30,000 字符。', 'activity-meta'));
    } else content.append(el('p', activity.state === 'running' ? '等待模型返回；处理步骤会更新，思考内容在服务商返回后显示。' : '此模型本次未返回可显示的思考内容；以上为实际处理记录。', 'activity-meta'));
    if (activity.error) content.append(el('p', activity.error, 'activity-error'));
  };
  return { node, render };
}

async function restoreActivity(draft) {
  if (!draft.generationId) return;
  try {
    const { activity } = await api(`activity/${draft.generationId}`);
    if (!activity || current?.id !== draft.id || activeGeneration()) return;
    const details = activityPanel(); details.render(activity);
    message('assistant', '上次生成记录').append(details.node);
  } catch { /* Old drafts remain usable without a generation record. */ }
}

const number = value => value == null ? '未提供' : value.toLocaleString('zh-CN');
const money = value => value == null ? '未提供' : value > 0 && value < 0.000001 ? '<$0.000001' : `$${Number(value.toFixed(6)).toString()}`;
function usageText(usage) {
  if (!usage) return '暂无用量';
  return `${usage.missingTokens ? '已知 ' : ''}${number(usage.totalTokens)} tokens · ${usage.missingCost && usage.costUsd != null ? '已知 ≥ ' : ''}${money(usage.costUsd)}${usage.missingCost ? '（部分费用未返回）' : ''}`;
}

async function refreshUsage() {
  if (!token || stopped) return;
  const rootId = current?.rootId || conversationId;
  try {
    const result = await api(`usage/${rootId}`);
    if (rootId !== (current?.rootId || conversationId)) return;
    const u = result.conversation;
    $('usage-caption').textContent = result.recordedRuns ? `本对话 ${usageText(u)}` : '用量与费用';
    $('conversation-usage').textContent = !result.recordedRuns && current ? '旧稿未记录用量，不能据此计算历史费用。' : `${u.requests} 次请求 · ${usageText(u)}\n输入 ${number(u.inputTokens)} / 输出 ${number(u.outputTokens)}\n已知缓存 ${number(u.cachedTokens)} / 已知思考 ${number(u.reasoningTokens)}（服务商统计）`;
    if (result.unreadableRuns) $('conversation-usage').textContent += `\n有 ${result.unreadableRuns} 份本机记录无法读取，合计可能不完整。`;
    $('local-account-usage').textContent = result.localAccount ? `本机记录（当前 Key）：${result.localAccount.requests} 次请求 · ${usageText(result.localAccount)}` : '尚未配置模型 API。';
  } catch (error) {
    if (rootId === (current?.rootId || conversationId)) $('conversation-usage').textContent = error.message;
  }
}

async function loadAccount() {
  if (accountLoading || stopped || !token) return;
  const version = accountVersion;
  accountLoading = true; $('refresh-usage').disabled = true;
  try {
    const { account } = await api('account');
    if (version !== accountVersion) return;
    $('account-usage').textContent = account.supported ? `OpenRouter Key 累计消费 ${money(account.usageUsd)}\n今日 ${money(account.dailyUsd)} / 本月 ${money(account.monthlyUsd)}（UTC）\n${account.limitUsd == null ? '未设置 Key 消费限额' : `Key 剩余额度 ${money(account.remainingUsd)} / 限额 ${money(account.limitUsd)}`}\n包含此 Key 在其他应用的调用；Key 额度不等于账户余额。` : account.message;
  } catch (error) { if (version === accountVersion) $('account-usage').textContent = error.message; }
  finally { accountLoading = false; $('refresh-usage').disabled = stopped; if (version !== accountVersion && $('usage-panel').open) void loadAccount(); }
}
$('usage-panel').addEventListener('toggle', () => { if ($('usage-panel').open) { void refreshUsage(); void loadAccount(); } });
$('refresh-usage').onclick = () => { void refreshUsage(); void loadAccount(); };

function renderLanguage() {
  const select = $('language');
  select.replaceChildren();
  if (current && !current.language) { const option = el('option', '选择语言'); option.value = ''; option.disabled = true; select.append(option); }
  for (const [value, label] of Object.entries(languages)) { const option = el('option', label); option.value = value; select.append(option); }
  select.value = current ? current.language || '' : config.language || 'zh-CN';
  $('language-hint').textContent = current ? '切换会重新整理草稿，并保存新版本' : '标题和正文说明使用所选语言';
  select.title = '模板固定章节名、分类、人员名和代码保留原文';
}

$('language').addEventListener('change', async () => {
  const language = $('language').value;
  const choice = ++languageChoice, rootId = conversationId;
  if (current && !await generate(`请将标题、正文说明和待确认项统一改写为${languages[language]}，保留所有事实、模板结构和代码引用，不新增内容。`, language)) return;
  if (choice !== languageChoice) return;
  await run(async () => {
    try {
      const saved = await api('config/language', { language }); config = saved.config;
      renderLanguage();
      if (rootId === conversationId) notify(`起票语言已设为 ${languages[language]}，下次启动会保留。`);
    } catch (error) { renderLanguage(); throw error; }
  });
});

function workspaceView(view) {
  const workbench = document.querySelector('.workbench'), expanded = view === 'document';
  workbench.dataset.mobileView = view;
  workbench.dataset.draftCollapsed = String(!expanded);
  $('draft-content').hidden = !expanded;
  $('draft-toggle').setAttribute('aria-expanded', String(expanded));
  $('draft-toggle').textContent = expanded ? '收起草稿' : '展开草稿';
  $('chat-tab').setAttribute('aria-selected', String(view === 'chat'));
  $('document-tab').setAttribute('aria-selected', String(view === 'document'));
}
$('draft-toggle').addEventListener('click', () => workspaceView($('draft-content').hidden ? 'document' : 'chat'));
$('chat-tab').addEventListener('click', () => workspaceView('chat'));
$('document-tab').addEventListener('click', () => workspaceView('document'));
$('recent-toggle').addEventListener('click', () => {
  const open = document.querySelector('.sidebar').classList.toggle('recent-open');
  $('recent-toggle').setAttribute('aria-expanded', String(open));
});

function closeRecents() {
  document.querySelector('.sidebar').classList.remove('recent-open');
  $('recent-toggle').setAttribute('aria-expanded', 'false');
}

function resetConversation(copy = '开始一个新问题吧。描述实际情况和期望结果，也可以附上截图。') {
  current = null; issueFields = null;
  conversationId = crypto.randomUUID();
  $('request').value = '';
  $('chat-log').replaceChildren();
  message('assistant', copy);
  renderUploads(); workspaceView('chat');
}

async function newConversation() {
  await run(async () => { await discardUploads(); resetConversation(); await refresh(); });
  if (!busy) $('request').focus();
}
$('new-chat').addEventListener('click', newConversation);
$('brand').addEventListener('click', event => { event.preventDefault(); newConversation(); });

async function deleteDraft(draft) {
  await run(async () => {
    if (!confirm(`删除“${draft.summary || '未命名草稿'}”所在的本机对话及其全部草稿版本？\n\n会释放不再被其他草稿引用的本机附件，无法恢复。Backlog 上的工单、用量和提交记录会保留。`)) return;
    let result;
    try { result = await api('draft/delete', { id: draft.id }); }
    catch (error) { await refresh(); throw error; }
    const deleted = new Set(result.deletedIds);
    for (const id of deleted) draftWarnings.delete(id);
    for (const [rootId, task] of generationTasks) {
      if (!task.running && deleted.has(task.draft?.id)) generationTasks.delete(rootId);
    }
    if (deleted.has(current?.id)) resetConversation('草稿及其历史版本已删除。可以开始一个新问题。');
    await refresh();
    notify(result.warning ? result.warning + pendingHistoryText(result.pendingFiles) : `已删除 ${result.deletedIds.length} 个草稿版本，释放附件文件 ${sizeText(result.freedBytes)}。`, !!result.warning);
  });
}
$('delete-draft').addEventListener('click', () => { if (current) void deleteDraft(current); });

function closeMenus() {
  ['model', 'project', 'type', 'category', 'assignee', 'notify'].forEach(kind => { $(`${kind}-menu`).hidden = true; $(`${kind}-picker`).setAttribute('aria-expanded', 'false'); });
  activeMenu = null;
}
document.addEventListener('click', event => { if (!event.target.closest('.picker-wrap')) closeMenus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });

async function openPicker(kind) {
  if (busy || stopped || !token || editing) return;
  if (kind === 'category' && current && (current.target?.project !== config.project || current.target?.origin !== config.backlogOrigin)) { notify('请先切回当前草稿对应的站点与项目，再选择分类。', true); return; }
  if (activeMenu === kind) { closeMenus(); return; }
  closeMenus();
  activeMenu = kind;
  const menu = $(`${kind}-menu`);
  menu.hidden = false; $(`${kind}-picker`).setAttribute('aria-expanded', 'true');
  menu.replaceChildren(el('p', '正在读取可选项…', 'picker-message'));
  try {
    const result = await api(kind === 'model' ? 'models' : kind === 'project' ? 'projects' : kind === 'category' ? 'categories' : 'types').catch(error => {
      if (kind !== 'model') throw error;
      return { error };
    });
    if (activeMenu !== kind) return;
    menu.replaceChildren();
    const effortBox = el('div', undefined, 'model-effort-settings');
    const renderEffort = () => {
      if (kind !== 'model') return;
      effortBox.replaceChildren();
      const selected = result.options?.find(model => model.id === config.model);
      const label = el('label', '思考强度');
      const control = el('select');
      control.setAttribute('aria-label', '思考强度');
      control.dataset.mutation = '';
      for (const level of ['auto', ...(selected?.efforts || [])]) {
        const option = el('option', level === 'auto' && selected?.defaultEffort ? `默认（${effortLevels[selected.defaultEffort]}）` : effortLevels[level] || level);
        option.value = level; control.append(option);
      }
      control.value = config.reasoningEffort || 'auto';
      if (control.selectedIndex < 0) {
        const stale = el('option', result.error ? `${effortLevels[config.reasoningEffort]}（当前）` : '原档位已不可用，请重新选择');
        stale.value = config.reasoningEffort; stale.disabled = true; control.append(stale); control.value = stale.value;
      }
      control.onchange = () => {
        const effort = control.value, model = config.model;
        void run(async () => {
          try {
            const saved = await api('effort', { model, effort });
            config = saved.config;
            renderConfig();
            notify(`思考强度已设为${effortLevels[effort]}，已按模型保存。`);
          } finally { renderEffort(); }
        });
      };
      label.append(control);
      effortBox.append(el('p', config.model || '请选择模型', 'effort-model'), label,
        el('p', selected?.efforts.length ? '强度越高，通常耗时和用量越多。' : '当前未获取到此模型的可调档位，可使用默认设置。', 'picker-message'));
    };
    if (result.error) {
      menu.append(el('p', result.error.message, 'picker-message'));
      if (config.model && config.reasoningEffort && config.reasoningEffort !== 'auto') {
        menu.append(effortBox);
        renderEffort();
      }
      return;
    }
    const choices = kind === 'model' ? result.models.map(name => ({ value: name, label: name })) : kind === 'project' ? result.projects.map(project => ({ value: project.key, label: project.key, detail: project.name })) : kind === 'category' ? [{ value: '', label: '不指定分类' }, ...result.categories.map(category => ({ value: category.name, label: category.name }))] : result.types.map(type => ({ value: type.name, label: type.name }));
    const search = el('input'); search.type = 'search'; search.placeholder = kind === 'model' ? '搜索模型，或输入完整模型 ID' : '搜索'; search.setAttribute('aria-label', `搜索${kind === 'model' ? '模型' : kind === 'project' ? '项目' : kind === 'category' ? '分类' : '工单类型'}`);
    search.dataset.mutation = '';
    const options = el('div', undefined, 'picker-options');
    const choose = value => {
      if (kind !== 'model') closeMenus();
      run(async () => {
        const body = kind === 'model' ? { model: value } : kind === 'project' ? { project: value } : kind === 'category' ? { category: value, ...(current && { id: current.id }) } : { type: value };
        const saved = await api(kind, body); config = saved.config;
        if (saved.draft) current = saved.draft;
        await refresh();
        if (kind === 'model') { filter(); renderEffort(); }
        if (kind === 'category') notify(current ? '草稿分类与标题已更新，并保存为新版本。' : '默认分类已按项目保存；生成草稿时会加入标题。');
        if (kind === 'project') {
          if (!current && issueFields) issueFields = { ...issueFields, assignee: '', notifiedUsers: [] };
          renderIssueFields();
          notify('项目已切换。请选择该项目的工单类型；当前草稿仍保留原项目。');
          setTimeout(() => openPicker('type'), 0);
        }
      });
    };
    const filter = () => {
      const query = search.value.trim().toLowerCase();
      const matches = choices.filter(choice => `${choice.label} ${choice.detail || ''}`.toLowerCase().includes(query));
      options.replaceChildren();
      matches.forEach(choice => {
        const selected = choice.value === (kind === 'model' ? config.model : kind === 'project' ? config.project : kind === 'category' ? (current ? current.category || '' : config.category) : config.issueType);
        const button = el('button', undefined, `picker-option${selected ? ' selected' : ''}`); button.type = 'button'; button.dataset.mutation = '';
        button.append(el('span', `${selected ? '✓  ' : ''}${choice.label}`));
        if (choice.detail) button.append(el('small', choice.detail));
        button.addEventListener('click', () => choose(choice.value)); options.append(button);
      });
      if (!matches.length) options.append(el('p', '没有匹配的选项', 'picker-message'));
      if (kind === 'model' && search.value.trim() && !choices.some(choice => choice.value === search.value.trim())) {
        const direct = el('button', `使用模型 ID：${search.value.trim()}`, 'picker-option direct-model');
        direct.dataset.mutation = '';
        direct.type = 'button'; direct.addEventListener('click', () => choose(search.value.trim())); options.append(direct);
      }
    };
    search.addEventListener('input', filter);
    search.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); options.querySelector('button')?.focus(); } });
    options.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...options.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    });
    menu.append(search, options);
    if (kind === 'model') { menu.append(effortBox); renderEffort(); }
    filter(); search.focus();
  } catch (error) { menu.replaceChildren(el('p', error.message, 'picker-message')); }
}
['model', 'project', 'type', 'category'].forEach(kind => $(`${kind}-picker`).addEventListener('click', () => openPicker(kind)));

function pickedFields() {
  const fields = current || issueFields || {};
  return { startDate: fields.startDate || dateDefaults.startDate, dueDate: fields.dueDate || dateDefaults.dueDate, assignee: fields.assignee || '', notifiedUsers: fields.notifiedUsers || [] };
}

function renderIssueFields() {
  const fields = pickedFields();
  $('start-date').value = fields.startDate || ''; $('due-date').value = fields.dueDate || '';
  $('fields-caption').textContent = fields.startDate ? `${fields.startDate} → ${fields.dueDate}` : '';
  $('assignee-picker').textContent = fields.assignee || '不指派';
  $('notify-picker').textContent = fields.notifiedUsers.length ? `已选择 ${fields.notifiedUsers.length} 人` : '不通知其他人';
  $('notify-picker').title = fields.notifiedUsers.join('、');
}

function applyFields(patch) {
  closeMenus();
  return run(async () => {
    const fields = { ...pickedFields(), ...patch };
    try {
      if (current) {
        const saved = await api('fields', { id: current.id, ...fields }); current = saved.draft;
        await refresh(); notify('日期与人员已保存为新版本。');
      } else {
        if (fields.startDate > fields.dueDate) throw new Error('截止日不能早于开始日，请先调整截止日。');
        issueFields = fields; renderIssueFields();
      }
    } catch (error) { renderIssueFields(); throw error; }
  });
}
for (const [id, field] of [['start-date', 'startDate'], ['due-date', 'dueDate']]) {
  $(id).addEventListener('change', () => applyFields({ [field]: $(id).value || dateDefaults[field] }));
}

async function openPeoplePicker(kind) {
  if (busy || stopped || !token || (current && (locked() || previewActive()))) return;
  if (current && (current.target?.project !== config.project || current.target?.origin !== config.backlogOrigin)) { notify('请先切回当前草稿对应的站点与项目，再选择人员。', true); return; }
  if (activeMenu === kind) { closeMenus(); return; }
  closeMenus(); activeMenu = kind;
  const menu = $(`${kind}-menu`); menu.hidden = false; $(`${kind}-picker`).setAttribute('aria-expanded', 'true');
  menu.replaceChildren(el('p', '正在读取项目成员…', 'picker-message'));
  try {
    const { users } = await api('users'); if (activeMenu !== kind) return;
    menu.replaceChildren();
    const search = el('input'); search.type = 'search'; search.placeholder = '搜索项目成员'; search.setAttribute('aria-label', kind === 'assignee' ? '搜索负责人' : '搜索通知对象');
    const options = el('div', undefined, 'picker-options');
    const selected = new Set(pickedFields().notifiedUsers);
    const filter = () => {
      options.replaceChildren();
      if (kind === 'assignee') { const clear = el('button', '不指派', 'picker-option'); clear.type = 'button'; clear.onclick = () => applyFields({ assignee: '' }); options.append(clear); }
      for (const user of users.filter(user => user.name.toLowerCase().includes(search.value.trim().toLowerCase()))) {
        const duplicated = users.filter(item => item.name === user.name).length > 1;
        if (kind === 'assignee') {
          const button = el('button', user.name + (duplicated ? '（姓名重名，请在官网指定）' : ''), 'picker-option'); button.type = 'button'; button.disabled = duplicated;
          button.onclick = () => applyFields({ assignee: user.name }); options.append(button);
        } else {
          const label = el('label', undefined, 'person-option'), check = el('input'); check.type = 'checkbox'; check.checked = selected.has(user.name); check.disabled = duplicated;
          check.onchange = () => { if (check.checked) selected.add(user.name); else selected.delete(user.name); };
          label.append(check, el('span', user.name + (duplicated ? '（姓名重名，请在官网指定）' : ''))); options.append(label);
        }
      }
      if (!users.length) options.append(el('p', '当前项目没有可选择的成员', 'picker-message'));
    };
    search.oninput = filter; menu.append(search, options);
    if (kind === 'notify') {
      const actions = el('div', undefined, 'people-actions'), clear = el('button', '清空', 'text-button'), save = el('button', '应用选择', 'small-button'); clear.type = save.type = 'button';
      clear.onclick = () => { selected.clear(); filter(); }; save.onclick = () => applyFields({ notifiedUsers: [...selected] }); actions.append(clear, save); menu.append(actions);
    }
    filter(); search.focus();
  } catch (error) { menu.replaceChildren(el('p', error.message, 'picker-message')); }
}
for (const kind of ['assignee', 'notify']) $(`${kind}-picker`).onclick = () => openPeoplePicker(kind);

function sizeText(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function renderStorage(storage) {
  $('storage-path').textContent = storage.directory;
  $('storage-usage').textContent = `${storage.files} 个附件 · ${sizeText(storage.bytes)}（含附件记录）`;
  $('storage-detail').textContent = storage.blocked ? '部分草稿无法检查或目录含异常条目，占用可能不完整；已停止清理，避免误删。' : `草稿引用 ${sizeText(storage.retainedBytes)} · 未关联草稿 ${sizeText(storage.unusedBytes)}`;
  $('cleanup-storage').hidden = storage.blocked || !storage.unusedBytes;
}

async function refreshStorage() {
  const { storage, pendingHistoryCleanup } = await api('storage');
  renderStorage(storage);
  $('cleanup-history').hidden = !pendingHistoryCleanup;
}

$('refresh-storage').addEventListener('click', () => run(refreshStorage, true));
$('cleanup-storage').addEventListener('click', () => run(async () => {
  if (!confirm('清理未被任何已保存草稿引用的附件？当前页面待用和可重试的附件会保留，其他页面尚未保存的附件可能被清理。')) return;
  const queuedFiles = [...generationTasks.values()].flatMap(task => [...task.uploads, ...task.editFiles]);
  const keepIds = [...new Set([...uploads, ...editFiles, ...queuedFiles].map(file => file.id).filter(Boolean))];
  const result = await api('storage/cleanup', { keepIds });
  renderStorage(result.storage);
  $('storage-result').textContent = `已清理 ${result.removedFiles} 个附件，释放 ${sizeText(result.freedBytes)}。`;
}, true));
$('cleanup-history').addEventListener('click', () => run(async () => {
  const { removed, remaining, pendingFiles } = await api('history/cleanup', {});
  await refreshStorage();
  $('storage-result').textContent = `已完成 ${removed} 份对话清理。` + (remaining ? `还有 ${remaining} 份待处理，请检查草稿、对话文件或目录权限后重试。` + pendingHistoryText(pendingFiles) : '');
}, true));

$('settings-open').addEventListener('click', () => {
  closeMenus(); $('settings-error').hidden = true; $('settings').showModal();
  $('storage-result').textContent = '';
  void run(refreshStorage, true);
});
$('settings-close').addEventListener('click', () => $('settings').close());
$('api-form').addEventListener('submit', event => {
  event.preventDefault();
  const key = $('api-key').value.trim();
  if (!key) { $('api-key').focus(); return; }
  run(async () => {
    const provider = $('provider').value;
    const result = await api('config/api', { key, ...(provider === 'auto' ? {} : { provider }) });
    $('api-key').value = ''; config = result.config; renderConfig();
    accountVersion++;
    $('account-usage').textContent = '展开后读取服务商数据';
    await refreshUsage(); if ($('usage-panel').open) await loadAccount();
    notify('模型 API 已配置。可在顶部选择模型。');
  }, true);
});
$('backlog-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const result = await api('config/backlog', { origin: $('backlog-origin').value.trim(), key: $('backlog-key').value.trim() });
    $('backlog-key').value = ''; config = result.config;
    if (!current && issueFields) issueFields = { ...issueFields, assignee: '', notifiedUsers: [] };
    await refresh(); notify('Backlog 配置已保存。请选择项目和工单类型。');
    $('settings').close(); setTimeout(() => openPicker('project'), 0);
  }, true);
});
$('choose-folder').addEventListener('click', () => run(async () => {
  const { repo } = await api('folder', {});
  if (repo !== null) $('repo').value = repo;
}, true));
$('repo-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const repo = $('repo').value.trim(), project = config.project, origin = config.backlogOrigin;
    const result = await api('config/repo', { repo, project, origin });
    config = result.config;
    renderConfig();
    notify(repo ? '代码目录已保存。' : '已清除代码目录。');
  }, true);
});

$('create').addEventListener('click', () => {
  if (!current || busy || locked()) return;
  $('confirm-summary').textContent = current.summary;
  $('confirm-target').textContent = [current.target?.origin || config.backlogOrigin, current.target?.project || config.project, current.issueType, current.category, languages[current.language], `${current.startDate} → ${current.dueDate}`, current.assignee && `负责人：${current.assignee}`, current.notifiedUsers?.length && `通知：${current.notifiedUsers.join('、')}`].filter(Boolean).join(' / ');
  $('confirm-create').showModal();
});
$('create-cancel').addEventListener('click', () => $('confirm-create').close());
$('create-confirm').addEventListener('click', () => {
  if (!current || locked()) return;
  run(async () => {
    $('confirm-create').close();
    try {
      const result = await api('create', { id: current.id });
      current = result.draft;
      await refresh();
      message('assistant', `工单 ${result.issue.issueKey} 已创建。可以在右侧打开 Backlog 查看。`);
      workspaceView('document'); notify(`工单 ${result.issue.issueKey} 已创建。`);
    } catch (error) {
      try { await refresh(); }
      catch {
        current.submission = { state: 'unknown' };
        renderDraft();
      }
      throw error;
    }
  });
});

function issueMeta(issue) {
  const date = new Date(issue.created);
  return [Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(), issue.createdBy && `创建人 ${issue.createdBy}`, issue.status].filter(Boolean).join(' · ');
}

function clearCheckedIssue() {
  checkedIssue = null;
  $('submission-detail').hidden = true;
  $('submission-link').textContent = '确认关联此工单';
  updateControls();
}

async function checkOperation(action) {
  await run(async () => {
    $('submission-check-error').hidden = true;
    try { await action(); }
    catch (error) {
      $('submission-check-error').textContent = error.message;
      $('submission-check-error').hidden = false;
    }
  });
}

async function readCheckedIssue(key) {
  clearCheckedIssue();
  const result = await api('submission/check', { id: $('submission-check').dataset.draftId, key });
  const issue = result.issue, detail = $('submission-detail');
  const link = el('a', `${issue.issueKey} · ${issue.summary}`);
  link.href = safeIssueUrl(issue.url); link.target = '_blank'; link.rel = 'noopener noreferrer';
  detail.replaceChildren(link, el('p', issueMeta(issue), 'submission-meta'));
  if (issue.summary !== result.summary) detail.append(el('p', '标题与提交时不同，请结合正文和创建时间核对。', 'form-message'));
  detail.append(el('pre', issue.description || '（正文为空）'));
  if (issue.attachments.length) detail.append(el('p', `附件 ${issue.attachments.join('、')}`, 'submission-meta'));
  detail.hidden = false;
  checkedIssue = issue;
  $('submission-link').textContent = `确认关联 ${issue.issueKey}`;
}

async function searchSubmissions(more = false) {
  clearCheckedIssue();
  if (!more) {
    $('submission-results').replaceChildren();
    $('submission-more').hidden = true;
    nextCheckOffset = null;
  }
  const keyword = more ? checkedKeyword : $('submission-keyword').value;
  const result = await api('submission/check', { id: $('submission-check').dataset.draftId, ...(keyword && { keyword }), offset: more ? nextCheckOffset : 0 });
  checkedKeyword = result.keyword;
  $('submission-keyword').value = checkedKeyword;
  nextCheckOffset = result.nextOffset;
  for (const issue of result.issues) {
    const row = el('div', undefined, 'submission-candidate');
    const button = el('button', `${issue.issueKey} · ${issue.summary}`, 'picker-option');
    button.type = 'button'; button.dataset.mutation = '';
    button.onclick = () => { void checkOperation(() => readCheckedIssue(issue.issueKey)); };
    row.append(button, el('p', issueMeta(issue), 'submission-meta'));
    $('submission-results').append(row);
  }
  if (!$('submission-results').children.length) $('submission-results').append(el('p', '暂未找到匹配工单。可以修改搜索词，或输入已知编号读取工单。', 'picker-message'));
  $('submission-more').hidden = nextCheckOffset === null;
}

$('check-submission').onclick = () => {
  void checkOperation(async () => {
    const dialog = $('submission-check');
    dialog.dataset.draftId = current.id;
    $('submission-keyword').value = '';
    $('submission-key').value = '';
    clearCheckedIssue();
    dialog.showModal();
    await searchSubmissions();
  });
};
$('submission-check-close').onclick = () => $('submission-check').close();
$('submission-check').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('submission-search').addEventListener('submit', event => {
  event.preventDefault();
  void checkOperation(() => searchSubmissions());
});
$('submission-more').onclick = () => { void checkOperation(() => searchSubmissions(true)); };
$('submission-lookup').addEventListener('submit', event => {
  event.preventDefault();
  void checkOperation(() => readCheckedIssue($('submission-key').value));
});
$('submission-link').onclick = () => {
  if (!checkedIssue) return;
  void checkOperation(async () => {
    const issue = checkedIssue;
    const result = await api('submission/link', { id: $('submission-check').dataset.draftId, key: issue.issueKey, expectedSummary: issue.summary, expectedUpdated: issue.updated });
    current = result.draft;
    $('submission-check').close();
    renderDraft();
    await refresh();
    notify(`已关联工单 ${result.issue.issueKey}。`);
  });
};

function renderPreview() {
  const visible = preview && preview.state !== 'closed';
  $('preview-panel').hidden = !visible;
  if (!visible) { clearTimeout(previewTimer); updateControls(); return; }
  const labels = { opening: '正在打开', waiting: '等待确认', filling: '正在填写', ready: '已填入', error: '需要处理' };
  $('preview-state').textContent = labels[preview.state] || '';
  $('preview-message').textContent = preview.error || (preview.state === 'waiting' && preview.prompt) || ({ opening: '正在打开专用浏览器。首次使用，请在新窗口登录 Backlog。', waiting: '在专用浏览器中完成登录，进入目标项目新建页后，点击继续填入。', filling: '正在填写 Backlog 表单，请稍候。', ready: '已填入 Backlog 新建页，可直接检查和编辑。' }[preview.state] || '');
  $('preview-continue').hidden = preview.state !== 'waiting';
  $('preview-close').hidden = false;
  updateControls();
  clearTimeout(previewTimer);
  if (!stopped && preview.state !== 'error') previewTimer = setTimeout(pollPreview, 1200);
}
async function pollPreview() {
  if (polling || stopped || !previewActive()) return;
  polling = true;
  try {
    const result = await api('preview');
    const before = preview?.state;
    preview = result.preview;
    renderPreview();
    if (preview?.issue || (before !== 'closed' && preview?.state === 'closed')) await refresh();
  } catch (error) {
    notify(error.message, true);
    clearTimeout(previewTimer);
  } finally { polling = false; }
}
$('open-preview').addEventListener('click', () => run(async () => {
  if (!current || previewActive()) return;
  const result = await api('preview', { id: current.id }); preview = result.preview; renderPreview();
}));
$('preview-continue').addEventListener('click', () => run(async () => {
  const result = await api('preview/continue', {}); preview = result.preview; renderPreview();
}));
$('preview-close').addEventListener('click', () => run(async () => {
  const result = await api('preview/close', {}); preview = result.preview || null;
  await refresh(); renderPreview();
}));
$('shutdown').addEventListener('click', () => {
  if (!confirm('退出本机工作台？已保存的配置和草稿会保留。')) return;
  run(async () => {
    await discardUploads();
    await api('shutdown', {}); stopped = true; clearTimeout(previewTimer); closeMenus(); $('settings').close();
    notify('工作台已退出。下次使用时，双击启动程序即可。');
  });
});

async function boot() {
  updateControls();
  if (!token) { notify('请双击「启动 Ticket」，使用自动打开的页面进入工作台。', true); return; }
  await run(async () => {
    await refresh(true);
    if (!config.apiKeyConfigured || !config.backlogKeyConfigured) notify('欢迎使用 Ticket。点击「配置工作台」，分别保存模型 API 和 Backlog 配置后即可开始。');
  });
}
boot();
