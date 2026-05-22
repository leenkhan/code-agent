# Code Agent

本项目是一个本地优先的 CLI 代码代理工具，命令名为 `code-agent`。

v0.3 的核心主题是**有状态的自主编程**：agent 不再只是"修改一次代码"，而是能**持续推进一个复杂开发任务直到完成**。v0.3 引入了 Task Runtime（任务分解 + 多步执行 + 断点续传），让 agent 从单轮补丁工具升级为真正的开发助手。

当前版本不包含后端服务、数据库、Redis、Web UI、MCP、LangGraph 或复杂沙箱。项目上下文仍保持本地优先，但会在文本级上下文之外补充轻量 AST/LSP-like 符号和诊断信息。

## 功能概览

- `code-agent init`：初始化全局配置和项目配置。
- `code-agent` / `code-agent chat`：进入交互式对话模式。用自然语言描述需求，LLM 自动识别意图（问答/改代码/执行命令），**复杂任务自动分解为多步计划并逐步执行**，每步写入文件、运行验证、失败时自动修复。耗时阶段会显示进度状态和执行耗时。
- `code-agent doctor`：检查当前项目、配置、Git 和环境信息。
- `code-agent plan "<任务>"`：只生成实现计划，不修改文件。
- `code-agent fix`：基于当前验证失败结果尝试生成修复补丁。
- `code-agent diff`：打印当前 `git diff`，并显示最近一次运行产物位置。
- `code-agent revert`：反向应用最近一次运行保存的补丁。
- `code-agent tasks`：列出所有已保存的任务及其状态。
- `code-agent resume [task-id]`：恢复一个暂停或未完成的任务，从断点继续执行。

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

查看已保存的任务：

```bash
node dist/cli.js tasks
```

恢复暂停的任务：

```bash
node dist/cli.js resume
```

或指定任务 ID：

```bash
node dist/cli.js resume 20260522-143000-add-oauth-login
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

普通输入会先收集当前项目上下文，再交给模型判断意图，因此可以询问项目结构、文件用途、可能的修改方案、错误原因等。上下文包含文件树、代表性文件内容、Git 状态/差异，以及轻量 AST/LSP-like 信息：TypeScript/JavaScript 会尽量通过 TypeScript Compiler API 提取函数、类、接口、类型、枚举、方法、变量和解析诊断；Python、Go、Rust、Java、Kotlin、Swift、PHP、Ruby、C# 等常见语言会优先通过 Tree-sitter WASM 语法树提取主要符号和解析错误，解析器或语法不可用时会回退到保守的文本规则。

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
/tasks             列出已保存的任务及状态
/resume [task-id]  恢复暂停或未完成的任务
/plan [goal]       进入多轮 Plan Mode，只讨论和收敛计划
/apply-plan        将当前 Plan Mode 讨论转换为可执行 TaskPlan
Shift+Tab          在 Plan Mode 中退出并回到普通 chat
/clear             清空当前对话历史
/exit, /quit       退出对话
```

**多轮 Plan Mode：**

在 chat 中输入 `/plan` 或 `/plan <goal>` 会进入持续的计划讨论模式。进入后，普通消息只用于澄清需求、比较方案和收敛计划，不会触发意图分类、文件写入、命令执行或任务执行。

Plan Mode 下输入提示会显示为 `you [PLAN - Shift+Tab exits]`，用于明确当前状态。按 `Shift+Tab` 可直接退出 Plan Mode 回到普通 chat；`/clear` 会清空对话并退出 Plan Mode。

当计划已经讨论清楚后，输入 `/apply-plan` 会把当前 plan-mode 历史和项目上下文转换为结构化 `TaskPlan`，展示步骤并复用现有确认机制。拒绝执行时，计划会以 ready 状态保存，之后可用 `/resume` 继续。

**多步任务执行（v0.3 核心功能）：**

当用户提出复杂开发任务（如"给项目加 GitHub OAuth 登录"、"实现完整的用户认证系统"），CLI 会自动检测并转入多步执行模式：

1. **任务分解**：LLM 将目标分解为有序、可独立验证的步骤（如：安装依赖 → 添加路由 → 添加 callback handler → 更新 env schema → 更新前端 → 添加中间件 → 写测试 → 验证）。
2. **逐步执行**：agent 按顺序执行每个步骤，每步独立生成代码、写入文件、运行验证、失败时进入修复循环。
3. **里程碑暂停**：涉及认证、数据库迁移、环境配置、中间件等关键步骤时自动暂停，等待用户确认后再继续。
4. **断点续传**：任务状态持久化到 `.code-agent/tasks/`，可随时 `/exit` 退出，下次用 `/resume` 从断点继续。
5. **进度展示**：每步执行时显示 `[2/8] 添加 OAuth route...` 及完成状态（✅ 通过 / ❌ 失败 / ⏭️ 跳过）。

简单任务（单文件修改、小 bug 修复）仍使用原有的单轮代码生成流程，不会进入多步模式。

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

### `tasks`

列出所有已保存的任务及状态：

```bash
node dist/cli.js tasks
```

输出示例：

```txt
✅ 20260522-143000-add-oauth-login
   Goal: Add GitHub OAuth login
   Status: completed | Updated: 2026-05-22T14:35:00.000Z

⏸️ 20260522-150000-user-auth-system
   Goal: 实现完整的用户认证系统
   Status: paused | Updated: 2026-05-22T15:20:00.000Z
```

### `resume`

恢复一个暂停或未完成的任务，从断点继续执行。

不指定任务 ID 时自动选择最近的未完成任务：

```bash
node dist/cli.js resume
```

指定任务 ID：

```bash
node dist/cli.js resume 20260522-150000-user-auth-system
```

恢复后 agent 会从上次中断的步骤继续执行，跳过已完成的步骤。在 CLI 模式下自动继续（不暂停确认）；在 chat 模式下使用 `/resume` 可获得完整交互体验。

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

### 任务存储

多步任务会持久化到 `.code-agent/tasks/` 目录：

```txt
.code-agent/tasks/<task-id>/
  plan.json              # TaskPlan（目标 + 步骤定义）
  state.json             # TaskState（完成进度、checkpoint）
  step-0-result.json     # 每个步骤的执行结果
  step-1-result.json
  ...
```

任务在以下情况自动保存：
- 任务计划生成后
- 每个步骤完成后
- 里程碑暂停时
- 遇到错误暂停时

使用 `code-agent tasks` 查看所有任务，`code-agent resume [task-id]` 从断点恢复。

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

## v0.3 变更

- **Task Runtime（多步任务执行引擎）**：复杂任务自动分解为有序步骤，逐步执行—生成代码—验证—修复，持续推动直到完成。
- **任务分解（Task Planner）**：LLM 将复杂目标分解为结构化步骤图，每步包含描述、预期文件、验证命令和依赖关系。认证、迁移、中间件等关键步骤自动标记为里程碑。
- **自主执行循环（Task Executor）**：async generator 事件流驱动，逐步执行计划、处理验证失败和修复循环。里程碑处自动暂停等待用户确认（混合执行模式）。
- **断点续传（Task Store）**：任务状态持久化到 `.code-agent/tasks/<id>/`，包含计划、完成进度、checkpoint 和每步执行产物。支持随时退出，下次从断点恢复。
- **跨步骤上下文压缩（Context Manager）**：每步只注入必要上下文（目标 + 已完成步骤摘要 + 当前步骤 + 项目状态），避免 token 爆炸。
- **新增命令**：`code-agent tasks`（列出任务）、`code-agent resume [task-id]`（恢复任务）。
- **Chat 命令扩展**：新增 `/tasks`、`/resume [task-id]`、`/plan [goal]`、`/apply-plan` 控制命令。
- **多轮 Plan Mode**：`/plan` 进入只讨论计划的多轮空间，普通消息不会触发意图分类、文件生成、命令执行或任务执行；`/apply-plan` 显式转为可执行 `TaskPlan`。
- **Plan Mode 状态提示和快捷退出**：Plan Mode 下输入提示显示 `you [PLAN - Shift+Tab exits]`，可按 `Shift+Tab` 退出回到普通 chat。
- **复杂任务自动检测**：chat 模式下根据关键词（auth、数据库、API、系统、全栈等）自动判断是否转入多步执行，简单任务仍走单轮流程。
- **进度实时展示**：每步执行时显示 `[2/8] 步骤标题` 和完成状态图标（✅/❌/⏭️）。

## v0.2 变更

- **移除 `run` 命令**：代码修改流程完全融入 chat 模式，用自然语言交互。
- **自动修复闭环**：chat 模式下写入文件后运行验证命令，失败时自动将错误反馈给 LLM 生成修复，循环至成功或达到次数上限。
- **项目审查体验优化**：chat 模式支持直接输入"代码审查"或"review 当前项目"，自动读取项目上下文并给出只读建议。
- **进度和耗时提示**：chat 模式的上下文收集、LLM 调用、命令执行和修复流程都会显示实时状态及耗时。
- **轻量 AST/LSP-like 上下文**：项目上下文新增 `symbols` 和 `diagnostics`，让代码审查、计划、修复更容易看到主要代码结构和语法诊断。符号会标注 `source`/`parser`，用于区分 TypeScript Compiler API、Tree-sitter 和正则回退来源。
- LLM 调用增加 AbortController 超时取消和指数退避重试。
- 命令安全检查从子串匹配升级为正则词边界匹配，减少误拦截。
- 消除 `renderContext` 和 `extractJson` 的重复代码，提取到共享模块。

## 当前限制

- 补丁应用依赖 Git：使用 `git apply` 和 `git apply -R`。
- AST/LSP-like 上下文是轻量本地分析，不启动语言服务器，也不替代完整 IDE/LSP 的跨文件语义能力。
- Tree-sitter 支持基于本地 WASM 语法包动态加载；如果运行环境无法加载解析器、某个语法版本不兼容，或语言不在当前映射内，CLI 会继续使用原有 TypeScript/正则路径。
- `plan`、`fix`、`resume` 需要可用的 API Key。
- 自动测试不调用真实 LLM，只覆盖安全策略、补丁校验、配置和运行时控制流。
- 多步任务执行依赖 LLM 生成合理的步骤计划；如果计划不合理（步骤粒度过大或过小），可能需要用户手动介入调整。

## v0.3 范围外

本版本不会实现：

- Web UI
- 后端服务
- 数据库
- Redis 队列
- Docker 沙箱
- MCP
- LangGraph
- 多 Agent 架构
- 外部 LSP Server 集成
- GitHub PR 创建
- 云端执行
- Symbol Graph / 相关性上下文检索（计划 v0.3.1）
- Semantic Verification / AST 级语义检查（计划 v0.3.2）
- Edit Strategy Engine / 分场景编辑模式（计划 v0.3.2）
