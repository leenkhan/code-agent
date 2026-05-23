const secretHints = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /(OPENAI_API_KEY|DEEPSEEK_API_KEY|ZHIPU_API_KEY|ZAI_API_KEY|MOONSHOT_API_KEY|MINIMAX_API_KEY|DASHSCOPE_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY)\s*=\s*\S+/g
];

export function redactSecrets(input: string): string {
  return secretHints.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), input);
}
