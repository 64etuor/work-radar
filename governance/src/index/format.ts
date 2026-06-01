import type { DecisionEntry, GovernanceIndex } from "./types.ts";

export function formatPrinciples(index: GovernanceIndex): string {
  const ps = index.principles;
  if (!ps.length) return "no principles found";
  return ps.map((p) => `${p.id} — ${p.title}`).join("\n");
}

export function formatDecisions(index: GovernanceIndex): string {
  const ds = index.decisions;
  if (!ds.length) return "no decisions found";
  return ds.map((d) => `${d.id}${d.status ? ` [${d.status}]` : ""} — ${d.title}`).join("\n");
}

export function formatDecision(entry: DecisionEntry | null, id: string): string {
  if (!entry) return `not found: ${id}`;
  const { row, supersededBy, referencedBy } = entry;
  const lines: string[] = [`${row.id}${row.status ? ` [${row.status}]` : ""} — ${row.title}`];
  if (row.date) lines.push(`date: ${row.date}`);
  if (row.excerpt) lines.push("", row.excerpt);
  const graph: string[] = [];
  if (row.supersedes.length) graph.push(`supersedes: ${row.supersedes.join(", ")}`);
  if (supersededBy.length) graph.push(`superseded-by: ${supersededBy.join(", ")}`);
  if (row.refs.length) graph.push(`refs: ${row.refs.join(", ")}`);
  if (referencedBy.length) graph.push(`referenced-by: ${referencedBy.join(", ")}`);
  if (graph.length) lines.push("", ...graph);
  return lines.join("\n");
}
