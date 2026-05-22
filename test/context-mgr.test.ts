import { describe, expect, it } from "vitest";
import {
  compressCompletedSteps,
  buildStepContext,
  buildStepResult,
  buildFallbackSummary
} from "../src/agent/context-mgr.js";
import type { TaskPlan, TaskState, ProjectContext } from "../src/types.js";

const samplePlan: TaskPlan = {
  goal: "Add OAuth login",
  steps: [
    { id: "1", title: "Install deps", description: "Install oauth", expectedFiles: ["package.json"], verification: "pnpm install", milestone: false },
    { id: "2", title: "Add route", description: "Create route", expectedFiles: ["src/auth.ts"], verification: "pnpm build", milestone: true },
    { id: "3", title: "Add tests", description: "Write tests", expectedFiles: ["test/auth.test.ts"], verification: "pnpm test", milestone: false }
  ]
};

const sampleContext: ProjectContext = {
  root: "/test/project",
  fileTree: ["src/auth.ts", "package.json"],
  importantFiles: [],
  task: "test"
};

describe("compressCompletedSteps", () => {
  it("returns placeholder when no steps completed", () => {
    const state: TaskState = {
      taskId: "t1", status: "running", currentStepIndex: 0,
      completedSteps: [], knownFailures: [],
      createdAt: "", updatedAt: ""
    };
    expect(compressCompletedSteps(state)).toContain("no steps completed yet");
  });

  it("formats completed steps with files", () => {
    const state: TaskState = {
      taskId: "t1", status: "running", currentStepIndex: 1,
      completedSteps: [
        buildStepResult(
          { id: "1", title: "Install deps" },
          ["package.json", "pnpm-lock.yaml"],
          "passed",
          "Added oauth dependency"
        )
      ],
      knownFailures: [],
      createdAt: "", updatedAt: ""
    };
    const result = compressCompletedSteps(state);
    expect(result).toContain("Install deps");
    expect(result).toContain("passed");
    expect(result).toContain("package.json");
  });

  it("shows semantic warnings", () => {
    const state: TaskState = {
      taskId: "t1", status: "running", currentStepIndex: 1,
      completedSteps: [
        buildStepResult(
          { id: "1", title: "Add route" },
          ["src/auth.ts"],
          "passed",
          "Created auth route",
          ["Export not yet imported"]
        )
      ],
      knownFailures: [],
      createdAt: "", updatedAt: ""
    };
    const result = compressCompletedSteps(state);
    expect(result).toContain("semantic warnings");
  });

  it("compresses older steps when exceeding max", () => {
    const steps = Array.from({ length: 15 }, (_, i) =>
      buildStepResult(
        { id: String(i + 1), title: `Step ${i + 1}` },
        [`file${i + 1}.ts`],
        "passed",
        `Completed step ${i + 1}`
      )
    );
    const state: TaskState = {
      taskId: "t1", status: "running", currentStepIndex: 14,
      completedSteps: steps,
      knownFailures: [],
      createdAt: "", updatedAt: ""
    };
    const result = compressCompletedSteps(state);
    // Should mention "Earlier" section
    expect(result).toContain("Earlier");
    expect(result).toContain("Recent");
  });
});

describe("buildStepContext", () => {
  it("includes goal and current step info", () => {
    const state: TaskState = {
      taskId: "t1", status: "running", currentStepIndex: 0,
      completedSteps: [], knownFailures: [],
      createdAt: "", updatedAt: ""
    };
    const ctx = buildStepContext({ plan: samplePlan, state, stepIndex: 0, context: sampleContext });
    expect(ctx).toContain("Add OAuth login");
    expect(ctx).toContain("Install deps");
    expect(ctx).toContain("pnpm install");
  });

  it("includes known failures", () => {
    const state: TaskState = {
      taskId: "t1", status: "running", currentStepIndex: 0,
      completedSteps: [],
      knownFailures: ["Step 1 failed: ENOENT"],
      createdAt: "", updatedAt: ""
    };
    const ctx = buildStepContext({ plan: samplePlan, state, stepIndex: 0, context: sampleContext });
    expect(ctx).toContain("ENOENT");
  });

  it("includes project state", () => {
    const state: TaskState = {
      taskId: "t1", status: "running", currentStepIndex: 0,
      completedSteps: [], knownFailures: [],
      createdAt: "", updatedAt: ""
    };
    const ctx = buildStepContext({ plan: samplePlan, state, stepIndex: 0, context: sampleContext });
    expect(ctx).toContain("/test/project");
    expect(ctx).toContain("src/auth.ts");
  });
});

describe("buildStepResult", () => {
  it("creates a step result with all fields", () => {
    const result = buildStepResult(
      { id: "1", title: "Test" },
      ["a.ts"],
      "passed",
      "All good",
      ["Warning 1"]
    );
    expect(result.stepId).toBe("1");
    expect(result.title).toBe("Test");
    expect(result.filesChanged).toEqual(["a.ts"]);
    expect(result.verificationResult).toBe("passed");
    expect(result.summary).toBe("All good");
    expect(result.semanticWarnings).toEqual(["Warning 1"]);
  });
});

describe("buildFallbackSummary", () => {
  it("generates summary from step info", () => {
    const summary = buildFallbackSummary(
      { id: "1", title: "Add route" },
      { filesChanged: ["auth.ts"], verificationResult: "passed" }
    );
    expect(summary).toContain("Add route");
    expect(summary).toContain("auth.ts");
    expect(summary).toContain("passed");
  });
});
