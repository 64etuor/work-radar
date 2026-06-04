import matter from "gray-matter";
import type { HypothesisKind, HypothesisRecord, HypothesisStatus } from "./types.ts";

const HYPOTHESIS_STATUSES: HypothesisStatus[] = ["testing", "verified", "refuted", "archived"];
const HYPOTHESIS_KINDS: HypothesisKind[] = ["commit_scope_hotspot_persists"];

export function isTerminalHypothesisStatus(status: HypothesisStatus): boolean {
  return status === "verified" || status === "refuted" || status === "archived";
}

export function parseHypothesisMarkdown(raw: string): HypothesisRecord {
  const parsed = matter(raw);
  const data = parsed.data;
  const id = requiredString(data, "id");
  const fromPattern = requiredString(data, "from_pattern");
  const kind = requiredEnum(data, "kind", HYPOTHESIS_KINDS);
  const scope = requiredString(data, "scope");
  const status = requiredEnum(data, "status", HYPOTHESIS_STATUSES);
  const testMethod = requiredString(data, "test_method");
  const baseline = requiredNumber(data, "baseline");
  const threshold = requiredNumber(data, "threshold");
  const expires = requiredDateString(data, "expires", raw);

  return {
    id,
    fromPattern,
    kind,
    scope,
    status,
    testMethod,
    baseline,
    threshold,
    expires,
    body: parsed.content,
  };
}

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Malformed hypothesis frontmatter: ${key} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Malformed hypothesis frontmatter: ${key} must be a finite number`);
  }
  return value;
}

function requiredDateString(data: Record<string, unknown>, key: string, raw?: string): string {
  const rawValue = rawFrontmatterValue(raw, key);
  if (rawValue !== null) {
    const date = unquote(rawValue);
    if (!isCalendarDate(date)) {
      throw new Error(`Malformed hypothesis frontmatter: ${key} must be YYYY-MM-DD`);
    }
    return date;
  }

  const value = data[key];
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const date = requiredString(data, key);
  if (!isCalendarDate(date)) {
    throw new Error(`Malformed hypothesis frontmatter: ${key} must be YYYY-MM-DD`);
  }
  return date;
}

function requiredEnum<T extends string>(data: Record<string, unknown>, key: string, values: T[]): T {
  const value = data[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Malformed hypothesis frontmatter: ${key} is not supported`);
  }
  return value as T;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function rawFrontmatterValue(raw: string | undefined, key: string): string | null {
  if (raw === undefined || !raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.slice(4, end).match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1] ?? null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
