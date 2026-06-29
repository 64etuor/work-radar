import { loadConductor, type ConductPlanInput } from "./conductShared.ts";

export interface ConductorStatusStep {
  stepIndex: number;
  text: string;
  taskId: string | null;
  surface: string | null;
  taskPhase: string | null;
  halted: boolean;
}
export interface ConductorStatusResult {
  planId: string;
  planPhase: string;
  cursor: number | null;
  halted: boolean;
  done: boolean;
  steps: ConductorStatusStep[];
}

/** conductor_status — READ-ONLY render of the derived projection. Writes nothing. */
export async function conductorStatus(
  workspaceDir: string,
  input: ConductPlanInput,
): Promise<ConductorStatusResult> {
  const { state } = await loadConductor(workspaceDir, input.planId);
  return {
    planId: state.planId,
    planPhase: state.planPhase,
    cursor: state.cursor,
    halted: state.halted,
    done: state.done,
    steps: state.steps.map((s) => ({
      stepIndex: s.stepIndex,
      text: s.text,
      taskId: s.taskId,
      surface: s.surface,
      taskPhase: s.taskPhase,
      halted: s.halted,
    })),
  };
}
