import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicCompatibleProvider } from "../src/llm/anthropic.js";

describe("AnthropicCompatibleProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the Anthropic messages endpoint and extracts text", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "{\"goal\":\"ok\",\"steps\":[]}" }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider("test-key", {
      baseUrl: "https://api.deepseek.com/anthropic",
      defaultModel: "deepseek-chat"
    });

    await expect(provider.generateText({ system: "sys", prompt: "prompt" })).resolves.toBe("{\"goal\":\"ok\",\"steps\":[]}");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/anthropic/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01"
        })
      })
    );
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const init = calls[0]![1];
    expect(JSON.parse(String(init.body)).max_tokens).toBe(8192);
  });

  it("retries thinking-only responses before failing the generation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [{ type: "thinking", thinking: "drafting..." }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [{ type: "text", text: "{\"files\":[]}" }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider("test-key", {
      baseUrl: "https://api.deepseek.com/anthropic"
    });

    await expect(provider.generateText({ system: "sys", prompt: "prompt" })).resolves.toBe("{\"files\":[]}");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports non-OK API responses with status and body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", {
      status: 404,
      statusText: "Not Found"
    })));

    const provider = new AnthropicCompatibleProvider("test-key", {
      baseUrl: "https://api.deepseek.com/anthropic"
    });

    await expect(provider.generateText({ system: "sys", prompt: "prompt" })).rejects.toThrow("404 Not Found");
  });

  it("reports request timeout clearly", async () => {
    vi.stubEnv("CODE_AGENT_LLM_TIMEOUT_MS", "1");
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        setTimeout(resolve, 50);
      });
      return new Response("{}", { status: 200 });
    }));

    const provider = new AnthropicCompatibleProvider("test-key", {
      baseUrl: "https://api.deepseek.com/anthropic"
    });

    await expect(provider.generateText({ system: "sys", prompt: "prompt" })).rejects.toThrow("LLM request timed out after 1ms");
  });
});
