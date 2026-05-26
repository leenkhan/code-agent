import { describe, expect, it } from "vitest";
import { runLangGraphNode, runLangGraphTask } from "../src/agent/graph/langgraph.js";

describe("LangGraph workflow helpers", () => {
  it("runs a task through a LangGraph node", async () => {
    await expect(runLangGraphTask("compute_value", async () => 42)).resolves.toBe(42);
  });

  it("passes and updates graph state", async () => {
    const result = await runLangGraphNode("increment", { count: 1 }, (state) => ({
      count: state.count + 1
    }));

    expect(result).toEqual({ count: 2 });
  });
});
