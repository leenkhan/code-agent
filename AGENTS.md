# AGENTS.md

## Project Goal

This repository implements a local CLI Code Agent.

The v0.1 target is a universal text-level code agent. It should work on any source-code project by reading files, searching text, generating plans, producing unified diff patches, applying patches after confirmation, running validation commands, and attempting repair based on command output.

This version must not implement a backend service, database, Redis, web UI, MCP, LangGraph, or complex sandbox.

## Tech Stack

Use:

- Node.js 20+
- TypeScript
- ESM modules
- commander for CLI commands
- tsup for build
- OpenAI SDK for LLM calls
- zod for structured validation
- fast-glob and ignore for file discovery
- execa for command execution
- simple-git for git status and diff
- @inquirer/prompts for interactive confirmation
- chalk and ora for terminal UI

Do not introduce:

- NestJS
- Fastify
- Express server
- PostgreSQL
- Redis
- Prisma
- BullMQ
- Docker sandbox
- LangGraph
- MCP
- Web frontend

## Product Scope for v0.1

Implement a local CLI tool named `code-agent`.

Primary commands:

- `code-agent init`
- `code-agent run "<task>"`
- `code-agent plan "<task>"`
- `code-agent fix`
- `code-agent doctor`
- `code-agent diff`
- `code-agent revert`

The core workflow for `run` is:

1. Detect current project root.
2. Collect general text-level project context.
3. Ask the LLM to generate a plan.
4. Ask the user to confirm the plan.
5. Ask the LLM to generate a unified diff patch.
6. Validate the patch format.
7. Show the diff to the user.
8. Ask the user to confirm before applying.
9. Apply the patch.
10. Run configured validation commands.
11. If validation fails, attempt repair up to the configured limit.
12. Save run artifacts in `.code-agent/runs/`.

## Important Design Principles

- Keep v0.1 simple and local-first.
- Use text-level project understanding only.
- Do not implement AST parsing yet.
- Do not implement language-specific adapters yet.
- Do not implement cloud sync or remote execution.
- Do not modify files without user confirmation unless `--auto-apply` is explicitly provided.
- Never read or write sensitive files by default.
- Prefer minimal patches over full-file rewrites.
- Always preserve existing project style as much as possible.
- Use unified diff as the only patch format.
- Use git diff for transparency.
- Store local task history for debugging and revert.

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
- `dist/**`
- `build/**`
- `.next/**`
- `.nuxt/**`
- `coverage/**`
- `.env`
- `.env.*`

## Command Safety Rules

Allowed commands should be limited to project validation commands such as:

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
- `go test ./...`
- `cargo test`
- `flutter analyze`
- `flutter test`

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
- `git push`
- `npm publish`
- `mvn deploy`
- `gradle publish`
- `kubectl apply`
- `terraform apply`
- `docker run --privileged`

## Build and Test Commands

Use these commands for this repository:

```bash
pnpm install
pnpm build
pnpm test
pnpm lint