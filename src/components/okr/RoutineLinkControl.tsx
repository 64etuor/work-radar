import { Link2, Repeat } from "lucide-react";
import { useRef, useState } from "react";

import type { KeyResult } from "@/bindings";
import {
  RoutineModal,
  type RoutineModalAnchor,
  type RoutineModalState,
} from "@/components/board/RoutineModal";
import { type RoutineDraft } from "@/components/board/routineSchedule";
import { Button } from "@/components/ui/button";
import {
  localToday,
  useCreateRoutine,
  useRoutineTracking,
  useSetKeyResultRoutine,
} from "@/lib/query";

/**
 * KR ↔ 루틴 연결 컨트롤(수치형 KR 전용). 연결하면 진행이 루틴 완료에서 자동 파생되어
 * KR 값 입력·주간 체크인이 사라진다 — 입력은 매일 루틴 체크 한 곳으로 수렴.
 * 기존 루틴 선택 또는 KR 제목으로 새 루틴 생성(활성 구간=이 분기, 매주/매일).
 */
export function RoutineLinkControl({
  kr,
  quarterStart,
  quarterEnd,
}: {
  kr: KeyResult;
  quarterStart: string;
  quarterEnd: string;
}) {
  const [modal, setModal] = useState<RoutineModalState | null>(null);
  const modalSeqRef = useRef(0);
  const routines = useRoutineTracking(localToday(), 1);
  const setRoutine = useSetKeyResultRoutine();
  const createRoutine = useCreateRoutine();
  const pending = setRoutine.isPending || createRoutine.isPending;
  const routineItems = routines.data ?? [];
  const availableRoutines: typeof routineItems = [];
  for (const routine of routineItems) {
    if (routine.id !== kr.routineId) {
      availableRoutines.push(routine);
    }
  }

  const openModal = (anchor: RoutineModalAnchor) => {
    modalSeqRef.current += 1;
    setModal({
      mode: "create",
      nonce: modalSeqRef.current,
      anchor,
      defaults: {
        title: kr.title,
        startDate: quarterStart,
        endDate: quarterEnd,
      },
    });
  };

  const closeModal = () => setModal(null);

  const link = async (routineId: string | null) => {
    await setRoutine.mutateAsync({ id: kr.id, routineId });
    closeModal();
  };

  const createAndLink = async (draft: RoutineDraft) => {
    const routine = await createRoutine.mutateAsync({
      ...draft,
      area: null,
      kind: null,
    });
    await link(routine.id);
  };

  return (
    <>
      <Button
        variant={kr.routineId ? "secondary" : "outline"}
        size="sm"
        className="mission-kr-routine-btn"
        title={
          kr.routineId
            ? `루틴 연결됨: ${kr.routine?.title ?? "루틴"} — KR 진행이 자동 집계됩니다`
            : "루틴으로 자동화 — 매일 루틴 체크만 하면 KR 진행이 자동 집계됩니다"
        }
        onClick={(event) => openModal(anchorFromElement(event.currentTarget))}
      >
        <Repeat className="size-3.5" />
        {kr.routineId ? (kr.routine?.title ?? "루틴 자동화") : "루틴으로 자동화"}
      </Button>
      <RoutineModal
        state={modal}
        title="KR 루틴 자동화"
        widthPx={400}
        maxHeightPx={800}
        beforeForm={
          <div className="mission-routine-modal-head">
            <span className="mission-muted typo-caption-sm">루틴 체크 = KR 진행이 자동 집계</span>
            {kr.routineId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void link(null)}
              >
                연결 해제 (수동 입력으로)
              </Button>
            )}
            <div className="mission-routine-list">
              {availableRoutines.map((routine) => (
                <button
                  key={routine.id}
                  type="button"
                  className="mission-routine-item"
                  disabled={pending}
                  onClick={() => void link(routine.id)}
                >
                  <Link2 className="size-3.5" aria-hidden />
                  <span className="typo-body-md">{routine.title}</span>
                </button>
              ))}
              {routineItems.length === 0 && (
                <span className="mission-muted typo-body-md">활성 루틴이 없습니다.</span>
              )}
            </div>
            <span className="typo-label-sm">새 루틴 만들고 KR에 연결 (이 분기 동안)</span>
          </div>
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeModal();
        }}
        onSubmit={(draft) => void createAndLink(draft)}
      />
    </>
  );
}

function anchorFromElement(element: HTMLElement): RoutineModalAnchor {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  };
}
