import { reportTaskDone, type TaskGateResult } from "../task/handlers.ts";

/** Executor-role complete_task MCP handler: report a hint, never certify completion. */
export async function completeTaskTool(
  workspaceDir: string,
  input: { taskId: string },
  now: Date,
  rand: number,
): Promise<TaskGateResult> {
  return reportTaskDone(workspaceDir, input, now, rand);
}
