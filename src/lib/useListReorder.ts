import { useEffect, useRef, useState } from "react";

/**
 * 공용 세로 리스트 드래그 정렬 훅 (Phase 17 Today, Phase 16 routines 재사용 — spec §1.C).
 *
 * 의존성 없이 기존 보드의 native pointer-drag 패턴(MatrixCanvas)을 따른다. dnd-kit 등 라이브러리를
 * 추가하지 않은 이유: 단순 1차원 재정렬이고, 보드가 이미 pointer 기반 드래그를 쓰므로 번들/패턴
 * 일관성을 위해 경량 native로 구현. rank 영속은 호출자가 onReorder(orderedIds)로 처리한다.
 *
 * 사용법:
 *   const dnd = useListReorder(items.map((i) => i.id), onReorder);
 *   <div {...dnd.containerProps}>
 *     {items.map((it) => (
 *       <div {...dnd.itemProps(it.id)} key={it.id}>
 *         <span {...dnd.handleProps(it.id)}>⠿</span>  // 드래그 핸들
 *         …
 *       </div>
 *     ))}
 *   </div>
 *
 * 클래스: 드래그 중 항목엔 `dragging`, 드롭 위치 인디케이터는 `drag-over-before`/`drag-over-after`가
 * data-attr로 노출되니 호출자가 CSS로 표시한다.
 */
export function useListReorder(ids: string[], onReorder: (orderedIds: string[]) => void) {
  // 드래그 중인 id (없으면 null).
  const [dragId, setDragId] = useState<string | null>(null);
  // 드롭 대상 id + before/after (인디케이터 표시용).
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null);

  // 최신 ids/콜백을 pointer 리스너에서 안전하게 읽기 위한 ref. 포인터 이벤트는
  // 항상 commit 이후 발생하므로 effect로 동기화해도 stale 위험이 없다(react-hooks/refs).
  const idsRef = useRef(ids);
  const cbRef = useRef(onReorder);
  useEffect(() => {
    idsRef.current = ids;
    cbRef.current = onReorder;
  });
  // id → 항목 DOM(드롭 인덱스 계산용).
  const itemEls = useRef<Map<string, HTMLElement>>(null);
  if (itemEls.current === null) itemEls.current = new Map();

  const registerItem = (id: string, el: HTMLElement | null) => {
    if (el) itemEls.current!.set(id, el);
    else itemEls.current!.delete(id);
  };

  const onHandlePointerDown = (e: React.PointerEvent, id: string) => {
    // 좌클릭/터치만. 다른 핸들/버튼과 충돌하지 않게 stopPropagation.
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    setDragId(id);
    setOver(null);

    // 드래그 중 행을 포인터에 맞춰 들어올려 따라오게 한다(브레인덤프 postit과 동일 감각).
    // React state 대신 직접 DOM 변형(MatrixCanvas 패턴) — 매 move 리렌더 회피.
    const startY = e.clientY;
    const draggingEl = itemEls.current!.get(id) ?? null;
    if (draggingEl) draggingEl.style.willChange = "transform";

    // 포인터 Y가 어느 항목의 어느 절반에 있는지 → 드롭 위치.
    const computeOver = (clientY: number): { id: string; before: boolean } | null => {
      let best: { id: string; before: boolean } | null = null;
      for (const oid of idsRef.current) {
        // 따라다니는(transform된) 자기 자신은 드롭 대상/측정에서 제외 —
        // 아니면 자신의 rect가 커서를 따라와 항상 self가 잡혀 재정렬이 안 된다.
        if (oid === id) continue;
        const el = itemEls.current!.get(oid);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          return { id: oid, before: clientY < r.top + r.height / 2 };
        }
        // 범위 밖이면 가장 가까운 끝으로 폴백(리스트 위/아래).
        if (clientY < r.top) {
          best = best ?? { id: oid, before: true };
        } else {
          best = { id: oid, before: false };
        }
      }
      return best;
    };

    const move = (ev: PointerEvent) => {
      if (draggingEl) {
        draggingEl.style.transform = `translateY(${ev.clientY - startY}px)`;
      }
      setOver(computeOver(ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      const target = computeOver(ev.clientY);
      // 들어올림 해제(따라다니던 transform 원복) 후 새 순서 반영.
      if (draggingEl) {
        draggingEl.style.transform = "";
        draggingEl.style.willChange = "";
      }
      setDragId(null);
      setOver(null);
      if (!target || target.id === id) return;

      // 새 순서 계산: id를 빼고, target 위치(before/after)에 끼운다.
      const next = idsRef.current.filter((x) => x !== id);
      const at = next.indexOf(target.id);
      if (at < 0) return;
      next.splice(target.before ? at : at + 1, 0, id);
      // 순서가 바뀐 경우에만 호출(불필요한 mutation 방지).
      const changed = next.some((x, i) => x !== idsRef.current[i]);
      if (changed) cbRef.current(next);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  return {
    /** 드래그 중인 항목 id (스타일링용). */
    dragId,
    /** 각 항목 래퍼에 펴 넣을 props (드롭 인디케이터 data-attr + ref). */
    itemProps: (id: string) => ({
      ref: (el: HTMLElement | null) => registerItem(id, el),
      "data-dragging": dragId === id ? "" : undefined,
      "data-drag-over": over?.id === id ? (over.before ? "before" : "after") : undefined,
    }),
    /** 드래그 핸들에 펴 넣을 props. */
    handleProps: (id: string) => ({
      onPointerDown: (e: React.PointerEvent) => onHandlePointerDown(e, id),
      style: { cursor: "grab", touchAction: "none" as const },
    }),
  };
}
