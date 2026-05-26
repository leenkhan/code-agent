# Changelog

## 0.3.3 - 2026-05-26

- LangGraph is now used as the internal agent workflow orchestration layer for planning, one-shot fix/run flows, chat-driven task execution, and resume paths.
- Added `@langchain/langgraph` and `@langchain/core` as runtime dependencies while keeping CodeShit local-first and CLI-only.
- Existing confirmation gates, patch artifacts, task state files, and safety policies remain unchanged.
- Interactive chat now supports internal history scrolling with `PageUp`/`PageDown`, plus `Ctrl+PageUp`/`Ctrl+PageDown` to jump to the top or bottom of long output.
- Long review reports, plan discussions, task execution logs, patch previews, and validation output can now be inspected without losing earlier content during TUI redraws.

## 0.3.2 - 2026-05-25

- Global LLM config now supports multiple saved providers in `~/.codeshit/config.json` under `providers`.
- `codeshit config` updates an existing provider entry when selected again, or appends a new entry when the provider is not yet configured.
- Provider entries now include `isDefault`; exactly one configured provider/model is treated as the default.
- Legacy single-provider global config is still accepted and is normalized into the new multi-provider shape.
- Runtime config uses the provider marked with `isDefault: true`; CLI and project `model` overrides only change the model name and do not switch providers.
- Chat adds `/model [model]` for session-local model switching within the current default provider only.
- Chat `/resume` without a task id now opens a picker for paused, blocked, running, or failed tasks, and auto-resumes when only one resumable task exists.
- `codeshit doctor` now reports the default provider/model and lists configured LLM providers.
