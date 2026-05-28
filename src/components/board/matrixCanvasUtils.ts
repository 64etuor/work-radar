/**
 * 인라인 제목 편집 결과를 정규화한다(순수 함수 — 단위테스트 대상).
 * 트림 후 빈 값이거나 원본과 동일하면 null(저장 안 함). 그 외 트림된 새 제목.
 */
export function normalizeTitleEdit(next: string, original: string): string | null {
  const trimmed = next.trim();
  if (trimmed === "" || trimmed === original.trim()) return null;
  return trimmed;
}
