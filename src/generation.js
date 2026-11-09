import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveJson, replacePrivateJson } from './config.js';
import { modelAccount, responseThoughts, responseUsage, sumUsage } from './usage.js';
import { selectedEffort } from './models.js';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
function generationView(run) {
  return { id: run.id, rootId: run.rootId, model: run.model, reasoningEffort: run.reasoningEffort, state: run.state, retrying: Boolean(run.retrying), startedAt: run.startedAt, events: run.events, thoughts: run.thoughts, thoughtsTruncated: run.thoughtsTruncated, usage: sumUsage(run.rounds), error: run.error };
}

export async function startGeneration(directory, id, rootId, config, env) {
  const account = modelAccount(config, env), file = path.join(directory, 'runs', `${id}.json`);
  const run = { id, rootId, account: account.id, model: config.model.name, reasoningEffort: selectedEffort(config.model), state: 'running', startedAt: new Date().toISOString(), events: [], thoughts: [], rounds: [], thoughtsTruncated: false };
  await saveJson(file, run);
  let original = JSON.stringify(run, null, 2) + '\n';
  const persist = async () => {
    await replacePrivateJson(file, run, original); original = JSON.stringify(run, null, 2) + '\n';
  };
  const log = message => { run.events.push({ at: new Date().toISOString(), text: String(message).slice(0, 500) }); run.events = run.events.slice(-100); };
  return {
    id, rootId, log, view: () => generationView(run),
    async onEvent(event) {
      if (event.type === 'request') run.rounds[event.round - 1] = {};
      else if (event.type === 'retry') run.retrying = true;
      else if (event.type === 'response') {
        run.retrying = false;
        run.rounds[event.round - 1] = responseUsage(event.data, account.openrouter);
        const thought = responseThoughts(event.data), remaining = 30_000 - run.thoughts.reduce((sum, item) => sum + item.text.length, 0);
        if (thought && remaining > 0) run.thoughts.push({ round: event.round, text: thought.slice(0, remaining) });
        if (thought.length > remaining) run.thoughtsTruncated = true;
      }
      await persist();
    },
    async finish(error) { run.state = error?.name === 'AbortError' ? 'cancelled' : error ? 'error' : 'complete'; run.retrying = false; if (error) run.error = error.code ? '本地操作未完成' : error.message; await persist(); },
  };
}

async function readRuns(directory) {
  const folder = path.join(directory, 'runs'), files = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const runs = []; let unreadableRuns = 0;
  for (const file of files.filter(file => /^[a-zA-Z0-9_-]+\.json$/.test(file))) {
    try { const run = JSON.parse(await readFile(path.join(folder, file), 'utf8')); if (run.id === file.slice(0, -5) && validId(run.id) && validId(run.rootId) && Array.isArray(run.rounds)) runs.push(run); else unreadableRuns++; } catch { unreadableRuns++; }
  }
  return { runs, unreadableRuns };
}

export async function savedGeneration(directory, id) {
  if (!validId(id)) return null;
  try {
    const run = JSON.parse(await readFile(path.join(directory, 'runs', `${id}.json`), 'utf8'));
    if (run.id !== id || !validId(run.rootId) || !Array.isArray(run.rounds) || !Array.isArray(run.events) || !Array.isArray(run.thoughts)) return null;
    return generationView(run);
  }
  catch { return null; }
}

export async function recordedUsage(directory, rootId, config, env) {
  if (!validId(rootId)) throw new Error('对话编号无效');
  const { runs, unreadableRuns } = await readRuns(directory), conversation = runs.filter(run => run.rootId === rootId);
  let account;
  try { account = modelAccount(config, env).id; } catch { /* Startup may be unconfigured. */ }
  const local = account ? runs.filter(run => run.account === account) : [];
  return { conversation: sumUsage(conversation.flatMap(run => run.rounds)), recordedRuns: conversation.length, unreadableRuns, localAccount: account ? sumUsage(local.flatMap(run => run.rounds)) : null };
}
