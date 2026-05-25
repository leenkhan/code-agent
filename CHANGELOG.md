# Changelog

## 0.3.2 - 2026-05-25

- Global LLM config now supports multiple saved providers in `~/.codeshit/config.json` under `providers`.
- `codeshit config` updates an existing provider entry when selected again, or appends a new entry when the provider is not yet configured.
- Provider entries now include `isDefault`; exactly one configured provider/model is treated as the default.
- Legacy single-provider global config is still accepted and is normalized into the new multi-provider shape.
- Runtime config uses the provider marked with `isDefault: true`; CLI and project `model` overrides only change the model name and do not switch providers.
- Chat adds `/model [model]` for session-local model switching within the current default provider only.
- `codeshit doctor` now reports the default provider/model and lists configured LLM providers.
