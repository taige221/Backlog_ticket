import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { pickModel } from '../src/model-picker.js';
import { createTerminal } from '../src/terminal.js';
import { runChat } from '../src/chat.js';

function tty() {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
  output.isTTY = true; output.columns = 90; output.rows = 24;
  output.on('data', chunk => { text += chunk; });
  return { input, output, get text() { return text; } };
}

test('局部弹窗默认高亮当前模型，不切换屏幕或清屏，完成后恢复输入模式', async () => {
  const io = tty();
  const pending = pickModel(['provider/a', 'provider/b', 'provider/c'], 'provider/b', io);
  assert(io.text.includes('选择模型'));
  assert(io.text.includes('provider/b [current]'));
  assert(!io.text.includes('\x1b[?1049h'));
  assert(!io.text.includes('\x1b[2J'));
  io.input.write('\x1b[B\r');
  assert.equal(await pending, 'provider/c');
  assert.equal(io.input.isRaw, false);
  assert(io.text.endsWith('\x1b[0m\x1b[?25h'));
  assert.equal(io.input.listenerCount('keypress'), 0);
  assert.equal(io.output.listenerCount('resize'), 0);
});

test('支持大小写不敏感搜索、无结果后清空、退格及分页', async () => {
  const io = tty();
  const choices = Array.from({ length: 30 }, (_, i) => `provider/model-${i}`);
  const pending = pickModel(choices, '', io);
  io.input.write('not-found\r');
  assert(io.text.includes('无匹配模型'));
  io.input.write('\x15MODEL-29x\x7f\r');
  assert.equal(await pending, 'provider/model-29');
  const next = pickModel(choices, '', io);
  io.input.write('\x1b[6~\r');
  assert.equal(await next, 'provider/model-5');
});

test('选择框最多显示5项，搜索只擦除自身区域，关闭后光标回到区域起点', async () => {
  const io = tty();
  io.output.write('已有对话内容\r\n');
  const before = io.text.length;
  const pending = pickModel(Array.from({ length: 30 }, (_, i) => `provider/model-${i}`), '', io);
  const frame = io.text.slice(before);
  assert.equal(frame.split('\r\n').length, 11);
  assert(frame.includes('provider/model-4'));
  assert(!frame.includes('provider/model-5'));
  const first = io.text.length;
  io.input.write('z');
  const refresh = io.text.slice(first);
  assert(refresh.startsWith('\r\x1b[10A'));
  assert.equal((refresh.match(/\x1b\[2K/g) || []).length, 11);
  const second = io.text.length;
  io.input.emit('keypress', '', { name: 'escape' });
  assert.equal(await pending, null);
  const cleanup = io.text.slice(second);
  assert.equal((cleanup.match(/\x1b\[2K/g) || []).length, 11);
  assert(cleanup.endsWith('\x1b[10A\r\x1b[0m\x1b[?25h'));
  assert(!io.text.includes('\x1b[2J'));
  assert(!io.text.includes('\x1b[?1049'));
});

test('Esc取消保留选择，Ctrl+C/关闭信号中止，均清理终端', async () => {
  const io = tty();
  const cancel = pickModel(['a', 'b'], 'a', io);
  io.input.emit('keypress', '', { name: 'escape' });
  assert.equal(await cancel, null);
  const interrupt = pickModel(['a', 'b'], 'a', io);
  io.input.write('\x03');
  await assert.rejects(interrupt, { code: 'ABORT_ERR' });
  const controller = new AbortController();
  const aborted = pickModel(['a', 'b'], 'a', { ...io, signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, { code: 'ABORT_ERR' });
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount('keypress'), 0);
});

test('小窗口或非交互输出返回文本回退，调整窗口可重绘', async () => {
  const io = tty();
  io.output.columns = 25;
  assert.equal(await pickModel(['a'], '', io), undefined);
  io.output.columns = 90; io.output.isTTY = false;
  assert.equal(await pickModel(['a'], '', io), undefined);
  io.output.isTTY = true;
  const pending = pickModel(['a', 'b'], '', io);
  const before = io.text.length;
  io.output.columns = 70; io.output.rows = 15; io.output.emit('resize');
  assert(io.text.length > before);
  io.input.write('\r'); assert.equal(await pending, 'a');
  const shrinking = pickModel(['a'], '', io);
  io.output.columns = 25; io.output.emit('resize');
  assert.equal(await shrinking, undefined);
});

test('弹窗关闭后恢复原聊天提示，重复打开和隐藏输入不会串键或泄露密钥', async () => {
  const io = tty(), terminal = createTerminal(io.input, io.output);
  try {
    const first = terminal.selectModel(['a', 'b'], 'a');
    io.input.write('\x1b[B\r'); assert.equal(await first, 'b');
    assert.equal(terminal.signal.aborted, false);
    const question = terminal.ask('ticket> ');
    io.input.write('下一条需求\r'); assert.equal(await question, '下一条需求');
    const second = terminal.selectModel(['a', 'b'], 'b');
    io.input.emit('keypress', '', { name: 'escape' }); assert.equal(await second, null);
    const secret = terminal.askSecret('API Key: ');
    io.input.write('hidden-after-popup\r'); assert.equal(await secret, 'hidden-after-popup');
    assert(!io.text.includes('hidden-after-popup'));
  } finally { terminal.close(); }
  assert.equal(io.input.isRaw, false);
});

test('主动关闭终端会中止正在显示的弹窗并清理输入监听', async () => {
  const io = tty(), terminal = createTerminal(io.input, io.output);
  const pending = terminal.selectModel(['a', 'b'], 'a');
  terminal.close();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount('keypress'), 0);
  assert.equal(terminal.signal.aborted, true);
});

test('项目选择复用局部选择框，显示项目标题并可搜索，关闭后继续聊天', async () => {
  const io = tty(), terminal = createTerminal(io.input, io.output);
  try {
    const pending = terminal.selectProject(['ONE — Alpha', 'TWO — Beta'], 'ONE — Alpha');
    assert(io.text.includes('选择 Backlog 项目'));
    assert(!io.text.includes('选择模型'));
    io.input.write('Beta\r');
    assert.equal(await pending, 'TWO — Beta');
    const next = terminal.ask('ticket> '); io.input.write('/config\r');
    assert.equal(await next, '/config');
    assert(!io.text.includes('\x1b[?1049'));
    assert.equal(terminal.signal.aborted, false);
  } finally { terminal.close(); }
});

test('工单类型使用局部选择框，搜索选择后恢复正常输入', async () => {
  const io = tty(), terminal = createTerminal(io.input, io.output);
  try {
    const pending = terminal.selectType(['Task', 'Bug'], 'Task');
    assert(io.text.includes('选择工单类型'));
    io.input.write('Bug\r'); assert.equal(await pending, 'Bug');
    const next = terminal.ask('ticket> '); io.input.write('/config\r'); assert.equal(await next, '/config');
    assert(!io.text.includes('\x1b[?1049'));
  } finally { terminal.close(); }
});

test('/model接入弹窗，取消保持当前模型，确认后生成使用新模型且不打印整份编号列表', async () => {
  const answers = ['/model', '问题一', '/model', '问题二', '/exit'], selected = [], generated = [], logs = [];
  const config = { model: { name: 'a' } };
  await runChat(config, { ask: async () => answers.shift(), list: async () => ['a', 'b'],
    selectModel: async (choices, current) => { assert.deepEqual(choices, ['a', 'b']); selected.push(current); return selected.length === 1 ? null : 'b'; },
    generate: async (next, request) => generated.push([next.model.name, request]), log: line => logs.push(line),
  });
  assert.deepEqual(selected, ['a', 'a']);
  assert.deepEqual(generated, [['a', '问题一'], ['b', '问题二']]);
  assert(!logs.some(line => line.startsWith('1. ')));
  assert.equal(config.model.name, 'a');
});
