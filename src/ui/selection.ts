export type ConfirmationAction = "proceed" | "skip" | "defer" | "cancel";

export type ConfirmationChoice = {
  value: ConfirmationAction;
  name: string;
  description?: string;
};

export function defaultConfirmationChoices(): ConfirmationChoice[] {
  return [
    { value: "proceed", name: "Proceed", description: "Continue with this action now." },
    { value: "skip", name: "Skip", description: "Skip this action and continue when possible." },
    { value: "defer", name: "Defer", description: "Save state and come back later." },
    { value: "cancel", name: "Cancel", description: "Stop the current task." }
  ];
}

export function actionFromConfirmation(answer: boolean, choices: ConfirmationChoice[] = defaultConfirmationChoices()): ConfirmationAction {
  if (answer) return "proceed";
  return choices.find((choice) => choice.value === "cancel")?.value
    ?? choices.find((choice) => choice.value === "skip")?.value
    ?? choices.find((choice) => choice.value === "defer")?.value
    ?? "cancel";
}
