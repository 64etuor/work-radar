import { useCallback, useEffect, useRef, useState } from "react";

import type { Kind, PromotionTarget, Weekday } from "@/bindings";
import {
  type CardMenuAction,
  type CardMenuState,
  CardMenu,
} from "@/components/board/CardMenu";
import { CapturePanel } from "@/components/board/CapturePanel";
import { MatrixCanvas } from "@/components/board/MatrixCanvas";
import { RoutinesPanel } from "@/components/board/RoutinesPanel";
import { TodayRail } from "@/components/board/TodayRail";
import { zoneToQuadrant, type ZoneKey } from "@/components/board/board-utils";
import {
  localToday,
  localWeekday,
  useClassifySignal,
  useCreatePromotionDraft,
  useCreateRoutine,
  useCreateSignal,
  useProjects,
  usePromoteToday,
  useReorderToday,
  useSetSignalStatus,
  useSignals,
  useSnoozeSignal,
  useToday,
  useTodayRoutines,
  useToggleRoutineCheck,
  useToggleTodayDone,
  useUnpromoteToday,
  tomorrow,
} from "@/lib/query";

const PROMOTION_TARGET: Record<"backlog" | "agenda" | "calendar", PromotionTarget> = {
  backlog: "notion_backlog",
  agenda: "notion_agenda",
  calendar: "calendar",
};
const PROMOTION_LABEL: Record<"backlog" | "agenda" | "calendar", string> = {
  backlog: "백로그 등록",
  agenda: "안건 승격",
  calendar: "캘린더 등록",
};

/**
 * Capture Board — 5영역(미분류·2×2·Today·Routines·캡처) 결정 보드.
 * 서버 상태(useSignals/useToday/useTodayRoutines)에서 렌더, 뮤테이션은 refetch로 재동기화.
 * INVARIANT #1: 카드는 항상 unclassified 생성, 사분면 변경은 명시적 사람 제스처(드래그/키보드)뿐.
 * INVARIANT #2: 백로그/안건/캘린더는 promotion draft만 (외부 무변경, Acceptance 대기).
 */
export function CaptureBoard() {
  const today = localToday();
  const weekday = localWeekday();

  const signalsQ = useSignals();
  const todayQ = useToday(today);
  const routinesQ = useTodayRoutines(today, weekday);
  const projectsQ = useProjects();

  const createSignal = useCreateSignal();
  const classifySignal = useClassifySignal();
  const promoteToday = usePromoteToday();
  const unpromoteToday = useUnpromoteToday();
  const toggleTodayDone = useToggleTodayDone();
  const reorderToday = useReorderToday();
  const setStatus = useSetSignalStatus();
  const snoozeSignal = useSnoozeSignal();
  const createDraft = useCreatePromotionDraft();
  const createRoutine = useCreateRoutine();
  const toggleRoutine = useToggleRoutineCheck();

  const signals = signalsQ.data ?? [];
  const todayItems = todayQ.data ?? [];
  const routines = routinesQ.data ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<CardMenuState | null>(null);
  const [poppedIds, setPoppedIds] = useState<Set<string>>(new Set());
  const todayPanelRef = useRef<HTMLDivElement>(null);
  const captureInputRef = useRef<HTMLInputElement>(null);

  // 새 카드 pop 추적: 직전까지 알던 id 집합. 새로 등장한 카드만 pop.
  const knownIdsRef = useRef<Set<string>>(new Set());
  const expectPopRef = useRef(false);

  useEffect(() => {
    const current = new Set(signals.map((s) => s.id));
    if (expectPopRef.current) {
      const fresh = signals.filter((s) => !knownIdsRef.current.has(s.id)).map((s) => s.id);
      if (fresh.length) {
        setPoppedIds(new Set(fresh));
        window.setTimeout(() => setPoppedIds(new Set()), 400);
      }
      expectPopRef.current = false;
    }
    knownIdsRef.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals]);

  // ── Toast ──
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const toast = useCallback((m: string) => {
    setToastMsg(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 1700);
  }, []);

  // ── 액션 ──
  // 새 신호는 kind에 맞는 프로젝트로 태깅(있으면). 없으면 NULL → 나중에 reconcile.
  const projects = projectsQ.data ?? [];
  const projectIdForKind = (kind: Kind): string | null =>
    projects.find((p) => p.kind === kind)?.id ?? null;

  const handleCapture = (title: string, kind: Kind) => {
    expectPopRef.current = true;
    createSignal.mutate({ title, kind, projectId: projectIdForKind(kind) });
  };

  const handleClassify = useCallback(
    (id: string, zone: ZoneKey) => {
      classifySignal.mutate({ id, quadrant: zoneToQuadrant(zone) });
    },
    [classifySignal],
  );

  const handlePromoteToday = useCallback(
    (id: string) => {
      promoteToday.mutate({ id, date: today });
      if (selectedId === id) setSelectedId(null);
      toast("Today 추가");
    },
    [promoteToday, today, selectedId, toast],
  );

  const handleUnpromote = (id: string) => {
    expectPopRef.current = true;
    unpromoteToday.mutate(id);
    toast("매트릭스로 되돌림");
  };

  const handleMenuAction = (action: CardMenuAction, signalId: string) => {
    switch (action) {
      case "today":
        handlePromoteToday(signalId);
        break;
      case "done":
        setStatus.mutate({ id: signalId, status: "done" });
        if (selectedId === signalId) setSelectedId(null);
        toast("완료");
        break;
      case "archive":
        setStatus.mutate({ id: signalId, status: "archived" });
        if (selectedId === signalId) setSelectedId(null);
        toast("보관");
        break;
      case "snooze":
        snoozeSignal.mutate({ id: signalId, until: tomorrow() });
        if (selectedId === signalId) setSelectedId(null);
        toast("내일로 미룸");
        break;
      case "backlog":
      case "agenda":
      case "calendar":
        createDraft.mutate({ signalId, target: PROMOTION_TARGET[action] });
        toast(`${PROMOTION_LABEL[action]} — Acceptance 대기`);
        break;
    }
  };

  const handleCreateRoutine = (title: string, daily: boolean, weekdays: Weekday[]) => {
    createRoutine.mutate({
      title,
      freq: daily ? "daily" : "weekly",
      weekdays,
      area: null,
      kind: null,
    });
    toast("루틴 추가");
  };

  // ── 키보드 (1/2/3/4 분류, 0/u 미분류, T Today, D/E 완료/보관) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        return; // App 셸의 Esc→hide 핸들러로 위임.
      }
      const ae = document.activeElement;
      if (
        ae instanceof HTMLInputElement ||
        ae instanceof HTMLTextAreaElement ||
        (ae instanceof HTMLElement && ae.isContentEditable)
      ) {
        return;
      }
      if (!selectedId) return;
      const zoneMap: Record<string, ZoneKey> = {
        "1": "q1",
        "2": "q2",
        "3": "q3",
        "4": "q4",
        "0": "unclassified",
        u: "unclassified",
      };
      const z = zoneMap[e.key];
      if (z) {
        handleClassify(selectedId, z);
        e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "t") {
        handlePromoteToday(selectedId);
        e.preventDefault();
      } else if (k === "s") {
        snoozeSignal.mutate({ id: selectedId, until: tomorrow() });
        setSelectedId(null);
        toast("내일로 미룸");
        e.preventDefault();
      } else if (k === "d") {
        setStatus.mutate({ id: selectedId, status: "done" });
        setSelectedId(null);
        toast("완료");
        e.preventDefault();
      } else if (k === "e") {
        setStatus.mutate({ id: selectedId, status: "archived" });
        setSelectedId(null);
        toast("보관");
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, handleClassify, handlePromoteToday, setStatus, snoozeSignal, toast]);

  const loadError = signalsQ.isError || todayQ.isError || routinesQ.isError;

  return (
    <div className="cb">
      <div className="cb-head">
        <span className="mark">◎ Work Radar / Capture</span>
        <span className="hint">
          드래그로 분류 · <b>1 2 3 4</b> 사분면 · <b>T</b> Today · 카드 ⋯ 메뉴 ·{" "}
          <b>⌘K</b> 설정/프로젝트
        </span>
      </div>

      {loadError && (
        <div
          className="empty"
          style={{ color: "var(--color-q1)", padding: "4px 22px" }}
        >
          데이터 로드 실패 —{" "}
          {String(signalsQ.error ?? todayQ.error ?? routinesQ.error)}
        </div>
      )}

      <div className="board">
        <MatrixCanvas
          signals={signals}
          selectedId={selectedId}
          poppedIds={poppedIds}
          onSelect={setSelectedId}
          onClassify={handleClassify}
          onPromoteToday={handlePromoteToday}
          onOpenMenu={(id, anchor) => {
            setSelectedId(id);
            setMenu({ signalId: id, anchor });
          }}
          todayPanelRef={todayPanelRef}
        />

        <div className="execute">
          <TodayRail
            items={todayItems}
            panelRef={todayPanelRef}
            onToggleDone={(id, done) => toggleTodayDone.mutate({ id, date: today, done })}
            onUnpromote={handleUnpromote}
            onReorder={(ids) => reorderToday.mutate(ids)}
          />
          <RoutinesPanel
            routines={routines}
            onToggle={(routineId, done) =>
              toggleRoutine.mutate({ routineId, date: today, done })
            }
            onCreate={handleCreateRoutine}
          />
        </div>
      </div>

      <CapturePanel
        onSubmit={handleCapture}
        disabled={createSignal.isPending}
        inputRef={captureInputRef}
      />

      <CardMenu state={menu} onAct={handleMenuAction} onClose={() => setMenu(null)} />
      <div className={`cb-toast${toastMsg ? " show" : ""}`}>{toastMsg}</div>
    </div>
  );
}
