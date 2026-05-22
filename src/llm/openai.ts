import OpenAI from "openai";
import type { LlmProvider } from "./provider.js";

const retryableStatuses = new Set([429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    if (error.status && retryableStatuses.has(error.status)) return true;
    return false;
  }
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return true;
}

export class OpenAiProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(apiKey: string, options: { baseUrl?: string; defaultModel?: string } = {}) {
    this.client = new OpenAI({ apiKey, baseURL: options.baseUrl });
    this.defaultModel = options.defaultModel ?? "gpt-4.1";
    this.timeoutMs = Number(process.env.CODE_AGENT_LLM_TIMEOUT_MS ?? 120000);
    this.maxRetries = Number(process.env.CODE_AGENT_LLM_RETRIES ?? 2);
    this.retryBaseMs = Number(process.env.CODE_AGENT_LLM_RETRY_BASE_MS ?? 1000);
  }

  async generateText(input: {
    system: string;
    prompt: string;
    model?: string;
    responseFormat?: "json_object";
  }): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.withTimeout((signal) =>
          this.client.chat.completions.create(
            {
              model: input.model ?? this.defaultModel,
              messages: [
                { role: "system", content: input.system },
                { role: "user", content: input.prompt }
              ],
              temperature: 0.2,
              response_format: input.responseFormat === "json_object" ? { type: "json_object" } : undefined
            },
            { signal }
          )
        );
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries) break;
        if (!isRetryableError(error)) break;
        const delay = this.retryBaseMs * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<{ readonly choices: Array<{ readonly message?: { readonly content?: string | null } | null }> }>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fn(controller.signal);
      return response.choices[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }
}
