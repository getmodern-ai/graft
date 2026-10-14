/**
 * The tool screen's and the task step's choice once ready-made tools are offered (GRA-276), pure:
 * one choice across both lists, a ready-made tool or a task to build, so picking one clears the
 * other. A task a ready-made tool already does is not offered to build beside it, since the
 * ready-made one is there now and the build would take a minute to make the same thing.
 */

/** What the step has chosen: a ready-made tool by its wire name, or a task to build. */
export type ToolChoice = { kind: "ready"; tool: string } | { kind: "task"; text: string };

/** The tasks offered to build: the starter's, less any a ready-made tool already does. */
export function tasksBesideReadyMade(
  tasks: readonly string[],
  readyMade: readonly ReadyMadeTasks[],
): string[] {
  const done = new Set(readyMade.flatMap(tasksDoneBy));
  return tasks.filter((task) => !done.has(task));
}

/** What the offer says of a ready-made tool: its own task, and the starter's tasks it does. */
type ReadyMadeTasks = { goal: string; replaces?: readonly string[] };

/** Every task a ready-made tool does: its own, and those its curation names (`replaces`). */
function tasksDoneBy(tool: ReadyMadeTasks): string[] {
  return [tool.goal, ...(tool.replaces ?? [])];
}

/**
 * Where the step starts: the ready-made tool the record already holds while the step offers it, else
 * the task text it would have shown before (the record's own task, or the fallback, the curated
 * one), as the ready-made tool that does that task when one is offered, since the task is no longer
 * offered to build beside it.
 */
export function initialToolChoice(
  record: { stockTool: string | null; goal: string | null } | null | undefined,
  readyMade: readonly ({ tool: string } & ReadyMadeTasks)[],
  fallbackTask: string,
): ToolChoice {
  const held = record?.stockTool;
  if (held && readyMade.some((tool) => tool.tool === held)) return { kind: "ready", tool: held };
  const text = held ? fallbackTask : (record?.goal ?? fallbackTask);
  const doing = readyMade.find((tool) => tasksDoneBy(tool).includes(text.trim()));
  return doing ? { kind: "ready", tool: doing.tool } : { kind: "task", text };
}

/** The words the footer's summary shows for a choice, or empty for none yet. */
export function choiceSummary(
  choice: ToolChoice,
  readyMade: readonly { tool: string; goal: string }[],
): string {
  if (choice.kind === "ready") {
    return readyMade.find((tool) => tool.tool === choice.tool)?.goal ?? "";
  }
  return choice.text.trim();
}

/** The header's line under the title: what the person picks from. */
export function toolStepDescription(options: { readyMade: boolean; connected: boolean }): string {
  if (options.connected) {
    return options.readyMade
      ? "Use a ready-made tool, or pick one to build. It is connected already, so it starts now."
      : "Pick one read-only tool to build. It is connected already, so the build starts now.";
  }
  return options.readyMade
    ? "Start with a ready-made tool, or pick one for Graft to build. You can add more from the console after."
    : "Pick one read-only tool to build first. You can add more from the console after.";
}

/**
 * The connect step's line under its title, by the path the record holds (GRA-276): a ready-made
 * tool is copied in once the connection lands and nothing is built, so only a task to build says
 * Graft starts building. A record with neither asks for the connection as the agent's own.
 */
export function connectStepDescription(options: {
  vendorName: string;
  agentName: string;
  record: { stockTool: string | null; goal: string | null } | null | undefined;
}): string {
  const { vendorName, agentName, record } = options;
  if (record?.stockTool) return `Your tool is ready the moment ${vendorName} is connected.`;
  if (record?.goal) return `Graft starts building your tool the moment ${vendorName} is connected.`;
  return `${agentName} asks for this connection as its own, the way it would from your harness. Answer it here.`;
}
