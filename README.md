# Mini Agent Lab

从 OpenClaw 精简迁移出来的**自包含 Agent 实验台**，只保留三项功能，**无认证、无 Gateway、无多余依赖**，UI 参照 DeepSeek 官网的浅色蓝色风格。

1. **会话（主体页面）** — 左侧会话列表 + 右侧聊天框，无多余的「新建会话」表单；聊天框内直接选择模型、力度（default / High）和 Agent。
2. **模型连接** — 按**分类**管理连接：例如一个「OpenAI」分类下可包含 `gpt-6`、`gpt-5.6` 等多个模型；会话与聊天框中的模型选择按分类分组显示。
3. **Agent 测试** — 配置系统提示词 + 内置工具 / 自定义 Webhook 工具，一键开会话测试。

## 运行

需要 Node.js ≥ 18（推荐 20+，本项目在 Node 24 上开发）。零 npm 依赖。

```bash
npm start          # http://localhost:3000
```

可选环境变量：`PORT`（默认 3000）、`HOST`（默认 0.0.0.0）。开发模式：`npm run dev`。

数据保存在 `data/store.json`（已 gitignore）。首次启动会写入两个示例连接（Ollama 本地、OpenAI 含 `gpt-6`/`gpt-5.6`）和一个示例 Agent。

## 使用流程

- **会话**是默认首页：左侧列表点条目切换会话，点「＋」直接新建会话（无弹窗表单）。发送消息后会自动用首条消息命名会话。
- 聊天框顶部三个选项：
  - **模型**：按连接分类分组显示，例如 `OpenAI → gpt-6 / gpt-5.6`；
  - **力度**：`default`（默认）或 `High`（High 会向 OpenAI 兼容接口发送 `reasoning_effort: high`，向 Anthropic 接口开启 extended thinking）；
  - **Agent**：默认「无」，选择后该会话使用对应系统提示词与工具。
- **模型连接** → 新增连接：填写分类名称、API 类型、Base URL、API Key，并在「该分类下的模型 ID」中逐个添加模型；可一键测试连通性。
- **Agent** → 新增 Agent：填写系统提示词，选绑定分类与模型，勾选内置工具（`get_time` / `calculator` / `echo`）或添加 Webhook 工具，点「对话测试」直接开会话。

## 支持的模型接口

| API 类型 | 接口 | 说明 |
| --- | --- | --- |
| `openai` | `POST {baseUrl}/chat/completions` | OpenAI / DeepSeek / Ollama / vLLM / 自定义中转，支持 Function Calling |
| `anthropic` | `POST {baseUrl}/messages` | Anthropic Messages API，支持 Tool Use |

## 目录结构

```
server/
  index.js   HTTP 服务与 REST / SSE 接口，无第三方框架
  store.js   JSON 文件持久化（连接分类 / Agent / 会话）
  llm.js     统一 LLM 层：OpenAI / Anthropic 流式输出 + 工具调用循环 + 力度选项
  tools.js   内置工具与 Webhook 工具执行
public/
  index.html / styles.css / app.js   无框架前端 SPA
```

## 接口一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/api/connections` | 连接分类列表 / 新增 |
| PUT/DELETE | `/api/connections/:id` | 修改 / 删除分类 |
| POST | `/api/connections/test` | 测试某分类下指定模型的连通性 |
| GET/POST | `/api/agents` | Agent 列表 / 新增 |
| PUT/DELETE | `/api/agents/:id` | 修改 / 删除 Agent |
| GET/POST | `/api/sessions` | 会话列表 / 新建 |
| GET/PUT/DELETE | `/api/sessions/:id` | 查看 / 修改 / 删除会话 |
| POST | `/api/chat` | 发送消息（SSE：delta / tool / done / error） |
| GET | `/api/tools` | 内置工具定义 |
| POST | `/api/tools/test` | 单独测试一个工具 |
