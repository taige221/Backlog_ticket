import { open } from 'node:fs/promises';
import path from 'node:path';
import { bodyHeadings, codeLayout } from './templates.js';

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
}

export async function attachmentImages(attachments) {
  const images = [];
  for (const file of attachments) {
    const handle = await open(file, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(12), 0, 12, 0);
      if (imageMime(buffer.subarray(0, bytesRead))) images.push(file);
    } finally { await handle.close(); }
  }
  for (const file of images) {
    const name = path.basename(file);
    if (attachments.filter(item => path.basename(item) === name).length > 1) throw new Error(`图片附件同名，无法准确引用：${name}。请重命名后重试`);
  }
  return images;
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function rewriteImageReferences(description, changes, rule) {
  if (!changes.size) return description;
  const names = [...changes.keys()].map(escape).join('|');
  const references = new RegExp('(`+)(.*?)\\1|!\\[([^\\]\\r\\n]*)\\]\\[(' + names + ')\\]|#image\\((' + names + ')\\)', 'g');
  const lines = description.split(/\r?\n/);
  const { code } = codeLayout(lines, rule);
  return lines.map((line, index) => {
    if (code.has(index)) return line;
    return line.replace(references, (match, ticks, _literal, alt, markdownName, backlogName) => {
      if (ticks) return match;
      const name = markdownName ?? backlogName;
      const file = changes.get(name);
      if (!file) return '';
      if (path.basename(file) === name) return match;
      const tag = imageReference(file, rule);
      return rule === 'markdown' && alt !== undefined ? tag.replace('![image]', () => `![${alt}]`) : tag;
    });
  }).join(description.includes('\r\n') ? '\r\n' : '\n');
}

export function imageReference(file, rule) {
  if (!['markdown', 'backlog'].includes(rule)) throw new Error('无法确定项目正文格式，未上传附件；请检查 Backlog 项目设置后重试');
  const name = path.basename(file);
  if ((rule === 'markdown' ? /[\[\]\\\r\n]/ : /[()\r\n]/).test(name)) throw new Error(`图片文件名无法用于正文引用：${name}。请移除括号或换行等特殊字符后重试`);
  return rule === 'markdown' ? `![image][${name}]` : `#image(${name})`;
}

function restorePosition(old, index, lines, headings, code) {
  const oldSection = old.headings.findLastIndex(heading => heading.line < index);
  const title = old.headings[oldSection]?.title;
  const occurrence = old.headings.slice(0, oldSection).filter(heading => heading.title === title).length;
  const section = title ? headings.indexOf(headings.filter(heading => heading.title === title)[occurrence]) : -1;
  if (title && section < 0) return;
  const start = (headings[section]?.line ?? -1) + 1;
  const end = headings[section + 1]?.line ?? lines.length;
  const oldStart = (old.headings[oldSection]?.line ?? -1) + 1;
  const oldEnd = old.headings[oldSection + 1]?.line ?? old.lines.length;
  // An unchanged neighboring line keeps a manually placed image between paragraphs.
  for (const direction of [1, -1]) {
    let neighbor = index + direction;
    while (neighbor >= oldStart && neighbor < oldEnd && (!old.lines[neighbor].trim() || old.code.has(neighbor) || /^\s*(?:!\[|#image\()/.test(old.lines[neighbor]))) neighbor += direction;
    if (neighbor < oldStart || neighbor >= oldEnd) continue;
    const matches = [];
    for (let i = start; i < end; i++) if (!code.has(i) && lines[i] === old.lines[neighbor]) matches.push(i);
    if (matches.length === 1) return matches[0] + (direction < 0 ? 1 : 0);
  }
  return end;
}

function restoreInterruptedCalls(description, references, rule) {
  const newline = description.includes('\r\n') ? '\r\n' : '\n';
  const lines = description.split(/\r?\n/);
  const { code } = codeLayout(lines, rule);
  const restored = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    restored.push(line);
    if (code.has(i) || !/\b[A-Za-z_$][\w$]*\([ \t]*$/.test(line)) continue;
    let end = i + 1, sawReference = false;
    for (; end < lines.length && !code.has(end); end++) {
      const text = lines[end].trim();
      if (!text) continue;
      if (!references.test(text)) break;
      sawReference = true;
    }
    if (sawReference && end < lines.length && !code.has(end) && /^[ \t]*\)/.test(lines[end])) {
      restored[restored.length - 1] = line.trimEnd() + lines[end].trimStart();
      i = end;
    }
  }
  return restored.length < lines.length ? restored.join(newline) : description;
}

export function inlineImageDescription(description, images, rule, previousDescription = '') {
  if (!images.length) return description;
  const names = images.map(file => escape(path.basename(file))).join('|');
  const references = new RegExp(`^(?:!\\[[^\\]\\r\\n]*\\]\\[(?:${names})\\]|#image\\((?:${names})\\))$`);
  description = restoreInterruptedCalls(description, references, rule);
  if (previousDescription) previousDescription = restoreInterruptedCalls(previousDescription, references, rule);
  const newline = description.includes('\r\n') ? '\r\n' : '\n';
  const lines = description.split(/\r?\n/);
  const { code, unclosedAt } = codeLayout(lines, rule);
  const oldLines = previousDescription.split(/\r?\n/);
  const old = { lines: oldLines, headings: bodyHeadings(previousDescription, rule), code: codeLayout(oldLines, rule).code };
  const missing = [];
  let converted = false;
  for (const file of images) {
    const name = path.basename(file);
    const tag = imageReference(file, rule);
    const markdown = new RegExp(`!\\[[^\\]\\r\\n]*\\]\\[${escape(name)}\\]`);
    const backlog = new RegExp(`#image\\(${escape(name)}\\)`);
    const [reference, alternate] = rule === 'markdown' ? [markdown, backlog] : [backlog, markdown];
    // Convert references if the project's formatting rule changed since drafting.
    let found = false;
    const convert = new RegExp(alternate.source, 'g');
    for (let i = 0; i < lines.length; i++) {
      if (code.has(i)) continue;
      if (alternate.test(lines[i])) { lines[i] = lines[i].replace(convert, () => tag); converted = true; }
      if (reference.test(lines[i])) found = true;
    }
    if (found) continue;
    const oldIndex = old.lines.findIndex((line, i) => !old.code.has(i) && (reference.test(line) || alternate.test(line)));
    missing.push({ tag: oldIndex >= 0 ? old.lines[oldIndex].match(reference)?.[0] ?? tag : tag, oldIndex });
  }
  if (!missing.length) return converted ? lines.join(newline) : description;
  const headings = bodyHeadings(lines.join(newline), rule);
  let section = headings.findIndex(item => /现状|現状|现象|現象|实际(?:结果|行为)|実際の動作|复现|再現|截图|スクリーンショット|actual behavio[u]?r|current behavio[u]?r|steps to reproduce|screenshots?/i.test(item.title));
  if (section < 0 && headings.length) section = 0;
  const first = lines.findIndex((line, i) => line.trim() && !code.has(i));
  const paragraphEnd = first < 0 ? -1 : lines.findIndex((line, i) => i > first && (!line.trim() || code.has(i)));
  const fallback = (section >= 0 ? headings[section + 1]?.line : paragraphEnd < 0 ? undefined : paragraphEnd) ?? lines.length;
  const insertions = new Map();
  for (const image of missing.sort((a, b) => (a.oldIndex < 0 ? Infinity : a.oldIndex) - (b.oldIndex < 0 ? Infinity : b.oldIndex))) {
    const restored = image.oldIndex < 0 ? undefined : restorePosition(old, image.oldIndex, lines, headings, code);
    let end = Math.min(restored ?? fallback, unclosedAt ?? lines.length);
    while (end < lines.length && !code.has(end) && !lines[end].trim()) end++;
    if (!insertions.has(end)) insertions.set(end, []);
    insertions.get(end).push(image.tag);
  }
  for (const [end, tags] of [...insertions].sort(([a], [b]) => b - a)) {
    let start = end;
    while (start > 0 && !code.has(start - 1) && !lines[start - 1].trim()) start--;
    lines.splice(start, end - start, ...(start ? [''] : []), tags.join(newline + newline), ...(end < lines.length ? [''] : []));
  }
  return lines.join(newline);
}
