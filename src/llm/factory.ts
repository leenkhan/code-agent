import type { RuntimeConfig } from "../types.js";
import type { LlmProvider } from "./provider.js";
import { DeepSeekProvider } from "./deepseek.js";
import { OpenAiProvider } from "./openai.js";

export function createLlmProvider(config: RuntimeConfig): LlmProvider {
  if (!config.apiKey) {
    const envName = config.provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
    throw new Error(`Missing ${config.provider} API key. Set ${envName} or run \`code-agent init\`.`);
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
