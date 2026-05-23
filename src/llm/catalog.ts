import type { ProviderName } from "../types.js";

export type WireProtocol = "openai" | "anthropic";

export type ProviderDefinition = {
  id: ProviderName;
  displayName: string;
  envKey: string;
  wireProtocol: WireProtocol;
  defaultBaseUrl?: string;
  defaultModel: string;
  models: readonly string[];
};

export const providerCatalog = [
  {
    id: "openai",
    displayName: "OpenAI",
    envKey: "OPENAI_API_KEY",
    wireProtocol: "openai",
    defaultModel: "gpt-4.1",
    models: ["gpt-5.2", "gpt-5.1", "gpt-4.1"]
  },
  {
    id: "deepseek",
    displayName: "DeepSeek V4",
    envKey: "DEEPSEEK_API_KEY",
    wireProtocol: "anthropic",
    defaultBaseUrl: "https://api.deepseek.com/anthropic",
    defaultModel: "deepseek-v4-pro",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"]
  },
  {
    id: "zhipu-cn",
    displayName: "智谱 AI (中国)",
    envKey: "ZHIPU_API_KEY",
    wireProtocol: "openai",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    defaultModel: "glm-5.1",
    models: ["glm-5.1", "glm-4.7"]
  },
  {
    id: "zhipu-global",
    displayName: "Z.AI (Global)",
    envKey: "ZAI_API_KEY",
    wireProtocol: "openai",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4/",
    defaultModel: "glm-4.7",
    models: ["glm-4.7", "glm-4.7-flashx", "glm-4.7-flash"]
  },
  {
    id: "kimi-cn",
    displayName: "Kimi (中国)",
    envKey: "MOONSHOT_API_KEY",
    wireProtocol: "openai",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.6",
    models: ["kimi-k2.6", "kimi-k2.5", "kimi-thinking-preview"]
  },
  {
    id: "kimi-global",
    displayName: "Kimi (Global)",
    envKey: "MOONSHOT_API_KEY",
    wireProtocol: "openai",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.6",
    models: ["kimi-k2.6", "kimi-k2.5"]
  },
  {
    id: "minimax-cn",
    displayName: "MiniMax (中国)",
    envKey: "MINIMAX_API_KEY",
    wireProtocol: "openai",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M2.7",
    models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]
  },
  {
    id: "minimax-global",
    displayName: "MiniMax (Global)",
    envKey: "MINIMAX_API_KEY",
    wireProtocol: "openai",
    defaultBaseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.7",
    models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"]
  },
  {
    id: "qwen-cn",
    displayName: "Qwen (中国)",
    envKey: "DASHSCOPE_API_KEY",
    wireProtocol: "openai",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.6-plus",
    models: ["qwen3.6-plus", "qwen3.6-flash", "qwen3-max", "qwen-plus", "qwen-flash", "qwen3-coder-plus"]
  },
  {
    id: "qwen-global",
    displayName: "Qwen (Global)",
    envKey: "DASHSCOPE_API_KEY",
    wireProtocol: "openai",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.6-plus",
    models: ["qwen3.6-plus", "qwen3.6-flash", "qwen-plus", "qwen-flash", "qwen3-coder-plus"]
  },
  {
    id: "claude",
    displayName: "Claude",
    envKey: "ANTHROPIC_API_KEY",
    wireProtocol: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-6",
    models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]
  },
  {
    id: "gemini",
    displayName: "Gemini",
    envKey: "GEMINI_API_KEY",
    wireProtocol: "openai",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-3.5-flash",
    models: ["gemini-3.5-flash", "gemini-3.1-pro", "gemini-2.5-pro", "gemini-2.5-flash"]
  }
] as const satisfies readonly ProviderDefinition[];

export const providerIds = providerCatalog.map((provider) => provider.id) as [ProviderName, ...ProviderName[]];

export function getProviderDefinition(provider: ProviderName): ProviderDefinition {
  return providerCatalog.find((entry) => entry.id === provider) ?? providerCatalog[0]!;
}

export function getEnvApiKey(provider: ProviderName): string | undefined {
  return process.env[getProviderDefinition(provider).envKey];
}
