import path from "node:path";
import fs from "fs-extra";
import { canonicalChatCommand, type ChatCommandUsage } from "../commands/chat-commands.js";
import { globalStateDir, migrateGlobalState } from "./paths.js";

export function chatCommandUsagePath(): string {
  return path.join(globalStateDir(), "chat-command-usage.json");
}

export async function readChatCommandUsage(): Promise<ChatCommandUsage> {
  await migrateGlobalState();
  const usagePath = chatCommandUsagePath();
  if (!(await fs.pathExists(usagePath))) return {};

  try {
    const raw = await fs.readJson(usagePath);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const usage: ChatCommandUsage = {};
    for (const [command, count] of Object.entries(raw)) {
      if (typeof count === "number" && Number.isFinite(count) && count > 0) {
        usage[command] = Math.floor(count);
      }
    }
    return usage;
  } catch {
    return {};
  }
}

export async function writeChatCommandUsage(usage: ChatCommandUsage): Promise<void> {
  await migrateGlobalState();
  const usagePath = chatCommandUsagePath();
  await fs.ensureDir(path.dirname(usagePath));
  await fs.writeJson(usagePath, usage, { spaces: 2 });
}

export async function recordChatCommandUsage(command: string): Promise<ChatCommandUsage> {
  const canonical = canonicalChatCommand(command);
  const usage = await readChatCommandUsage();
  if (!canonical) return usage;
  usage[canonical] = (usage[canonical] ?? 0) + 1;
  await writeChatCommandUsage(usage);
  return usage;
}
