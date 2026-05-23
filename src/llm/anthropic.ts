import type { LlmProvider } from "./provider.js";

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string; thinking?: string }>;
  error?: { message?: string; type?: string };
};

export class AnthropicCompatibleProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxTokens: number;

  constructor(apiKey: string, options: { baseUrl: string; defaultModel?: string }) {
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.defaultModel = options.defaultModel ?? "deepseek-v4-pro";
    this.timeoutMs = Number(process.env.CODE_AGENT_LLM_TIMEOUT_MS ?? 120000);
    this.maxRetries = Number(process.env.CODE_AGENT_LLM_RETRIES ?? 2);
    this.retryBaseMs = Number(process.env.CODE_AGENT_LLM_RETRY_BASE_MS ?? 1000);
    this.maxTokens = Number(process.env.CODE_AGENT_LLM_MAX_TOKENS ?? 8192);
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
        return await this.send(input);
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries || !isRetryableError(error)) break;
        await sleep(this.retryBaseMs * Math.pow(2, attempt));
      }
    }
    throw lastError;
  }

  private async send(input: {
    system: string;
    prompt: string;
    model?: string;
    responseFormat?: "json_object";
  }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: input.model ?? this.defaultModel,
          max_tokens: this.maxTokens,
          temperature: 0.2,
          system: input.system,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: input.prompt }]
            }
          ]
        })
      });

      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Anthropic-compatible API request failed: ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
      }

      let data: AnthropicResponse;
      try {
        data = JSON.parse(body) as AnthropicResponse;
      } catch (error) {
        throw new Error(`Anthropic-compatible API response was not JSON: ${error instanceof Error ? error.message : String(error)}. Response preview: ${body.slice(0, 300)}`);
      }

      if (data.error) {
        throw new Error(`Anthropic-compatible API error: ${data.error.type ?? "unknown"} ${data.error.message ?? ""}`.trim());
      }

      const text = data.content
        ?.filter((part) => part.type === undefined || part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
        .trim() ?? "";
      if (!text) {
        const contentTypes = data.content?.map((part) => part.type ?? "text").join(", ") || "none";
        const hasThinking = data.content?.some((part) => part.type === "thinking" || Boolean(part.thinking)) ?? false;
        const hint = hasThinking
          ? ` The response only contained thinking content; the model likely ran out of output budget before producing the final answer. Current max_tokens=${this.maxTokens}.`
          : "";
        throw new Error(`Anthropic-compatible API response did not include text content. Content types: ${contentTypes}.${hint} Response preview: ${body.slice(0, 300)}`);
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

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (!(error instanceof Error)) return true;
  if (error.message.includes("only contained thinking content")) return true;
  if (error.message.includes("response did not include text content")) return false;
  if (error.message.includes("response was not JSON")) return false;
  return /\b(?:429|500|502|503|504)\b/.test(error.message);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
