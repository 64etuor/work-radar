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

/**
 * 외부 서비스에 **쓰기**를 일으키는 액션 kind인지(noop 제외). 승인 패널이 중복-쓰기 잔여 위험(#5)
 * 캡션을 보일지 결정한다 — POST 도달 후 응답 유실 시 재승인이 중복일 수 있음을 사람에게 알린다.
 * dot 있는 kind = 외부 커넥터 액션(github / notion 등), noop 등 점 없는 kind는 외부 쓰기 아님.
 */
export function isExternalWriteKind(kind: string): boolean {
  return kind.includes(".");
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
  // 미매핑 서비스는 raw `service · kind` 라벨로 폴스루 — 새 커넥터 추가 전에도 깨지지 않게(의도, 버그 아님).
  return `${label[service] ?? service} · ${rest.join(".")}`;
}
