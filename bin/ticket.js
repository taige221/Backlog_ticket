#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exampleConfig, loadConfig, saveJson, modelConfig, modelConnection, resolveConfigFile, selectedProjectRepo, withProjectRepo } from '../src/config.js';
import { generateDraft, readDraft, formatDraft } from '../src/draft.js';
import { getProjectMetadata, rememberProject, rememberProjectType, withProjectType, rememberProjectCategory, withProjectCategory } from '../src/backlog.js';
import { openPreview } from '../src/preview.js';
import { runChat } from '../src/chat.js';
import { createTerminal } from '../src/terminal.js';
import { setupModel, setupConfig, setupSection } from '../src/setup.js';
import { rememberModel, rememberEffort } from '../src/models.js';
import { runDraftActions } from '../src/draft-actions.js';
import { submitDraft } from '../src/submit.js';

const help = `ticket — 独立 AI 起票 CLI（Node.js 22+）

  ticket                              进入交互起票，首次启动输入 API Key 自动配置
  ticket init                         配置模型 API、Backlog API 和可选代码目录
  ticket config api                   单独配置模型 API Key 与服务商
  ticket config backlog               单独配置 Backlog 地址、API Key 与默认项目
  ticket config repo                  单独配置或清除代码目录
  ticket doctor                       检查配置与只读 Backlog 连接
  ticket chat                         交互起票，支持 /model、/effort、/project、/type、/category、/api、/backlog、/repo、/config
  ticket draft "问题描述" [选项]       生成本地草稿，不创建工单
  ticket show 草稿.json                显示票面、字段和待确认项
  ticket preview 草稿.json             填入官网新建页并停留在编辑表单

通用：--config 文件                    优先于环境变量 TICKET_CONFIG
      默认配置                        ~/.config/backlog-ticket/config.json
      init --template                 仅创建空配置模板（供脚本使用，不覆盖）
草稿：--repo 代码目录                  允许模型读取该目录的相关源码
      --image 截图路径                 可重复，最多5张；同时列为官网附件
      --attach 附件路径                可重复；不传模型，在预览或直接创建时上传
      --input 描述文件                 与命令行描述二选一；用 - 从 stdin 读取
      --project 项目key --type 类型名 --assignee 完整显示名
      --category 分类名                使用项目已有カテゴリー，标题加【分类名】
      --start YYYY-MM-DD --due YYYY-MM-DD --language zh-CN|ja|en
      --notify 完整显示名               可重复；可不选，创建时通知这些项目成员
      日期默认                         本机今天开始，截止于今天之后最近的周五
      --metadata                       额外读取项目用户，用于负责人校验
      --no-template                    跳过类型模板；选择分类时仍校验项目分类
      --out 草稿路径                    默认 <配置目录>/drafts/<时间>.json，不覆盖
说明：preview 使用专用 Chromium 登录目录；首次须登录，不会自动提交。
交互起票显示草稿后可选 1 填入官网、2 直接创建、3 修改；也可直接输入修改要求。
已配置目标项目时使用该项目已选类型的模板，未选时默认 Task；--type 可覆盖。
模型仅支持配置的 Responses 或 Chat Completions 协议，服务须支持图片/工具调用。
使用 --repo/--image 会把相关源码/截图发送给配置的模型服务。`;

async function createDraft(config, values, filename, request, previous, interactive = false, signal) {
  const model = modelConfig(config);
  const before = previous?.draft;
  if (before?.target) config = { ...config, backlog: { ...config.backlog, ...before.target } };
  console.error(`使用模型：${model.name}；模型服务：${new URL(model.baseUrl).origin}；代码源：${values.repo || selectedProjectRepo(config) || '无'}；截图：${values.image?.length || 0} 张。`);
  const draft = await generateDraft(config, { request, previousDraft: before, images: values.image, attachments: before ? before.attachments : values.attach, repo: values.repo, project: before?.target?.project || values.project,
    issueType: before ? before.issueType : values.type, category: before ? before.category : values.category, assignee: before ? before.assignee : values.assignee, notifiedUsers: before ? before.notifiedUsers : values.notify, startDate: before ? before.startDate : values.start, dueDate: before ? before.dueDate : values.due, language: values.language, metadata: values['no-template'] ? false : values.metadata },
    { log: message => console.error(message), signal });
  signal?.throwIfAborted();
  if (previous) draft.revisionOf = previous.filename;
  const output = path.resolve(values.out || path.join(path.dirname(filename), 'drafts', `${Date.now()}-${randomUUID().slice(0, 8)}.json`));
  await saveJson(output, draft);
  console.log(formatDraft(draft));
  console.log(`\n草稿：${output}${interactive ? '' : `\n下一步：ticket preview ${JSON.stringify(output)} --config ${JSON.stringify(filename)}`}`);
  return { draft, filename: output };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, repo: { type: 'string' }, image: { type: 'string', multiple: true }, attach: { type: 'string', multiple: true },
    input: { type: 'string' }, project: { type: 'string' }, type: { type: 'string' }, category: { type: 'string' }, assignee: { type: 'string' },
    start: { type: 'string' }, due: { type: 'string' }, notify: { type: 'string', multiple: true }, language: { type: 'string' }, out: { type: 'string' },
    metadata: { type: 'boolean' }, 'no-template': { type: 'boolean' }, template: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  let [command, ...args] = positionals;
  if (values.metadata && values['no-template']) throw new Error('--metadata 与 --no-template 不能同时使用');
  if (!command && process.stdin.isTTY && !values.help) command = 'chat';
  if (!command || values.help) return console.log(help);
  if (!['init', 'config', 'doctor', 'chat', 'draft', 'show', 'preview'].includes(command)) throw new Error(`未知命令：${command}。使用 --help 查看用法`);
  const filename = resolveConfigFile(values.config);
  if (command === 'config') {
    if (!args.length) return console.log('用法：ticket config api|backlog|repo [--config 文件]\napi：模型 API；backlog：Backlog API 与项目；repo：可选代码目录。');
    if (args.length !== 1 || !['api', 'backlog', 'repo'].includes(args[0])) throw new Error('用法：ticket config api|backlog|repo [--config 文件]');
    const terminal = createTerminal();
    try { await setupSection(filename, args[0], terminal); }
    finally { terminal.close(); }
    return;
  }
  if (command === 'init') {
    if (args.length) throw new Error('init 不接收位置参数');
    if (values.template) {
      await saveJson(filename, exampleConfig);
      return console.log(`空配置模板已创建：${filename}\n运行 ticket init 完成模型、Backlog 和代码目录配置。`);
    }
    const terminal = createTerminal();
    try { await setupConfig(filename, terminal); }
    finally { terminal.close(); }
    return;
  }
  if (command === 'show') {
    if (args.length !== 1) throw new Error('用法：ticket show 草稿.json');
    return console.log(formatDraft(await readDraft(args[0])));
  }
  let config = await loadConfig(filename, { allowMissing: command === 'chat' });
  if (values.project) config.backlog = { ...config.backlog, project: values.project };
  if (command === 'chat') {
    if (args.length || values.input || values.out) throw new Error('chat 不接收描述参数、--input 或 --out；请在提示符中输入描述，每份草稿自动保存');
    if (!process.stdin.isTTY) throw new Error('chat 需要交互终端；脚本调用请用 ticket draft');
    const terminal = createTerminal();
    try {
      let ready = false;
      try { modelConnection(config); ready = true; } catch { /* First use is configured interactively. */ }
      if (!ready) config = await setupModel(filename, terminal);
      if (values.project) config.backlog = { ...config.backlog, project: values.project };
      if (values.repo) {
        config = withProjectRepo(config, path.resolve(values.repo));
        delete values.repo;
      }
      if (values.type && config.backlog?.project) config.backlog = withProjectType(config.backlog, values.type);
      if (values.category !== undefined && config.backlog?.project) config.backlog = withProjectCategory(config.backlog, values.category);
      await runChat(config, { filename, signal: terminal.signal, ask: terminal.ask, selectModel: terminal.selectModel, selectEffort: terminal.selectEffort, selectProject: terminal.selectProject, selectType: terminal.selectType, selectCategory: terminal.selectCategory, initialCommand: config.model?.name ? null : '/model',
        persistModel: (selected, model) => rememberModel(filename, model, selected),
        persistEffort: (effort, model) => rememberEffort(filename, model, effort),
        persistProject: async (selected, backlog) => { await rememberProject(filename, backlog, selected); delete values.project; delete values.type; delete values.category; },
        persistType: async (selected, backlog) => { await rememberProjectType(filename, backlog, selected); delete values.type; },
        persistCategory: async (selected, backlog) => { await rememberProjectCategory(filename, backlog, selected); delete values.category; },
        configure: async (scope, target) => {
          const updated = await setupSection(filename, scope, { ...terminal, repoTarget: target });
          if (scope === 'backlog') { delete values.project; delete values.type; delete values.category; }
          return updated;
        },
        generate: (selected, request) => createDraft(selected, values, filename, request, undefined, true, terminal.signal),
        actOnDraft: (selected, draft) => runDraftActions(selected, draft, {
          ask: terminal.ask,
          preview: async current => {
            const result = await openPreview(current.draft, selected, { profileDir: path.join(path.dirname(filename), 'browser-profile'), ask: terminal.ask, signal: terminal.signal });
            if (result?.url) {
              try { await saveJson(`${draft.filename}.submission.json`, { state: 'browser-opened', ...result }); }
              catch { console.error(`浏览器已打开工单，请保存链接：${result.url}；本地提交记录未更新。`); }
            }
            return result;
          },
          create: (current, currentConfig, originalFile) => submitDraft(current.draft, currentConfig, { receiptFile: `${originalFile}.submission.json`, signal: terminal.signal }),
          revise: (current, instruction) => createDraft(selected, values, filename, instruction, current, true, terminal.signal),
        }) });
    } finally { terminal.close(); }
    return;
  }
  if (command === 'doctor') {
    modelConnection(config);
    console.log('模型服务配置与凭据齐备（未调用模型，兼容性未验证）。');
    if (config.backlog?.origin && config.backlog?.project) {
      const metadata = await getProjectMetadata(config);
      console.log(JSON.stringify(metadata, null, 2));
    } else console.log('未配置 Backlog；仍可生成无目标的本地草稿。');
    return;
  }
  if (command === 'draft') {
    if (args.length && values.input) throw new Error('问题描述与 --input 只能选一种');
    let request = args.join(' ');
    if (values.input === '-') {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      request = Buffer.concat(chunks).toString('utf8');
    } else if (values.input) request = await readFile(values.input, 'utf8');
    if (!request.trim()) throw new Error('请提供问题描述或 --input 文件');
    await createDraft(config, values, filename, request);
    return;
  }
  if (args.length !== 1) throw new Error('用法：ticket preview 草稿.json');
  if (!process.stdin.isTTY) throw new Error('preview 需要交互终端，以便确认浏览器登录与目标页面');
  const terminal = createTerminal();
  try {
    const draft = await readDraft(args[0]);
    console.log(formatDraft(draft));
    await openPreview(draft, config, { profileDir: path.join(path.dirname(filename), 'browser-profile'), ask: terminal.ask, signal: terminal.signal });
  } finally { terminal.close(); }
}

main().catch(error => { console.error(`错误：${error.code ? `本地操作失败（${error.code}）` : error.message}`); process.exitCode = 1; });
