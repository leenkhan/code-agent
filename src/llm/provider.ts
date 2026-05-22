export interface LlmProvider {
  generateText(input: {
    system: string;
    prompt: string;
    model?: string;
    responseFormat?: "json_object";
  }): Promise<string>;
}
