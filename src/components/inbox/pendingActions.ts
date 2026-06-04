import type { PendingAction } from "../../bindings";

/** origin(에이전트)별로 대기 액션을 그룹핑. 표시 순서 보존(Map). */
export function groupPendingByOrigin(actions: PendingAction[]): Map<string, PendingAction[]> {
  const out = new Map<string, PendingAction[]>();
  for (const a of actions) {
    const list = out.get(a.origin) ?? [];
    list.push(a);
    out.set(a.origin, list);
  }
  return out;
}

/** "github.comment" → "GitHub · comment". 점 없는 kind는 그대로. */
export function formatActionKind(kind: string): string {
  const [service, ...rest] = kind.split(".");
  if (rest.length === 0) return kind;
  const label: Record<string, string> = {
    github: "GitHub",
    notion: "Notion",
    gmail: "Gmail",
    calendar: "Calendar",
  };
  return `${label[service] ?? service} · ${rest.join(".")}`;
}
