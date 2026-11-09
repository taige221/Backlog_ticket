import { mkdir, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { httpUrl, projectKey } from './config.js';
import { validateDraft, withDefaultSchedule } from './draft.js';
import { get, listCategories, resolveCategory, categorySummary, listProjectUsers, resolveProjectUser } from './backlog.js';
import { attachmentImages, inlineImageDescription } from './attachments.js';

export function previewTarget(draft, config) {
  const origin = httpUrl(config.backlog?.origin, 'Backlog 地址', { originOnly: true });
  const project = projectKey(config.backlog?.project);
  if (draft.target && (draft.target.origin !== origin || draft.target.project !== project)) throw new Error('草稿目标与当前配置不同；请使用对应配置，避免填错项目');
  return { origin, project, url: `${origin}/add/${project}` };
}

const labels = {
  title: /^(件名|Subject|Summary)$/i,
  description: /^(description text area|Description)$/i,
  type: /^(種別|Issue type)$/i,
  assignee: /^(担当者|Assignee)$/i,
  files: /^(ファイルを選択(?:する)?|Select files?|Choose files?)[.．…]*$/i,
  category: /^(カテゴリー|Category)$/i,
  notify: /^(課題の追加をお知らせしたいユーザー|Users to notify|Notify users)$/i,
};

async function choose(page, label, value) {
  const control = page.getByRole('combobox', { name: label, exact: true });
  const selected = () => control.evaluate(element => element.tagName === 'SELECT' ? element.selectedOptions[0]?.textContent : (element.value || element.textContent));
  if ((await selected())?.trim() === value) return;
  if (await control.evaluate(element => element.tagName) === 'SELECT') {
    await control.selectOption({ label: value });
  } else {
    await control.click();
    const option = page.getByRole('option', { name: value, exact: true });
    if (await option.count()) await option.click();
    else await page.getByText(value, { exact: true }).last().click();
  }
  const actual = await selected();
  if (actual?.trim() !== value) throw new Error(`字段选择结果未匹配：${value}，已停止`);
}

function checkDescription(element, expected) {
  // ProseMirror's innerText adds extra newlines between its plain-text paragraphs.
  const actual = !element.isContentEditable ? element.value
    : element.classList.contains('ProseMirror') && [...element.children].every(child => child.tagName === 'P')
      ? [...element.children].map(child => child.textContent).join('\n') : element.innerText;
  if (actual !== expected) return false;
  const doc = element.pmViewDesc?.node;
  if (doc?.type?.name === 'doc' && typeof doc.forEach === 'function') {
    const blocks = [];
    doc.forEach(block => blocks.push(block));
    if (blocks.every(block => block.type.name === 'paragraph') && blocks.map(block => block.textContent).join('\n') !== expected) return false;
  }
  return true;
}

function waitForUploadedImageText(element, names) {
  return new Promise(resolve => {
    const check = () => names.every(name => (element.isContentEditable ? element.textContent : element.value).includes(name));
    if (check()) return resolve();
    const poll = setInterval(() => { if (check()) finish(); }, 25);
    // A ready attachment button can appear before the editor inserts its reference.
    // The deadline also allows variants that only attach the file to continue.
    const timeout = setTimeout(finish, 15_000);
    function finish() { clearInterval(poll); clearTimeout(timeout); resolve(); }
  });
}

export async function fillDraftForm(page, draft, { imageNames = [] } = {}) {
  draft = withDefaultSchedule(draft);
  draft = { ...draft, summary: categorySummary(draft.summary, draft.category) };
  validateDraft(draft);
  // Never choose restore/delete on someone else's draft automatically.
  if (await page.getByText('自動バックアップされた変更内容があります', { exact: true }).first().isVisible()) throw new Error('官网存在自动备份草稿，请在浏览器中手动处理后重试');
  if (draft.issueType) {
    await choose(page, labels.type, draft.issueType);
    const keepBody = page.getByRole('button', { name: '種別のみ変更する', exact: true });
    if (await keepBody.isVisible()) await keepBody.click();
  }
  const title = page.getByRole('textbox', { name: labels.title });
  const description = page.getByRole('textbox', { name: labels.description });
  if (draft.category) await choose(page, labels.category, draft.category);
  await title.fill(draft.summary);
  if (draft.assignee) await choose(page, labels.assignee, draft.assignee);
  for (const [field, names] of [['startDate', /^(startDate|Start Date)$/i], ['dueDate', /^(dueDate|Due Date)$/i]]) {
    if (!draft[field]) continue;
    const input = page.getByRole('textbox', { name: names });
    await input.fill(draft[field].replaceAll('-', '/'));
    await input.press('Tab');
    if ((await input.inputValue()).replaceAll('/', '-') !== draft[field]) throw new Error(`${field} 填写未生效，已停止`);
  }
  if (draft.attachments.length) {
    // Keep the real body out of the editor while Backlog is adding upload references.
    if (imageNames.length) await description.fill('');
    let remaining = draft.attachments;
    while (remaining.length) {
      // Backlog creates its file input on demand; register before opening it.
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('button', { name: labels.files, exact: true }).click(),
      ]);
      const batch = chooser.isMultiple() ? remaining : remaining.slice(0, 1);
      await chooser.setFiles(batch);
      // The upload queue shows names early; the attachment button appears when ready.
      for (const file of batch) await page.getByRole('button', { name: path.basename(file), exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 60_000 });
      remaining = remaining.slice(batch.length);
    }
    if (imageNames.length) await description.evaluate(waitForUploadedImageText, imageNames);
  }
  const matches = () => description.evaluate(checkDescription, draft.description);
  await description.fill(draft.description);
  if (!await matches()) {
    await description.fill(draft.description);
    if (!await matches()) throw new Error('正文被模板或页面改写，恢复后仍不一致，请在编辑页检查');
  }
  if (draft.notifiedUsers?.length) {
    const input = page.getByRole('textbox', { name: labels.notify });
    const picker = input.locator('..').locator('..');
    const select2 = await input.evaluate(element => element.classList.contains('select2-input'));
    const localPicker = !select2 && await picker.getByRole('textbox').count() === 1 && await picker.getByRole('combobox').count() === 0;
    const names = [...new Set(draft.notifiedUsers)];
    const selected = name => (select2 ? picker.locator('.select2-search-choice') : picker)
      .getByText(name, { exact: true }).filter({ visible: true }).first();
    for (const name of names) {
      // Backlog renders its named candidate list outside the input's container.
      const option = page.getByRole('option', { name, exact: true }).or(
        page.getByRole('list', { name: labels.notify, exact: true }).getByText(name, { exact: true }));
      const candidates = localPicker ? option.or(picker.getByText(name, { exact: true })) : option;
      const chip = selected(name);
      for (let attempt = 0; ; attempt++) {
        if (select2 && await chip.isVisible()) break;
        try {
          // Select2 may keep focus after closing; filling alone does not reopen its results.
          await input.click();
          await input.fill(name);
          if (select2) await input.and(page.locator('input:not(.select2-active)')).waitFor({ state: 'visible', timeout: 5_000 });
          await candidates.filter({ visible: true }).last().click({ timeout: 5_000 });
          await chip.waitFor({ state: 'visible', timeout: 5_000 });
          if (await input.inputValue() !== '') throw new Error(`通知对象选择未生效：${name}，请在编辑页检查`);
          break;
        } catch (error) {
          if (error.name !== 'TimeoutError') throw error;
          if (attempt) throw new Error(`未能添加通知对象「${name}」。请在 Backlog 中检查候选名单。`, { cause: error });
          await input.press('Escape');
        }
      }
    }
    const missing = [];
    for (const name of names) if (!await selected(name).isVisible()) missing.push(name);
    if (missing.length) throw new Error(`通知对象只保留了 ${names.length - missing.length}/${names.length} 位，缺少：${missing.join('、')}。请在编辑页检查。`);
  }
  if (await title.inputValue() !== draft.summary) throw new Error('标题被模板或页面改写，请在编辑页检查');
  // Blur directly because the editor can interpret Tab as checklist indentation.
  if (imageNames.length) await description.blur();
  if (!await matches()) {
    await description.fill(draft.description);
    if (imageNames.length) await description.blur();
    if (!await matches()) throw new Error('正文被页面再次改写，请在编辑页检查附件上传状态');
  }
}

export async function openPreview(draft, config, { profileDir, ask, signal, log = console.log, chromium: injectedChromium, fetchImpl = fetch, env = process.env } = {}) {
  draft = withDefaultSchedule(draft);
  validateDraft(draft);
  const target = previewTarget(draft, config);
  if (draft.category) resolveCategory(await listCategories(config, { fetchImpl, env, signal }), draft.category);
  if (draft.assignee || draft.notifiedUsers?.length) {
    const users = await listProjectUsers(config, { fetchImpl, env, signal });
    for (const name of new Set([draft.assignee, ...(draft.notifiedUsers || [])].filter(Boolean))) resolveProjectUser(users, name);
  }
  for (const file of draft.attachments) {
    if (!(await stat(file)).isFile()) throw new Error(`附件不是文件：${file}`);
  }
  const images = await attachmentImages(draft.attachments);
  if (images.length) {
    const project = await get(config, `projects/${target.project}`, { fetchImpl, env, signal });
    if (project?.projectKey !== target.project) throw new Error('Backlog 项目不匹配，未填写');
    draft = { ...draft, description: inlineImageDescription(draft.description, images, project.textFormattingRule) };
  }
  let chromium = injectedChromium;
  if (!chromium) {
    try { ({ chromium } = await import('playwright')); }
    catch { throw new Error('缺少浏览器依赖，请先运行 npm install'); }
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
  let context;
  try { context = await chromium.launchPersistentContext(profileDir, { headless: false }); }
  catch { throw new Error('无法启动专用浏览器。请运行 npx playwright install chromium，并确认没有另一进程使用该登录目录'); }
  const lifecycle = new AbortController();
  context.once('close', () => lifecycle.abort());
  const abort = () => { lifecycle.abort(); void context.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const finish = async () => {
    try { await ask('按回车关闭预览浏览器并返回；也可手动关闭浏览器。Ctrl+C 退出 CLI：', { signal: lifecycle.signal }); }
    catch (error) { if (!lifecycle.signal.aborted) throw error; }
  };
  let openedIssue;
  try {
    if (signal?.aborted) return;
    const page = context.pages()[0] ?? await context.newPage();
    page.once?.('close', abort);
    page.on?.('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      const url = new URL(frame.url());
      if (url.origin === target.origin && new RegExp(`^/view/${target.project}-[0-9]+$`).test(url.pathname)) {
        openedIssue = { issueKey: url.pathname.slice('/view/'.length), url: `${url.origin}${url.pathname}` };
      }
    });
    page.setDefaultTimeout(15_000);
    try { await page.goto(target.url, { waitUntil: 'domcontentloaded' }); }
    catch { log('新建页自动打开失败，请在浏览器中重新加载目标地址，进入新建表单后再继续。'); }
    log('请在专用浏览器中完成登录。如有旧备份，先手动恢复或删除；本工具不会自动覆盖。');
    await ask('确认已进入目标项目的新建表单后，按回车开始填入（不会提交）：', { signal: lifecycle.signal });
    const current = new URL(page.url());
    if (current.origin !== target.origin || current.pathname !== `/add/${target.project}`) throw new Error('当前页面不是目标项目新建页，已停止');
    log(`将填入 ${draft.attachments.length} 个附件。内容会传至该 Backlog 站点。`);
    await fillDraftForm(page, draft, { imageNames: images.map(file => path.basename(file)) });
    log('已填入官网新建表单。可在编辑页检查和修改，确认后可手动点击「追加」。');
    await finish();
    return openedIssue;
  } catch (error) {
    if (lifecycle.signal.aborted) return openedIssue;
    log(`填写失败：${error.message}`);
    log('浏览器保留供检查。');
    await finish();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await context.close();
  }
}
