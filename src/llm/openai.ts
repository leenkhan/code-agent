import OpenAI from "openai";
import type { LlmProvider } from "./provider.js";

const retryableStatuses = new Set([429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes("LLM response did not include text content")) {
    return false;
  }
  if (typeof OpenAI.APIError === "function" && error instanceof OpenAI.APIError) {
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

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fn(controller.signal);
      const text = extractText(response);
      if (!text.trim()) {
        throw new Error(`LLM response did not include text content. Response shape: ${summarizeResponse(response)}`);
      }
      return text;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`LLM request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const record = response as Record<string, unknown>;

  const text = record.output_text;
  if (typeof text === "string") return text;

  const output = record.output;
  if (Array.isArray(output)) {
    const parts = output.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as Record<string, unknown>).content;
      if (typeof content === "string") return [content];
      if (Array.isArray(content)) {
        return content.flatMap((part) => {
          if (!part || typeof part !== "object") return [];
          const partRecord = part as Record<string, unknown>;
          if (typeof partRecord.text === "string") return [partRecord.text];
          if (typeof partRecord.content === "string") return [partRecord.content];
          return [];
        });
      }
      return [];
    });
    if (parts.length > 0) return parts.join("");
  }

  const choices = record.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const message = (choice as Record<string, unknown>).message;
      if (!message || typeof message !== "object") continue;
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const parts = content.flatMap((part) => {
          if (!part || typeof part !== "object") return [];
          const partRecord = part as Record<string, unknown>;
          if (typeof partRecord.text === "string") return [partRecord.text];
          if (typeof partRecord.content === "string") return [partRecord.content];
          return [];
        });
        if (parts.length > 0) return parts.join("");
      }
    }
  }

  return "";
}

function summarizeResponse(response: unknown): string {
  if (!response || typeof response !== "object") return String(response);
  const keys = Object.keys(response as Record<string, unknown>);
  return keys.length > 0 ? `keys=${keys.join(",")}` : "empty-object";
}
