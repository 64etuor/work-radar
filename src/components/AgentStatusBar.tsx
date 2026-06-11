import "./AgentStatusBar.css";

import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Calendar, Inbox, Plus } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useHermesTabsStore } from "@/components/hermes/useHermesTabsStore";
import { InboxTray } from "@/components/inbox/InboxTray";
import { isActiveJobStatus, isFinishedJobStatus } from "@/components/jobs/jobsConstants";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type BoxState, overflowSplit } from "@/lib/agentBar";
import { useAgentRuns, useInboxCounts } from "@/lib/query";
import { useAgentNames, useSetAgentName } from "@/lib/query/agentsConfig";
import { useCmuxStatus, useFocusCmuxWorkspace } from "@/lib/query/cmux";
import { useUIStore } from "@/store";

import { AgentBox } from "./agent-status/AgentBox";
import {
  getFirstSeenSnapshot,
  reconcileFirstSeen,
  subscribeFirstSeen,
} from "./agent-status/firstSeen";
import { runToBox } from "./agent-status/runToBox";
import { type SessionBox, STATE_LABEL } from "./agent-status/shared";

/**
 * 글로벌 에이전트 상태 바 (Phase 20 #16 / P10a redesign) — 모든 뷰 상단 상주 스트립.
 *
 * P10a: 얇은 트랙 → **정체성 박스**(아이콘 + 이름 + 상태색·라벨 병기 + 경과 백필).
 *  - codex 잡(agent_runs): elapsed/timeout 비율로 백필 + width 성장.
 *  - hermes/cmux 세션: agent_runs rows가 없을 수 있어 별도 enumerate(각 1박스).
 *    timeout이 없으므로 client-side first-seen 경과만으로 채움(상한 도달 시 포화, bounded).
 *  - 개수 상한 8 + 초과 시 '+N' 오버플로 칩. idle 시 단일 'Agents · idle' pill.
 *
 * INVARIANT #1: cmux/세션 데이터는 표시 전용 — 어떤 결정(분류·승격·실행)에도 입력 안 됨.
 */

/** cmux `claude_code` 상태 태그 → 박스 상태(색 dot). "Running"=working, "Needs input"=waiting, 그 외/없음=idle. */
function cmuxBoxState(status: string | null): BoxState {
  if (status === "Running") return "working";
  if (status === "Needs input") return "waiting";
  return "idle";
}

/** '+N' 오버플로 칩 tooltip — 접힌 세션 이름 나열(오버라이드 우선). */
function overflowTitle(hidden: SessionBox[], nameOverrides: Record<string, string>): string {
  return hidden.map((b) => `${nameOverrides[b.key] ?? b.name} (${b.stateLabel})`).join("\n");
}

export function AgentStatusBar() {
  const { goTo, setCalendarOpen } = useUIStore();
  const setOpenAgentRunId = useUIStore((s) => s.setOpenAgentRunId);
  const inboxOpen = useUIStore((s) => s.inboxOpen);
  const setInboxOpen = useUIStore((s) => s.setInboxOpen);
  const runs = useAgentRuns();
  const inboxCounts = useInboxCounts();
  const list = runs.data ?? [];

  // hermes multi-session tabs (표시 전용 INVARIANT #1 — store selector만, 결정 미사용).
  const hermesTabs = useHermesTabsStore((s) => s.tabs);
  const hermesOpenTab = useHermesTabsStore((s) => s.openTab);
  const hermesSetActive = useHermesTabsStore((s) => s.setActive);
  const hermesRename = useHermesTabsStore((s) => s.rename);

  const cmux = useCmuxStatus();
  const focusCmux = useFocusCmuxWorkspace();

  // client-side first-seen: 백엔드 timestamp 없는 세션(hermes tabs/cmux)의 경과 기준점.
  // 표시 전용 — 결정 로직 미사용. 외부 레지스트리(firstSeen.ts) 구독 — effect가 setState 없이
  // reconcile만 하므로 React Compiler 최적화가 유지된다. 신규 키가 처음 보일 한 프레임은
  // 스냅샷 미반영("0s" fallback)이며 직후 effect가 persist.
  const firstSeen = useSyncExternalStore(subscribeFirstSeen, getFirstSeenSnapshot);

  // ── 세션 → 박스 enumerate (codex runs + hermes tabs + cmux) ──────────────
  const boxes: SessionBox[] = [];
  {
    const out = boxes;

    // 1) agent_runs: 활성 잡 + 사용자가 아직 ack(모달 클릭→close)하지 않은 종료 잡을 표시.
    //    클릭 → `AgentRunModal` 오픈 → 모달 닫힐 때 `acked_at` 마킹(SQLite SSOT) → 바에서 숨김.
    //    자동 모달 오픈 없음(INVARIANT #1 표시 전용). list는 created_at DESC.
    for (const run of list) {
      const shouldShow =
        isActiveJobStatus(run.status) || (isFinishedJobStatus(run.status) && run.ackedAt === null);
      if (shouldShow) out.push(runToBox(run));
    }

    // 2) hermes 탭: 탭당 1박스 enumerate (useHermesTabsStore selector — 표시 전용 INVARIANT #1).
    //    status "starting" = working, "error" = error, 그 외 = idle.
    for (const t of hermesTabs.values()) {
      const key = `hermes:${t.id}`;
      const state: BoxState =
        t.status === "error" ? "error" : t.status === "starting" ? "working" : "idle";
      out.push({
        key,
        engine: "hermes",
        name: t.name,
        state,
        stateLabel: STATE_LABEL[state],
        startedMs: state === "working" ? (firstSeen.get(key) ?? null) : null,
        timeoutSec: null,
        title: `Hermes · ${t.name} · ${STATE_LABEL[state]}`,
      });
    }

    // 3) cmux 워크스페이스: 각 1박스(세션 enumerate). 활성 판정 = cmux의 claude_code 상태 태그
    //    (agentStatus): "Running"=working, 그 외("Needs input"/없음)=idle. 이전엔 selected(포커스 탭)를
    //    working으로 썼으나 실제 실행 상태와 불일치 → cmux가 추적하는 권위 태그로 교체(표시 전용 #1).
    const cmuxData = cmux.data;
    if (cmuxData?.available && cmuxData.workspaces.length > 0) {
      for (const w of cmuxData.workspaces) {
        const key = `cmux:${w.reference}`;
        const state = cmuxBoxState(w.agentStatus);
        out.push({
          key,
          engine: "claude",
          name: w.title,
          state,
          stateLabel: STATE_LABEL[state],
          startedMs: state === "working" ? (firstSeen.get(key) ?? null) : null,
          timeoutSec: null,
          title: `cmux · ${w.title} (${w.reference})${w.agentStatus ? ` · ${w.agentStatus}` : ""}`,
        });
      }
    }
  }

  // hermes tab / cmux 세션 first-seen 등록 + 사라진 키 정리. Date.now()는 impure라 render에 못 두므로
  // effect에서 외부 레지스트리에 reconcile(setState 0 — 스토어 스냅샷 교체가 구독 리렌더를 만든다).
  // hermes는 working일 때만, cmux도 마찬가지.
  const cmuxData = cmux.data;
  useEffect(() => {
    const desired = new Set<string>();
    for (const t of hermesTabs.values()) {
      if (t.status === "starting") desired.add(`hermes:${t.id}`);
    }
    if (cmuxData?.available) {
      for (const w of cmuxData.workspaces) {
        if (cmuxBoxState(w.agentStatus) === "working") desired.add(`cmux:${w.reference}`);
      }
    }
    reconcileFirstSeen(desired);
  }, [hermesTabs, cmuxData]);

  // 박스 이름 오버라이드(app_config) — 키별 사용자 지정 라벨. 없으면 box.name fallback.
  const sessionKeys = boxes.map((b) => b.key);
  const names = useAgentNames(sessionKeys);
  const nameOverrides = names.data ?? {};
  const setName = useSetAgentName();

  const { visibleCount, overflow } = overflowSplit(boxes.length);
  const visible = boxes.slice(0, visibleCount);

  // 진행/width 애니메이션용 1s UI 시계 — working 박스가 있을 때만 가동.
  const hasWorking = boxes.some((b) => b.state === "working");
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasWorking) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasWorking]);

  // 인라인 이름 편집 중인 박스 key(없으면 null). 더블클릭으로 진입.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // 박스 클릭 라우팅:
  //  hermes:* → setActive(tabId) + hermes:open (패널 열기 — 이미 열려 있으면 no-op).
  //    INVARIANT #1: click = navigation only, no decision input.
  //  cmux 워크스페이스 → cmux 포커스 이동(select-workspace).
  //  run:* (codex agent_runs) → 전역 `AgentRunModal` 오픈(상태별 진행/결과/Proposal 한 곳에서).
  const openBox = (box: SessionBox) => {
    if (box.key.startsWith("hermes:")) {
      const tabId = box.key.slice("hermes:".length);
      hermesSetActive(tabId);
      void emit("hermes:open");
    } else if (box.key.startsWith("cmux:"))
      // cmux 딥링크: 포커스 이동이 실제 성공(true)하면 Work Radar 창을 숨겨 cmux에 자리 양보.
      // best-effort 실패(false)면 숨기지 않는다 — 앞에 뜨는 창이 없는데 앱만 사라지는 상황 방지.
      focusCmux.mutate(box.key.slice("cmux:".length), {
        onSuccess: (focused) => {
          if (focused) void getCurrentWindow().hide();
        },
      });
    else if (box.key.startsWith("run:")) {
      setOpenAgentRunId(box.key.slice("run:".length));
    } else goTo("jobs");
  };
  const commitName = (sessionKey: string, defaultName: string, next: string) => {
    setEditingKey(null);
    const trimmed = next.trim();
    if (sessionKey.startsWith("hermes:")) {
      // Hermes tab rename: in-memory store only (NOT keychain — different destination).
      const tabId = sessionKey.slice("hermes:".length);
      const finalName = trimmed === "" ? defaultName : trimmed;
      hermesRename(tabId, finalName);
      return;
    }
    // 빈 값 또는 기본 라벨과 동일 → 오버라이드 삭제(null). 그 외 새 이름 저장.
    const value = trimmed === "" || trimmed === defaultName ? null : trimmed;
    setName.mutate({ sessionKey, name: value });
  };

  // 캘린더 트리거 — 바 최우측 상주 아이콘(단축키 ⌘⇧C와 동일 전역 토글). 어느 뷰에서나.
  const calendarBtn = (
    <button
      key="asb-cal"
      type="button"
      className="asb-cal"
      onClick={() => setCalendarOpen(true)}
      title="캘린더 (⌘⇧C)"
      aria-label="캘린더 열기"
    >
      <Calendar size={15} strokeWidth={1.5} />
    </button>
  );
  const unreadInbox = inboxCounts.data?.unread ?? 0;
  // 벨 = Popover 트리거 → Inbox 트레이 아코디언(뷰 이동 아님). 컨트롤드 open(store)로 팔레트/단축키도 토글.
  // Popover Content는 overlay-stack 마커(data-wr-overlay-open) + radix Esc 닫기·트리거 포커스 복원을 내장.
  const inboxBtn = (
    // 안정 key: 빈/비빈 상태 두 return 분기에서 React가 위치가 아니라 key로 매칭 → boxes 0↔N 전이에도
    // Popover 인스턴스(트레이 open 상태) 보존(remount로 트레이가 닫히는 회귀 차단).
    <Popover key="asb-inbox" open={inboxOpen} onOpenChange={setInboxOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="asb-inbox"
          title={unreadInbox > 0 ? `Inbox unread ${unreadInbox}` : "Inbox"}
          aria-label={unreadInbox > 0 ? `Inbox unread ${unreadInbox}` : "Inbox 열기"}
        >
          <Inbox size={15} strokeWidth={1.5} />
          {unreadInbox > 0 && <span className="asb-badge">{unreadInbox}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[360px] p-0 shadow-[0_8px_22px_rgba(15,20,40,0.12)]"
      >
        <InboxTray onClose={() => setInboxOpen(false)} />
      </PopoverContent>
    </Popover>
  );

  // ⊕ 칩 — hermes 박스 그룹 우측. 표시 전용(INVARIANT #1).
  // 클릭 시 탭 생성 + 패널 열기(hermes:open) — 0탭 상태에서 패널 진입점 보장.
  const hermesAddChip = (
    <button
      type="button"
      className="asb-add-chip"
      aria-label="새 Hermes 탭"
      title="새 Hermes 탭"
      onClick={() => {
        void (async () => {
          const id = await hermesOpenTab();
          if (id) {
            hermesSetActive(id);
            void emit("hermes:open");
          }
        })();
      }}
    >
      <Plus size={12} strokeWidth={1.5} />
    </button>
  );

  // ── 빈 상태: 조용한 단일 'Agents · idle' pill (박스 없음). ──────────────
  // Even with no boxes, show ⊕ chip so users can start their first Hermes tab.
  if (boxes.length === 0) {
    return (
      <div className="asb-row">
        <button
          type="button"
          className="asb asb-idle"
          onClick={() => goTo("jobs")}
          title="Agent Jobs 열기"
        >
          <span className="asb-label">Agents</span>
          <span className="asb-idle-text">idle</span>
        </button>
        {hermesAddChip}
        {inboxBtn}
        {calendarBtn}
      </div>
    );
  }

  return (
    <div className="asb-row">
      <span className="asb-label asb-label-lead">Agents</span>
      <div className="asb-boxes">
        {visible.map((box) => (
          <AgentBox
            key={box.key}
            box={box}
            displayName={nameOverrides[box.key] ?? box.name}
            nowMs={nowMs}
            editing={editingKey === box.key}
            onOpen={() => openBox(box)}
            onEditStart={() => setEditingKey(box.key)}
            onCommit={(next) => commitName(box.key, box.name, next)}
            onCancel={() => setEditingKey(null)}
          />
        ))}
        {overflow > 0 && (
          <span
            className="asb-overflow"
            title={overflowTitle(boxes.slice(visibleCount), nameOverrides)}
          >
            +{overflow}
          </span>
        )}
        {hermesAddChip}
      </div>
      {inboxBtn}
      {calendarBtn}
    </div>
  );
}
