/** run.trigger(JSON)에서 PR 링크 정보 추출 (없으면 null). */
export function prTrigger(
  trigger: string | null,
): { prUrl: string; repoFullName: string; prNumber: number } | null {
  if (!trigger) return null;
  try {
    const v = JSON.parse(trigger);
    if (typeof v?.prUrl === "string") return v;
  } catch {
    /* 무시 — 트리거 없는 잡. */
  }
  return null;
}
