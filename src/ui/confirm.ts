import { confirm } from "@inquirer/prompts";

export async function askConfirm(message: string, defaultValue = false): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}
