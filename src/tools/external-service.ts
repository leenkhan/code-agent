import { execa } from "execa";
import { redactSecrets } from "../safety/secrets.js";

export type ExternalService = {
  pid: number;
  command: string;
  port?: number;
  address?: string;
  raw: string;
};

export type ServiceCommand =
  | { kind: "list"; port?: number }
  | { kind: "stop"; pid: number };

export function parseServiceCommand(command: string): ServiceCommand | undefined {
  const trimmed = command.trim();
  const list = trimmed.match(/^codeshit\s+list-services(?:\s+(\d+))?$/);
  if (list) {
    return { kind: "list", port: list[1] ? Number(list[1]) : undefined };
  }
  const stop = trimmed.match(/^codeshit\s+stop-service\s+(\d+)$/);
  if (stop) {
    return { kind: "stop", pid: Number(stop[1]) };
  }
  return undefined;
}

function parseLsofOutput(output: string, port?: number): ExternalService[] {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const command = parts[0] ?? "unknown";
      const pid = Number(parts[1]);
      const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/);
      const addressMatch = line.match(/\s((?:\*|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|localhost|[^:\s]+):\d+)\s+\(LISTEN\)/);
      return {
        pid,
        command,
        port: portMatch?.[1] ? Number(portMatch[1]) : port,
        address: addressMatch?.[1],
        raw: redactSecrets(line)
      };
    })
    .filter((service) => Number.isInteger(service.pid) && service.pid > 0);
}

export async function listExternalServices(port?: number): Promise<ExternalService[]> {
  const args = port
    ? ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]
    : ["-nP", "-iTCP", "-sTCP:LISTEN"];
  const result = await execa("lsof", args, { reject: false });
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return [];
  }
  return parseLsofOutput(result.stdout, port);
}

export async function stopExternalService(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid: ${pid}`);
  }
  const result = await execa("kill", [String(pid)], { reject: false });
  return result.exitCode === 0;
}

export function formatExternalServices(services: ExternalService[]): string {
  if (services.length === 0) return "No listening services found.";
  const unique = dedupeServices(services);
  const visible = unique.slice(0, 10);
  const rows = [
    "PID     PORT    COMMAND",
    ...visible.map((service) => `${pad(String(service.pid), 7)} ${pad(String(service.port ?? "unknown"), 7)} ${service.command}`)
  ];
  const hidden = unique.length - visible.length;
  if (hidden > 0) {
    rows.push(`... ${hidden} more service(s) hidden. Ask for a specific port, e.g. codeshit list-services 8000.`);
  }
  return rows.join("\n");
}

function dedupeServices(services: ExternalService[]): ExternalService[] {
  const byKey = new Map<string, ExternalService>();
  for (const service of services) {
    const key = `${service.pid}:${service.command}:${service.port ?? "unknown"}`;
    if (!byKey.has(key)) {
      byKey.set(key, service);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.port ?? 0) - (b.port ?? 0) || a.pid - b.pid);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}
