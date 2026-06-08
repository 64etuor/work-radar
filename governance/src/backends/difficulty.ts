export type Difficulty = "trivial" | "standard" | "hard";

export interface DifficultySignals {
  touchedFileCount?: number;
  hasForbiddenClass?: boolean;
  scopeTags?: readonly string[];
}

const HARD_SCOPE_TAGS = new Set([
  "architecture",
  "security",
  "dependency",
  "data-loss",
  "migration",
  "schema",
  "cross-cutting",
  "broad",
]);

const TRIVIAL_SCOPE_TAGS = new Set(["local", "targeted", "docs", "format", "test"]);

export function inferDifficulty(signals: DifficultySignals): Difficulty {
  const tags = signals.scopeTags ?? [];
  if (signals.hasForbiddenClass || (signals.touchedFileCount ?? 0) >= 6 || tags.some((t) => HARD_SCOPE_TAGS.has(t))) {
    return "hard";
  }
  if (
    signals.touchedFileCount !== undefined &&
    signals.touchedFileCount <= 1 &&
    tags.every((t) => TRIVIAL_SCOPE_TAGS.has(t))
  ) {
    return "trivial";
  }
  return "standard";
}
