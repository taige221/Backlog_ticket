#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, chmod, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { rg: { type: 'string' }, out: { type: 'string' }, 'no-zip': { type: 'boolean' } } });
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('免依赖发行包请在 macOS 或 Windows 上构建；Linux 可用 npm run web 开发运行。');
const name = `Ticket-web-${process.platform}-${process.arch}`;
const output = path.resolve(values.out || path.join(root, 'dist', name));
try { await access(output); throw new Error(`输出目录已存在，未覆盖：${output}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const rg = values.rg || (await exec(process.platform === 'win32' ? 'where.exe' : 'which', ['rg'])).stdout.trim().split(/\r?\n/)[0];
await exec(rg, ['--version']);
const metadata = JSON.parse(await readFile(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'));
const revision = metadata.browsers.find(browser => browser.name === 'chromium').revision;
let browserSource = path.dirname(chromium.executablePath());
while (path.basename(browserSource) !== `chromium-${revision}`) {
  const parent = path.dirname(browserSource);
  if (parent === browserSource) throw new Error('找不到匹配当前 Playwright 的 Chromium，请先运行 npx playwright install chromium');
  browserSource = parent;
}
await access(chromium.executablePath());
const nodeLicense = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'LICENSE' : '../LICENSE');
await access(nodeLicense);
await mkdir(path.join(output, 'runtime'), { recursive: true });
for (const directory of ['src', 'bin', 'web', 'licenses']) await cp(path.join(root, directory), path.join(output, directory), { recursive: true });
await cp(path.join(root, 'package.json'), path.join(output, 'package.json'));
for (const dependency of ['playwright', 'playwright-core']) await cp(path.join(root, 'node_modules', dependency), path.join(output, 'node_modules', dependency), { recursive: true });
await cp(process.execPath, path.join(output, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
await cp(rg, path.join(output, 'runtime', process.platform === 'win32' ? 'rg.exe' : 'rg'));
await cp(nodeLicense, path.join(output, 'licenses', 'Node-LICENSE'));
// Chromium's macOS framework uses relative links that must stay inside the bundle.
await cp(browserSource, path.join(output, 'browsers', `chromium-${revision}`), { recursive: true, verbatimSymlinks: true });
const cache = path.dirname(browserSource);
for (const directory of await import('node:fs/promises').then(fs => fs.readdir(cache))) {
  if (/^(winldd|ffmpeg)-\d+$/.test(directory)) await cp(path.join(cache, directory), path.join(output, 'browsers', directory), { recursive: true });
}
const launcher = process.platform === 'win32' ? '启动 Ticket.cmd' : '启动 Ticket.command';
const script = process.platform === 'win32'
  ? '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0bin\\web.js" %*\r\nif errorlevel 1 pause\r\n'
  : '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nexport PATH="$PWD/runtime:/usr/bin:/bin:/usr/sbin:/sbin"\nexec "$PWD/runtime/node" "$PWD/bin/web.js" "$@"\n';
await writeFile(path.join(output, launcher), script, { mode: 0o755 });
await chmod(path.join(output, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), 0o755);
await chmod(path.join(output, 'runtime', process.platform === 'win32' ? 'rg.exe' : 'rg'), 0o755);
await cp(path.join(root, 'README.md'), path.join(output, 'README.md'));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile(path.join(output, 'build-manifest.json'), JSON.stringify({ builtAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, ripgrep: (await exec(rg, ['--version'])).stdout.split('\n')[0], chromium: revision,
  sha256: { node: await hash(process.execPath), rg: await hash(rg) }, includesUserConfiguration: false }, null, 2));
console.log(`免依赖目录已生成：${output}`);
if (!values['no-zip']) {
  const zip = `${output}.zip`;
  try { await access(zip); throw new Error(`ZIP 已存在，未覆盖：${zip}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.platform === 'darwin') await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', output, zip], { maxBuffer: 1024 * 1024 });
  else {
    const command = 'Compress-Archive -LiteralPath $env:TICKET_PACKAGE_SOURCE -DestinationPath $env:TICKET_PACKAGE_ZIP';
    await exec('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { env: { ...process.env, TICKET_PACKAGE_SOURCE: output, TICKET_PACKAGE_ZIP: zip } });
  }
  console.log(`ZIP：${zip}（${Math.round((await stat(zip)).size / 1024 / 1024)} MiB）`);
}
