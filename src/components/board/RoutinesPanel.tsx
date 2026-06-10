import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import type { Kind, LifeWheelTagConfig, Project, RoutineToday } from "@/bindings";
import { CheckIcon } from "@/components/board/CheckIcon";
import { AreaRadialPalette, CardTagEditor } from "@/components/board/LifeWheelPalette";
import { RoutineForm } from "@/components/board/RoutineForm";
import { type RoutineDraft, schedLabel } from "@/components/board/routineSchedule";
import { RoutineSyncButton } from "@/components/board/RoutineSyncButton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/components/ui/cn";
import { useListReorder } from "@/lib/useListReorder";

// 외부 소비자(CaptureBoard/ExecutionRail)가 이 모듈에서 RoutineDraft를 import 하므로 재export로 경로 유지.
export type { RoutineDraft };

// 매 렌더 새 JSX 노드 할당 방지(react-doctor/jsx-no-jsx-as-prop) — props/closure가 없는 정적 SVG.
const CHECK_INDICATOR = <CheckIcon />;

type Props = {
  routines: RoutineToday[];
  lifeWheelTags: LifeWheelTagConfig[];
  /** Google 캘린더 동기화 picker 후보 산출용(루틴 kind와 같은 kind 프로젝트의 선택 캘린더). */
  projects: Project[];
  onToggle: (routineId: string, done: boolean) => void;
  onCreate: (draft: RoutineDraft) => void;
  onUpdate: (id: string, draft: RoutineDraft) => void;
  onDelete: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onOpenTracking: () => void;
  /** 루틴 personal/work 즉시 갱신(signals와 동일 패턴). */
  onSetKind: (id: string, kind: Kind | null) => void;
  /** Life Wheel tag 단일 선택(커스텀 키 허용). */
  onSetAreaTagKey: (id: string, tagKey: string | null) => void;
  /** Google 동기화 ON(kind 일치 프로젝트 + 캘린더). */
  onEnableSync: (routineId: string, projectId: string, calendarId: string) => void;
  /** Google 동기화 OFF. */
  onDisableSync: (routineId: string) => void;
  /** 동기화 캘린더 이동(옛 master 삭제 + 새 캘린더에 생성). */
  onMoveSync: (routineId: string, projectId: string, calendarId: string) => void;
  /** 동기화 mutation 진행 중(중복 클릭 방지). */
  syncBusy?: boolean;
};

/** 우측 하단 Routines 패널 — 오늘 해당 반복 작업 체크리스트 + 추가 폼 + 드래그 정렬. */
export function RoutinesPanel({
  routines,
  lifeWheelTags,
  projects,
  onToggle,
  onCreate,
  onUpdate,
  onDelete,
  onReorder,
  onOpenTracking,
  onSetKind,
  onSetAreaTagKey,
  onEnableSync,
  onDisableSync,
  onMoveSync,
  syncBusy,
}: Props) {
  // open=false: 폼 닫힘. open=true + editId=null: 새 루틴 추가. open=true + editId: 수정 모드.
  // openSeq는 폼 remount nonce — 열 때마다 증가시켜 RoutineForm(key=openSeq)을 새로 마운트해
  // 입력 state를 리셋/재시드한다(과거 reset() + 개별 set* 동작과 동치).
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [openSeq, setOpenSeq] = useState(0);
  // BrainDump 카드와 동일하게 area 방사형 휠을 위한 anchor 상태(panel 내 자체 소유).
  const [areaPalette, setAreaPalette] = useState<{
    routineId: string;
    x: number;
    y: number;
  } | null>(null);

  const dnd = useListReorder(
    routines.map((r) => r.id),
    onReorder,
  );

  const openCreate = () => {
    setEditId(null);
    setOpenSeq((s) => s + 1);
    setOpen(true);
  };

  const openEdit = (r: RoutineToday) => {
    setEditId(r.id);
    setOpenSeq((s) => s + 1);
    setOpen(true);
  };

  const closeForm = () => {
    setOpen(false);
    setEditId(null);
  };

  const handleDelete = (r: RoutineToday) => {
    if (!window.confirm(`"${r.title}" 루틴을 삭제할까요?`)) return;
    onDelete(r.id);
  };

  return (
    <div className="panelbox">
      <div className="pb-head">
        <span className="lbl">Routines</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-2.5 text-[11px]"
          onClick={onOpenTracking}
          title="루틴 트래킹"
        >
          트래킹
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-2.5 text-[11px]"
          onClick={openCreate}
        >
          + 루틴
        </Button>
      </div>

      {open && (
        <RoutineForm
          key={openSeq}
          isEdit={editId !== null}
          initial={editId ? (routines.find((r) => r.id === editId) ?? null) : null}
          onSubmit={(draft) => {
            if (editId) onUpdate(editId, draft);
            else onCreate(draft);
            closeForm();
          }}
          onCancel={closeForm}
        />
      )}

      <div className="pb-body">
        {routines.length === 0 ? (
          <div className="empty">오늘 해당하는 루틴이 없습니다. + 루틴으로 추가</div>
        ) : (
          routines.map((r) => (
            <div key={r.id} className={cn("item", r.done && "done")} {...dnd.itemProps(r.id)}>
              <span className="grip" title="드래그로 정렬" {...dnd.handleProps(r.id)}>
                ⠿
              </span>
              <Checkbox
                className="cb-check"
                checked={r.done}
                onCheckedChange={(v) => onToggle(r.id, v === true)}
                aria-label={r.done ? "완료 해제" : "완료"}
                forceMountIndicator
                indicator={CHECK_INDICATOR}
              />
              <div className="body">
                <div className="ttl">
                  <span className="ttl-text">{r.title}</span>
                  {r.timeOfDay && <span className="ttl-time">{r.timeOfDay}</span>}
                </div>
                <div className="meta">
                  <span className="badge b-sched">{schedLabel(r)}</span>
                  <CardTagEditor
                    target={r}
                    tags={lifeWheelTags}
                    onSetKind={onSetKind}
                    onOpenAreaPalette={(button) => {
                      const rect = button.getBoundingClientRect();
                      setAreaPalette({
                        routineId: r.id,
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2,
                      });
                    }}
                  />
                </div>
              </div>
              <div className="ractions">
                <RoutineSyncButton
                  routine={r}
                  projects={projects}
                  onEnable={onEnableSync}
                  onDisable={onDisableSync}
                  onMove={onMoveSync}
                  busy={syncBusy}
                />
                <button
                  type="button"
                  className="ract"
                  title="수정"
                  aria-label="루틴 수정"
                  onClick={() => openEdit(r)}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="ract danger"
                  title="삭제"
                  aria-label="루틴 삭제"
                  onClick={() => handleDelete(r)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {areaPalette &&
        (() => {
          const target = routines.find((r) => r.id === areaPalette.routineId);
          if (!target) return null;
          return (
            <AreaRadialPalette
              target={target}
              tags={lifeWheelTags.filter((tag) => tag.enabled)}
              anchor={{ x: areaPalette.x, y: areaPalette.y }}
              onClose={() => setAreaPalette(null)}
              onSetAreaTagKey={onSetAreaTagKey}
            />
          );
        })()}
    </div>
  );
}
