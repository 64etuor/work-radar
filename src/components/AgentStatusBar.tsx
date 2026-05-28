import "./AgentStatusBar.css";

import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Bot,
  Calendar,
  Inbox,
  MessagesSquare,
  PanelsTopLeft,
  Plus,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentRunView, AgentStatus, Engine } from "@/bindings";
import { useHermesTabsStore } from "@/components/hermes/useHermesTabsStore";
import { type BoxState, overflowSplit, progressRatio } from "@/lib/agentBar";
import { useAgentRuns, useInboxCounts } from "@/lib/query";
import { useAgentNames, useSetAgentName } from "@/lib/query/agentsConfig";
import { useCmuxStatus, useFocusCmuxWorkspace } from "@/lib/query/cmux";
import { useUIStore } from "@/store";

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

/** 세션 1개 = 박스 1개의 표시 모델(표시 전용, 결정 미사용). */
type SessionBox = {
  key: string;
  engine: Engine;
  name: string;
  state: BoxState;
  /** 상태 라벨(색+텍스트 병기 — 색만으로 의미 전달 금지). */
  stateLabel: string;
  /** epoch ms — 백엔드 startedAt(codex) 또는 client first-seen(hermes/cmux). null이면 idle. */
  startedMs: number | null;
  /** codex 잡 timeout(초). 없는 세션은 null → 경과만으로 포화. */
  timeoutSec: number | null;
  title: string;
};

const STATE_LABEL: Record<BoxState, string> = {
  idle: "대기",
  working: "작업 중",
  waiting: "입력 대기",
  error: "오류",
};

/** cmux `claude_code` 상태 태그 → 박스 상태(색 dot). "Running"=working, "Needs input"=waiting, 그 외/없음=idle. */
function cmuxBoxState(status: string | null): BoxState {
  if (status === "Running") return "working";
  if (status === "Needs input") return "waiting";
  return "idle";
}

const STATUS_TO_STATE: Record<AgentStatus, BoxState> = {
  proposed: "working",
  running: "working",
  awaiting_approval: "working",
  succeeded: "idle",
  failed: "error",
  cancelled: "idle",
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  proposed: "큐 대기",
  running: "실행 중",
  awaiting_approval: "승인 대기",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

function isActive(s: AgentStatus): boolean {
  return s === "running" || s === "proposed" || s === "awaiting_approval";
}

/**
 * box → lucide thin-line 아이콘.
 * cmux 세션은 engine="claude"로 들어오지만 멀티플렉서 정체성을 위해 별도 식별(분할 패널).
 * 식별은 key 접두사("cmux:")로 — openBox 라우팅과 동일 규약.
 */
function BoxIcon({ box, size = 13 }: { box: SessionBox; size?: number }) {
  if (box.key.startsWith("cmux:")) return <PanelsTopLeft size={size} strokeWidth={1.5} />;
  switch (box.engine) {
    case "codex":
      return <SquareTerminal size={size} strokeWidth={1.5} />;
    case "hermes":
      return <MessagesSquare size={size} strokeWidth={1.5} />;
    case "claude":
      return <Sparkles size={size} strokeWidth={1.5} />;
    default:
      return <Bot size={size} strokeWidth={1.5} />;
  }
}

/** SQLite UTC datetime('YYYY-MM-DD HH:MM:SS') → epoch ms. */
function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** agent_runs(codex 등) 활성 잡 → 세션 박스. 호출부에서 isActive로 필터(종료/취소 잡은 제외). */
function runToBox(run: AgentRunView): SessionBox {
  const state = STATUS_TO_STATE[run.status];
  return {
    key: `run:${run.id}`,
    engine: run.engine,
    name: run.kind,
    state,
    stateLabel: STATUS_LABEL[run.status],
    // working(running)일 때만 경과 백필 — 종료 잡은 idle width.
    startedMs: run.status === "running" ? parseUtcMs(run.startedAt) : null,
    timeoutSec: run.timeoutSec > 0 ? run.timeoutSec : null,
    title: `${run.engine} · ${run.kind} · ${STATUS_LABEL[run.status]}`,
  };
}

export function AgentStatusBar() {
  const { goTo, setCalendarOpen } = useUIStore();
  const runs = useAgentRuns();
  const inboxCounts = useInboxCounts();
  const list = useMemo(() => runs.data ?? [], [runs.data]);

  // hermes multi-session tabs (표시 전용 INVARIANT #1 — store selector만, 결정 미사용).
  const hermesTabs = useHermesTabsStore((s) => s.tabs);
  const hermesCap = useHermesTabsStore((s) => s.cap);
  const hermesOpenTab = useHermesTabsStore((s) => s.openTab);
  const hermesSetActive = useHermesTabsStore((s) => s.setActive);
  const hermesRename = useHermesTabsStore((s) => s.rename);

  const cmux = useCmuxStatus();
  const focusCmux = useFocusCmuxWorkspace();

  // client-side first-seen: 백엔드 timestamp 없는 세션(hermes tabs/cmux)의 경과 기준점.
  // 표시 전용 — 결정 로직 미사용. 신규 키는 effect에서 등록·사라진 키는 정리(react-hooks/refs).
  // 신규 키가 처음 보일 한 프레임은 Date.now() fallback("0s")으로 노출되며 직후 effect가 persist.
  const [firstSeen, setFirstSeen] = useState<Map<string, number>>(() => new Map());

  // ── 세션 → 박스 enumerate (codex runs + hermes tabs + cmux) ──────────────
  const boxes = useMemo<SessionBox[]>(() => {
    const out: SessionBox[] = [];

    // 1) agent_runs: 활성 잡만 표시(running/proposed/awaiting_approval, list는 created_at DESC).
    //    종료 잡(succeeded/failed/cancelled)은 바에 안 띄운다 — 끝났거나 취소된 잡이 남으면
    //    "작업 중"으로 오인됨(이력은 Jobs 뷰). 활성이 없고 hermes/cmux도 없으면 'Agents · idle' pill.
    for (const run of list) {
      if (isActive(run.status)) out.push(runToBox(run));
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

    return out;
  }, [list, hermesTabs, cmux.data, firstSeen]);

  // hermes tab / cmux 세션 first-seen 등록 + 사라진 키 정리. Date.now()는 impure라 render에 못 두므로
  // effect에서만 호출(react-hooks/{refs,purity}). hermes는 working일 때만, cmux도 마찬가지.
  // 함수형 updater + 변경 없으면 prev 반환으로 cascading render 차단 — set-state-in-effect 룰의
  // 회피 의도(불필요 리렌더)는 만족하므로 suppress.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFirstSeen((prev) => {
      const desired = new Set<string>();
      for (const t of hermesTabs.values()) {
        const state: BoxState =
          t.status === "error" ? "error" : t.status === "starting" ? "working" : "idle";
        if (state === "working") desired.add(`hermes:${t.id}`);
      }
      const cmuxData = cmux.data;
      if (cmuxData?.available) {
        for (const w of cmuxData.workspaces) {
          if (cmuxBoxState(w.agentStatus) === "working") desired.add(`cmux:${w.reference}`);
        }
      }
      let changed = false;
      const next = new Map(prev);
      const now = Date.now();
      for (const k of desired) {
        if (!next.has(k)) {
          next.set(k, now);
          changed = true;
        }
      }
      for (const k of next.keys()) {
        if (!desired.has(k)) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [hermesTabs, cmux.data]);

  // 박스 이름 오버라이드(app_config) — 키별 사용자 지정 라벨. 없으면 box.name fallback.
  const sessionKeys = useMemo(() => boxes.map((b) => b.key), [boxes]);
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
  //  그 외(codex 잡) → Jobs 뷰.
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
    else goTo("jobs");
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
  const inboxBtn = (
    <button
      type="button"
      className="asb-inbox"
      onClick={() => goTo("inbox")}
      title={unreadInbox > 0 ? `Inbox unread ${unreadInbox}` : "Inbox"}
      aria-label={unreadInbox > 0 ? `Inbox unread ${unreadInbox}` : "Inbox 열기"}
    >
      <Inbox size={15} strokeWidth={1.5} />
      {unreadInbox > 0 && <span className="asb-badge">{unreadInbox}</span>}
    </button>
  );

  // ⊕ 칩 — hermes 박스 그룹 우측, cap 미달 시만 표시. 표시 전용(INVARIANT #1).
  const hermesAddChip =
    hermesTabs.size < hermesCap ? (
      <button
        type="button"
        className="asb-add-chip"
        aria-label="새 Hermes 탭"
        title="새 Hermes 탭"
        onClick={() => void hermesOpenTab()}
      >
        <Plus size={12} strokeWidth={1.5} />
      </button>
    ) : null;

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

/** 정체성 박스 1개 — 아이콘 + 이름 + 상태(색 dot + 라벨) + 경과 백필 wash. */
function AgentBox({
  box,
  displayName,
  nowMs,
  editing,
  onOpen,
  onEditStart,
  onCommit,
  onCancel,
}: {
  box: SessionBox;
  /** 표시 이름 = app_config 오버라이드 또는 기본 라벨(box.name) fallback. */
  displayName: string;
  nowMs: number;
  editing: boolean;
  onOpen: () => void;
  onEditStart: () => void;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const working = box.state === "working";
  const elapsedSec = box.startedMs != null ? (nowMs - box.startedMs) / 1000 : 0;
  const ratio = working ? progressRatio(elapsedSec, box.timeoutSec) : 0;

  // 편집 중에는 클릭이 Jobs로 이동하지 않도록 div로 전환(input 포커스 보존).
  const Tag = editing ? "div" : "button";

  return (
    <Tag
      type={editing ? undefined : "button"}
      className={`asb-box asb-box-${box.state}`}
      onClick={editing ? undefined : onOpen}
      title={editing ? undefined : box.title}
    >
      {working && box.startedMs != null && !editing && (
        <span className="asb-box-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      )}
      {/* 상태등 — 맨 앞, 색으로만 상태 표시(텍스트 라벨 없음). 의미는 aria-label/title로 보강. */}
      <span className="asb-box-dot" role="img" aria-label={box.stateLabel} title={box.stateLabel} />
      <span className="asb-box-icon">
        <BoxIcon box={box} size={13} />
      </span>
      {editing ? (
        <NameEditor initial={displayName} onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <span
          className="asb-box-name"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onEditStart();
          }}
          title="더블클릭해서 이름 편집"
        >
          {displayName}
        </span>
      )}
    </Tag>
  );
}

/**
 * 박스 이름 인라인 입력. 마운트 시 포커스+전체선택, Enter/blur 저장, Esc 취소.
 * P2 `TitleEditor` 패턴 재사용: capture-phase Esc(App 셸 창 숨김 핸들러보다 먼저 가로챔)
 * + settled 1회 가드(Esc 언마운트→blur(commit) 되살아남 차단).
 */
function NameEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const commit = (value: string) => {
    if (settled.current) return;
    settled.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Esc 취소(캡처 단계 — App 셸의 창 숨김 핸들러보다 먼저 가로채야 한다).
  // synthetic stopPropagation은 native window 리스너를 못 막으므로 ProjectPickerModal과 동일 패턴.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <input
      ref={ref}
      className="asb-box-name-edit"
      aria-label="에이전트 박스 이름 편집"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(draft);
        }
      }}
    />
  );
}

/** '+N' 오버플로 칩 tooltip — 접힌 세션 이름 나열(오버라이드 우선). */
function overflowTitle(hidden: SessionBox[], nameOverrides: Record<string, string>): string {
  return hidden.map((b) => `${nameOverrides[b.key] ?? b.name} (${b.stateLabel})`).join("\n");
}
