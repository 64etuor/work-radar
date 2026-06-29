// Conductor handlers — split into focused modules (2026-06-29 architecture review: the original
// 917-LOC god file mixed spawn / redispatch / resume / prompt / backend selection / status). This
// barrel preserves the original public import surface; implementations live in:
//   - prompt.ts         buildPrompt, completionCertificationLines
//   - backend.ts        executor backend selection + viability probes + budget context + env defaults
//   - conductShared.ts  loadConductor + the shared spawn-and-record helpers + small projections
//   - spawn.ts          conductPlan (first conduct of a step)
//   - redispatch.ts     redispatchExecutorAttempt (token-exhaustion retry)
//   - resume.ts         resumeChosenEscalation (post-escalation resume)
//   - status.ts         conductorStatus (read-only render)

export {
  type ConductPlanInput,
  type ConductStepReport,
  type ConductPlanResult,
} from "./conductShared.ts";

export {
  type ConductorEnvelopeDefaults,
  type ExecutorViabilityProbes,
  type SelectedExecutorBackend,
  selectViableExecutorBackend,
} from "./backend.ts";

export {
  type RedispatchExecutorAttemptInput,
  type RedispatchExecutorAttemptResult,
  redispatchExecutorAttempt,
} from "./redispatch.ts";

export {
  type ResumeChosenEscalationInput,
  type ResumeChosenEscalationResult,
  resumeChosenEscalation,
} from "./resume.ts";

export { conductPlan } from "./spawn.ts";

export {
  type ConductorStatusStep,
  type ConductorStatusResult,
  conductorStatus,
} from "./status.ts";
