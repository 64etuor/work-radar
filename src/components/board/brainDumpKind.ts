import type { Kind } from "@/bindings";

export function nextBrainDumpKind(kind: Kind): Kind {
  return kind === "work" ? "personal" : "work";
}
