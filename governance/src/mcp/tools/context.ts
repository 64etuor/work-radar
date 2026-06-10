import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Shared dependencies threaded into every domain tool registrar.
 *  Domain-specific deps (adapters, models, policy, …) are passed as a SECOND options
 *  argument per registrar — this stays minimal and is NOT a mega-context. */
export type ToolContext = {
  server: McpServer;
  /** Verdict tools (approve/reject/choose/accept_plan/accept_spec/…) register ONLY through
   *  this — the single executor-role verdict gate lives in server.ts. */
  registerVerdictTool: McpServer["registerTool"];
  workspace: string;
  repoRoot: string;
  now: () => Date;
  rand: () => number;
};
