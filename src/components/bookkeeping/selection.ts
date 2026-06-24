/**
 *  리뷰 큐 다중 선택용 작은 순수 API. 선택은 `ReadonlySet<string>`로 들고,
 *  매 변경마다 새 `Set`을 돌려준다(React state 불변 업데이트 친화).
 */

/**  id를 토글한다: 있으면 제거, 없으면 추가. 항상 새 `Set`을 반환한다. */
export function toggleSelection(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/**  선택된 id 배열(삽입 순서). */
export function selectedIds(set: ReadonlySet<string>): string[] {
  return Array.from(set);
}

/**  선택 전체 해제(빈 `Set`). */
export function clearSelection(): Set<string> {
  return new Set();
}
