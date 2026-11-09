import { readdir, readFile, lstat, realpath, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const idPattern = new RegExp(`^${uuid}$`, 'i'), entryPattern = new RegExp(`^(${uuid})(\\.json)?$`, 'i');
export const uploadId = value => typeof value === 'string' && idPattern.test(value);
const entries = directory => readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });

async function inspect(dataDir) {
  const directory = path.join(dataDir, 'uploads'), groups = new Map(), referenced = new Set();
  let blocked = false;
  const root = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (root && (!root.isDirectory() || root.isSymbolicLink())) throw new Error('附件目录不是普通目录，已停止清理');
  const physicalDirectory = root ? await realpath(directory) : directory;
  // Scan every saved version, including drafts outside the recent 50-item list.
  for (const entry of await entries(path.join(dataDir, 'drafts'))) {
    if (!/\.json$/i.test(entry.name) || /\.submission\.json$/i.test(entry.name)) continue;
    try {
      if (!entry.isFile()) throw new Error('草稿不是普通文件');
      const draft = JSON.parse(await readFile(path.join(dataDir, 'drafts', entry.name), 'utf8'));
      if (!Array.isArray(draft.attachments) || draft.attachments.some(file => typeof file !== 'string')) throw new Error('附件记录无效');
      for (const file of draft.attachments) {
        const resolved = path.resolve(dataDir, 'drafts', file);
        const physicalFile = await realpath(resolved).catch(error => { if (error.code === 'ENOENT') return resolved; throw error; });
        const relative = path.relative(physicalDirectory, physicalFile);
        const id = relative.split(path.sep)[0];
        if (uploadId(id)) referenced.add(id.toLowerCase());
      }
    } catch { blocked = true; }
  }
  for (const entry of await entries(directory)) {
    const match = entry.name.match(entryPattern);
    if (!match) { blocked = true; continue; }
    const id = match[1].toLowerCase();
    const group = groups.get(id) || { id, bytes: 0, files: 0, paths: [], folder: null };
    groups.set(id, group);
    const file = path.join(directory, entry.name);
    if (!match[2] && entry.isDirectory()) {
      group.folder = file;
      for (const child of await entries(file)) {
        if (!child.isFile()) { blocked = true; continue; }
        const childPath = path.join(file, child.name);
        group.bytes += (await lstat(childPath)).size; group.files++; group.paths.push(childPath);
      }
    } else if (match[2] && entry.isFile()) {
      group.bytes += (await lstat(file)).size; group.paths.push(file);
    } else blocked = true;
  }
  const storage = { directory, bytes: 0, files: 0, retainedBytes: 0, unusedBytes: 0, blocked };
  for (const group of groups.values()) {
    storage.bytes += group.bytes; storage.files += group.files;
    storage[referenced.has(group.id) ? 'retainedBytes' : 'unusedBytes'] += group.bytes;
  }
  return { storage, groups, referenced };
}

export async function uploadStorage(dataDir) {
  return (await inspect(dataDir)).storage;
}

export async function cleanUploads(dataDir, { ids, keepIds = [], keepReferenced = false } = {}) {
  if ((ids && (!Array.isArray(ids) || ids.some(id => !uploadId(id)))) || !Array.isArray(keepIds) || keepIds.length > 10 || keepIds.some(id => !uploadId(id))) throw new Error('附件编号无效');
  const { storage, groups, referenced } = await inspect(dataDir);
  if (storage.blocked) throw new Error('有草稿无法检查或附件目录包含异常条目，已停止清理，避免误删');
  if (!keepReferenced && ids?.some(id => referenced.has(id.toLowerCase()))) throw new Error('附件仍被已保存草稿引用，已保留');
  const keep = new Set([...referenced, ...keepIds.map(id => id.toLowerCase())]), selected = ids ? new Set(ids.map(id => id.toLowerCase())) : null;
  let freedBytes = 0, removedFiles = 0;
  for (const group of groups.values()) {
    if (keep.has(group.id) || (selected && !selected.has(group.id))) continue;
    for (const file of group.paths) await unlink(file);
    if (group.folder) await rmdir(group.folder);
    freedBytes += group.bytes; removedFiles += group.files;
  }
  return { storage: await uploadStorage(dataDir), freedBytes, removedFiles };
}
