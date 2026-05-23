import { OpenAiProvider } from "./openai.js";

export class DeepSeekProvider extends OpenAiProvider {
  constructor(apiKey: string, options: { baseUrl?: string; defaultModel?: string } = {}) {
    super(apiKey, {
      baseUrl: options.baseUrl ?? "https://api.deepseek.com/anthropic",
      defaultModel: options.defaultModel ?? "deepseek-v4-pro"
    });
  }
}
