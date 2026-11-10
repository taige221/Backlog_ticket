#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, 'runtime');
if (existsSync(runtime)) process.env.PATH = `${runtime}${path.delimiter}${process.env.PATH || ''}`;
if (existsSync(path.join(root, 'browsers'))) process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'browsers');
const { values } = parseArgs({ options: {
  config: { type: 'string' }, 'no-open': { type: 'boolean' }, port: { type: 'string' },
  'no-template': { type: 'boolean' }, 'no-templates': { type: 'boolean' },
} });
// Without the -- separator, npm 10 passes negated options as config variables.
const npmSkippedTemplates = process.env.npm_lifecycle_event === 'web'
  && [process.env.npm_config_template, process.env.npm_config_templates].some(value => value === '' || value === 'false');
const noTemplate = Boolean(values['no-template'] || values['no-templates'] || npmSkippedTemplates);
const { startWebServer } = await import('../src/web-server.js');
try {
  const app = await startWebServer({ filename: values.config, port: values.port ? Number(values.port) : undefined, noTemplate });
  console.log(`Ticket 本地网页版已启动：${app.url}`);
  if (noTemplate) console.log('新草稿将跳过 Backlog 模板。');
  console.log('保持此窗口开启；网页「退出应用」或关闭启动器可结束服务。');
  const close = () => { void app.close().then(() => process.exit(0)); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, close);
  if (!values['no-open']) {
    const command = process.platform === 'darwin' ? ['open', [app.url]] : process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', app.url]] : ['xdg-open', [app.url]];
    execFile(command[0], command[1], error => { if (error) console.error('无法自动打开浏览器，请复制上方本机地址访问。'); });
  }
} catch (error) { console.error(`无法启动 Ticket：${error.code || error.message}`); process.exitCode = 1; }
