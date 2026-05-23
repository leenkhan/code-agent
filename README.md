# CodeShit

CodeShit is a local-first CLI coding agent for messy codebases.

It reads your project, plans changes, shows patch diffs before writing, applies patches locally, runs validation commands, and can continue multi-step tasks with saved state.

> Public beta: CodeShit is a 0.x tool. It is patch-based, confirmation-oriented, and local-first, but command behavior and UX may still change quickly.

## Install

Install globally:

```bash
npm install -g @codeshit/cli
```

Run it:

```bash
codeshit
```

Or try it without installing:

```bash
npx @codeshit/cli
```

Requirements:

- Node.js 20+
- Git
- DeepSeek API key or OpenAI API key

## Quick Start

Initialize config:

```bash
codeshit init
```

Check project and environment detection:

```bash
codeshit doctor
```

Start interactive chat:

```bash
codeshit
```

Common commands:

```bash
codeshit plan "add password reset endpoints"
codeshit fix --cmd "pnpm test"
codeshit diff
codeshit revert
codeshit tasks
codeshit resume
```

## What It Does

- `codeshit` / `codeshit chat`: starts an interactive terminal coding session.
- `codeshit init`: creates global and project config.
- `codeshit doctor`: prints project, config, Git, and environment diagnostics.
- `codeshit plan "<task>"`: generates an implementation plan without editing files.
- `codeshit fix`: runs validation and attempts repair from command output.
- `codeshit diff`: prints current `git diff` and latest run patch history.
- `codeshit revert`: reverses the latest saved patch artifact.
- `codeshit tasks`: lists resumable task state.
- `codeshit resume [task-id]`: resumes a paused or incomplete task.

For code changes, CodeShit converts model-generated file actions into unified diff patches and prints them before applying:

```txt
Patch: patch.diff
===================================================================
--- a/src/auth/User.java
+++ b/src/auth/User.java
@@ -12,6 +12,8 @@
 ...
```

Patch artifacts are saved under `.codeshit/runs/<run>/` for review and rollback.

## Configuration

CodeShit uses two config levels:

```txt
CLI flags > project config > global config > defaults
```

Global config:

```txt
~/.codeshit/config.json
```

Project config:

```txt
.codeshit/config.json
```

Example project config:

```json
{
  "model": "deepseek-v4-pro",
  "autoApply": false,
  "maxRepairAttempts": 3,
  "validationCommands": ["pnpm build", "pnpm test", "pnpm lint"],
  "ignore": ["node_modules", "dist", "build", ".next", ".nuxt", "coverage", ".git"]
}
```

You can also provide API keys through environment variables:

```bash
export DEEPSEEK_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."
```

Environment variables take precedence over config file `apiKey` values. CodeShit does not print API keys.

### Migration From Pre-Beta Builds

Older local builds used `.code-agent` and `~/.code-agent`.

On first run, CodeShit migrates:

- `.code-agent` to `.codeshit`
- `~/.code-agent` to `~/.codeshit`

If both old and new directories exist, CodeShit uses the new `.codeshit` path and leaves the old `.code-agent` directory untouched.

## Chat Controls

Inside interactive chat:

```txt
/help              Show chat commands
/doctor            Print project diagnostics
/diff              Print current git diff and latest run patch history
/tasks             List saved tasks and their status
/resume [task-id]  Resume a paused or incomplete task
/plan [goal]       Enter multi-turn Plan Mode; does not edit files or run commands
/apply-plan        Convert the current Plan Mode discussion into an executable task plan
Shift+Tab          Leave Plan Mode and return to normal chat
/clear             Clear in-memory conversation history
/exit, /quit       Leave chat
```

For long-running dev servers such as `npm run dev`, `pnpm dev`, `vite`, or `mvn spring-boot:run`, CodeShit can start a background process and return to the prompt. Internal service-control commands use the `codeshit` command namespace, for example `codeshit list-services 8000`.

## Multi-Step Tasks

When a request is complex, CodeShit can decompose it into ordered steps:

1. Generate a task plan.
2. Execute each step.
3. Show and apply patch diffs.
4. Run validation commands.
5. Attempt repair when validation fails.
6. Pause at milestones or environment blockers.
7. Resume later from saved task state.

Task state is stored in:

```txt
.codeshit/tasks/<task-id>/
  plan.json
  state.json
  step-0-result.json
  step-1-result.json
```

Run artifacts are stored in:

```txt
.codeshit/runs/YYYYMMDD-HHmmss-slug/
  task.txt
  transcript.json
  context.json
  plan.md
  patch.diff
  environment-fix.diff
  repair-1.diff
  step-2-add-user-fields.diff
  result.json
```

## Safety Model

By default, CodeShit does not read sensitive files such as:

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

By default, it does not write generated/build folders or sensitive paths such as:

- `.git/**`
- `node_modules/**`
- `dist/**`
- `build/**`
- `.next/**`
- `.nuxt/**`
- `coverage/**`
- `.env`
- `.env.*`

Dangerous commands are blocked, including:

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

Install commands require explicit confirmation.

## For Contributors

Install dependencies:

```bash
pnpm install
```

Run from source:

```bash
pnpm dev --help
```

Build:

```bash
pnpm build
```

Run built CLI locally:

```bash
node dist/cli.js --help
```

Release checks:

```bash
pnpm lint
pnpm test
pnpm build
npm pack --dry-run
```

Validate the packed CLI in a temp project before publishing:

```bash
npm pack --dry-run
npm install -g ./codeshit-cli-0.3.1-beta.0.tgz
codeshit --help
codeshit doctor
```

Publish beta manually:

```bash
npm publish --access public --tag beta
```

## License

MIT
