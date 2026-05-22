import { resolveRuntimeConfig } from "../state/config.js";
import { executeFix } from "../agent/runtime.js";
import { logger } from "../ui/logger.js";
import { createLlmProvider } from "../llm/factory.js";

type FixCliOptions = {
  autoApply?: boolean;
  maxRepairAttempts?: string;
  cmd?: string[];
  model?: string;
};

export async function fixCommand(root: string, options: FixCliOptions): Promise<void> {
  const config = await resolveRuntimeConfig(root, {
    model: options.model,
    autoApply: options.autoApply,
    maxRepairAttempts: options.maxRepairAttempts ? Number(options.maxRepairAttempts) : undefined,
    validationCommands: options.cmd
  });
  const result = await executeFix({ root, config, provider: createLlmProvider(config), commands: options.cmd });
  logger.info(`Fix finished: ${result.status}`);
}
