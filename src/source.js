import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
export const sourceReadLimit = 400;
const blockedPart = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git|\.aws|\.ssh|\.codex|\.agents|\.ticket|node_modules|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.local\.json|.*\.(?:pem|key|p12|pfx))$/i;
export const safePath = (file) => !file.split(/[\\/]/).some(part => blockedPart.test(part));

export async function openSource(directory, { signal } = {}) {
  signal?.throwIfAborted();
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new Error('代码源必须是目录');
  let listing;
  try { listing = await exec('rg', ['--files', '--hidden', '--no-require-git', '-g', '!.git', '-g', '!node_modules', '-g', '!.ticket'], { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 15_000, signal }); }
  catch { signal?.throwIfAborted(); throw new Error('代码索引失败。请安装 ripgrep（rg）并确认代码目录可读'); }
  const files = new Set(listing.stdout.split(/\r?\n/).filter(file => file && safePath(file)));
  const evidence = [];
  const resolveFile = async (file) => {
    if (typeof file !== 'string' || !files.has(file)) throw new Error('文件不在允许的代码索引中');
    const resolved = await realpath(path.join(root, file));
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !safePath(relative)) throw new Error('拒绝读取代码目录外或受保护文件');
    if ((await stat(resolved)).size > 256 * 1024) throw new Error('文件超过 256 KiB，跳过');
    return resolved;
  };
  let revision = 'unknown', dirty = null;
  try {
    revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5000, signal })).stdout.trim();
    dirty = Boolean((await exec('git', ['status', '--porcelain'], { cwd: root, timeout: 5000, signal })).stdout.trim());
  } catch { signal?.throwIfAborted(); /* A local source directory does not have to be a Git checkout. */ }
  return {
    snapshot: { revision, dirty }, evidence,
    async call(name, args) {
      signal?.throwIfAborted();
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象');
      if (name === 'list_files') {
        const query = String(args.query ?? '').replaceAll('\\', '/').toLowerCase();
        return [...files].filter(file => file.replaceAll('\\', '/').toLowerCase().includes(query)).slice(0, 300);
      }
      if (name === 'read_file') {
        if (Object.keys(args).some(key => !['path', 'start', 'end'].includes(key))) throw new Error('read_file 仅支持 path、start、end；行号从1开始且包含end，例如 {"path":"src/App.tsx","start":201,"end":600}');
        const start = args.start ?? 1, end = args.end ?? start + sourceReadLimit - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('start、end 必须是正整数且 end >= start；范围包含两端，超出单次上限会自动分段');
        const text = await readFile(await resolveFile(args.path), { encoding: 'utf8', signal });
        if (text.includes('\0')) throw new Error('不读取二进制文件');
        const lines = text.split(/\r?\n/);
        if (start > lines.length) throw new Error('起始行超过文件长度');
        const excerpt = []; let length = 0;
        for (let i = start - 1; i < Math.min(end, start + sourceReadLimit - 1, lines.length); i++) {
          const line = `${i + 1}: ${lines[i]}`;
          if (length + line.length + 1 > 24_000) break;
          excerpt.push(line); length += line.length + 1;
        }
        if (!excerpt.length) throw new Error('该行超过单次24000字符上限，请用 search_code 定位相关标识符，不能完整读取此行');
        const actualEnd = start + excerpt.length - 1;
        evidence.push({ path: args.path, start, end: actualEnd });
        return `file: ${args.path}\ntotalLines: ${lines.length}\nreturned: ${start}-${actualEnd}\nnextStart: ${actualEnd < lines.length ? actualEnd + 1 : 'EOF'}\n${excerpt.join('\n')}`;
      }
      if (name === 'search_code') {
        if (typeof args.query !== 'string' || !args.query || args.query.length > 200) throw new Error('搜索词需要 1～200 字符');
        let output;
        try {
          output = (await exec('rg', ['--json', '--hidden', '--no-require-git', '--fixed-strings', '--max-count', '5', '-g', '!.git', '-g', '!node_modules', '-g', '!.ticket', '--', args.query, '.'], { cwd: root, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, signal })).stdout;
        } catch (error) {
          signal?.throwIfAborted();
          if (error.code === 1) return [];
          throw new Error('代码搜索失败或结果过大，请缩小搜索词');
        }
        const found = [];
        for (const line of output.split('\n').filter(Boolean)) {
          const item = JSON.parse(line);
          if (item.type !== 'match') continue;
          const file = item.data.path.text?.replace(/^\.[\\/]/, '');
          if (!files.has(file)) continue;
          try { await resolveFile(file); } catch { continue; }
          found.push({ path: file, line: item.data.line_number, text: item.data.lines.text.slice(0, 800) });
          if (found.length === 60) break;
        }
        return found;
      }
      throw new Error('未知只读工具');
    },
  };
}
