import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pickModel } from './model-picker.js';

export function createTerminal(input = process.stdin, output = process.stdout) {
  if (!input.isTTY) throw new Error('请输入交互终端后重试；API Key 不接收命令行参数');
  let muted = false;
  const sink = new Writable({ write(chunk, encoding, callback) { if (!muted) output.write(chunk, encoding); callback(); } });
  sink.isTTY = Boolean(output.isTTY);
  sink.columns = output.columns;
  const controller = new AbortController();
  let rl, suspended = false;
  const startReadline = () => {
    rl = createInterface({ input, output: sink, terminal: true, historySize: 0 });
    rl.once('close', () => { if (!suspended) controller.abort(); });
    rl.on('SIGINT', () => rl.close());
  };
  startReadline();
  const ask = (question, { signal } = {}) => rl.question(question, { signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal });
  const select = async (choices, current, labels = {}) => {
    // The popup owns keyboard input exclusively, then restores the chat prompt.
    suspended = true;
    rl.close();
    try { return await pickModel(choices, current, { input, output, signal: controller.signal, ...labels }); }
    finally { suspended = false; if (!controller.signal.aborted) startReadline(); }
  };
  return {
    ask, signal: controller.signal, close: () => { controller.abort(); rl.close(); },
    selectModel: (choices, current) => select(choices, current),
    selectEffort: (choices, current) => select(choices, current, { title: '思考强度' }),
    selectProject: (choices, current) => select(choices, current, { title: '选择 Backlog 项目', emptyMessage: '无匹配项目，请修改搜索词' }),
    selectType: (choices, current) => select(choices, current, { title: '选择工单类型', emptyMessage: '无匹配类型，请修改搜索词' }),
    selectCategory: (choices, current) => select(choices, current, { title: '选择项目分类（カテゴリー）', emptyMessage: '无匹配分类，请修改搜索词' }),
    async askSecret(question) {
      output.write(question);
      muted = true;
      try { return await ask(''); }
      finally { muted = false; rl.history = []; output.write('\n'); }
    },
  };
}
