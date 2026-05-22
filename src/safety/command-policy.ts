const dangerousPatterns: RegExp[] = [
  /\brm\s+(?:-r\S*|-f\S*|--recursive)/i,
  /\bsudo\b/i,
  /\bchmod\s+777\b/i,
  /\bcurl\b.+\|\s*(?:sh|bash)\b/i,
  /\bwget\b.+\|\s*(?:sh|bash)\b/i,
  /\bgit\s+push\b(?!\s+(?:--dry-run|-n))/i,
  /\bnpm\s+publish\b/i,
  /\bmvn\s+deploy\b/i,
  /\bgradle\s+publish\b/i,
  /\bkubectl\s+apply\b/i,
  /\bterraform\s+apply\b/i,
  /\bdocker\s+run\b.+(?:--privileged|--cap-add)/i
];

const installPatterns: RegExp[] = [
  /\bnpm\s+install\b/i,
  /\bpnpm\s+install\b/i,
  /\byarn\s+install\b/i,
  /\bpip\s+install\b/i,
  /\bpoetry\s+install\b/i,
  /\bcargo\s+install\b/i,
  /\bflutter\s+pub\s+get\b/i,
  /\bpod\s+install\b/i
];

export function isDangerousCommand(command: string): boolean {
  return dangerousPatterns.some((pattern) => pattern.test(command));
}

export function requiresInstallConfirmation(command: string): boolean {
  return installPatterns.some((pattern) => pattern.test(command.trim()));
}

export function assertCommandAllowed(command: string): void {
  if (isDangerousCommand(command)) {
    throw new Error(`Dangerous command blocked: ${command}`);
  }
}
