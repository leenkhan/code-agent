import type { RuntimeConfig } from "../types.js";
import { getProviderDefinition } from "./catalog.js";
import type { LlmProvider } from "./provider.js";
import { AnthropicCompatibleProvider } from "./anthropic.js";
import { DeepSeekProvider } from "./deepseek.js";
import { OpenAiProvider } from "./openai.js";

export function createLlmProvider(config: RuntimeConfig): LlmProvider {
  const provider = getProviderDefinition(config.provider);
  if (!config.apiKey) {
    throw new Error(`Missing ${config.provider} API key. Set ${provider.envKey} or run \`codeshit config\`.`);
  }

  if (provider.wireProtocol === "anthropic" || config.baseUrl?.includes("/anthropic")) {
    return new AnthropicCompatibleProvider(config.apiKey, {
      baseUrl: config.baseUrl ?? provider.defaultBaseUrl ?? "https://api.anthropic.com",
      defaultModel: config.model
    });
  }

  if (config.provider === "deepseek") {
    return new DeepSeekProvider(config.apiKey, {
      baseUrl: config.baseUrl,
      defaultModel: config.model
    });
  }
  return new OpenAiProvider(config.apiKey, {
    baseUrl: config.baseUrl,
    defaultModel: config.model
  });
}
