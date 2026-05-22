import { useCallback, useEffect, useRef, useState } from "react";

import type { Kind, PromotionTarget } from "@/bindings";
import {
  type CardMenuAction,
  type CardMenuState,
  CardMenu,
} from "@/components/board/CardMenu";
import {
  type CalendarModalState,
  CalendarEventModal,
} from "@/components/board/CalendarEventModal";
import { EnrichModal } from "@/components/board/EnrichModal";
import { CapturePanel } from "@/components/board/CapturePanel";
import { MatrixCanvas } from "@/components/board/MatrixCanvas";
import { RoutinesPanel, type RoutineDraft } from "@/components/board/RoutinesPanel";
import { TodayRail } from "@/components/board/TodayRail";
import { zoneToQuadrant, type ZoneKey } from "@/components/board/board-utils";
import {
  localToday,
  localWeekday,
  useClassifySignal,
  useCodexStatus,
  useCreateRoutine,
  useUpdateRoutine,
  useDeleteRoutine,
  useCreateSignal,
  useDeleteSignal,
  useFlushPromotions,
  useProjects,
  usePromoteToday,
  usePromoteToNotion,
  useReorderRoutines,
  useReorderToday,
  useSetSignalStatus,
  useSignals,
  useSnoozeSignal,
  useToday,
  useTodayRoutines,
  useToggleRoutineCheck,
  useToggleTodayDone,
  useTriggerEnrich,
  useTriggerEnrichAll,
  useUnpromoteToday,
  useUpdateSignalTitle,
  tomorrow,
} from "@/lib/query";
import { useUIStore } from "@/store";
import { useToastStore } from "@/lib/toast";

const PROMOTION_TARGET: Record<"backlog" | "agenda", PromotionTarget> = {
  backlog: "notion_backlog",
  agenda: "notion_agenda",
};
const PROMOTION_LABEL: Record<"backlog" | "agenda", string> = {
  backlog: "백로그 등록",
  agenda: "안건 승격",
};

/**
 * Capture Board — 5영역(미분류·2×2·Today·Routines·캡처) 결정 보드.
 * 서버 상태(useSignals/useToday/useTodayRoutines)에서 렌더, 뮤테이션은 refetch로 재동기화.
 * INVARIANT #1: 카드는 항상 unclassified 생성, 사분면 변경은 명시적 사람 제스처(드래그/키보드)뿐.
 * INVARIANT #2: 백로그/안건은 Notion 즉시 승격(사람 클릭=결정). 캘린더는 직접 모달 → 즉시 write(Phase 19,
 * 사용자 폼=사람 결정 — Acceptance 게이트는 자동화/Codex의 외부 mutate 차단용이라 사람 폼 제출엔 불요).
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
  const promoteToNotion = usePromoteToNotion();
  const flushPromotions = useFlushPromotions();
  const createRoutine = useCreateRoutine();
  const updateRoutine = useUpdateRoutine();
  const deleteRoutine = useDeleteRoutine();
  const reorderRoutines = useReorderRoutines();
  const toggleRoutine = useToggleRoutineCheck();
  const codex = useCodexStatus();
  const triggerEnrich = useTriggerEnrich();
  const triggerEnrichAll = useTriggerEnrichAll();
  const updateTitle = useUpdateSignalTitle();
  const deleteSignal = useDeleteSignal();
  const { goTo } = useUIStore();
  const { pushSuccess, pushError } = useToastStore();
  const codexReady = !!codex.data?.installed && !!codex.data?.authed;

  const signals = signalsQ.data ?? [];
  const todayItems = todayQ.data ?? [];
  const routines = routinesQ.data ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<CardMenuState | null>(null);
  const [calendarModal, setCalendarModal] = useState<CalendarModalState | null>(null);
  const [enrichRunId, setEnrichRunId] = useState<string | null>(null);
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
      pushSuccess("Today 추가");
    },
    [promoteToday, today, selectedId, pushSuccess],
  );

  const handleUnpromote = (id: string) => {
    expectPopRef.current = true;
    unpromoteToday.mutate(id);
    pushSuccess("매트릭스로 되돌림");
  };

  // 카드 → Notion 백로그/안건 즉시 승격(write). 사람 클릭이 곧 결정/accept (INVARIANT #2).
  // project_id 라우팅: 신호에 이미 project_id가 있으면 그대로, 없으면 kind 매칭 프로젝트로:
  //   - 1개 → 백엔드가 자동 지정(projectId=null 전달), outcome.resolvedProjectId로 라벨 표시.
  //   - 여러 개 → 프런트 picker에서 사람이 선택(INVARIANT #1 — 자동 확정 없음).
  //   - 0개 → 설정 안내 toast.
  const handleNotionPromote = (signalId: string, action: "backlog" | "agenda") => {
    const sig = signals.find((s) => s.id === signalId);
    const label = PROMOTION_LABEL[action];
    const target = PROMOTION_TARGET[action];

    const doPromote = (projectId: string | null) => {
      promoteToNotion.mutate(
        { signalId, target, projectId },
        {
          onSuccess: (outcome) => {
            if (outcome.status === "created") {
              // 자동 지정(projectId=null로 호출 → 백엔드가 단일 후보 해석)된 경우에만 라벨 표시
              // (INVARIANT #1: 사람이 볼 수 있게). picker로 직접 고른 경우(projectId!=null)는 제외.
              if (projectId === null && outcome.resolvedProjectId && !sig?.projectId) {
                const autoProj = projects.find((p) => p.id === outcome.resolvedProjectId);
                const projName = autoProj?.name ?? outcome.resolvedProjectId;
                pushSuccess(
                  `${label}됨 — 프로젝트 자동 지정: ${projName} (설정에서 변경 가능)`,
                  outcome.pageUrl
                    ? { actionUrl: outcome.pageUrl, actionLabel: "열기" }
                    : undefined,
                );
              } else {
                pushSuccess(
                  `${label}됨`,
                  outcome.pageUrl
                    ? { actionUrl: outcome.pageUrl, actionLabel: "열기" }
                    : undefined,
                );
              }
            } else if (outcome.status === "draft") {
              pushSuccess(`${label} — 오프라인, 큐에 저장됨(복구 시 등록)`);
            } else {
              pushError("notion", `${label} 실패: ${outcome.detail}`);
            }
          },
          onError: (e) => {
            const msg = String(e);
            if (msg.includes("프로젝트 선택 필요")) {
              // 여러 프로젝트: picker — 사람이 직접 선택 (INVARIANT #1).
              const kind = sig?.kind ?? null;
              const candidates = kind ? projects.filter((p) => p.kind === kind) : projects;
              if (candidates.length === 0) {
                pushError("notion", `${label} 실패: 설정에서 프로젝트를 먼저 생성하세요`);
                return;
              }
              // window.prompt을 picker 대용으로 사용 (기존 코드 패턴 — 인라인 편집과 동일).
              const names = candidates.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
              const answer = window.prompt(
                `승격할 프로젝트를 선택하세요:\n${names}\n\n번호를 입력하세요:`,
              );
              const idx = answer ? parseInt(answer, 10) - 1 : -1;
              if (idx >= 0 && idx < candidates.length) {
                doPromote(candidates[idx].id);
              } else if (answer !== null) {
                pushError("notion", `${label} 취소 — 올바른 번호를 입력하세요`);
              }
            } else if (msg.includes("해당 kind의 프로젝트가 없음")) {
              pushError("notion", `${label} 실패: 설정에서 프로젝트를 먼저 생성하세요`);
            } else {
              pushError("notion", `${label} 실패: ${msg}`);
            }
          },
        },
      );
    };

    doPromote(sig?.projectId ?? null);
  };

  // 미분류 전체 배치 enrich(Phase 15 #4): 단일 codex 잡 → Jobs에서 카드별 제안 검토·accept(자동 분류 0).
  const unclassifiedCount = signals.filter((s) => s.quadrant === "unclassified").length;
  const handleEnrichAll = () => {
    if (!codexReady) {
      pushError("codex", "codex 미가용 — 설치·로그인 후 사용");
      return;
    }
    if (unclassifiedCount === 0) {
      pushSuccess("미분류 카드가 없습니다");
      return;
    }
    triggerEnrichAll.mutate(
      { projectId: null, timeoutSec: 180, maxTurns: 12, costCapUsd: 1.0 },
      {
        onSuccess: () => goTo("jobs"),
        onError: (e) => pushError("codex", `전체 제안 실패: ${String(e)}`),
      },
    );
  };

  const handleMenuAction = (action: CardMenuAction, signalId: string) => {
    switch (action) {
      case "today":
        handlePromoteToday(signalId);
        break;
      case "enrich":
        // 제안 레일: codex로 영역/사분면 제안(Acceptance 게이트 — 인플레이스 모달로 검토·accept).
        // gated 잡 유지: trigger_enrich → awaiting_approval → EnrichModal 폴링 → accept_enrich.
        if (!codexReady) {
          pushError("codex", "codex 미가용 — 설치·로그인 후 사용");
          break;
        }
        triggerEnrich.mutate(
          { signalId, timeoutSec: 90, maxTurns: 6, costCapUsd: 0.5 },
          {
            onSuccess: (runId) => setEnrichRunId(runId),
            onError: (e) => pushError("codex", `AI 제안 실패: ${String(e)}`),
          },
        );
        break;
      case "edit": {
        // 인라인 제목 편집(Phase 15 #5). dedup 키는 백엔드가 새 제목으로 갱신.
        // window.prompt 방식: 기존 패턴과 동일하게 유지하되 항상 동작하도록 확인.
        const sig = signals.find((s) => s.id === signalId);
        const next = window.prompt("카드 제목 편집", sig?.title ?? "");
        if (next !== null && next.trim() !== "" && next.trim() !== sig?.title) {
          updateTitle.mutate(
            { id: signalId, title: next.trim() },
            {
              onSuccess: () => pushSuccess("제목 수정"),
              onError: (e) => pushError("signal", `수정 실패: ${String(e)}`),
            },
          );
        }
        break;
      }
      case "delete":
        // 하드 삭제(영구 — archive와 구분, Phase 15 #5). 확인 후 삭제.
        if (window.confirm("이 카드를 영구 삭제합니다(복원 불가). 계속할까요?")) {
          deleteSignal.mutate(signalId, {
            onSuccess: () => pushSuccess("삭제됨"),
            onError: (e) => pushError("signal", `삭제 실패: ${String(e)}`),
          });
          if (selectedId === signalId) setSelectedId(null);
        }
        break;
      case "done":
        setStatus.mutate({ id: signalId, status: "done" });
        if (selectedId === signalId) setSelectedId(null);
        pushSuccess("완료");
        break;
      case "archive":
        setStatus.mutate({ id: signalId, status: "archived" });
        if (selectedId === signalId) setSelectedId(null);
        pushSuccess("보관");
        break;
      case "snooze":
        snoozeSignal.mutate({ id: signalId, until: tomorrow() });
        if (selectedId === signalId) setSelectedId(null);
        pushSuccess("내일로 미룸");
        break;
      case "backlog":
      case "agenda":
        // write 레일: 즉시 Notion에 페이지 생성 (Phase 3).
        handleNotionPromote(signalId, action);
        break;
      case "calendar": {
        // write 레일: 직접 모달 → Google Calendar 이벤트 생성 (Phase 19).
        // 사용자 폼 제출 = 사람 결정이라 Acceptance 대기 없음 (게이트는 자동화의 외부 mutate 차단용, #2).
        const sig = signals.find((s) => s.id === signalId);
        setCalendarModal({
          signalId,
          title: sig?.title ?? "",
          projectId: sig?.projectId ?? null,
        });
        break;
      }
    }
  };

  const handleCreateRoutine = (draft: RoutineDraft) => {
    createRoutine.mutate({
      title: draft.title,
      freq: draft.freq,
      weekdays: draft.weekdays,
      anchorDate: draft.anchorDate,
      timeOfDay: draft.timeOfDay,
      reminderOffsetMin: draft.reminderOffsetMin,
      area: null,
      kind: null,
    });
    pushSuccess("루틴 추가");
  };

  const handleUpdateRoutine = (id: string, draft: RoutineDraft) => {
    updateRoutine.mutate({
      id,
      title: draft.title,
      freq: draft.freq,
      weekdays: draft.weekdays,
      anchorDate: draft.anchorDate,
      timeOfDay: draft.timeOfDay,
      reminderOffsetMin: draft.reminderOffsetMin,
      area: null,
      kind: null,
    });
    pushSuccess("루틴 수정");
  };

  const handleDeleteRoutine = (id: string) => {
    deleteRoutine.mutate(id);
    pushSuccess("루틴 삭제");
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
        pushSuccess("내일로 미룸");
        e.preventDefault();
      } else if (k === "d") {
        setStatus.mutate({ id: selectedId, status: "done" });
        setSelectedId(null);
        pushSuccess("완료");
        e.preventDefault();
      } else if (k === "e") {
        setStatus.mutate({ id: selectedId, status: "archived" });
        setSelectedId(null);
        pushSuccess("보관");
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, handleClassify, handlePromoteToday, setStatus, snoozeSignal, pushSuccess]);

  // 네트워크 복구 시 오프라인 큐(draft) flush (INVARIANT #5: bounded, 무한 poll 아님).
  useEffect(() => {
    const onOnline = () => {
      flushPromotions.mutate(undefined, {
        onSuccess: (s) => {
          if (s.created > 0) pushSuccess(`복구 — Notion에 ${s.created}건 등록됨`);
        },
      });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flushPromotions, pushSuccess]);

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
          onEnrichAll={handleEnrichAll}
          enrichAllDisabled={
            !codexReady || unclassifiedCount === 0 || triggerEnrichAll.isPending
          }
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
            onUpdate={handleUpdateRoutine}
            onDelete={handleDeleteRoutine}
            onReorder={(ids) => reorderRoutines.mutate(ids)}
            onOpenTracking={() => goTo("routines")}
          />
        </div>
      </div>

      <CapturePanel
        onSubmit={handleCapture}
        disabled={createSignal.isPending}
        inputRef={captureInputRef}
      />

      <CardMenu
        state={menu}
        onAct={handleMenuAction}
        onClose={() => setMenu(null)}
        codexReady={codexReady}
      />
      <CalendarEventModal
        state={calendarModal}
        onClose={() => setCalendarModal(null)}
      />
      {enrichRunId && (
        <EnrichModal
          runId={enrichRunId}
          onClose={() => setEnrichRunId(null)}
        />
      )}
    </div>
  );
}
