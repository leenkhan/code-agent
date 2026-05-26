import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

const NodeState = Annotation.Root({
  payload: Annotation<unknown>()
});

export async function runLangGraphNode<T>(
  nodeName: string,
  initialState: T,
  node: (state: T) => Promise<T> | T
): Promise<T> {
  const graph = new StateGraph(NodeState)
    .addNode(nodeName, async (state: typeof NodeState.State) => ({
      payload: await node(state.payload as T)
    }))
    .addEdge(START, nodeName)
    .addEdge(nodeName, END)
    .compile();

  const result = await graph.invoke({ payload: initialState });
  return result.payload as T;
}

export async function runLangGraphTask<T>(nodeName: string, task: () => Promise<T> | T): Promise<T> {
  const result = await runLangGraphNode<{ result?: T }>(nodeName, {}, async () => ({
    result: await task()
  }));
  return result.result as T;
}
