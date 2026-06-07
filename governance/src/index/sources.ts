/** Where buildIndex discovers L3/L4 markdown. Source discovery is data, not
 *  hardcoded paths, so governance-owned ADRs/decisions can live under
 *  `governance/docs/` while the repo-root app ADRs/decisions keep working.
 *  All paths are repo-root-relative (joined with repoRoot in build.ts). */

export type DecisionSource =
  | { kind: "adr-dir"; dir: string; sourcePathPrefix: string }
  | { kind: "decision-log"; file: string; sourcePath: string; idPrefix: string };

export type PrincipleSource = { kind: "rails"; file: string; sourcePath: string };

export interface IndexSources {
  readonly decisionSources: readonly DecisionSource[];
  readonly principleSources: readonly PrincipleSource[];
}

/** Default ingestion: repo-root app L3/L4 (back-compat) PLUS governance-owned
 *  L3/L4. Missing sources are fail-soft (absent dir/file is skipped), so a repo
 *  without the governance dirs still produces a valid root-only index.
 *  Governance decision-log rows are prefixed `GDL-*` to avoid colliding with the
 *  repo-root `DL-*` ordinals. `decision-rails.md` stays repo-wide (not Boule-only). */
export const DEFAULT_INDEX_SOURCES: IndexSources = {
  decisionSources: [
    { kind: "adr-dir", dir: "docs/adr", sourcePathPrefix: "docs/adr" },
    { kind: "adr-dir", dir: "governance/docs/adr", sourcePathPrefix: "governance/docs/adr" },
    { kind: "decision-log", file: "docs/decisions.md", sourcePath: "docs/decisions.md", idPrefix: "DL" },
    {
      kind: "decision-log",
      file: "governance/docs/decisions.md",
      sourcePath: "governance/docs/decisions.md",
      idPrefix: "GDL",
    },
  ],
  principleSources: [
    { kind: "rails", file: "docs/areas/decision-rails.md", sourcePath: "docs/areas/decision-rails.md" },
  ],
};
