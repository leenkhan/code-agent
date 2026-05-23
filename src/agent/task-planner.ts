import { z } from "zod";
import type { LlmProvider } from "../llm/provider.js";
import type { ProjectContext, TaskPlan, TaskStep } from "../types.js";
import { renderContext, extractJson } from "../utils/llm.js";
import { buildProjectProfile, hasProfileMarker, normalizeVerificationCommand, validationCommandsForProfile } from "../project/profile.js";

const taskStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  expectedFiles: z.array(z.string()).default([]),
  verification: z.string().default(""),
  milestone: z.boolean().optional(),
  dependsOn: z.array(z.string()).optional()
});

const taskPlanSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(taskStepSchema).min(1)
});

export function parseTaskPlan(text: string): TaskPlan {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(text)) as unknown;
  } catch (error) {
    throw new Error(`Task plan response was not valid JSON: ${error instanceof Error ? error.message : String(error)}. Response preview: ${preview(text)}`);
  }
  const parsed = taskPlanSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Task plan did not match expected schema: ${parsed.error.message}. Response preview: ${preview(text)}`);
  }
  // Auto-detect milestone for steps that touch auth, schema, migration, or middleware
  for (const step of parsed.data.steps) {
    if (step.milestone === undefined) {
      step.milestone = isMilestoneStep(step);
    }
  }
  return parsed.data;
}

function preview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}...` : compact;
}

function isMilestoneStep(step: TaskStep): boolean {
  const keywords = [
    "auth", "认证", "登录", "权限",
    "migration", "迁移", "数据库",
    "schema", "env", "配置",
    "middleware", "中间件",
    "deploy", "部署", "publish"
  ];
  const text = `${step.title} ${step.description}`.toLowerCase();
  return keywords.some((kw) => text.includes(kw));
}

export async function generateTaskPlan(input: {
  provider: LlmProvider;
  model: string;
  goal: string;
  context: ProjectContext;
}): Promise<TaskPlan> {
  try {
    const response = await input.provider.generateText({
      model: input.model,
      responseFormat: "json_object",
      system: `You are a task planner for a local CLI code agent. Your job is to decompose a complex development goal into ordered, concrete, verifiable steps.

Return only strict JSON. Do not include markdown fences.

Each step must be:
- Small enough to complete in one focused pass
- Independently verifiable (a build, test, lint, service start, curl, or diagnostic command)
- Ordered logically (respect dependencies)

Mark a step as a "milestone" when it involves: authentication, authorization, database migrations, environment configuration, API signature changes, or middleware. The agent will pause at milestones for user confirmation.

If the goal is primarily operational validation, startup, testing, or curl verification, still return a structured task plan. Include resumable steps such as detecting the build tool, running build or unit tests, starting the service, running endpoint checks, and summarizing results. Do not collapse these goals into one command.

For operational validation steps, set expectedFiles to [] and put the exact shell command in verification. Do not invent file edits for build, test, service startup, curl, or summary steps unless the user explicitly asked to modify code. The executor treats expectedFiles: [] plus verification as a command-only step.

For a simple goal (single file change, small bug fix), 2-3 steps is fine.
For a feature, 4-7 steps.
For a full subsystem, 7-10 steps.
Never exceed 12 steps — if the goal is larger, scope it down to the first deliverable increment.`,
      prompt: `Goal:
${input.goal}

Project context:
${renderContext(input.context)}

Return JSON with this exact shape:
{
  "goal": "restated concise goal",
  "steps": [
    {
      "id": "1",
      "title": "short imperative title",
      "description": "what this step does and why",
      "expectedFiles": ["relative/path/to/file.ts"],
      "verification": "build or test command to run after this step",
      "milestone": false,
      "dependsOn": []
    }
  ]
}

Order steps so each one builds on the previous. Include dependsOn only when a step genuinely cannot start before another completes.`
    });

    return normalizeTaskPlanForContext(ensureImplementationPlan(parseTaskPlan(response), input.context, input.goal), input.context);
  } catch (error) {
    const fallback = buildOperationalFallbackPlan(input.goal, input.context);
    if (fallback) return normalizeTaskPlanForContext(fallback, input.context);
    throw error;
  }
}

export function normalizeTaskPlanForContext(plan: TaskPlan, context: ProjectContext): TaskPlan {
  const profile = context.profile ?? buildProjectProfile(context.fileTree);
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      verification: normalizeVerificationCommand(profile, step.verification)
    }))
  };
}

function ensureImplementationPlan(plan: TaskPlan, context: ProjectContext, requestedGoal: string): TaskPlan {
  const goalText = `${requestedGoal}\n${plan.goal}`;
  if (!isImplementationGoal(goalText)) return plan;
  if (plan.steps.some((step) => step.expectedFiles.length > 0)) return plan;

  const profile = context.profile ?? buildProjectProfile(context.fileTree);
  const verification = plan.steps.find((step) => step.verification.trim())?.verification
    ?? validationCommandsForProfile(profile, "verify")[0]
    ?? "";
  const expectedFiles = inferImplementationFiles(plan.goal, context);

  const implementationStep: TaskStep = {
    id: "1",
    title: "Implement requested code changes",
    description: `Modify the project code to satisfy this feature request: ${requestedGoal}`,
    expectedFiles,
    verification,
    milestone: isMilestoneStep({
      id: "1",
      title: plan.goal,
      description: plan.goal,
      expectedFiles,
      verification
    })
  };

  const verificationStep: TaskStep | undefined = verification
    ? {
      id: "2",
      title: "Verify implementation",
      description: "Run the project validation command after applying the code changes.",
      expectedFiles: [],
      verification,
      milestone: false,
      dependsOn: ["1"]
    }
    : undefined;

  return {
    ...plan,
    steps: verificationStep ? [implementationStep, verificationStep] : [implementationStep]
  };
}

function isImplementationGoal(goal: string): boolean {
  const normalized = goal.toLowerCase();
  const changeWords = [
    "增加", "添加", "修改", "更新", "实现", "新增",
    "add", "modify", "update", "implement", "create"
  ];
  const targetWords = [
    "接口", "api", "endpoint", "注册", "登录", "认证", "邮箱", "邮件", "email",
    "验证码", "找回密码", "密码", "password", "controller", "service", "entity"
  ];
  return changeWords.some((word) => normalized.includes(word))
    && targetWords.some((word) => normalized.includes(word));
}

function inferImplementationFiles(goal: string, context: ProjectContext): string[] {
  const normalizedGoal = goal.toLowerCase();
  const sourceFiles = context.fileTree.filter((file) => /\.(ts|tsx|js|jsx|java|kt|py|go|rs|php|rb|cs)$/i.test(file));
  const priorityWords = [
    "auth",
    "user",
    "security",
    "controller",
    "service",
    "repository",
    "model",
    "entity",
    "login",
    "register",
    "password",
    "email"
  ];
  const chineseIntent = ["注册", "登录", "认证", "验证码", "找回密码", "邮箱", "邮件", "密码", "接口"]
    .some((word) => normalizedGoal.includes(word));
  const scored = sourceFiles
    .map((file) => {
      const lower = file.toLowerCase();
      const score = priorityWords.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0)
        + (chineseIntent && /(?:auth|user|security|controller|service|repository|model|entity)/i.test(file) ? 2 : 0);
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .map((entry) => entry.file);

  if (scored.length > 0) return scored.slice(0, 8);
  return sourceFiles.slice(0, 5);
}

export function buildOperationalFallbackPlan(goal: string, context: ProjectContext): TaskPlan | undefined {
  const normalizedGoal = goal.toLowerCase();
  const isOperational = [
    "构建",
    "build",
    "运行服务",
    "启动服务",
    "run service",
    "start service",
    "测试",
    "test",
    "验证",
    "verify"
  ].some((keyword) => normalizedGoal.includes(keyword));
  if (!isOperational) return undefined;

  const profile = context.profile ?? buildProjectProfile(context.fileTree);
  const steps: TaskStep[] = [];

  const hasMaven = hasProfileMarker(context.fileTree, "pom.xml");
  const hasGradle = hasProfileMarker(context.fileTree, "build.gradle") || hasProfileMarker(context.fileTree, "build.gradle.kts");
  const hasPackageJson = hasProfileMarker(context.fileTree, "package.json");

  if (hasMaven) {
    const hasWrapper = hasProfileMarker(context.fileTree, ".mvn/wrapper/maven-wrapper.jar") && hasProfileMarker(context.fileTree, "mvnw");
    const mvn = hasWrapper ? "./mvnw" : "mvn";
    steps.push({
      id: "1",
      title: "Build and test with Maven",
      description: "Compile the project and run Maven tests.",
      expectedFiles: [],
      verification: `${mvn} test`,
      milestone: false
    });
    if (normalizedGoal.includes("运行") || normalizedGoal.includes("启动") || normalizedGoal.includes("service")) {
      steps.push({
        id: "2",
        title: "Start Spring Boot service",
        description: "Start the service so endpoint checks can run.",
        expectedFiles: [],
        verification: `${mvn} spring-boot:run`,
        milestone: false,
        dependsOn: ["1"]
      });
    }
  } else if (hasGradle) {
    const hasWrapper = hasProfileMarker(context.fileTree, "gradlew");
    const gradle = hasWrapper ? "./gradlew" : "gradle";
    steps.push({
      id: "1",
      title: "Build and test with Gradle",
      description: "Compile the project and run Gradle tests.",
      expectedFiles: [],
      verification: `${gradle} test`,
      milestone: false
    });
    if (normalizedGoal.includes("运行") || normalizedGoal.includes("启动") || normalizedGoal.includes("service")) {
      steps.push({
        id: "2",
        title: "Start Spring Boot service",
        description: "Start the service so endpoint checks can run.",
        expectedFiles: [],
        verification: `${gradle} bootRun`,
        milestone: false,
        dependsOn: ["1"]
      });
    }
  } else if (hasPackageJson) {
    const command = validationCommandsForProfile(profile, "verify")[0] ?? "npm test";
    steps.push({
      id: "1",
      title: "Run project tests",
      description: "Run the package test command.",
      expectedFiles: [],
      verification: command,
      milestone: false
    });
  }

  return steps.length > 0 ? { goal, steps } : undefined;
}

export async function adjustTaskPlan(input: {
  provider: LlmProvider;
  model: string;
  plan: TaskPlan;
  completedSteps: string[];
  currentIssue: string;
}): Promise<TaskPlan> {
  const response = await input.provider.generateText({
    model: input.model,
    responseFormat: "json_object",
    system: `You adjust an existing task plan based on execution progress and issues encountered.

Return only strict JSON. Do not include markdown fences.
Keep completed steps unchanged. Only modify, insert, or reorder remaining steps.
If the current issue requires a new step before continuing, insert it.
If later steps are no longer needed, remove them.`,
    prompt: `Current plan:
${JSON.stringify(input.plan, null, 2)}

Completed steps:
${input.completedSteps.join("\n")}

Issue encountered:
${input.currentIssue}

Return the adjusted full plan JSON with the same schema. Keep completed steps as-is.`
  });

  return parseTaskPlan(response);
}
