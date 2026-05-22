# Code Agent

本项目是一个本地优先的 CLI 代码代理工具，命令名为 `code-agent`。

v0.2 的核心改进是将代码修改流程完全融入 chat 模式：用户用自然语言描述需求，LLM 识别意图后自动生成文件动作，写入后运行验证命令，**验证失败时自动进入修复循环**——不再需要显式使用 `run` 命令。`run` 命令已移除。

当前版本不包含后端服务、数据库、Redis、Web UI、MCP、LangGraph 或复杂沙箱。项目上下文仍保持本地优先，但会在文本级上下文之外补充轻量 AST/LSP-like 符号和诊断信息。

## 功能概览

- `code-agent init`：初始化全局配置和项目配置。
- `code-agent` / `code-agent chat`：进入交互式对话模式。用自然语言描述需求，LLM 自动识别意图（问答/改代码/执行命令），生成文件动作、写入文件、运行验证命令，验证失败时**自动尝试修复**。耗时阶段会显示进度状态和执行耗时。
- `code-agent doctor`：检查当前项目、配置、Git 和环境信息。
- `code-agent plan "<任务>"`：只生成实现计划，不修改文件。
- `code-agent fix`：基于当前验证失败结果尝试生成修复补丁。
- `code-agent diff`：打印当前 `git diff`，并显示最近一次运行产物位置。
- `code-agent revert`：反向应用最近一次运行保存的补丁。

## 环境要求

- Node.js 20+
- pnpm
- Git
- DeepSeek API Key，或 OpenAI API Key

安装依赖：

```bash
pnpm install
```

构建：

```bash
pnpm build
```

查看 CLI 帮助：

```bash
node dist/cli.js --help
```

## 快速开始

初始化配置：

```bash
node dist/cli.js init
```

检查当前项目：

```bash
node dist/cli.js doctor
```

进入交互式对话：

```bash
node dist/cli.js
```

或显式使用：

```bash
node dist/cli.js chat
```

生成计划：

```bash
node dist/cli.js plan "给 README 增加使用示例"
```

查看当前差异：

```bash
node dist/cli.js diff
```

撤销最近一次补丁：

```bash
node dist/cli.js revert
```

## 配置

Code Agent 支持两级配置：全局配置和项目配置。优先级为：

```txt
CLI 参数 > 项目配置 > 全局配置 > 默认值
```

### 全局配置

路径：

```txt
~/.code-agent/config.json
```

示例：

```json
{
  "provider": "deepseek",
  "apiKey": "sk-...",
  "model": "deepseek-v4-pro",
  "baseUrl": "https://api.deepseek.com"
}
```

默认按 DeepSeek V4 API 适配。DeepSeek V4 使用 OpenAI Chat Completions 兼容接口，默认模型为 `deepseek-v4-pro`，也可以改成 `deepseek-v4-flash`。

也可以通过环境变量提供 API Key：

```bash
export DEEPSEEK_API_KEY="sk-..."
```

如果使用 OpenAI provider，则配置示例为：

```json
{
  "provider": "openai",
  "apiKey": "sk-...",
  "model": "gpt-4.1"
}
```

对应环境变量：

```bash
export OPENAI_API_KEY="sk-..."
```

环境变量优先于全局配置里的 `apiKey`。CLI 不会打印 API Key。

### 项目配置

路径：

```txt
.code-agent/config.json
```

示例：

```json
{
  "model": "deepseek-v4-pro",
  "autoApply": false,
  "maxRepairAttempts": 3,
  "validationCommands": ["pnpm build", "pnpm test", "pnpm lint"],
  "ignore": [
    "node_modules",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    ".git"
  ]
}
```

## 命令说明

### `chat`

启动交互式终端对话。直接执行 `code-agent` 时也会进入这个模式。

普通输入会先收集当前项目上下文，再交给模型判断意图，因此可以询问项目结构、文件用途、可能的修改方案、错误原因等。上下文包含文件树、代表性文件内容、Git 状态/差异，以及轻量 AST/LSP-like 信息：TypeScript/JavaScript 会尽量通过 TypeScript Compiler API 提取函数、类、接口、类型、枚举、方法、变量和解析诊断；Python、Go、Rust、Java 等常见语言会用保守的文本规则提取主要符号。

对于"代码审查"、"review 当前项目"、"分析这个项目"这类只读项目分析请求，CLI 会直接基于已收集的文件树和代表性源码内容生成建议，不会要求你手动粘贴代码，也不会进入代码修改确认流程。

所有耗时阶段都会在终端显示进度状态，并在完成或失败时打印耗时，例如：

```txt
Collecting project context (180ms)
Generating project review (6.4s)
Running command: pnpm test (2.1s)
```

这些状态覆盖上下文收集、意图判断、LLM 回复、文件动作生成、命令执行、自动修复、`/doctor` 和 `/diff`。

**代码修改和自动修复（v0.2 核心功能）：**

如果模型判断你想修改代码，CLI 会先展示建议任务，再让模型生成结构化文件动作。确认后写入文件，然后按模型建议运行验证命令。

如果验证命令失败（如测试报错、编译失败），CLI 会**自动将错误信息反馈给 LLM，生成修复文件**，并在你确认后应用修复、重新运行验证。这个修复循环会持续到验证通过或达到 `maxRepairAttempts` 上限。

整个过程在 chat 模式下自然完成，不需要切换命令。

**命令执行：**

如果模型判断你想执行命令，CLI 会先展示建议命令和原因，并在确认后执行。

对于 `uvicorn ... --reload`、`npm run dev`、`pnpm dev`、`vite` 等长时间运行的开发服务，CLI 会作为后台进程启动，并立即回到输入状态。后续如果你表达"停止刚才的服务"这类意图，模型会结合后台进程列表返回具体停止命令，CLI 展示确认后执行。

如果服务不是由当前 chat 会话启动的，模型可以先返回受控内部命令查询外部服务，例如 `code-agent list-services 8000`。CLI 会用本机工具发现监听端口的进程并展示 pid；你再表达停止意图时，模型可以返回 `code-agent stop-service <pid>`，CLI 确认后停止该外部进程。

对话模式保留少量控制命令：

```txt
/help              显示对话命令
/doctor            打印项目诊断信息
/diff              打印当前 git diff 和最近运行目录
/clear             清空当前对话历史
/exit, /quit       退出对话
```

### `init`

创建或更新：

- `~/.code-agent/config.json`
- `.code-agent/config.json`
- `.code-agent/runs/`

如果配置已存在，命令会先询问是否更新，不会静默覆盖。

### `doctor`

打印当前环境和项目状态，包括：

- 当前工作目录
- 检测到的项目根目录
- Git 是否可用
- 当前目录是否为 Git 仓库
- Node.js 版本
- 全局配置和项目配置是否存在
- API Key 是否已配置
- 检测到的重要文件
- 配置的验证命令
- 非 Git 仓库安全提醒

### `plan "<任务>"`

只收集项目上下文并请求 LLM 生成实现计划，不会修改文件。

计划会保存到：

```txt
.code-agent/runs/<时间戳>-<任务摘要>/plan.md
```

### `fix`

运行验证命令。如果验证失败，会基于错误日志、当前 git diff 和项目上下文请求 LLM 生成修复补丁。

示例：

```bash
node dist/cli.js fix --cmd "pnpm test"
```

### `diff`

打印当前 `git diff`，并显示最近一次运行目录和补丁路径。

### `revert`

查找最近一次运行保存的 `patch.diff`，确认后执行：

```bash
git apply -R patch.diff
```

## 运行产物

每次 `chat`、`plan` 或 `fix` 会在 `.code-agent/runs/` 下创建运行目录，例如：

```txt
.code-agent/runs/YYYYMMDD-HHmmss-slug/
  task.txt
  transcript.json
  context.json
  plan.md
  patch.diff
  applied.diff
  validation.log
  repair-1.diff
  repair-1.log
  result.json
```

`chat` 会保存 `transcript.json`；`plan` 和 `fix` 会按实际流程保存上下文、计划、补丁、验证日志和结果。这些文件用于调试、审查和回滚。

## 安全规则

默认不会读取敏感文件：

- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `id_rsa`
- `id_ed25519`
- `.ssh/**`
- `.aws/**`
- `.gcp/**`
- `.azure/**`

默认不会写入这些路径：

- `.git/**`
- `node_modules/**`
- `dist/**`
- `build/**`
- `.next/**`
- `.nuxt/**`
- `coverage/**`
- `.env`
- `.env.*`

危险命令会被阻止，例如：

- `rm -rf`
- `sudo`
- `chmod 777`
- `curl | sh`
- `wget | sh`
- `git push`
- `npm publish`
- `kubectl apply`
- `terraform apply`
- `docker run --privileged`

安装类命令需要显式确认，例如：

- `npm install`
- `pnpm install`
- `yarn install`
- `pip install`
- `poetry install`
- `cargo install`

## 开发

常用命令：

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

开发模式运行：

```bash
pnpm dev --help
```

构建后运行：

```bash
node dist/cli.js --help
```

## v0.2 变更

- **移除 `run` 命令**：代码修改流程完全融入 chat 模式，用自然语言交互。
- **自动修复闭环**：chat 模式下写入文件后运行验证命令，失败时自动将错误反馈给 LLM 生成修复，循环至成功或达到次数上限。
- **项目审查体验优化**：chat 模式支持直接输入"代码审查"或"review 当前项目"，自动读取项目上下文并给出只读建议。
- **进度和耗时提示**：chat 模式的上下文收集、LLM 调用、命令执行和修复流程都会显示实时状态及耗时。
- **轻量 AST/LSP-like 上下文**：项目上下文新增 `symbols` 和 `diagnostics`，让代码审查、计划、修复更容易看到主要代码结构和语法诊断。
- LLM 调用增加 AbortController 超时取消和指数退避重试。
- 命令安全检查从子串匹配升级为正则词边界匹配，减少误拦截。
- 消除 `renderContext` 和 `extractJson` 的重复代码，提取到共享模块。

## 当前限制

- 补丁应用依赖 Git：使用 `git apply` 和 `git apply -R`。
- AST/LSP-like 上下文是轻量本地分析，不启动语言服务器，也不替代完整 IDE/LSP 的跨文件语义能力。
- `plan`、`fix` 需要可用的 API Key。
- 自动测试不调用真实 LLM，只覆盖安全策略、补丁校验、配置和运行时控制流。

## v0.2 范围外

本版本不会实现：

- Web UI
- 后端服务
- 数据库
- Redis 队列
- Docker 沙箱
- MCP
- LangGraph
- 多 Agent 架构
- Tree-sitter AST
- 外部 LSP Server 集成
- GitHub PR 创建
- 云端执行
