import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Calendar, ChevronDown, ChevronRight, Repeat } from "lucide-react";
import { type CSSProperties, useState } from "react";

import type { CalendarEvent, Kind, Quadrant, RoutineToday, WorkSignal } from "@/bindings";
import { areaLabel, shortDate } from "@/components/board/boardUtils";
import { CheckIcon } from "@/components/board/CheckIcon";
import {
  CARD_HEIGHT,
  type CardPosition,
  computeZonePositions,
} from "@/components/board/matrixGeometry";
import { InboxColumn } from "@/components/inbox/InboxColumn";
import { PostitCard, type PostitQuadrant } from "@/components/postit/PostitCard";
import type { DragData, DropData } from "@/components/today/useTimelineDnd";
import { calendarColorStyle } from "@/lib/projectCalendarColor";

type Props = {
  unscheduledTodays: WorkSignal[];
  unscheduledRoutines: RoutineToday[];
  allDayEvents: CalendarEvent[];
  onToggleDone: (id: string, done: boolean) => void;
  onToggleRoutine: (routineId: string, done: boolean) => void;
};

const KIND_KO: Record<Kind, string> = { personal: "개인", work: "업무" };

/**
 * 캡쳐보드 인박스와 동일: 178px 컬럼 + 1-col 스택(겹치는 카드 deck).
 * computeZonePositions: cols≤1 분기 — y step=58px(cap), x wobble=16/28, rotation ±2deg.
 * footerHeight=0(트레이엔 enrich 버튼 없음). 표 38px = 라벨 자리.
 */
const STEP = 58;
const DECK_TOP = 40;
const DECK_BOTTOM_PAD = 8;
const INBOX_WIDTH = 178;

function computeDeckHeight(count: number): number {
  if (count <= 0) return DECK_TOP; // 라벨 자리만 확보(allDay extras를 라벨 아래로 밀어냄).
  return DECK_TOP + (count - 1) * STEP + CARD_HEIGHT + DECK_BOTTOM_PAD;
}

function positionStyle(pos: CardPosition): CSSProperties {
  return {
    position: "absolute",
    left: pos.x,
    top: pos.y,
    transform: `rotate(${pos.rotation}deg)`,
  };
}

/** Postit quadrant 색 슬러그 매핑(`q1_do_now`→`q1`). 미분류는 null. */
function mapQuadrant(q: Quadrant): PostitQuadrant | null {
  switch (q) {
    case "q1_do_now":
      return "q1";
    case "q2_schedule":
      return "q2";
    case "q3_quick_contain":
      return "q3";
    case "q4_drop":
      return "q4";
    default:
      return null;
  }
}

function KindChip({ kind }: { kind: Kind }) {
  return <span className={`postit-card-chip postit-card-chip--${kind}`}>{KIND_KO[kind]}</span>;
}

function AreaChip({ tag }: { tag: NonNullable<WorkSignal["area"]> }) {
  return <span className="postit-card-chip">{areaLabel(tag)}</span>;
}

function CheckButton({
  done,
  onClick,
  label,
}: {
  done: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="postit-card-check"
      data-state={done ? "checked" : "unchecked"}
      aria-label={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      <CheckIcon />
    </button>
  );
}

/** 미배치 signal — postit 풀카피 비주얼. 절대배치 좌표는 상위에서 style로 주입. */
function SignalDraggableCard({
  signal,
  done,
  onToggleDone,
  style,
}: {
  signal: WorkSignal;
  done: boolean;
  onToggleDone: (id: string, done: boolean) => void;
  style?: CSSProperties;
}) {
  const data: DragData = { from: "tray", signalId: signal.id, title: signal.title };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tray:signal:${signal.id}`,
    data,
  });
  return (
    <PostitCard
      ref={setNodeRef}
      quadrant={mapQuadrant(signal.quadrant)}
      dragging={isDragging}
      style={style}
      data-kind="today"
      data-done={done || undefined}
      {...attributes}
      {...listeners}
      aria-label={`${signal.title} (Today, 드래그하여 시간축에 배치)`}
      tags={
        <>
          {signal.kind && <KindChip kind={signal.kind} />}
          {signal.area && <AreaChip tag={signal.area} />}
          <CheckButton
            done={done}
            onClick={() => onToggleDone(signal.id, !done)}
            label={done ? "완료 취소" : "완료"}
          />
        </>
      }
      body={signal.title}
      footer={shortDate(signal.createdAt)}
    />
  );
}

/** 미배치 routine — postit 풀카피 + 좌상단 Repeat 아이콘 유지. */
function RoutineDraggableCard({
  routine,
  onToggleRoutine,
  style,
}: {
  routine: RoutineToday;
  onToggleRoutine: (routineId: string, done: boolean) => void;
  style?: CSSProperties;
}) {
  const data: DragData = { from: "routine", routineId: routine.id, title: routine.title };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tray:routine:${routine.id}`,
    data,
  });
  return (
    <PostitCard
      ref={setNodeRef}
      dragging={isDragging}
      style={style}
      data-kind="routine"
      data-done={routine.done || undefined}
      {...attributes}
      {...listeners}
      aria-label={`${routine.title} (루틴, 드래그하여 시간축에 배치)`}
      tags={
        <>
          <span className="postit-card-icon" aria-label="루틴" title="루틴">
            <Repeat className="size-3" aria-hidden />
          </span>
          {routine.kind && <KindChip kind={routine.kind} />}
          {routine.area && <AreaChip tag={routine.area} />}
          <CheckButton
            done={routine.done}
            onClick={() => onToggleRoutine(routine.id, !routine.done)}
            label={routine.done ? "완료 취소" : "완료"}
          />
        </>
      }
      body={routine.title}
      footer={routine.freq}
    />
  );
}

/**
 * 미배치 트레이(스펙 §3·§D2·§D3). 시간 미지정 Today + 시간 미지정 루틴 + 종일 이벤트(접힘).
 * 카드는 캡쳐보드 인박스(1-col 스택 deck)와 동일 — 절대배치·겹침·회전을 `computeZonePositions` 공유로.
 * PR 5: 전체 영역이 droppable("tray") — 캔버스에서 unschedule, 카드는 draggable.
 */
export function UnscheduledTray({
  unscheduledTodays,
  unscheduledRoutines,
  allDayEvents,
  onToggleDone,
  onToggleRoutine,
}: Props) {
  const [allDayOpen, setAllDayOpen] = useState(false);
  const cardCount = unscheduledTodays.length + unscheduledRoutines.length;
  const empty = cardCount === 0 && allDayEvents.length === 0;

  const dropData: DropData = { to: "tray" };
  const { setNodeRef, isOver } = useDroppable({ id: "today-tray", data: dropData });

  // 1-col deck 좌표 — 캡쳐보드와 동일 함수, footerHeight=0 (트레이엔 enrich 버튼 없음).
  const deckHeight = computeDeckHeight(cardCount);
  const positions = computeZonePositions({
    count: cardCount,
    zone: "unclassified",
    rect: { x: 0, y: 0, w: INBOX_WIDTH, h: deckHeight },
    footerHeight: 0,
  });

  return (
    <aside
      ref={setNodeRef}
      className="today-tray"
      aria-label="미배치 항목"
      data-drop-over={isOver || undefined}
    >
      <InboxColumn label="Inbox" ko="미배치" count={cardCount}>
        <ul className="today-tray-deck" aria-label="미배치 카드" style={{ height: deckHeight }}>
          {unscheduledTodays.map((s, i) => (
            <li key={`s-${s.id}`} className="today-tray-card-item">
              <SignalDraggableCard
                signal={s}
                done={Boolean(s.todayDoneAt)}
                onToggleDone={onToggleDone}
                style={positionStyle(positions[i])}
              />
            </li>
          ))}
          {unscheduledRoutines.map((r, i) => (
            <li key={`r-${r.id}`} className="today-tray-card-item">
              <RoutineDraggableCard
                routine={r}
                onToggleRoutine={onToggleRoutine}
                style={positionStyle(positions[unscheduledTodays.length + i])}
              />
            </li>
          ))}
        </ul>
        {(empty || allDayEvents.length > 0) && (
          <div className="today-tray-extras">
            {empty && <div className="today-tray-empty">모든 항목이 시간축에 배치됐어요.</div>}
            {allDayEvents.length > 0 && (
              <div className="today-tray-section">
                <button
                  type="button"
                  className="today-tray-section-head"
                  onClick={() => setAllDayOpen((v) => !v)}
                  aria-expanded={allDayOpen}
                  aria-controls="today-tray-allday-body"
                  aria-label={`종일 이벤트 ${allDayEvents.length}건${allDayOpen ? "(펼침)" : "(접힘)"}`}
                >
                  {allDayOpen ? (
                    <ChevronDown className="size-3.5" aria-hidden />
                  ) : (
                    <ChevronRight className="size-3.5" aria-hidden />
                  )}
                  <Calendar className="size-3.5" aria-hidden />
                  <span>종일</span>
                  <span className="today-tray-count" aria-hidden>
                    {allDayEvents.length}
                  </span>
                </button>
                {allDayOpen && (
                  <ul
                    id="today-tray-allday-body"
                    className="today-tray-allday"
                    aria-label="종일 이벤트 목록"
                  >
                    {allDayEvents.map((e) => (
                      <li
                        key={e.id}
                        className="today-tray-chip"
                        style={calendarColorStyle(e.projectColor, e.projectTextColor)}
                        title={e.calendarSummary}
                      >
                        {e.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </InboxColumn>
    </aside>
  );
}
