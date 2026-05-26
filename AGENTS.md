# AGENTS.md

## Project Goal

This repository implements CodeShit, a local-first CLI coding agent for messy codebases.

The current release line is `0.3.x`; the repository version is `0.3.3`. The published package is `@codeshit/cli`, and the CLI binary is `codeshit`.

CodeShit should help developers work inside an existing local project by reading safe project context, planning changes, producing unified diff patches, applying patches only after confirmation unless explicitly configured otherwise, running validation commands, repairing failures when possible, and saving artifacts for review and rollback.

Keep the product local-first, patch-first, and confirmation-oriented. Do not turn it into a backend service, web application, cloud agent, remote executor, or complex sandbox.

## Tech Stack

Use:

- Node.js 20+
- TypeScript
- ESM modules
- commander for CLI commands
- tsup for build
- OpenAI SDK and provider adapters for LLM calls
- zod for structured validation
- fast-glob and ignore for file discovery
- execa for command execution
- simple-git for git status and diff
- diff for patch handling
- fs-extra for filesystem utilities
- @inquirer/prompts for interactive confirmation and selection
- chalk and ora for terminal UI
- vitest for tests
- tree-sitter-wasms and web-tree-sitter for lightweight code-context support

Do not introduce:

- NestJS
- Fastify
- Express server
- PostgreSQL
- Redis
- Prisma
- BullMQ
- Docker sandbox
- MCP
- Web frontend
- Cloud sync
- Remote execution
- Complex sandboxing

Use LangGraph as the internal agent workflow orchestration layer for planning, one-shot fix/run flows, chat-driven task execution, and resume paths. Keep LangGraph usage local and embedded in the CLI; do not add LangSmith, LangGraph server, remote deployment, or web UI unless product direction explicitly changes.

## Product Scope for 0.3.x

Implement and maintain a local CLI tool named `codeshit`.

Primary commands:

- `codeshit` or `codeshit chat`
- `codeshit config`
- `codeshit init`
- `codeshit doctor`
- `codeshit plan "<task>"`
- `codeshit fix`
- `codeshit diff`
- `codeshit revert`
- `codeshit tasks`
- `codeshit resume [task-id]`

Interactive chat supports slash commands:

- `/help`
- `/doctor`
- `/diff`
- `/model [model]`
- `/tasks`
- `/resume [task-id]`
- `/plan [goal]`
- `/apply-plan`
- `/clear`
- `/exit` and `/quit`

Interactive chat also supports long-output navigation:

- `PageUp` and `PageDown` scroll chat history.
- `Ctrl+PageUp` and `Ctrl+PageDown` jump to the top or bottom of long chat history.
- New output should return the view to the bottom so active task progress remains visible.

The core workflow for code changes is:

1. Detect the current project root.
2. Collect safe project context.
3. Build a lightweight project profile from root markers, important files, source globs, toolchains, and validation commands.
4. Ask the LLM to plan or decompose the task.
5. Ask the user to confirm plans and patches unless `--auto-apply` is explicitly provided or an internal resume flow intentionally continues an already accepted task.
6. Convert model-generated file actions into unified diff patches.
7. Validate and display the patch.
8. Apply the patch locally.
9. Run configured or detected validation commands.
10. If validation fails, classify environment or code failures and attempt repair up to the configured limit.
11. Save run artifacts in `.codeshit/runs/`.
12. Save resumable multi-step task state in `.codeshit/tasks/`.

## State and Configuration

Project state is stored in:

- `.codeshit/config.json`
- `.codeshit/runs/`
- `.codeshit/tasks/`

Global state is stored in:

- `~/.codeshit/config.json`

Older pre-beta builds used `.code-agent` and `~/.code-agent`. On first run, CodeShit migrates old state directories to `.codeshit` and `~/.codeshit` when the new directories do not already exist. If both old and new directories exist, use the new `.codeshit` path and leave the old directory untouched.

Runtime configuration precedence is:

1. CLI flags
2. Project config
3. Global config
4. Defaults

Global LLM config supports multiple saved providers under `providers`. Exactly one provider entry should be marked `isDefault: true`. Runtime config uses that default provider/model unless a project or CLI model override is provided.

Project config and CLI `--model` values override only the model name for the current default provider. They must not switch providers.

Environment variables can provide API keys and take precedence over stored `apiKey` values. Do not print API keys.

Supported provider IDs are maintained in `src/llm/catalog.ts`; keep docs and tests aligned when provider names, default models, base URLs, or wire protocols change.

## Important Design Principles

- Keep the tool local-first and transparent.
- Prefer minimal patches over full-file rewrites.
- Use unified diff as the only patch artifact format.
- Use git diff for transparency.
- Preserve existing project style as much as possible.
- Do not modify files without user confirmation unless `--auto-apply` is explicitly provided or the user is resuming an already accepted task flow.
- Never read or write sensitive files by default.
- Store local run and task history for debugging, resume, and revert.
- Keep project understanding lightweight: file discovery, project profiles, toolchain detection, important files, source globs, and tree-sitter-assisted context are acceptable.
- Avoid heavyweight framework rewrites or language-specific subsystems unless they are clearly justified by repeated product needs.
- Prefer explicit TypeScript modules and simple state machines over framework-heavy orchestration.

## File Safety Rules

By default, never read these files:

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

By default, never write these paths:

- `.git/**`
- `node_modules/**`
- `venv/**`
- `.venv/**`
- `dist/**`
- `build/**`
- `.next/**`
- `.nuxt/**`
- `coverage/**`
- `.env`
- `.env.*`

Generated patches must also pass the same write policy. Do not bypass `src/safety/file-policy.ts` for patch application or file actions.

## Command Safety Rules

Validation commands may include common project checks such as:

- `npm test`
- `npm run test`
- `npm run build`
- `npm run lint`
- `npx tsc --noEmit`
- `pnpm test`
- `pnpm build`
- `pnpm lint`
- `yarn test`
- `yarn build`
- `pytest`
- `python -m pytest`
- `uv run pytest`
- `go test ./...`
- `cargo test`
- `swift test`
- `composer test`
- `bundle exec rspec`
- `dotnet test`

Commands that install dependencies require confirmation:

- `npm install`
- `pnpm install`
- `yarn install`
- `pip install`
- `poetry install`
- `cargo install`
- `flutter pub get`
- `pod install`

Never run dangerous commands:

- `rm -rf`
- `sudo`
- `chmod 777`
- `curl | sh`
- `wget | sh`
- `git push` unless it is an explicit dry run
- `npm publish`
- `mvn deploy`
- `gradle publish`
- `kubectl apply`
- `terraform apply`
- `docker run --privileged`
- `docker run --cap-add`

Long-running development commands such as `npm run dev`, `pnpm dev`, `yarn dev`, `vite`, `next dev`, `uvicorn`, `fastapi dev`, `mvn spring-boot:run`, and `gradle bootRun` should be treated as background service candidates rather than blocking validation steps.

## Multi-Step Tasks and Chat

For complex requests, CodeShit can decompose work into ordered steps, execute each step, show and apply patch diffs, run validation, attempt repair, pause at milestones or environment blockers, and resume later from saved task state.

Task state belongs under `.codeshit/tasks/<task-id>/` and includes the plan, current state, and step result artifacts. Run artifacts belong under `.codeshit/runs/<run>/` and may include task text, transcript, context, plan, patches, repair patches, environment fixes, and result metadata.

Plan Mode in chat is non-mutating until the user applies it. `/plan [goal]` enters multi-turn planning, and `/apply-plan` converts the current planning discussion into an executable task plan.

Long review reports, plan discussions, task execution logs, patch previews, and validation output must remain inspectable in the chat TUI. Keep scrolling behavior in the shared chat frame so fixes apply to review output and other task output consistently.

`/model [model]` is session-local and can switch only between models listed for the current default provider. Use `codeshit config` to change the default provider.

`codeshit resume [task-id]` and `/resume [task-id]` resume paused, blocked, running, or failed tasks. If no task ID is provided, the CLI may select or prompt from resumable tasks.

## Build and Test Commands

Use these commands for this repository:

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

When validating documentation-only changes, run at least:

```bash
pnpm lint
pnpm test
```

## Short-Term Direction

- Keep improving local task execution, project profiling, validation repair, chat ergonomics, and provider configuration.
- Keep chat long-output handling reliable for review reports, task logs, patches, and validation results.
- Keep migration from `.code-agent` to `.codeshit` backward compatible.
- Keep safety policies centralized and covered by tests.
- Keep LangGraph usage focused on local agent orchestration; do not expand it into hosted services, LangGraph server deployment, or remote execution by default.
- Do not add a backend service, database, Redis, web UI, MCP integration, Docker sandbox, cloud sync, or remote execution unless the product direction explicitly changes.
