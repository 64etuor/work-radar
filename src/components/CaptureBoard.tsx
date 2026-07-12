import "./CaptureBoard.css";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Kind, PromotionTarget, WorkSignal } from "@/bindings";
import { BoardOverlays } from "@/components/board/BoardOverlays";
import {
  projectPickerErrorMessage,
  projectPickerSuccessMessage,
} from "@/components/board/boardOverlayUtils";
import { type ZoneKey, zoneToQuadrant } from "@/components/board/boardUtils";
import { type CalendarModalState } from "@/components/board/CalendarEventModal";
import { CaptureBoardHeader } from "@/components/board/CaptureBoardHeader";
import { type CardMenuAction, type CardMenuState } from "@/components/board/CardMenu";
import { ExecutionRail } from "@/components/board/ExecutionRail";
import { MatrixCanvas } from "@/components/board/MatrixCanvas";
import { normalizeTitleEdit } from "@/components/board/matrixCanvasUtils";
import { type ProjectPickerState } from "@/components/board/ProjectPickerModal";
import { type RoutineDraft } from "@/components/board/RoutinesPanel";
import { sortSignalsForBoard } from "@/components/board/signalOrdering";
import { useBoardKeyboard } from "@/components/board/useBoardKeyboard";
import { useSignalPop } from "@/components/board/useSignalPop";
import { currentQuarterKey } from "@/lib/lifeOs";
import {
  localToday,
  localWeekday,
  tomorrow,
  useApplyCalendarUrgency,
  useCalendarEvents,
  useClassifySignal,
  useCodexStatus,
  useCreateRoutine,
  useCreateSignal,
  useDeleteRoutine,
  useDeleteRoutineLocalOnly,
  useDeleteSignal,
  useDisableRoutineGoogleSync,
  useEnableRoutineGoogleSync,
  useEnrichAllRunning,
  useFlushPromotions,
  useLifeWheelTags,
  useMoveRoutineGoogleSync,
  useObjectives,
  useOkrCheckIns,
  useProjects,
  usePromoteToday,
  usePromoteToNotion,
  useReorderRoutines,
  useReorderToday,
  useSetRoutineAreaTagKey,
  useSetRoutineKind,
  useSetSignalAreaTagKey,
  useSetSignalKind,
  useSetSignalStatus,
  useSignals,
  useSnoozeSignal,
  useToday,
  useTodayRoutines,
  useToggleRoutineCheck,
  useToggleTodayDone,
  useTriggerEnrichAll,
  useUnpromoteToday,
  useUpdateRoutine,
  useUpdateSignalTitle,
} from "@/lib/query";
import { IpcError, pushMutationError } from "@/lib/query/client";
import { signalCalendarProjectId } from "@/lib/signalCalendarRouting";
import { useToastStore } from "@/lib/toast";
import { usePendingSignalFocus } from "@/lib/usePendingSignalFocus";
import { useUIStore } from "@/store";

const PROMOTION_TARGET: Record<"backlog" | "agenda", PromotionTarget> = {
  backlog: "notion_backlog",
  agenda: "notion_agenda",
};
const PROMOTION_LABEL: Record<"backlog" | "agenda", string> = {
  backlog: "백로그 등록",
  agenda: "안건 승격",
};
const EMPTY_SIGNALS: WorkSignal[] = [];

// Capture Board owner: query/mutation orchestration plus human-only decision gestures.
function useCaptureBoardView() {
  const today = localToday();
  const weekday = localWeekday();

  const signalsQ = useSignals();
  // 이번 분기 Objective/체크인 — 헤더 OKR 스트립 전용(표시 전용, 캡처 흐름 비관여).
  const okrQuarter = currentQuarterKey();
  const objectivesQ = useObjectives(okrQuarter);
  const okrCheckInsQ = useOkrCheckIns(okrQuarter);
  const todayQ = useToday(today);
  const routinesQ = useTodayRoutines(today, weekday);
  const projectsQ = useProjects();
  // 캘린더 긴급도 가중(표시 힌트 전용). 보드의 오늘 이벤트(ambient)를 미분류 카드에 퍼지 매칭한다.
  const calendarQ = useCalendarEvents(today);
  const { mutate: applyUrgency } = useApplyCalendarUrgency();

  const createSignal = useCreateSignal();
  const classifySignal = useClassifySignal();
  const promoteToday = usePromoteToday();
  const unpromoteToday = useUnpromoteToday();
  const toggleTodayDone = useToggleTodayDone();
  const reorderToday = useReorderToday();
  const setStatus = useSetSignalStatus();
  const lifeWheelTags = useLifeWheelTags();
  const setAreaTagKey = useSetSignalAreaTagKey();
  const setKind = useSetSignalKind();
  const setRoutineKind = useSetRoutineKind();
  const setRoutineAreaTagKey = useSetRoutineAreaTagKey();
  const snoozeSignal = useSnoozeSignal();
  const promoteToNotion = usePromoteToNotion();
  const flushPromotions = useFlushPromotions();
  const createRoutine = useCreateRoutine();
  const updateRoutine = useUpdateRoutine();
  const deleteRoutine = useDeleteRoutine();
  const deleteRoutineLocalOnly = useDeleteRoutineLocalOnly();
  const reorderRoutines = useReorderRoutines();
  const toggleRoutine = useToggleRoutineCheck();
  const enableRoutineSync = useEnableRoutineGoogleSync();
  const disableRoutineSync = useDisableRoutineGoogleSync();
  const moveRoutineSync = useMoveRoutineGoogleSync();
  const codex = useCodexStatus();
  const triggerEnrichAll = useTriggerEnrichAll();
  const updateTitle = useUpdateSignalTitle();
  const deleteSignal = useDeleteSignal();
  const { goTo } = useUIStore();
  const enrichAllAgentRunning = useEnrichAllRunning();
  const { pushSuccess, pushError } = useToastStore();
  const codexReady = !!codex.data?.installed && !!codex.data?.authed;

  const signals = signalsQ.data ?? EMPTY_SIGNALS;
  const [captureOrder, setCaptureOrder] = useState<ReadonlyMap<string, number>>(() => new Map());
  const boardSignals = sortSignalsForBoard(signals, captureOrder);
  const todayItems = todayQ.data ?? [];
  const routines = routinesQ.data ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  usePendingSignalFocus(setSelectedId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<CardMenuState | null>(null);
  const [calendarModal, setCalendarModal] = useState<CalendarModalState | null>(null);
  const [projectPicker, setProjectPicker] = useState<ProjectPickerState | null>(null);
  const todayPanelRef = useRef<HTMLDivElement>(null);
  const captureInputRef = useRef<HTMLInputElement>(null);

  const { knownIdsRef, markPopped, poppedIds } = useSignalPop(signals);
  const urgencyAppliedRef = useRef<Set<string>>(null);
  if (urgencyAppliedRef.current === null) urgencyAppliedRef.current = new Set();

  // 새 신호는 kind에 맞는 프로젝트로 태깅(있으면). 없으면 NULL → 나중에 reconcile.
  const projects = projectsQ.data ?? [];
  const projectIdForKind = (kind: Kind): string | null =>
    projects.find((p) => p.kind === kind)?.id ?? null;

  const handleCapture = (title: string, kind: Kind) => {
    createSignal.mutate(
      { title, kind, projectId: projectIdForKind(kind) },
      {
        onSuccess: (signal) => {
          if (knownIdsRef.current.has(signal.id)) return;
          markPopped(signal.id);
          setCaptureOrder((prev) => {
            const next = new Map(prev);
            next.set(signal.id, next.size + 1);
            return next;
          });
        },
      },
    );
  };

  // 둘 다 키다운 effect deps로 쓰여 referential identity가 필요 — 컴파일러가 메모이즈하지만
  // 정적 분석기(no-effect-with-fresh-deps)와 bailout 시 안전을 위해 명시 유지.
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
    unpromoteToday.mutate(id, { onSuccess: () => markPopped(id) });
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
              // 생성된 페이지 열기: notion:// 딥링크 우선, https는 폴백(데스크톱 앱 없을 때).
              const openUrl = outcome.pageDeepLink ?? outcome.pageUrl;
              const openOpt = openUrl ? { actionUrl: openUrl, actionLabel: "열기" } : undefined;
              // 자동 지정(projectId=null로 호출 → 백엔드가 단일 후보 해석)된 경우에만 라벨 표시
              // (INVARIANT #1: 사람이 볼 수 있게). picker로 직접 고른 경우(projectId!=null)는 제외.
              if (projectId === null && outcome.resolvedProjectId && !sig?.projectId) {
                const autoProj = projects.find((p) => p.id === outcome.resolvedProjectId);
                const projName = autoProj?.name ?? outcome.resolvedProjectId;
                pushSuccess(
                  `${label}됨 — 프로젝트 자동 지정: ${projName} (설정에서 변경 가능)`,
                  openOpt,
                );
              } else {
                pushSuccess(`${label}됨`, openOpt);
              }
            } else if (outcome.status === "draft") {
              pushSuccess(`${label} — 오프라인, 큐에 저장됨(복구 시 등록)`);
            } else {
              pushError("notion", `${label} 실패: ${outcome.detail}`);
            }
          },
          onError: (e) => {
            const code = e instanceof IpcError ? e.app.code : null;
            if (code === "notion.needs_project_pick") {
              // 여러 프로젝트: picker 모달 — 사람이 직접 선택 (INVARIANT #1).
              const kind = sig?.kind ?? null;
              const candidates = kind ? projects.filter((p) => p.kind === kind) : projects;
              if (candidates.length === 0) {
                pushError("notion", `${label} 실패: 설정에서 프로젝트를 먼저 생성하세요`);
                return;
              }
              setProjectPicker({ signalId, target, label, candidates });
            } else if (code === "notion.db_id_missing" && e instanceof IpcError) {
              // DB ID 미설정: 프로젝트명 + "설정 열기" 액션(AppError.action) 그대로 surface.
              pushError("notion", e.app);
            } else {
              pushError("notion", `${label} 실패: ${String(e)}`);
            }
          },
        },
      );
    };

    doPromote(sig?.projectId ?? null);
  };

  // 미분류 전체 배치 enrich(Phase 8 #1/#2): 단일 codex 잡을 **백그라운드**로 트리거하고, 페이지 이동
  // 없이 전역 리뷰 패널(App shell)이 폴링·표시한다. 잡 캡(timeout/turns/cost)은
  // 유지(INVARIANT #5). accept해도 quadrant 자동 확정 0(INVARIANT #1) — 패널에서 사람이 수정·적용.
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
        // 자동 모달 오픈 없음 — 에이전트 바 박스에서 사용자가 클릭해 결과를 본다(INVARIANT #1 표시 전용).
        onError: (e) => pushError("codex", `전체 제안 실패: ${String(e)}`),
      },
    );
  };

  const handleMenuAction = (action: CardMenuAction, signalId: string) => {
    switch (action) {
      case "today":
        handlePromoteToday(signalId);
        break;
      case "edit":
        // 인라인 제목 편집(Phase 15 #5). 카드에 <textarea>를 띄워 Enter/blur 저장, Esc 취소.
        // dedup 키는 백엔드가 새 제목으로 갱신. 저장 정규화는 handleTitleCommit에서.
        setEditingId(signalId);
        break;
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
          projectId: sig
            ? signalCalendarProjectId(projects, sig.projectId ?? null, sig.kind ?? null)
            : null,
        });
        break;
      }
    }
  };

  // 인라인 제목 편집 저장: 트림 후 빈 값/무변경이면 무시(원복), 그 외 update title 뮤테이션.
  // 성공 시 signals invalidate(훅 onSuccess) → 즉시 재조회 반영.
  const handleTitleCommit = (signalId: string, nextTitle: string) => {
    const sig = signals.find((s) => s.id === signalId);
    const normalized = normalizeTitleEdit(nextTitle, sig?.title ?? "");
    setEditingId(null);
    if (normalized === null) return;
    updateTitle.mutate(
      { id: signalId, title: normalized },
      {
        onSuccess: () => pushSuccess("제목 수정"),
        onError: (e) => pushError("signal", `수정 실패: ${String(e)}`),
      },
    );
  };

  const handleCreateRoutine = (draft: RoutineDraft) => {
    createRoutine.mutate({
      title: draft.title,
      freq: draft.freq,
      weekdays: draft.weekdays,
      anchorDate: draft.anchorDate,
      startDate: draft.startDate,
      endDate: draft.endDate,
      timeOfDay: draft.timeOfDay,
      reminderOffsetMin: draft.reminderOffsetMin,
      area: null,
      kind: null,
      monthlyPattern: draft.monthlyPattern,
      monthlyNthWeek: draft.monthlyNthWeek,
      durationMin: draft.durationMin,
    });
    pushSuccess("루틴 추가");
  };

  const handleUpdateRoutine = (id: string, draft: RoutineDraft) => {
    updateRoutine.mutate(
      {
        id,
        title: draft.title,
        freq: draft.freq,
        weekdays: draft.weekdays,
        anchorDate: draft.anchorDate,
        startDate: draft.startDate,
        endDate: draft.endDate,
        timeOfDay: draft.timeOfDay,
        reminderOffsetMin: draft.reminderOffsetMin,
        monthlyPattern: draft.monthlyPattern,
        monthlyNthWeek: draft.monthlyNthWeek,
        durationMin: draft.durationMin,
      },
      {
        onSuccess: () => pushSuccess("루틴 수정"),
        // 동기화 루틴의 Google PATCH 실패(routine.sync.patch_failed)는 "저장됐지만 동기화 실패"
        // 메시지를 그대로 노출. 로컬 변경은 onSettled 무효화로 화면에 반영된다.
        onError: (e) => pushMutationError("calendar", e, "루틴 수정"),
      },
    );
  };

  const handleEnableRoutineSync = (routineId: string, projectId: string, calendarId: string) => {
    enableRoutineSync.mutate(
      { routineId, projectId, calendarId },
      {
        onSuccess: () => pushSuccess("Google 캘린더 동기화 켜짐"),
        onError: (e) => pushMutationError("calendar", e, "동기화"),
      },
    );
  };

  const handleDisableRoutineSync = (routineId: string) => {
    disableRoutineSync.mutate(routineId, {
      onSuccess: () => pushSuccess("Google 캘린더 동기화 해제"),
      onError: (e) => pushMutationError("calendar", e, "해제"),
    });
  };

  const handleMoveRoutineSync = (routineId: string, projectId: string, calendarId: string) => {
    moveRoutineSync.mutate(
      { routineId, projectId, calendarId },
      {
        onSuccess: () => pushSuccess("Google 캘린더 이동됨"),
        onError: (e) => pushMutationError("calendar", e, "이동"),
      },
    );
  };

  const handleDeleteRoutine = (id: string) => {
    deleteRoutine.mutate(id, {
      onSuccess: () => pushSuccess("루틴 삭제"),
      onError: (e) => {
        const app = e instanceof IpcError ? e.app : null;
        // 동기화 ON 루틴의 Google master event 삭제 실패 → 로컬만 지울지 confirm.
        if (app?.code === "routine.sync.delete_remote_failed") {
          if (
            window.confirm("Google 캘린더에서 이벤트를 삭제하지 못했습니다. 로컬에서만 삭제할까요?")
          ) {
            deleteRoutineLocalOnly.mutate(id, {
              onSuccess: () => pushSuccess("루틴 삭제 (로컬만)"),
              onError: (e2) => pushMutationError("calendar", e2, "루틴 삭제"),
            });
          }
        } else {
          pushError("calendar", app ?? `루틴 삭제 실패: ${String(e)}`);
        }
      },
    });
  };

  // ── 키보드 (1/2/3/4 분류, 0/u 미분류, T Today, S 미루기, D/E 완료/보관) — 훅 경계로 추출 ──
  useBoardKeyboard({
    selectedId,
    onEscape: () => setMenu(null),
    onClassify: handleClassify,
    onPromoteToday: handlePromoteToday,
    onSnooze: (id) => {
      snoozeSignal.mutate({ id, until: tomorrow() });
      setSelectedId(null);
      pushSuccess("내일로 미룸");
    },
    onDone: (id) => {
      setStatus.mutate({ id, status: "done" });
      setSelectedId(null);
      pushSuccess("완료");
    },
    onArchive: (id) => {
      setStatus.mutate({ id, status: "archived" });
      setSelectedId(null);
      pushSuccess("보관");
    },
  });

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

  // 캘린더 긴급도 가중(제안 레일 — suggested_quadrant 힌트만, 카드 자동 이동 0 = INVARIANT #1).
  // 오늘 이벤트(ambient)가 로드되면 미분류 active 카드를 이벤트 title과 퍼지 매칭해 suggested 힌트를
  // Rust 순수 함수로 가중한다. 같은 (카드,이벤트집합)엔 한 번만 호출(ref 가드 — churn/무한 호출 방지).
  // 매칭/가중은 표시일 뿐 — 매트릭스 확정 quadrant는 백엔드가 절대 안 건드린다(set_suggested_quadrant_only).
  useEffect(() => {
    const events = calendarQ.data ?? [];
    if (events.length === 0) return;
    // 이벤트 집합 시그니처(id+start) — 같은 표시 데이터면 재적용 안 함.
    const eventsSig = events.map((e) => `${e.id}@${e.start}`).join("|");
    const unclassified = signals.filter(
      (s) => s.quadrant === "unclassified" && s.status !== "snoozed",
    );
    for (const s of unclassified) {
      const key = `${s.id}::${eventsSig}`;
      if (urgencyAppliedRef.current!.has(key)) continue;
      urgencyAppliedRef.current!.add(key);
      // keywords는 현재 보조 키워드 모델이 없어 빈 배열(제목 매칭만). 실패는 조용히 무시(표시 힌트).
      applyUrgency({ signalId: s.id, keywords: [], events });
    }
  }, [applyUrgency, calendarQ.data, signals]);

  const loadError = signalsQ.isError || todayQ.isError || routinesQ.isError;

  const handleProjectPick = (projectId: string) => {
    if (!projectPicker) return;
    // 사람이 고른 프로젝트로 재승격(projectId 명시 → 백엔드가 persist, INVARIANT #1).
    promoteToNotion.mutate(
      {
        signalId: projectPicker.signalId,
        target: projectPicker.target,
        projectId,
      },
      {
        onSuccess: (outcome) => {
          const result = projectPickerSuccessMessage(projectPicker.label, outcome);
          if (outcome.status === "failed") {
            pushError("notion", result.message);
            return;
          }
          pushSuccess(
            result.message,
            result.openUrl ? { actionUrl: result.openUrl, actionLabel: "열기" } : undefined,
          );
        },
        onError: (e) => pushError("notion", projectPickerErrorMessage(projectPicker.label, e)),
      },
    );
  };

  return (
    <div className="cb">
      <CaptureBoardHeader
        okrQuarter={okrQuarter}
        okrObjectives={objectivesQ.data ?? []}
        okrCheckIns={okrCheckInsQ.data ?? []}
      />

      {loadError && (
        <div className="empty" style={{ color: "var(--color-q1)", padding: "4px 22px" }}>
          데이터 로드 실패: {String(signalsQ.error ?? todayQ.error ?? routinesQ.error)}
        </div>
      )}

      <div className="board">
        <MatrixCanvas
          signals={boardSignals}
          selectedId={selectedId}
          poppedIds={poppedIds}
          onSelect={setSelectedId}
          onClassify={handleClassify}
          onPromoteToday={handlePromoteToday}
          onOpenMenu={(id, anchor) => {
            setSelectedId(id);
            setMenu({ signalId: id, anchor });
          }}
          editingId={editingId}
          onEditStart={(id) => {
            setSelectedId(id);
            setEditingId(id);
          }}
          onEditCommit={handleTitleCommit}
          onEditCancel={() => setEditingId(null)}
          onEnrichAll={handleEnrichAll}
          onSetKind={(id, kind) => setKind.mutate({ id, kind })}
          onSetAreaTagKey={(id, tagKey) => setAreaTagKey.mutate({ id, tagKey })}
          lifeWheelTags={lifeWheelTags.data ?? []}
          enrichAllDisabled={!codexReady || unclassifiedCount === 0 || triggerEnrichAll.isPending}
          enrichAllRunning={triggerEnrichAll.isPending || enrichAllAgentRunning}
          todayPanelRef={todayPanelRef}
          onCapture={handleCapture}
          captureInputRef={captureInputRef}
          captureDisabled={createSignal.isPending}
        />

        <ExecutionRail
          todayItems={todayItems}
          routines={routines}
          lifeWheelTags={lifeWheelTags.data ?? []}
          projects={projects}
          todayPanelRef={todayPanelRef}
          onToggleTodayDone={(id, done) => toggleTodayDone.mutate({ id, date: today, done })}
          onUnpromoteToday={handleUnpromote}
          onReorderToday={(ids) => reorderToday.mutate(ids)}
          onSetTodayKind={(id, kind) => setKind.mutate({ id, kind })}
          onSetTodayAreaTagKey={(id, tagKey) => setAreaTagKey.mutate({ id, tagKey })}
          onToggleRoutine={(routineId, done) =>
            toggleRoutine.mutate({ routineId, date: today, done })
          }
          onCreateRoutine={handleCreateRoutine}
          onUpdateRoutine={handleUpdateRoutine}
          onDeleteRoutine={handleDeleteRoutine}
          onReorderRoutines={(ids) => reorderRoutines.mutate(ids)}
          onOpenRoutineTracking={() => goTo("routines")}
          onSetRoutineKind={(id, kind) => setRoutineKind.mutate({ id, kind })}
          onSetRoutineAreaTagKey={(id, tagKey) => setRoutineAreaTagKey.mutate({ id, tagKey })}
          onEnableRoutineSync={handleEnableRoutineSync}
          onDisableRoutineSync={handleDisableRoutineSync}
          onMoveRoutineSync={handleMoveRoutineSync}
          routineSyncBusy={
            enableRoutineSync.isPending || disableRoutineSync.isPending || moveRoutineSync.isPending
          }
        />
      </div>

      <BoardOverlays
        menu={menu}
        calendarModal={calendarModal}
        projectPicker={projectPicker}
        onMenuAction={handleMenuAction}
        onMenuClose={() => setMenu(null)}
        onCalendarClose={() => setCalendarModal(null)}
        onProjectPickerClose={() => setProjectPicker(null)}
        onProjectPick={handleProjectPick}
      />
    </div>
  );
}

export function CaptureBoard() {
  return useCaptureBoardView();
}
