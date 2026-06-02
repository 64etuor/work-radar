#!/usr/bin/env node
// Bounded one-shot MCP client for the Boule governance server.
//   node bridge/boule-mcp.mjs <tool> [json-args]
// Spawns the stdio server, calls ONE tool, prints its text result to stdout, exits.
// Used by the inbound Telegram interceptor (choose) and the live-smoke runbook
// (escalate / pending_escalations / why). BOULE_WORKSPACE is inherited from env.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "src", "mcp", "server.ts");

const tool = process.argv[2];
if (!tool) {
  process.stderr.write("usage: boule-mcp.mjs <tool> [json-args]\n");
  process.exit(2);
}
let args = {};
if (process.argv[3]) {
  try {
    args = JSON.parse(process.argv[3]);
  } catch {
    process.stderr.write("invalid JSON args\n");
    process.exit(2);
  }
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["--experimental-strip-types", serverEntry],
  // Inherit env so BOULE_WORKSPACE (and PATH) reach the server unchanged.
  env: process.env,
  cwd: resolve(here, ".."),
});
const client = new Client({ name: "boule-bridge", version: "1.0.0" });

try {
  await client.connect(transport);
  const res = await client.callTool({ name: tool, arguments: args });
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  process.stdout.write(text + "\n");
  process.exitCode = res.isError ? 1 : 0;
} catch (err) {
  process.stderr.write(`boule-mcp error: ${err?.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
