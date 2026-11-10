const taskNames = new Set(['task', 'タスク', '任务']);

export function cleanSummary(summary) {
  summary = summary.replace(/\s*\/\s*Frontend名\s*\/\s*Backend名\s*$/i, '').trimEnd();
  const tail = /\s*\/\s*([^/\r\n]+?)\s*\/\s*(?:无|不适用|なし|無し|該当なし|none|n\/a|not applicable)\s*$/i.exec(summary);
  // Only remove an old metadata tail when its module is already named in the title.
  const prefix = tail && summary.slice(0, tail.index);
  if (tail && prefix.includes(tail[1].trim()) && !/(?:\b[a-z][a-z0-9+.-]*:\/\/|\s\/|^\/)\S*$/i.test(prefix)) summary = prefix.trimEnd();
  return summary;
}

export function selectIssueType(types, requested) {
  if (requested) {
    const exact = types.find(type => type.name === requested);
    if (exact) return exact;
  }
  const candidates = taskNames.has((requested || 'Task').toLowerCase())
    ? types.filter(type => taskNames.has(type.name.toLowerCase())) : [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error('项目中有多个 Task 类型，请用 /type 或 --type 指定项目中的完整类型名');
  throw new Error(requested ? '指定类型不在项目类型列表中，请用 /type 或 --type 重新选择' : '项目中没有 Task／タスク／任务 类型，请用 /type 或 --type 指定已有类型');
}

export function codeLayout(lines, format) {
  const code = new Set();
  let fence = null, unclosedAt, listIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (format === 'backlog') {
      if (!fence && /^\{code(?::[^}]*)?\}\s*$/.test(line)) { fence = 'backlog'; unclosedAt = i; }
      if (fence) code.add(i);
      if (/^\{\/code\}\s*$/.test(line)) { code.add(i); fence = null; unclosedAt = undefined; }
    } else {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker || fence) code.add(i);
      else {
        const indent = /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
        if (line.trim() && indent < listIndent) listIndent = 0;
        const item = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.exec(line)?.[0];
        if (item) listIndent = item.replace(/\t/g, '    ').length;
        if (indent >= listIndent + 4) code.add(i);
      }
      if (marker && !fence) { fence = marker; unclosedAt = i; }
      else if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) {
        fence = null; unclosedAt = undefined;
      }
    }
  }
  return { code, unclosedAt };
}

export function bodyHeadings(text, format) {
  const lines = text.split(/\r?\n/), result = [];
  const { code } = codeLayout(lines, format);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (code.has(i) || /^\s*>/.test(line)) continue;
    if (format === 'backlog') {
      if (/^\*{1,6}(?:[^*\s]|[ \t]+\S)/.test(line)) result.push({ title: line.trim(), line: i });
    } else {
      if (/^ {0,3}#{1,6}[ \t]+\S/.test(line)) result.push({ title: line.trim(), line: i });
      else if (line.trim() && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[i + 1] || '')) { result.push({ title: `${line.trim()}\n${lines[i + 1].trim()}`, line: i }); i++; }
    }
  }
  return result;
}

const genericSections = [
  { 'zh-CN': ['现象', '问题现象'], ja: ['現象', '事象'], en: ['Observed behavior', 'Current behavior'] },
  { 'zh-CN': ['预期', '预期结果'], ja: ['期待', '期待結果'], en: ['Expected behavior', 'Expected result'] },
  { 'zh-CN': ['待确认项', '待确认事项'], ja: ['要確認事項', '待確認事項', '確認事項'], en: ['Open questions', 'Items to confirm'] },
];

export function localizeGenericHeadings(description, format, language, fixedHeadings) {
  const lines = description.split('\n');
  const marker = format === 'backlog' ? /^\*{1,6}[ \t]*/ : /^#{1,6}[ \t]+/;
  for (const { title, line } of bodyHeadings(description, format)) {
    if (fixedHeadings.includes(title)) continue;
    const label = title.split('\n')[0].replace(marker, '').replace(/[ \t]+#+$/, '');
    const section = genericSections.find(labels => Object.values(labels).some(values => values.some(value => value.toLowerCase() === label.toLowerCase())));
    if (section) lines[line] = lines[line].replace(label, section[language][0]);
  }
  return lines.join('\n');
}

export function templateFillingHints(description, format) {
  const lines = description.split(/\r?\n/);
  const { code } = codeLayout(lines, format);
  const headings = bodyHeadings(description, format);
  const hints = [];
  for (const [section, { title, line }] of headings.entries()) {
    const headingLines = title.split('\n');
    const end = headings[section + 1]?.line ?? lines.length;
    let index = line + headingLines.length;
    while (index < end && !lines[index].trim()) index++;
    if (index >= end || code.has(index)) continue;
    const hint = lines[index].trim();
    const example = /^(?:記入例|填写示例|填寫示例)$/u.test(hint);
    const instruction = /^(?:\(.+\)|（.+）)$/u.test(hint)
      && /どんな|どのような|記入|記載|記述|填写|填寫|请描述|請描述|\b(?:describe|enter|fill in)\b/iu.test(hint);
    if (example || instruction) hints.push({ heading: headingLines[0], hint });
  }
  return hints;
}

export function withoutTemplateFillingHints(description, hints, format) {
  if (!hints.length) return description;
  const lines = description.split('\n');
  const { code } = codeLayout(lines, format);
  return lines.flatMap((line, index) => {
    if (code.has(index) || /^\s*>/.test(line)) return [line];
    const content = line.trim();
    for (const { heading, hint } of hints) {
      const atHeading = content.startsWith(heading);
      const afterHeading = atHeading ? content.slice(heading.length).trimStart() : content;
      if (!afterHeading.startsWith(hint)) continue;
      const remainder = afterHeading.slice(hint.length);
      if (remainder && (!/^[ \t]/.test(remainder) || !/^[（(]/.test(hint))) continue;
      return [atHeading ? heading : '', remainder.trimStart()].filter(Boolean);
    }
    return [line];
  }).join('\n');
}

export function matchesTemplateStructure(description, template, format) {
  const expected = bodyHeadings(template, format).map(item => item.title), actual = bodyHeadings(description, format).map(item => item.title);
  let position = 0;
  for (const heading of expected) {
    position = actual.indexOf(heading, position);
    if (position < 0) return false;
    position++;
  }
  return true;
}
