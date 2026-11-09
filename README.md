# Ticket 起票工作台

用问题描述和截图生成 Backlog 工单草稿。可以在工作台修改草稿，也可以填入 Backlog 编辑页继续处理。

## 快速开始

发行包自带运行环境。解压后双击 macOS 的「启动 Ticket.command」或 Windows 的「启动 Ticket.cmd」，浏览器会自动打开工作台。使用时请保持启动窗口开启。

## 首次配置

在工作台左下角打开「配置工作台」。

1. **模型 API Key**。登录 [OpenAI API Keys](https://platform.openai.com/api-keys) 或 [OpenRouter Keys](https://openrouter.ai/settings/keys)，创建一个密钥。把密钥粘贴到「模型 API」的「API Key」栏，点击「保存模型配置」，然后在工作台顶部选模型。若「自动识别」无法判断服务商，手动选择对应的一家。
2. **Backlog API Key**。登录公司的 Backlog 站点，打开「个人设置（個人設定）→ API」，点击「注册（登録）」生成密钥。回到工作台的「Backlog」，填写站点地址（例如 `https://your-space.backlog.com`，填到域名为止）和「Backlog API Key」，点击「保存 Backlog 配置」，再选择项目和工单类型。 [Backlog 官方说明](https://support-ja.backlog.com/hc/ja/articles/360035641754-API%E3%81%AE%E8%A8%AD%E5%AE%9A)

密钥在工作台界面填写，保存在本机。需要结合本地源码分析时，先选择项目，再配置该项目的代码目录。CLI 可用 `/repo` 设置当前项目的目录。

模型选择框可调整「思考强度」，可选档位按模型支持情况显示，并分别记住每个模型的选择。CLI 使用 `/effort` 调整，`/effort auto` 恢复默认。

## 起票

1. 选择项目、类型和起票语言，描述问题并添加截图，然后点击「整理草稿」。分类、日期、负责人和通知对象可按需调整。
2. 展开「当前草稿」，点击「编辑草稿与附件」修改标题、正文或附件。普通保存不调用 AI。需要按新增截图补写正文时，可勾选编辑区的 AI 选项。
3. 点击「官网预览」，在专用浏览器登录 Backlog，再回工作台点击「已进入新建页，继续填入」。填完会停在 Backlog 编辑页，可继续修改并手动提交。也可用「复制标题」「复制正文」手动填写，或在工作台点击「创建工单」并确认，直接提交。

生成时可以点「新建对话」开始第二份草稿。最多同时生成两份，点击左侧「生成中」的对话可查看进度或单独停止。刷新网页后，工作台会重新显示仍在生成的对话。

提交结果待确认时，点击「核对创建结果」搜索或输入工单编号，核对正文后确认关联。暂未找到时可稍后继续核对。

配置、草稿及其对话默认保存在用户主目录的 `.config/backlog-ticket/`。打开旧草稿可查看该版本分支的原始描述和修改记录。继续修改时，当前草稿、原始描述和近期已生成版本的修改要求会发送给模型服务，删除整份草稿时也会删除对话记录。生成时选用的截图和相关源码片段同样会发送给模型服务。

## 从源码运行

需要 Node.js 22 或以上版本。使用源码分析或构建发行包时还需安装 ripgrep（`rg`）。

```sh
npm ci
npx playwright install chromium
npm run web
```

CLI 可运行 `npm run ticket -- init` 配置、`npm run ticket -- chat` 起票，或用 `npm run ticket -- --help` 查看命令。可在对应架构的 macOS 或 Windows 上运行 `npm run package:web` 生成发行包。
