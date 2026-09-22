# AI for the old

中文 | [English](#english)

## 中文

AI for the old 是一个本地优先的 DeepSeek 任务工作台，面向需要处理文件、材料、表格和文档，但不想面对命令行、沙箱和复杂 Prompt 的用户。它把一次任务固定成一条可恢复的路径：

`说清楚需求 → 选择最多三个意图 → 一次性确认访问范围 → 本地 workspace 执行 → 查看结果 → 在原任务中反馈和重做`

当前版本提供：

- 大字、中文/English 切换和高对比度模式；
- 澄清候选、补充说明和执行前预览；
- 本地 Node 服务、桌面/下载目录索引和 `input/`、`work/`、`output/`、`logs/` workspace；
- 只读/复制优先的结构化工具白名单，不执行模型生成的 shell 命令；
- 任务历史、阶段状态、结果路径、版本化反馈和离线本地持久化；
- DeepSeek 官方登录页二维码入口和可选 API 适配器。

原始 DeepSeek Harness 上游源码保留在 [`deepseek-harness/`](deepseek-harness/)，用于复用插件、会话持久化和本地 Agent 能力。根目录的 `app/` 是本项目面向中老年用户的工作台壳层。

### 快速开始

需要 Node.js 22 或更高版本。安装依赖并启动本地前端和 API：

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>（Vite 会代理 `/api` 到 `127.0.0.1:4179`）。如果需要安装依赖时使用代理：

```bash
HTTPS_PROXY=http://127.0.0.1:6268 HTTP_PROXY=http://127.0.0.1:6268 npm install
```

本地 API 默认只监听 `127.0.0.1`。设置 `DEEPSEEK_API_KEY` 后，服务端可以调用 DeepSeek `deepseek-chat`；不设置时仍可使用本地澄清与文件工作流。API key 不写入仓库，也不在浏览器 localStorage 中保存。

### 验证

```bash
npm run check
npm test
npm run build
```

维护、数据目录、恢复策略、发布流程和安全边界见英文文档 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)。产品设计依据见 [`Deepseek-harness-for-seniors-应用设计方案.md`](Deepseek-harness-for-seniors-应用设计方案.md)。

## English

AI for the old is a local-first DeepSeek task workspace for people who need help with files, documents, spreadsheets, and everyday computer work without learning shell commands, sandbox policies, or prompt engineering. Every task follows one recoverable path:

`describe the goal → choose up to three intents → approve one access scope → run in a local workspace → review the result → give feedback and revise`

The current release includes:

- large text, Chinese/English switching, and a high-contrast mode;
- intent candidates, free-form clarification, and a pre-run review;
- a local Node service, Desktop/Downloads indexing, and `input/`, `work/`, `output/`, `logs/` workspaces;
- a structured safe-tool allowlist that never executes model-generated shell commands;
- task history, stage state, result paths, versioned feedback, and local persistence;
- an official DeepSeek sign-in QR entry point and an optional API adapter.

The upstream DeepSeek Harness source is kept in [`deepseek-harness/`](deepseek-harness/) for plugin, session persistence, and local-agent reuse. The root `app/` directory is the senior-friendly product shell described by the design document.

### Quick start

Node.js 22 or newer is required:

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies `/api` to the local service at `127.0.0.1:4179`. For dependency installation through the configured proxy:

```bash
HTTPS_PROXY=http://127.0.0.1:6268 HTTP_PROXY=http://127.0.0.1:6268 npm install
```

The local API binds to loopback only. With `DEEPSEEK_API_KEY` set, it can call the official `deepseek-chat` endpoint; without a key, the local clarification and file workflow still works. The API key is never committed and is not stored in browser localStorage.

### Verification

```bash
npm run check
npm test
npm run build
```

See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for reproducible setup, data layout, recovery, release, and security guidance. The product requirements are documented in [`Deepseek-harness-for-seniors-应用设计方案.md`](Deepseek-harness-for-seniors-应用设计方案.md).

## License

The product shell is released under the MIT License. The vendored upstream source keeps its original license and notices.
