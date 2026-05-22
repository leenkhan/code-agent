#!/usr/bin/env node
import { Command } from "commander";
import { findProjectRoot } from "./project/root.js";
import { logger } from "./ui/logger.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { planCommand } from "./commands/plan.js";
import { fixCommand } from "./commands/fix.js";
import { diffCommand } from "./commands/diff.js";
import { revertCommand } from "./commands/revert.js";
import { chatCommand } from "./commands/chat.js";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("code-agent")
    .description("Local text-level CLI code agent — natural language driven with auto-repair")
    .version("0.2.0")
    .option("--model <model>", "model for interactive chat");

  program.action(async (options: { model?: string }) => {
    await chatCommand(await findProjectRoot(), options);
  });

  program.command("init").description("Create global and project code-agent config").action(async () => {
    await initCommand(await findProjectRoot());
  });

  program.command("doctor").description("Print detected project and configuration information").action(async () => {
    await doctorCommand(await findProjectRoot());
  });

  program.command("plan").argument("<task>").option("--model <model>").description("Generate and save an implementation plan").action(async (task: string, options: { model?: string }) => {
    await planCommand(await findProjectRoot(), task, options);
  });

  program.command("fix")
    .option("--auto-apply", "apply patches without confirmation")
    .option("--max-repair-attempts <number>")
    .option("--cmd <command>", "validation command", (value, previous: string[] = []) => [...previous, value], [])
    .option("--model <model>")
    .description("Run validation and repair failures")
    .action(async (options) => {
      await fixCommand(await findProjectRoot(), options);
    });

  program.command("diff").description("Print current git diff and latest run patch path").action(async () => {
    await diffCommand(await findProjectRoot());
  });

  program.command("revert").description("Revert latest applied patch").action(async () => {
    await revertCommand(await findProjectRoot());
  });

  program.command("chat")
    .option("--auto-apply", "write inferred file actions without confirmation")
    .option("--no-test", "skip validation commands for inferred code changes")
    .option("--max-repair-attempts <number>")
    .option("--cmd <command>", "validation command for inferred code changes", (value, previous: string[] = []) => [...previous, value], [])
    .option("--model <model>")
    .description("Start an interactive terminal conversation")
    .action(async (options) => {
      await chatCommand(await findProjectRoot(), options);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
