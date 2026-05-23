import { useEffect, useMemo, useRef, useState } from "react";
import {
  MessageCircle,
  Send,
  Sparkles,
  SquareTerminal,
} from "lucide-react";

import type { AgentRunView, AgentStatus, Engine } from "@/bindings";
import {
  type BoxState,
  boxWidth,
  overflowSplit,
  progressRatio,
} from "@/lib/agentBar";
import { useAgentRuns } from "@/lib/query";
import { useAgentNames, useSetAgentName } from "@/lib/query/agentsConfig";
import { useCmuxStatus } from "@/lib/query/cmux";
import { useHermesBridgeStatus } from "@/lib/query/hermes";
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
  error: "오류",
};

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

/** engine → lucide thin-line 아이콘. */
function EngineIcon({ engine, size = 13 }: { engine: Engine; size?: number }) {
  switch (engine) {
    case "codex":
      return <SquareTerminal size={size} strokeWidth={1.5} />;
    case "hermes":
      return <Send size={size} strokeWidth={1.5} />;
    case "claude":
      return <Sparkles size={size} strokeWidth={1.5} />;
    default:
      return <MessageCircle size={size} strokeWidth={1.5} />;
  }
}

/** SQLite UTC datetime('YYYY-MM-DD HH:MM:SS') → epoch ms. */
function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** agent_runs(codex 등) → 세션 박스. 활성 잡 우선, 그 외 최근 종료 잡도 1박스로 표시. */
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
  const { goTo } = useUIStore();
  const runs = useAgentRuns();
  const list = runs.data ?? [];

  // hermes/cmux 세션 (agent_runs에 없을 수 있어 별도 enumerate — 표시 전용 INVARIANT #1).
  const hermes = useHermesBridgeStatus();
  const cmux = useCmuxStatus();

  // client-side first-seen: 백엔드 timestamp 없는 세션(hermes/cmux)의 경과 기준점.
  // 표시 전용 — 결정 로직 미사용. 사라진 세션 키는 정리.
  const firstSeenRef = useRef<Map<string, number>>(new Map());

  // ── 세션 → 박스 enumerate (codex runs + hermes + cmux) ─────────────────
  const boxes = useMemo<SessionBox[]>(() => {
    const out: SessionBox[] = [];

    // 1) agent_runs: 활성 잡 먼저(list는 created_at DESC), 그 외 최근 잡.
    const sortedRuns = [...list].sort((a, b) => {
      const aw = isActive(a.status) ? 0 : 1;
      const bw = isActive(b.status) ? 0 : 1;
      return aw - bw;
    });
    for (const run of sortedRuns) out.push(runToBox(run));

    // 2) hermes 세션: 연결되어 있으면 1박스(엔진 박스, idle).
    if (hermes.data?.configured) {
      out.push({
        key: "hermes:bridge",
        engine: "hermes",
        name: "Hermes",
        state: "idle",
        stateLabel: STATE_LABEL.idle,
        startedMs: firstSeenMs(firstSeenRef.current, "hermes:bridge"),
        timeoutSec: null,
        title: `hermes · ${hermes.data.detail}`,
      });
    }

    // 3) cmux 워크스페이스: 각 1박스(세션 enumerate). selected=working, 그 외 idle.
    const cmuxData = cmux.data;
    if (cmuxData?.available && cmuxData.workspaces.length > 0) {
      for (const w of cmuxData.workspaces) {
        const key = `cmux:${w.reference}`;
        const working = w.selected;
        out.push({
          key,
          engine: "claude",
          name: w.title,
          state: working ? "working" : "idle",
          stateLabel: working ? STATE_LABEL.working : STATE_LABEL.idle,
          startedMs: working ? firstSeenMs(firstSeenRef.current, key) : null,
          timeoutSec: null,
          title: `cmux · ${w.title} (${w.reference})`,
        });
      }
    }

    // 사라진 세션 키 정리(메모리 누수 방지).
    pruneFirstSeen(
      firstSeenRef.current,
      out.map((b) => b.key),
    );

    return out;
  }, [list, hermes.data, cmux.data]);

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
  const commitName = (sessionKey: string, defaultName: string, next: string) => {
    setEditingKey(null);
    const trimmed = next.trim();
    // 빈 값 또는 기본 라벨과 동일 → 오버라이드 삭제(null). 그 외 새 이름 저장.
    const value = trimmed === "" || trimmed === defaultName ? null : trimmed;
    setName.mutate({ sessionKey, name: value });
  };

  // ── 빈 상태: 조용한 단일 'Agents · idle' pill (박스 없음). ──────────────
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
            onOpen={() => goTo("jobs")}
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
      </div>
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
  const width = editing ? undefined : boxWidth(ratio, working && box.startedMs != null);

  // 편집 중에는 클릭이 Jobs로 이동하지 않도록 div로 전환(input 포커스 보존).
  const Tag = editing ? "div" : "button";

  return (
    <Tag
      type={editing ? undefined : "button"}
      className={`asb-box asb-box-${box.state}`}
      style={{ width }}
      onClick={editing ? undefined : onOpen}
      title={editing ? undefined : box.title}
    >
      {working && box.startedMs != null && !editing && (
        <span
          className="asb-box-fill"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      )}
      <span className="asb-box-icon">
        <EngineIcon engine={box.engine} size={13} />
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
      <span className={`asb-box-state asb-box-state-${box.state}`}>
        <span className="asb-box-dot" aria-hidden="true" />
        <span className="asb-box-state-label">{box.stateLabel}</span>
      </span>
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

/** client first-seen 경과 기준점(epoch ms). 없으면 now로 초기화 후 반환. */
function firstSeenMs(map: Map<string, number>, key: string): number {
  const existing = map.get(key);
  if (existing != null) return existing;
  const now = Date.now();
  map.set(key, now);
  return now;
}

/** 살아있는 키만 남기고 정리. */
function pruneFirstSeen(map: Map<string, number>, liveKeys: string[]): void {
  const live = new Set(liveKeys);
  for (const k of map.keys()) {
    if (!live.has(k)) map.delete(k);
  }
}

/** '+N' 오버플로 칩 tooltip — 접힌 세션 이름 나열(오버라이드 우선). */
function overflowTitle(
  hidden: SessionBox[],
  nameOverrides: Record<string, string>,
): string {
  return hidden
    .map((b) => `${nameOverrides[b.key] ?? b.name} (${b.stateLabel})`)
    .join("\n");
}
