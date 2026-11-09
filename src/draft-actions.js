export async function runDraftActions(config, initial, { ask, preview, create, revise, log = console.log }) {
  let current = initial;
  while (true) {
    log('\n1. preview（填入官网编辑页，回车或关闭浏览器后回到这里）\n2. 直接创建（提交到 Backlog）\n3. 进行修改（也可直接输入修改要求）\n0. 保存草稿，返回新问题');
    const answer = await ask('操作> ');
    if (answer == null || ['/exit', '0'].includes(answer.trim())) return answer?.trim() === '/exit' ? 'exit' : undefined;
    const choice = answer.trim();
    if (!choice) continue;
    try {
      if (choice === '1' || choice === 'preview') {
        const result = await preview(current, config);
        if (result?.url) { log(`浏览器已打开工单：${result.url}。本份草稿结束处理，避免重复创建。`); return; }
        continue;
      }
      if (choice === '2') {
        log(`正在创建：${current.draft.target?.project || config.backlog?.project || '未配置项目'} / ${current.draft.summary}`);
        const result = await create(current, config, initial.filename);
        log(`已创建：${result.issueKey}\n${result.url}`);
        if (result.warning) log(result.warning);
        return;
      }
      if (choice.startsWith('/')) throw new Error('当前在草稿操作中；输入 0 返回对话后使用 / 命令');
      if (/^\d+$/.test(choice) && choice !== '3') throw new Error('请选择 1、2、3 或 0，也可直接输入修改要求');
      const instruction = choice === '3' ? await ask('修改内容> ') : choice;
      if (instruction == null) return;
      if (!instruction.trim()) continue;
      if (instruction.trim() === '/exit') return 'exit';
      current = await revise(current, instruction.trim(), config);
    } catch (error) {
      if (['ABORT_ERR', 'ERR_USE_AFTER_CLOSE'].includes(error.code)) throw error;
      log(`错误：${error.code ? `本地操作失败（${error.code}）` : error.message}。当前草稿仍已保存。`);
    }
  }
}
