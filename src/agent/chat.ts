import type { LlmProvider } from "../llm/provider.js";
import type { ProjectContext } from "../types.js";
import { renderContext } from "../utils/llm.js";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

function renderHistory(history: ChatMessage[]): string {
  if (history.length === 0) {
    return "(empty)";
  }
  return history.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

export async function generateChatReply(input: {
  provider: LlmProvider;
  model: string;
  message: string;
  history: ChatMessage[];
  context: ProjectContext;
}): Promise<string> {
  return input.provider.generateText({
    model: input.model,
    system: `You are Code Agent, a local CLI coding assistant running inside the user's terminal.
Answer conversationally and pragmatically.
Use the provided project context when useful.
When the user asks to review, inspect, explain, or analyze the current project/codebase, use the provided file tree and file contents. If context is incomplete, say what you could inspect and give concrete observations from the visible files instead of asking the user to paste project files.
Do not claim to have modified files unless a tool command or explicit patch workflow was used.
For file-changing work, explain what should be changed; the CLI will ask for confirmation before applying edits.
Do not reveal secrets, API keys, or sensitive file contents.
Reply in the same language the user uses unless they ask otherwise.`,
    prompt: `Project context:
${renderContext(input.context)}

Conversation history:
${renderHistory(input.history.slice(-12))}

User message:
${input.message}`
  });
}
