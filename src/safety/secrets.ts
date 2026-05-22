const secretHints = [/sk-[A-Za-z0-9_-]{20,}/g, /OPENAI_API_KEY\s*=\s*\S+/g, /DEEPSEEK_API_KEY\s*=\s*\S+/g];

export function redactSecrets(input: string): string {
  return secretHints.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), input);
}
