import { createHash } from "node:crypto";

const HEX = "0123456789abcdef";

export type LayerPrefix = "evt" | "ptn" | "hyp" | "dec" | "prn";

/** Format a Date as YYYYMMDD_HHMMSS in UTC. */
export function stampUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** Inverse of stampUtc within a generateId-format id (`prefix_YYYYMMDD_HHMMSS_<4hex>`). Returns
 *  the encoded UTC instant, or null for ids that carry no stamp (deriveEventId ids like
 *  evt_commit_<sha> / evt_adr_ADR-0007). Used by TTL stall detection to age a session by its
 *  spawn-event id without a separate clock field. */
export function parseIdStampUtc(id: string): Date | null {
  const m = id.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!));
}

/** Deterministic id: prefix_YYYYMMDD_HHMMSS_<4hex>. rand in [0,1). */
export function generateId(prefix: LayerPrefix, now: Date, rand: number): string {
  let r = Math.floor(rand * 0x10000) & 0xffff;
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix = HEX[r & 0xf] + suffix;
    r >>= 4;
  }
  return `${prefix}_${stampUtc(now)}_${suffix}`;
}

/** Stable lowercase sha256 hex of a string. */
export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Deterministic event id from full, stable source identity.
 *  commit  → evt_commit_<full-40-hex-sha>
 *  adr     → evt_adr_<full-adr-id>            (e.g. evt_adr_ADR-0007)
 *  decision→ evt_decision_<sha256(normalized bullet text)>
 *  No truncation in the id itself; sha7/hash7 are filename/display-only. */
export function deriveEventId(kind: "commit" | "adr" | "decision", sourceKey: string): string {
  if (kind === "commit") return `evt_commit_${sourceKey}`;
  if (kind === "adr") return `evt_adr_${sourceKey}`;
  return `evt_decision_${sha256hex(sourceKey)}`;
}
