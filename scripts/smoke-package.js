import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = path.resolve(process.argv[2]);
const windows = process.platform === 'win32';
const launcher = windows ? '启动 Ticket.cmd' : '启动 Ticket.command';
await access(path.join(bundle, launcher), windows ? constants.F_OK : constants.X_OK);
const manifest = JSON.parse(await readFile(path.join(bundle, 'build-manifest.json'), 'utf8'));
assert.equal(manifest.platform, process.platform);
assert.equal(manifest.arch, process.arch);
assert.equal(manifest.node, process.version);
assert.match(execFileSync(path.join(bundle, 'runtime', windows ? 'rg.exe' : 'rg'), ['--version'], { encoding: 'utf8' }), /^ripgrep /);

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(bundle, 'browsers');
const { chromium } = await import(pathToFileURL(path.join(bundle, 'node_modules', 'playwright', 'index.mjs')));
const { startWebServer } = await import(pathToFileURL(path.join(bundle, 'src', 'web-server.js')));
const profile = await mkdtemp(path.join(tmpdir(), 'ticket-package-smoke-'));
let app, browser;
try {
  app = await startWebServer({ filename: path.join(profile, 'config.json'), env: {} });
  browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage();
  const [state] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/state'),
    page.goto(app.url),
  ]);
  assert(state.ok());
  const { config, drafts } = await state.json();
  assert.equal(config.apiKeyConfigured, false);
  assert.equal(config.backlogKeyConfigured, false);
  assert.deepEqual(drafts, []);
  console.log(`Verified extracted package on ${manifest.platform}-${manifest.arch}`);
} finally {
  try { await browser?.close(); }
  finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true });
  }
}
