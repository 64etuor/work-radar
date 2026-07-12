// pushMutationError는 query 레이어 정본으로 승격 — 기존 콜사이트 import 경로 유지용 재수출.
export { pushMutationError } from "@/lib/query";

export function splitCsv(value: string) {
  return value.split(",").flatMap((item) => {
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function appendCsvToken(value: string, token: string) {
  const items = splitCsv(value);
  if (!items.includes(token)) items.push(token);
  return items.join(", ");
}

export function nullableText(value: string) {
  return value.trim() || null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}
