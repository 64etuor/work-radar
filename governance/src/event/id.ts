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
