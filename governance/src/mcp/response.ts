/** Shared MCP response helpers for the standard ok/refused envelope shape.
 *  Only covers tools whose result is exactly `{ content: [{ type:"text", text: ... }] }` with
 *  no extra fields — tools with richer envelopes are handled inline. */

/** The standard MCP tool response envelope: a single text content item. */
export type TextContent = { content: [{ type: "text"; text: string }] };

/** Build a success text response: `"<verb>: <eventId>"`. */
function okText(verb: string, eventId: string): TextContent {
  return { content: [{ type: "text", text: `${verb}: ${eventId}` }] };
}

/** Build a refused text response: `"REFUSED: <reason>"`. */
export function refusedText(reason: string): TextContent {
  return { content: [{ type: "text", text: `REFUSED: ${reason}` }] };
}

/** Choose between ok and refused based on a standard `{ ok, eventId?, reason? }` result.
 *  Converts the common `r.ok ? \`verb: ${r.eventId}\` : \`REFUSED: ${r.reason}\`` pattern. */
export function okOrRefused(
  verb: string,
  r: { ok: boolean; eventId?: string; reason?: string },
): TextContent {
  return r.ok
    ? okText(verb, r.eventId ?? "")
    : refusedText(r.reason ?? "unknown");
}

/** Plain text response (for tools that produce freeform text).
 *  Exported again 2026-06-12: the unused-surface trim un-exported it, but the P2
 *  accept_plan checkless warning (mcp/tools/plans.ts) now consumes it. */
export function plainText(text: string): TextContent {
  return { content: [{ type: "text", text }] };
}
