import { describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: createMock
      }
    }
  }))
}));

import { OpenAiProvider } from "../src/llm/openai.js";

describe("OpenAiProvider", () => {
  it("extracts text from chat completion responses", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: "{\"ok\":true}" } }]
    });

    const provider = new OpenAiProvider("test-key");
    await expect(provider.generateText({ system: "s", prompt: "p" })).resolves.toBe("{\"ok\":true}");
  });

  it("extracts text from responses-style output_text", async () => {
    createMock.mockResolvedValueOnce({
      output_text: "{\"goal\":\"test\",\"steps\":[]}"
    });

    const provider = new OpenAiProvider("test-key");
    await expect(provider.generateText({ system: "s", prompt: "p" })).resolves.toBe("{\"goal\":\"test\",\"steps\":[]}");
  });

  it("throws a useful error when no text is present", async () => {
    createMock.mockResolvedValueOnce({ id: "resp_1", choices: [] });

    const provider = new OpenAiProvider("test-key");
    await expect(provider.generateText({ system: "s", prompt: "p" })).rejects.toThrow("Response shape: keys=id,choices");
  });
});
