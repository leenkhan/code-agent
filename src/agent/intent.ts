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
    intent: z.literal("task_goal"),
    task: z.string(),
    reason: z.string()
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

function inferCodeChangeIntent(message: string): ChatIntent | undefined {
  const normalized = message.toLowerCase();
  const asksForCreationOrImplementation = [
    "增加",
    "添加",
    "修改",
    "更新",
    "创建",
    "新建",
    "实现",
    "搭建",
    "生成",
    "写一个",
    "create",
    "build",
    "implement",
    "scaffold",
    "set up",
    "setup"
  ].some((keyword) => normalized.includes(keyword));
  if (!asksForCreationOrImplementation) return undefined;

  const targetsProjectOrCode = [
    "项目",
    "后端",
    "服务",
    "框架",
    "代码",
    "接口",
    "注册",
    "验证码",
    "找回密码",
    "邮箱",
    "邮件",
    "密码",
    "springboot",
    "spring boot",
    "kotlin",
    "sqlite",
    "sqllit",
    "backend",
    "service",
    "framework",
    "endpoint",
    "api",
    "project",
    "app",
    "application"
  ].some((keyword) => normalized.includes(keyword));
  if (!targetsProjectOrCode) return undefined;

  return {
    intent: "code_change",
    task: message,
    reason: "The user asked to create or implement project code; any requested run/test steps should happen after file generation."
  };
}

function inferTaskGoalIntent(message: string): ChatIntent | undefined {
  const normalized = message.toLowerCase();
  const goalKeywords = [
    "完成",
    "验证",
    "测试链路",
    "跑通",
    "启动服务",
    "运行服务",
    "启动并测试",
    "运行并测试",
    "修复后验证",
    "complete",
    "verify",
    "validate",
    "run and test",
    "start service",
    "start the service",
    "run the service",
    "after fixing",
    "end-to-end",
    "e2e"
  ];
  const strongCompositeGoals = [
    "启动服务并完成测试",
    "启动并测试",
    "运行并测试",
    "修复后验证",
    "完成测试链路",
    "run and test",
    "start service and test",
    "start the service and test",
    "after fixing"
  ];
  const executionKeywords = [
    "测试",
    "test",
    "build",
    "构建",
    "curl",
    "接口",
    "endpoint",
    "服务",
    "service",
    "验证",
    "validate",
    "verify"
  ];
  const hasGoal = goalKeywords.some((keyword) => normalized.includes(keyword));
  if (strongCompositeGoals.some((keyword) => normalized.includes(keyword))) {
    return {
      intent: "task_goal",
      task: message,
      reason: "The user described a multi-step execution or verification goal that should be planned, tracked, and resumable."
    };
  }
  const executionMatches = executionKeywords.filter((keyword) => normalized.includes(keyword)).length;
  const hasSequence = [
    "并",
    "以及",
    "然后",
    "再",
    "and",
    "then"
  ].some((keyword) => normalized.includes(keyword));

  if (!hasGoal || (executionMatches < 2 && !hasSequence)) return undefined;

  return {
    intent: "task_goal",
    task: message,
    reason: "The user described a multi-step execution or verification goal that should be planned, tracked, and resumable."
  };
}

export async function classifyChatIntent(input: {
  provider: LlmProvider;
  model: string;
  message: string;
  history: ChatMessage[];
  context: ProjectContext;
  runtimeContext?: string;
}): Promise<ChatIntent> {
  const inferred = inferCodeChangeIntent(input.message);
  if (inferred) return inferred;
  const taskGoal = inferTaskGoalIntent(input.message);
  if (taskGoal) return taskGoal;

  const response = await input.provider.generateText({
    model: input.model,
    responseFormat: "json_object",
    system: `You classify a user's terminal chat message for a local coding agent.
Return only strict JSON. Do not include markdown.

Choose exactly one intent:
- answer: The user is asking a question, brainstorming, requesting an explanation, or chatting. No file changes or command execution should happen.
- task_goal: The user describes a multi-step operational goal that must be planned, tracked, verified, and resumable, such as starting a service and testing it, running a build/test/curl validation chain, or validating after a fix.
- code_change: The user wants files edited, code written, bugs fixed, tests added, docs changed, formatting changed, or implementation work done.
- command: The user wants one explicit shell/project command run, such as "run pnpm test", "git status", "doctor", or one clear diagnostics command.

For code_change, produce a concise task that can be passed to the patch workflow.
For task_goal, preserve the full user goal so the task runtime can decompose it into steps.
For command, produce one safe command string. Prefer command only for explicit one-shot requests. Prefer validation commands like pnpm test, pnpm build, pnpm lint, npm test, npm run build, npm run lint, npx tsc --noEmit.
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
{"intent":"task_goal","task":"...","reason":"..."}
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
