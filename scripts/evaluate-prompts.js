import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig, resolveConfigFile } from '../src/config.js';
import { generateDraft } from '../src/draft.js';

const { values } = parseArgs({ options: { config: { type: 'string' } } });
const config = await loadConfig(resolveConfigFile(values.config));
const selected = { ...config, repo: '', backlog: {} };
const previous = { version: 1, summary: '旧标题', description: '## 现状\n菜单折叠时显示异常，展开时正常。\n\n## 验证\n- [x] QA 已在 Chrome 复现。\n- [ ] Safari 待确认。', unknowns: ['Safari 待确认'], attachments: [], language: 'zh-CN', textFormattingRule: 'markdown' };
const scenarios = [
  { name: '中文：直接陈述、保留QA结果、区分未知与不适用', language: 'zh-CN', request: '设置菜单折叠时隐藏成员管理，展开时可见。QA 已在 Windows 11 复现。浏览器与版本未提供，需待确认。此问题明确不涉及移动端，移动端检查不适用。请起票。', check(draft) {
    assert.match(draft.description, /QA/); assert.match(draft.description, /Windows 11/); assert.match(draft.description, /已复现|已在.*复现|复现.*完成/);
    assert.match(draft.description + draft.unknowns.join('\n'), /浏览器[^\n]*待确认|待确认[^\n]*浏览器/);
    assert.match(draft.description, /移动端[^\n]*(?:不适用|不涉及)|(?:不适用|不涉及)[^\n]*移动端/);
  } },
  { name: '日文：中文输入仍以日文起票', language: 'ja', request: '点击保存后没有反应，没有进行运行验证，原因尚未确认。整理为日文工单。', check(draft) { assert.match(draft.summary + draft.description, /[ぁ-んァ-ヶ]/); assert(!/报告称|据用户反馈/.test(draft.description)); } },
  { name: '英文：中文输入仍以英文起票', language: 'en', request: '打开详情页后关闭弹窗，页面无法滚动。尚未确认技术原因，不要声称已经修复。', check(draft) { assert.match(draft.description, /scroll/i); assert(!/\p{Script=Han}/u.test(draft.summary + draft.description + draft.unknowns.join(''))); } },
  { name: '不确定性与否定：不能把可能原因写成事实', language: 'zh-CN', request: '菜单仅在折叠时异常，展开时正常。可能与缓存有关，但尚未确认；不要认定缓存就是原因。', check(draft) { assert.match(draft.description + draft.unknowns.join('\n'), /缓存/); assert.match(draft.description, /可能|待确认|尚未确认|未验证/); assert.match(draft.description, /展开[^\n]*正常/); } },
  { name: '只改标题：正文、QA勾选与待确认项保持原样', language: 'zh-CN', previousDraft: previous, request: '只将标题改为“菜单折叠时显示不一致”，正文和待确认项保持原样。', check(draft) { assert.equal(draft.summary, '菜单折叠时显示不一致'); assert.equal(draft.description, previous.description); assert.deepEqual(draft.unknowns, previous.unknowns); } },
  { name: '切换日文：保留原章节、Chrome证据及未完成检查', language: 'ja', previousDraft: previous, request: '将正文说明和待确认项翻译为日文，保留原章节名、QA验证结果及检查项完成状态。', check(draft) { assert.match(draft.description, /^## 现状/m); assert.match(draft.description, /^## 验证/m); assert.match(draft.description, /\[x\].*Chrome/); assert.match(draft.description, /\[ \].*Safari/); assert.match(draft.description, /[ぁ-んァ-ヶ]/); } },
];
const report = { at: new Date().toISOString(), model: config.model?.name, protocol: config.model?.protocol, syntheticOnly: true, cases: [] };
for (const scenario of scenarios) {
  const start = Date.now(), usage = [];
  const record = { name: scenario.name, language: scenario.language };
  try {
    const draft = await generateDraft(selected, { request: scenario.request, language: scenario.language, previousDraft: scenario.previousDraft, metadata: false }, { fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (response.ok) { const data = await response.clone().json(); if (data.usage) usage.push(data.usage); }
      return response;
    } });
    record.output = { summary: draft.summary, description: draft.description, unknowns: draft.unknowns };
    scenario.check(draft); record.pass = true;
  } catch (error) { record.pass = false; record.error = error.message; }
  record.elapsedMs = Date.now() - start; record.usage = usage;
  report.cases.push(record); console.log(`${record.pass ? 'PASS' : 'FAIL'} ${record.name}${record.error ? ': ' + record.error : ''}`);
}
const output = new URL('../artifacts/prompt-evaluation.json', import.meta.url);
await mkdir(new URL('.', output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(`${report.cases.filter(item => item.pass).length}/${report.cases.length} passed; report: ${output.pathname}`);
if (report.cases.some(item => !item.pass)) process.exitCode = 1;
