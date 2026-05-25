export type ChatCommandDefinition = {
  command: string;
  aliases?: string[];
  usage: string;
  description: string;
  argumentHint?: string;
};

export type ChatCommandUsage = Record<string, number>;

export const chatCommandDefinitions: ChatCommandDefinition[] = [
  {
    command: "/apply-plan",
    usage: "/apply-plan",
    description: "Convert the current plan-mode discussion into an executable task plan"
  },
  {
    command: "/clear",
    usage: "/clear",
    description: "Clear in-memory conversation history"
  },
  {
    command: "/diff",
    usage: "/diff",
    description: "Print current git diff and latest run patch path"
  },
  {
    command: "/doctor",
    usage: "/doctor",
    description: "Print project diagnostics"
  },
  {
    command: "/exit",
    aliases: ["/quit"],
    usage: "/exit, /quit",
    description: "Leave chat"
  },
  {
    command: "/help",
    usage: "/help",
    description: "Show chat commands"
  },
  {
    command: "/model",
    usage: "/model [model]",
    description: "Switch models within the current default provider",
    argumentHint: "model"
  },
  {
    command: "/plan",
    usage: "/plan [goal]",
    description: "Enter multi-turn plan mode; does not edit files or run commands",
    argumentHint: "goal"
  },
  {
    command: "/resume",
    usage: "/resume [task-id]",
    description: "Resume a paused or incomplete task, or pick one when omitted",
    argumentHint: "task-id"
  },
  {
    command: "/tasks",
    usage: "/tasks",
    description: "List saved tasks and their status"
  }
];

export function findChatCommandDefinition(command: string): ChatCommandDefinition | undefined {
  return chatCommandDefinitions.find((definition) =>
    definition.command === command || definition.aliases?.includes(command)
  );
}

export function canonicalChatCommand(command: string): string | undefined {
  return findChatCommandDefinition(command)?.command;
}

export function rankChatCommands(
  definitions: ChatCommandDefinition[],
  usage: ChatCommandUsage
): ChatCommandDefinition[] {
  return [...definitions].sort((a, b) => {
    const countDiff = (usage[b.command] ?? 0) - (usage[a.command] ?? 0);
    if (countDiff !== 0) return countDiff;
    return a.command.localeCompare(b.command);
  });
}
