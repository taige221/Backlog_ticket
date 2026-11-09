import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { attachmentImages, inlineImageDescription } from '../src/attachments.js';

test('按文件内容识别图片，PDF和伪图片保留为普通附件，同名图片停止处理', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = [Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from([255,216,255]), Buffer.from('GIF89a'), Buffer.from('RIFF0000WEBP'), Buffer.from('%PDF-1.4'), Buffer.from('not an image')];
  const files = ['截图.dat', '截图.jpg', '动图.gif', '截图.webp', '说明.pdf', 'fake.png'].map(name => path.join(root, name));
  for (const [index, file] of files.entries()) await writeFile(file, content[index]);
  assert.deepEqual(await attachmentImages(files), files.slice(0, 4));
  await mkdir(path.join(root, 'another'));
  const duplicate = path.join(root, 'another', '截图.jpg'); await writeFile(duplicate, content[1]);
  await assert.rejects(attachmentImages([files[1], duplicate]), /同名/);
});

test('两种正文格式可补图、保留已有位置与说明、重复执行不重复插图，并转换旧格式', () => {
  const images = ['/tmp/截图 一.png', '/tmp/截图二.jpg'];
  for (const rule of ['markdown', 'backlog']) {
    const tag = name => rule === 'markdown' ? `![image][${name}]` : `#image(${name})`;
    const other = name => rule === 'markdown' ? `#image(${name})` : `![说明][${name}]`;
    const input = `原有正文\n\n${other('截图 一.png')}\n\n后续说明`;
    const actual = inlineImageDescription(input, images, rule);
    assert.equal(actual, `原有正文\n\n${tag('截图二.jpg')}\n\n${tag('截图 一.png')}\n\n后续说明`);
    assert.equal(inlineImageDescription(actual, images, rule), actual);
  }
  const described = '![复现截图][截图 一.png]\n\n保留说明';
  assert.equal(inlineImageDescription(described, images.slice(0, 1), 'markdown'), described);
  assert.equal(inlineImageDescription('正文', [], undefined), '正文');
  assert.throws(() => inlineImageDescription('正文', images, undefined), /正文格式/);
  assert.throws(() => inlineImageDescription('正文', ['/tmp/图]片.png'], 'markdown'), /文件名/);
  assert.throws(() => inlineImageDescription('正文', ['/tmp/截图(1).png'], 'backlog'), /文件名/);
  assert.equal(inlineImageDescription('正文', ['/tmp/截图(1).png'], 'markdown'), '正文\n\n![image][截图(1).png]');
});

test('遗漏图片补在现状或复现章节，保留后续预期及验收内容，两种格式均幂等', () => {
  for (const rule of ['markdown', 'backlog']) {
    const h = text => rule === 'markdown' ? `## ${text}` : `*${text}`;
    const tag = name => rule === 'markdown' ? `![image][${name}]` : `#image(${name})`;
    for (const title of ['现状', '現状', '实际行为', 'Steps to reproduce']) {
      const input = `${h('背景')}\n背景信息。\n\n${h(title)}\n菜单折叠时显示异常。\n\n${h('期待')}\n权限一致。\n\n${h('验收')}\n- [ ] 检查菜单。`;
      const output = inlineImageDescription(input, ['/tmp/折叠.png', '/tmp/展开.png'], rule);
      assert.equal(output, input.replace(`\n\n${h('期待')}`, `\n\n${tag('折叠.png')}\n\n${tag('展开.png')}\n\n${h('期待')}`));
      assert.equal(inlineImageDescription(output, ['/tmp/折叠.png', '/tmp/展开.png'], rule), output);
    }
  }
});

test('人工或模型已指定的图片位置保持不变，缺失图定位不受代码块或引用内伪标题影响', () => {
  const specified = '## 现状\n现象。\n\n## 期待\n预期画面：\n![预期][期望.png]\n\n## 验收\n检查。';
  assert.equal(inlineImageDescription(specified, ['/tmp/期望.png'], 'markdown'), specified);
  const setext = '现状\n====\n实际画面。\n\n```md\n## 期待（示例）\n```\n\n> ## 截图（引用）\n\n期望\n====\n正确显示。';
  const actual = inlineImageDescription(setext, ['/tmp/现状.png'], 'markdown');
  assert(actual.includes('> ## 截图（引用）\n\n![image][现状.png]\n\n期望\n===='));
  const backlog = '*現状\n异常。\n{code}\n*期待（示例）\n{/code}\n\n*期待\n正确显示。';
  assert.equal(inlineImageDescription(backlog, ['/tmp/现状.png'], 'backlog'), backlog.replace('\n\n*期待\n', '\n\n#image(现状.png)\n\n*期待\n'));
});

test('清理打断检查项函数调用的附件引用，保留现状截图及代码块原文', () => {
  const images = ['/tmp/截屏2026-11-06 11.17.02.png', '/tmp/截屏2026-11-06 11.15.05.png'];
  for (const rule of ['markdown', 'backlog']) {
    const tags = images.map(file => rule === 'markdown' ? `![image][${path.basename(file)}]` : `#image(${path.basename(file)})`).join('\n\n');
    const heading = rule === 'markdown' ? '## ' : '*';
    const report = `${heading}現状\n菜单折叠时显示异常。`;
    const checklist = `${heading}チェックリスト\n- [ ] ThreadLocal / InheritableThreadLocalの場合、必ずremove()\n- [ ] データシートには必須チェック以外追加の場合、既存データの検証`;
    const interrupted = checklist.replace('remove()', `remove(\n${tags}\n)`);
    const expected = `${report}\n\n${tags}\n\n${checklist}`;
    assert.equal(inlineImageDescription(`${report}\n\n${tags}\n\n${interrupted}`, images, rule), expected);
    assert.equal(inlineImageDescription(`${report}\n\n${interrupted}`, images, rule), expected);
    const code = rule === 'markdown' ? `\`\`\`md\n${interrupted}\n\`\`\`` : `{code}\n${interrupted}\n{/code}`;
    assert.equal(inlineImageDescription(`${expected}\n\n${code}`, images, rule), `${expected}\n\n${code}`);
  }
});

test('漏图只补到代码块外，代码里的引用示例保持原样且不算正文图片', () => {
  for (const [rule, open, close, tag] of [
    ['markdown', '```js', '```', '![image][截图.png]'],
    ['backlog', '{code:js}', '{/code}', '#image(截图.png)'],
  ]) {
    const code = [open, tag, '', 'const value = true;', close].join('\n');
    const body = `${code}\n\n菜单权限显示异常。\n\n验收时检查两种状态。`;
    const filled = inlineImageDescription(body, ['/tmp/截图.png'], rule);
    assert.equal(filled, `${code}\n\n菜单权限显示异常。\n\n${tag}\n\n验收时检查两种状态。`);
    assert.equal(inlineImageDescription(filled, ['/tmp/截图.png'], rule), filled);
    const unfinished = `${open}\nconst value = true;\n\nconst next = false;`;
    assert.equal(inlineImageDescription(unfinished, ['/tmp/截图.png'], rule), `${tag}\n\n${unfinished}`);
  }
  const indented = '    const first = true;\n\n    const second = true;\n\n菜单异常。';
  assert.equal(inlineImageDescription(indented, ['/tmp/截图.png'], 'markdown'), `${indented}\n\n![image][截图.png]`);
  const step = '1. 复现菜单问题。\n\n    ![对照画面][截图.png]';
  assert.equal(inlineImageDescription(step, ['/tmp/截图.png'], 'markdown'), step);
});
