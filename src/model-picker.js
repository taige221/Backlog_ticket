import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

function fit(text, width) {
  let result = '', used = 0;
  for (const char of stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '')) {
    const size = /\p{Mark}/u.test(char) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
    if (used + size > width) break;
    result += char; used += size;
  }
  return result + ' '.repeat(Math.max(0, width - used));
}

export async function pickModel(choices, current, { input = process.stdin, output = process.stdout, signal, title = '选择模型', emptyMessage = '无匹配模型，请修改搜索词' } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function' || output.columns < 40 || output.rows < 10) return undefined;
  if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORT_ERR' });
  if (!choices.length) return null;
  let query = '', index = Math.max(0, choices.indexOf(current)), done = false;
  let drawnRows = 0, drawnWidth = 0;
  let matches = [...choices];
  const wasRaw = Boolean(input.isRaw);
  return new Promise((resolve, reject) => {
    const pageSize = () => Math.max(1, Math.min(5, choices.length, Math.floor((output.rows || 24) / 2) - 6));
    const clear = () => {
      if (!drawnRows) return;
      // Resize can wrap the old frame or scroll part of it out of view.
      const rows = Math.min(drawnRows * Math.ceil(drawnWidth / Math.max(1, output.columns || 80)), output.rows || 24);
      const up = rows > 1 ? `\x1b[${rows - 1}A` : '';
      output.write('\r' + up + Array.from({ length: rows }, (_, i) => '\x1b[2K' + (i < rows - 1 ? '\x1b[1B' : '')).join('') + up + '\r');
      drawnRows = 0;
    };
    const render = () => {
      clear();
      const columns = Math.max(40, output.columns || 80);
      const width = Math.min(72, columns - 2), count = pageSize();
      index = Math.max(0, Math.min(index, matches.length - 1));
      const offset = Math.max(0, Math.min(index - count + 1, matches.length - count));
      const row = content => `│ ${fit(content, width - 4)} │`;
      const divider = `├${'─'.repeat(width - 2)}┤`;
      const lines = [`┌${fit(` ${title} `, width - 2).replace(/ +$/, spaces => '─'.repeat(spaces.length))}┐`, row(`搜索: ${query || '输入名称筛选'}`), divider];
      for (let position = 0; position < count; position++) {
        const name = matches[offset + position];
        const selected = Boolean(name) && offset + position === index;
        const text = name ? `${selected ? '›' : ' '} ${name}${name === current ? ' [current]' : ''}` : position === 0 ? emptyMessage : '';
        lines.push(`${selected ? '\x1b[7m' : ''}${row(text)}\x1b[0m`);
      }
      lines.push(divider, row(`${matches.length ? index + 1 : 0}/${matches.length}  ↑↓  Enter 确认  Esc 取消`), `└${'─'.repeat(width - 2)}┘`);
      output.write('\r' + lines.join('\r\n'));
      drawnRows = lines.length;
      drawnWidth = width;
    };
    const finish = (value, error) => {
      if (done) return;
      done = true;
      input.removeListener('keypress', onKey);
      input.removeListener('end', abort);
      input.removeListener('error', onError);
      output.removeListener('resize', onResize);
      signal?.removeEventListener('abort', abort);
      clear();
      output.write('\x1b[0m\x1b[?25h');
      input.setRawMode(wasRaw);
      input.pause();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(null, Object.assign(new Error('已取消选择'), { code: 'ABORT_ERR' }));
    const onError = () => finish(null, new Error('终端输入中断'));
    const onResize = () => { if (output.columns < 40 || output.rows < 10) finish(undefined); else render(); };
    const onKey = (text, key = {}) => {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return abort();
      if (key.name === 'escape') return finish(null);
      if (['return', 'enter'].includes(key.name)) { if (matches.length) finish(matches[index]); return; }
      if (key.name === 'up') index--;
      else if (key.name === 'down') index++;
      else if (key.name === 'pageup') index -= pageSize();
      else if (key.name === 'pagedown') index += pageSize();
      else if (key.name === 'home') index = 0;
      else if (key.name === 'end') index = matches.length - 1;
      else {
        if (key.name === 'backspace') query = Array.from(query).slice(0, -1).join('');
        else if (key.ctrl && key.name === 'u') query = '';
        else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(text)) query = (query + text).slice(0, 200);
        else return;
        matches = choices.filter(name => name.toLowerCase().includes(query.toLowerCase()));
        index = 0;
      }
      render();
    };
    emitKeypressEvents(input);
    input.on('keypress', onKey);
    input.once('end', abort);
    input.once('error', onError);
    output.on('resize', onResize);
    signal?.addEventListener('abort', abort, { once: true });
    input.setRawMode(true);
    output.write('\x1b[?25l');
    render();
    input.resume();
  });
}
