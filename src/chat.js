import { listModels, listModelOptions, validModel, effortLabels, selectedEffort, withEffort } from './models.js';
import { credentials, projectKey, migrateProjectRepo, selectedProjectRepo, withProjectRepo } from './config.js';
import { describeConfig } from './config-view.js';
import { listProjects, listIssueTypes, selectedProjectType, withProjectType, listCategories, resolveCategory, selectedProjectCategory, withProjectCategory } from './backlog.js';
import { selectIssueType } from './templates.js';
import { stripVTControlCharacters } from 'node:util';

const help = `/model             实时读取模型列表，局部弹窗搜索并选择模型
/model <模型ID>    直接切换模型
/effort [档位]     选择当前模型的思考强度；auto 使用默认
/api               配置模型 API Key 与服务商
/backlog           配置 Backlog 地址、API Key 与默认项目
/project [项目KEY]  选择或切换 Backlog 项目并保存
/type [类型名]     选择当前项目的 Task、Bug 等类型并保存
/category [分类名]  从当前项目カテゴリー选择分类；- 清除，标题加【分类名】
/repo              配置或清除当前项目的代码目录
/config            查看当前 API、Backlog、代码目录及密钥设置状态
/help              查看帮助
/exit              退出
直接输入问题描述，按所选类型模板生成草稿；随后选择预览、直接创建或输入修改要求。模型和项目类型选择会保存。`;

function localModels(config) {
  const configured = config.model?.models ?? [];
  if (!Array.isArray(configured) || configured.some(value => !validModel(value))) throw new Error('model.models 必须是有效模型 ID 的数组');
  return [...new Set([config.model?.name, ...configured].filter(value => validModel(value)))];
}

export async function runChat(config, { ask, generate, actOnDraft, log = console.log, list = listModels, modelOptions = listModelOptions, projects = listProjects, types = listIssueTypes, categories = listCategories, signal, initialCommand = null, selectModel, selectEffort, selectProject, selectType, selectCategory, configure, persistModel, persistEffort, persistProject, persistType, persistCategory, filename, env = process.env }) {
  config = migrateProjectRepo(config);
  let models = localModels(config);
  let current = config.model?.name || '';
  log(`交互起票已启动。当前模型：${current || '未设置'}\n${help}`);
  while (true) {
    let line;
    try { line = initialCommand ?? await ask('ticket> '); initialCommand = null; }
    catch (error) {
      if (['ABORT_ERR', 'ERR_USE_AFTER_CLOSE'].includes(error.code)) break;
      throw error;
    }
    if (line == null) break;
    line = line.trim();
    if (!line) continue;
    if (line === '/exit') break;
    if (line === '/help') { log(help); continue; }
    try {
      const command = line.split(/\s+/)[0];
      if (command === '/effort') {
        if (!validModel(current)) throw new Error('请先用 /model 选择模型');
        const currentModel = { ...config.model, name: current };
        let effort = line.slice(command.length).trim();
        if (effort !== 'auto') {
          const available = await modelOptions({ ...config, model: currentModel }, { env, signal });
          const supported = ['auto', ...(available.find(model => model.id === current)?.efforts || [])];
          if (!effort) {
            const choices = supported.map(level => `${effortLabels[level]} (${level})`);
            const level = selectedEffort(currentModel);
            const previous = `${effortLabels[level]} (${level})`;
            const picked = selectEffort ? await selectEffort(choices, previous) : undefined;
            if (picked === null) continue;
            if (picked !== undefined) effort = supported[choices.indexOf(picked)];
            else {
              choices.forEach((label, index) => log(`${index + 1}. ${label}`));
              const answer = await ask('输入编号或档位（回车取消）：');
              if (answer == null) break;
              if (!answer.trim()) continue;
              effort = /^\d+$/.test(answer.trim()) ? supported[Number(answer.trim()) - 1] : answer.trim();
            }
          }
          if (!supported.includes(effort)) throw new Error('当前模型未提供该思考档位');
        }
        const model = withEffort(currentModel, effort);
        if (persistEffort) await persistEffort(effort, currentModel);
        config = { ...config, model };
        log(`思考强度已设为${effortLabels[effort]}${persistEffort ? '，已按模型保存' : ''}。`);
        continue;
      }
      if (command === '/category') {
        if (!config.backlog?.origin || !config.backlog?.project) throw new Error('请先用 /backlog 或 /project 配置目标项目');
        let selected = line.slice('/category'.length).trim();
        const available = await categories(config, { env, signal });
        const none = '（不指定分类）';
        if (!selected) {
          const names = [none, ...available.map(item => item.name)];
          const picked = selectCategory ? await selectCategory(names, selectedProjectCategory(config.backlog) || none) : undefined;
          if (picked === null) continue;
          if (picked !== undefined) selected = picked;
          else {
            names.forEach((name, index) => log(`${index + 1}. ${name}`));
            const answer = await ask('输入编号或完整分类名（回车取消）：');
            if (answer == null) break;
            selected = answer.trim(); if (!selected) continue;
            if (/^\d+$/.test(selected)) selected = names[Number(selected) - 1];
          }
        }
        if (selected === '-' || selected === none) selected = '';
        if (selected !== '') resolveCategory(available, selected);
        const backlog = withProjectCategory(config.backlog, selected);
        if (persistCategory) await persistCategory(selected, config.backlog);
        config = { ...config, backlog };
        log(selected ? `已选择分类：${selected}。后续草稿标题加上【${selected}】，并填写对应カテゴリー。` : '已清除当前项目的默认分类。');
        continue;
      }
      if (command === '/type') {
        let selected = line.slice('/type'.length).trim();
        if (!config.backlog?.origin || !config.backlog?.project) throw new Error('请先用 /backlog 或 /project 配置目标项目');
        log(`正在读取 ${config.backlog.project} 的工单类型…`);
        const available = await types(config, { env, signal });
        if (!Array.isArray(available) || available.some(item => !item || typeof item.name !== 'string' || !item.name.trim() || /[\x00-\x1f\x7f-\x9f]/.test(item.name))) throw new Error('工单类型列表格式无效，原选择未变');
        if (!available.length) throw new Error('当前项目没有可选的工单类型');
        if (!selected) {
          const names = available.map(item => item.name);
          let currentType = selectedProjectType(config.backlog) || '';
          if (!names.includes(currentType)) {
            try { currentType = selectIssueType(available).name; } catch { currentType = ''; }
          }
          const picked = selectType ? await selectType(names, currentType) : undefined;
          if (picked === null) continue;
          if (picked !== undefined) selected = picked;
          else {
            names.forEach((name, index) => log(`${index + 1}. ${name}${name === currentType ? '（当前）' : ''}`));
            const answer = await ask('输入编号或完整类型名（回车取消）：');
            if (answer == null) break;
            selected = answer.trim();
            if (!selected) continue;
            if (/^\d+$/.test(selected)) selected = names[Number(selected) - 1];
          }
        }
        if (!available.some(item => item.name === selected)) throw new Error('请选择当前项目列表中的类型，原选择未变');
        if (persistType) await persistType(selected, config.backlog);
        config = { ...config, backlog: withProjectType(config.backlog, selected) };
        log(`已选择工单类型：${selected}${persistType ? '（已按项目保存）' : ''}。后续拟稿使用该类型的模板。`);
        continue;
      }
      if (command === '/project') {
        let selected = line.slice('/project'.length).trim();
        if (selected) projectKey(selected);
        if (!config.backlog?.origin) throw new Error('请先用 /backlog 配置 Backlog 站点和 API Key');
        log(`当前项目：${config.backlog.project || '未设置'}；正在读取可访问项目…`);
        const available = await projects(config, { env, signal });
        if (!Array.isArray(available) || available.some(item => !item || typeof item.key !== 'string' || typeof item.name !== 'string')) throw new Error('Backlog 项目列表格式无效，当前项目未变');
        available.forEach(item => projectKey(item.key));
        if (!available.length) throw new Error('没有可访问的未归档项目，当前项目未变');
        if (!selected) {
          const labels = available.map(item => `${item.key} — ${stripVTControlCharacters(item.name).replace(/[\x00-\x1f\x7f-\x9f]/g, '')}`);
          const currentLabel = labels[available.findIndex(item => item.key === config.backlog.project)];
          const picked = selectProject ? await selectProject(labels, currentLabel || '') : undefined;
          if (picked === null) continue;
          if (picked !== undefined) selected = available[labels.indexOf(picked)]?.key;
          else {
            labels.forEach((label, index) => log(`${index + 1}. ${label}${available[index].key === config.backlog.project ? '（当前）' : ''}`));
            const answer = await ask('输入编号或项目 KEY（回车取消）：');
            if (answer == null) break;
            selected = answer.trim();
            if (!selected) continue;
            if (/^\d+$/.test(selected)) selected = available[Number(selected) - 1]?.key;
          }
        }
        if (!available.some(item => item.key === selected)) throw new Error('请选择列表中的项目，当前项目未变');
        if (persistProject) await persistProject(selected, config.backlog);
        config = { ...config, backlog: { ...config.backlog, project: selected } };
        log(`已切换项目：${selected}${persistProject ? '（已保存，下次启动自动沿用）' : ''}。后续草稿读取该项目的类型模板。`);
        initialCommand = '/type';
        continue;
      }
      if (command === '/config') {
        if (line !== command) throw new Error('/config 不接收参数；修改配置请使用 /api、/backlog 或 /repo');
        log(await describeConfig({ ...config, model: { ...config.model, name: current } }, { filename, env }));
        continue;
      }
      if (['/api', '/backlog', '/repo'].includes(command)) {
        if (line !== command) throw new Error(`${command} 不接收参数，请按提示输入配置；密钥会隐藏输入`);
        const scope = command.slice(1);
        if (!configure) throw new Error(`当前会话未接入配置引导，请运行 ticket config ${scope}`);
        const next = await configure(scope, config.backlog);
        if (scope === 'api') {
          const sameService = config.model?.baseUrl === next.model?.baseUrl && config.model?.protocol === next.model?.protocol;
          const selected = sameService ? current : next.model?.name || '';
          const choices = localModels({ ...next, model: { ...next.model, name: selected } });
          config = { ...config, model: next.model, [credentials]: next[credentials] };
          current = selected;
          models = choices;
          if (!validModel(current)) initialCommand = '/model';
        } else if (scope === 'backlog') {
          if (config.backlog?.origin !== next.backlog?.origin || config.backlog?.project !== next.backlog?.project) initialCommand = '/type';
          config = { ...config, backlog: next.backlog, [credentials]: next[credentials] };
        } else {
          config = withProjectRepo(config, selectedProjectRepo(next, config.backlog));
        }
        log('配置已用于当前会话。');
        continue;
      }
      if (line === '/model' || line.startsWith('/model ')) {
        let selected = line.slice('/model'.length).trim();
        if (!selected) {
          log(`当前模型：${current || '未设置'}`);
          let choices = models;
          log('正在读取当前 API 的模型列表…');
          try {
            choices = await list(config, { signal });
            if (!Array.isArray(choices) || choices.some(name => !validModel(name))) throw new Error('模型列表格式不兼容');
            log(`接口返回 ${choices.length} 个模型（尚未验证图片、工具及生成权限）。`);
          } catch (error) {
            if (['ABORT_ERR', 'ERR_USE_AFTER_CLOSE'].includes(error.code)) throw error;
            choices = models;
            log(`${error.message}。以下为本地候选，非实时列表；也可手动输入模型 ID。`);
          }
          const picked = choices.length && selectModel ? await selectModel(choices, current) : undefined;
          if (picked === null) continue;
          if (picked !== undefined) selected = picked;
          else {
            choices.forEach((name, index) => log(`${index + 1}. ${name}${name === current ? '（当前）' : ''}`));
            if (!choices.length) log('列表为空，可直接输入聚合 API 提供的模型 ID。');
            const answer = await ask('输入编号或模型 ID（回车取消）：');
            if (answer == null) break;
            selected = answer.trim();
            if (!selected) continue;
            if (/^\d+$/.test(selected)) {
              const name = choices[Number(selected) - 1];
              if (!name) throw new Error('模型编号不存在，当前模型未变');
              selected = name;
            }
          }
        }
        if (!validModel(selected)) throw new Error('模型 ID 应为1～200个非空白字符，当前模型未变');
        if (persistModel) await persistModel(selected, config.model);
        current = selected;
        config = { ...config, model: { ...config.model, name: current } };
        if (!models.includes(current)) models.push(current);
        log(`已切换模型：${current}${persistModel ? '（已保存，下次启动自动沿用）' : ''}。API 地址、密钥引用和协议沿用配置；可用性在生成时验证。`);
        continue;
      }
      if (line.startsWith('/')) throw new Error('未知命令，输入 /help 查看用法');
      if (!validModel(current)) throw new Error('请先输入 /model 设置模型');
      const selected = { ...config, model: { ...config.model, name: current } };
      const draft = await generate(selected, line);
      if (actOnDraft && await actOnDraft(selected, draft) === 'exit') break;
    } catch (error) {
      if (['ABORT_ERR', 'ERR_USE_AFTER_CLOSE'].includes(error.code)) break;
      log(`错误：${error.code ? `本地操作失败（${error.code}）` : error.message}`);
    }
  }
}
