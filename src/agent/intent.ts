import { z } from "zod";
import type { LlmProvider } from "../llm/provider.js";
import type { ProjectContext } from "../types.js";
import type { ChatMessage } from "./chat.js";
import { renderContext, extractJson } from "../utils/llm.js";

const intentSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("answer"),
    answer: z.string()
  }),
  z.object({
    intent: z.literal("code_change"),
    task: z.string(),
    reason: z.string()
  }),
  z.object({
    intent: z.literal("command"),
    command: z.string(),
    reason: z.string()
  })
]);

export type ChatIntent = z.infer<typeof intentSchema>;

function renderHistory(history: ChatMessage[]): string {
  if (history.length === 0) return "(empty)";
  return history.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

export function parseChatIntent(text: string): ChatIntent {
  const parsed = intentSchema.safeParse(JSON.parse(extractJson(text)) as unknown);
  if (!parsed.success) {
    throw new Error("Intent response did not match the expected schema.");
  }
  return parsed.data;
}

export async function classifyChatIntent(input: {
  provider: LlmProvider;
  model: string;
  message: string;
  history: ChatMessage[];
  context: ProjectContext;
  runtimeContext?: string;
}): Promise<ChatIntent> {
  const response = await input.provider.generateText({
    model: input.model,
    responseFormat: "json_object",
    system: `You classify a user's terminal chat message for a local coding agent.
Return only strict JSON. Do not include markdown.

Choose exactly one intent:
- answer: The user is asking a question, brainstorming, requesting an explanation, or chatting. No file changes or command execution should happen.
- code_change: The user wants files edited, code written, bugs fixed, tests added, docs changed, formatting changed, or implementation work done.
- command: The user wants a shell/project command run, such as tests, build, lint, doctor, status, or diagnostics.

For code_change, produce a concise task that can be passed to the patch workflow.
For command, produce one safe command string. Prefer validation commands like pnpm test, pnpm build, pnpm lint, npm test, npm run build, npm run lint, npx tsc --noEmit.
If the user wants to stop a currently running background command, return command intent with exactly:
- code-agent stop-background <id>
Use the running command id from the runtime context. If the user wants to stop all background commands, return:
- code-agent stop-background all
If the user wants to discover externally running local services, return:
- code-agent list-services
If the user names a port, return:
- code-agent list-services <port>
If the runtime context contains an external service pid and the user wants to stop that external service, return:
- code-agent stop-service <pid>
If the user asks to stop an external service but no pid is known yet, return a list-services command first.
Never choose command for dangerous, publishing, deployment, sudo, or destructive requests; answer with a refusal instead.
Reply in the user's language for answer intent.`,
    prompt: `Project context:
${renderContext(input.context)}

Conversation history:
${renderHistory(input.history.slice(-8))}

Runtime context:
${input.runtimeContext ?? "(none)"}

User message:
${input.message}

Return JSON matching one of:
{"intent":"answer","answer":"..."}
{"intent":"code_change","task":"...","reason":"..."}
{"intent":"command","command":"...","reason":"..."}`
  });
  try {
    return parseChatIntent(response);
  } catch {
    return {
      intent: "answer",
      answer: response.trim() || "我没能可靠判断你的意图。请换一种说法，或明确说明要修改代码还是执行命令。"
    };
  }
}
