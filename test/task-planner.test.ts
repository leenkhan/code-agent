import { describe, expect, it } from "vitest";
import { buildOperationalFallbackPlan, normalizeTaskPlanForContext, parseTaskPlan } from "../src/agent/task-planner.js";

describe("parseTaskPlan", () => {
  it("parses a valid task plan", () => {
    const json = JSON.stringify({
      goal: "Add GitHub OAuth login",
      steps: [
        {
          id: "1",
          title: "Install dependencies",
          description: "Add oauth package",
          expectedFiles: ["package.json"],
          verification: "pnpm install",
          milestone: false
        },
        {
          id: "2",
          title: "Add OAuth route",
          description: "Create auth route handler",
          expectedFiles: ["src/auth/oauth.ts"],
          verification: "pnpm build",
          milestone: true
        }
      ]
    });
    const plan = parseTaskPlan(json);
    expect(plan.goal).toBe("Add GitHub OAuth login");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].id).toBe("1");
    expect(plan.steps[0].title).toBe("Install dependencies");
    expect(plan.steps[1].milestone).toBe(true);
  });

  it("auto-marks auth steps as milestones", () => {
    const json = JSON.stringify({
      goal: "Add authentication",
      steps: [
        {
          id: "1",
          title: "Implement login",
          description: "JWT based authentication",
          expectedFiles: [],
          verification: "pnpm build"
        }
      ]
    });
    const plan = parseTaskPlan(json);
    expect(plan.steps[0].milestone).toBe(true);
  });

  it("auto-marks migration steps as milestones", () => {
    const json = JSON.stringify({
      goal: "DB changes",
      steps: [
        {
          id: "1",
          title: "Create migration",
          description: "Add users table migration",
          expectedFiles: [],
          verification: "pnpm build"
        }
      ]
    });
    const plan = parseTaskPlan(json);
    expect(plan.steps[0].milestone).toBe(true);
  });

  it("parses fenced JSON", () => {
    const plan = parseTaskPlan('```json\n{"goal":"test","steps":[{"id":"1","title":"step","description":"desc","expectedFiles":[],"verification":"","milestone":false}]}\n```');
    expect(plan.goal).toBe("test");
    expect(plan.steps).toHaveLength(1);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTaskPlan("not json")).toThrow();
  });

  it("throws on missing goal", () => {
    expect(() => parseTaskPlan('{"steps":[{"id":"1","title":"s","description":"d","expectedFiles":[],"verification":"","milestone":false}]}')).toThrow();
  });

  it("throws on empty steps array", () => {
    expect(() => parseTaskPlan('{"goal":"test","steps":[]}')).toThrow();
  });

  it("parses plan with dependsOn", () => {
    const json = JSON.stringify({
      goal: "Multi-step feature",
      steps: [
        { id: "1", title: "Step 1", description: "First", expectedFiles: [], verification: "", milestone: false },
        { id: "2", title: "Step 2", description: "Second", expectedFiles: [], verification: "", milestone: false, dependsOn: ["1"] }
      ]
    });
    const plan = parseTaskPlan(json);
    expect(plan.steps[1].dependsOn).toEqual(["1"]);
  });
});

describe("buildOperationalFallbackPlan", () => {
  it("builds a Maven operational plan without calling the model", () => {
    const plan = buildOperationalFallbackPlan("构建代码，运行服务，并跑项目测试", {
      root: "/tmp/project",
      fileTree: ["pom.xml", "src/main/java/App.java"],
      importantFiles: []
    });

    expect(plan?.steps).toEqual([
      expect.objectContaining({
        title: "Build and test with Maven",
        verification: "mvn test"
      }),
      expect.objectContaining({
        title: "Start Spring Boot service",
        verification: "mvn spring-boot:run",
        dependsOn: ["1"]
      })
    ]);
  });

  it("prefers Maven wrapper when present", () => {
    const plan = buildOperationalFallbackPlan("build and test", {
      root: "/tmp/project",
      fileTree: ["pom.xml", "mvnw", ".mvn/wrapper/maven-wrapper.jar"],
      importantFiles: []
    });

    expect(plan?.steps[0]?.verification).toBe("./mvnw test");
  });

  it("uses system Maven when wrapper jar is missing", () => {
    const plan = buildOperationalFallbackPlan("build and test", {
      root: "/tmp/project",
      fileTree: ["pom.xml", "mvnw"],
      importantFiles: []
    });

    expect(plan?.steps[0]?.verification).toBe("mvn test");
  });

  it("rewrites generated Maven wrapper commands when wrapper jar is missing", () => {
    const plan = normalizeTaskPlanForContext({
      goal: "构建代码，运行服务，并跑项目测试",
      steps: [
        {
          id: "1",
          title: "Compile",
          description: "Compile",
          expectedFiles: [],
          verification: "./mvnw compile test-compile -DskipTests",
          milestone: false
        },
        {
          id: "2",
          title: "Start",
          description: "Start",
          expectedFiles: [],
          verification: "./mvnw spring-boot:run & sleep 15 && lsof -i :8080",
          milestone: false
        }
      ]
    }, {
      root: "/tmp/project",
      fileTree: ["pom.xml", "mvnw"],
      importantFiles: []
    });

    expect(plan.steps[0].verification).toBe("mvn compile test-compile -DskipTests");
    expect(plan.steps[1].verification).toBe("mvn spring-boot:run & sleep 15 && lsof -i :8080");
  });
});
