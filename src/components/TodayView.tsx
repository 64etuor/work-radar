import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Circle,
  ExternalLink,
  Flame,
  GitPullRequest,
  Inbox,
  Repeat,
  Trash2,
} from "lucide-react";

import type { CalendarEvent, WorkSignal } from "@/bindings";
import {
  ageFromForDate,
  isTodayDone,
  localToday,
  localWeekday,
  openExternal,
  usePromoteToday,
  useCalendarEvents,
  useToday,
  useTodayOverview,
  useTodayRoutines,
  useToggleRoutineCheck,
  useToggleTodayDone,
  useUnpromoteToday,
} from "@/lib/query";
import { useUIStore } from "@/store";

/** 타임드 이벤트 시작 → 로컬 HH:MM. all-day는 호출 안 함. */
function eventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Today — 하루 운영 콕핏 (Phase 11a). 캡처 보드의 Today 레일(decide/curate)과 달리 execute/overview.
 * 상단 Work Debt 스트립 + 캘린더 오늘 이벤트 + Q1 + Today 레일(focus) + PR attention + 루틴.
 * 전부 read 집계 + 기존 사람 액션 재사용 — 자동 분류 없음(INVARIANT #1).
 */
export function TodayView() {
  const { goTo } = useUIStore();
  const today = localToday();
  const weekday = localWeekday();

  const overview = useTodayOverview(today);
  const events = useCalendarEvents(today);
  const todayRail = useToday(today);
  const routines = useTodayRoutines(today, weekday);

  const promoteToday = usePromoteToday();
  const unpromote = useUnpromoteToday();
  const toggleDone = useToggleTodayDone();
  const toggleRoutine = useToggleRoutineCheck();

  const debt = overview.data?.workDebt;
  const q1Items = overview.data?.q1Items ?? [];
  const prAttention = overview.data?.prAttention ?? [];
  const railItems = todayRail.data ?? [];
  const allDay = (events.data ?? []).filter((e) => e.allDay);
  const timed = (events.data ?? []).filter((e) => !e.allDay);
  const routineList = routines.data ?? [];

  return (
    <div className="today">
      <header className="today-head" data-tauri-drag-region>
        <button type="button" className="today-back" onClick={() => goTo("board")}>
          <ArrowLeft className="size-4" />
          보드
        </button>
        <span className="today-title">Today</span>
        <span className="today-date">{today}</span>
      </header>

      <div className="today-scroll">
        {/* Work Debt 스트립 — 클릭하면 해당 소스로 점프. */}
        <div className="today-debt">
          <DebtTile
            label="미분류"
            value={debt?.unclassified}
            icon={<Inbox className="size-4" />}
            tone="warn"
            onClick={() => goTo("board")}
          />
          <DebtTile
            label="Q1 overdue"
            value={debt?.q1Overdue}
            icon={<Flame className="size-4" />}
            tone="urgent"
            onClick={() => goTo("board")}
          />
          <DebtTile
            label="stale backlog"
            value={debt?.staleBacklog}
            icon={<AlertTriangle className="size-4" />}
            tone="warn"
            onClick={() => goTo("board")}
          />
          <DebtTile
            label="cleanup"
            value={debt?.cleanupNeeded}
            icon={<Trash2 className="size-4" />}
            tone="muted"
            onClick={() => goTo("radar")}
          />
        </div>

        {/* 캘린더 오늘 일정 (ambient — 미연결/실패는 graceful degrade). */}
        <section className="today-sec">
          <div className="today-sec-head">
            <CalendarDays className="size-4 text-wr-subtle" />
            <span className="today-sec-name">오늘 일정</span>
            <span className="today-sec-count">{(events.data ?? []).length}</span>
          </div>
          {events.isError && (
            <div className="today-hint">캘린더를 불러오지 못했습니다 — 설정에서 Google Calendar 연결을 확인하세요.</div>
          )}
          {!events.isError && (events.data ?? []).length === 0 && (
            <div className="today-hint">오늘 일정이 없습니다 (연결된 캘린더 기준).</div>
          )}
          {allDay.length > 0 && (
            <div className="today-allday">
              {allDay.map((e) => (
                <EventChip key={e.id} ev={e} allDay />
              ))}
            </div>
          )}
          {timed.map((e) => (
            <button
              key={e.id}
              type="button"
              className="today-event"
              onClick={() => e.url && void openExternal(e.url)}
            >
              <span className="today-event-time">{eventTime(e.start)}</span>
              <span className="today-event-title">{e.title}</span>
              <span className="today-event-cal">{e.calendarSummary}</span>
              {e.url && <ExternalLink className="size-3.5 text-wr-subtle" />}
            </button>
          ))}
        </section>

        {/* Q1 — 사람이 분류한 긴급·중요, 아직 Today에 안 올린 것 (콕핏에서 끌어올림). */}
        <section className="today-sec">
          <div className="today-sec-head">
            <Flame className="size-4 text-q1" />
            <span className="today-sec-name">Q1 — 지금/중요</span>
            <span className="today-sec-count">{q1Items.length}</span>
          </div>
          {q1Items.length === 0 && <div className="today-hint">매트릭스 Q1에 올릴 항목이 없습니다.</div>}
          {q1Items.map((s) => (
            <div key={s.id} className="today-row">
              <span className="today-badge today-q1">Q1</span>
              <span className="today-row-title">{s.title}</span>
              <button
                type="button"
                className="today-act"
                disabled={promoteToday.isPending}
                onClick={() => promoteToday.mutate({ id: s.id, date: today })}
              >
                + Today
              </button>
            </div>
          ))}
        </section>

        {/* Today 레일 — 오늘의 focus 큐 (완료 토글 + 경과일 +N + 되돌리기). */}
        <section className="today-sec">
          <div className="today-sec-head">
            <CheckCircle2 className="size-4 text-wr-subtle" />
            <span className="today-sec-name">Today 레일 (focus)</span>
            <span className="today-sec-count">{railItems.length}</span>
          </div>
          {railItems.length === 0 && (
            <div className="today-hint">오늘 집중할 항목이 없습니다 — 위 Q1이나 보드에서 추가하세요.</div>
          )}
          {railItems.map((s) => {
            const done = isTodayDone(s, today);
            const age = s.todayForDate ? ageFromForDate(s.todayForDate) : 0;
            return (
              <div key={s.id} className={`today-row${done ? " today-done" : ""}`}>
                <button
                  type="button"
                  className="today-check"
                  aria-label={done ? "완료 취소" : "완료"}
                  onClick={() =>
                    toggleDone.mutate({ id: s.id, date: today, done: !done })
                  }
                >
                  {done ? (
                    <CheckCircle2 className="size-4 text-q2" />
                  ) : (
                    <Circle className="size-4 text-wr-subtle" />
                  )}
                </button>
                <span className="today-row-title">{s.title}</span>
                {age > 1 && <span className="today-age" title="경과일">+{age}</span>}
                <button
                  type="button"
                  className="today-act"
                  title="매트릭스로 되돌리기"
                  onClick={() => unpromote.mutate(s.id)}
                >
                  되돌리기
                </button>
              </div>
            );
          })}
        </section>

        {/* PR attention — 매트릭스로 escalate된 PR 신호 (자세히는 PR Radar). */}
        <section className="today-sec">
          <div className="today-sec-head">
            <GitPullRequest className="size-4 text-wr-subtle" />
            <span className="today-sec-name">PR attention</span>
            <span className="today-sec-count">{prAttention.length}</span>
          </div>
          {prAttention.length === 0 && <div className="today-hint">주의가 필요한 PR이 없습니다.</div>}
          {prAttention.map((s: WorkSignal) => (
            <button
              key={s.id}
              type="button"
              className="today-row today-row-btn"
              onClick={() => goTo("radar")}
            >
              <span className="today-badge today-pr">PR</span>
              <span className="today-row-title">{s.title}</span>
            </button>
          ))}
        </section>

        {/* 루틴 — 오늘 해당분 (날짜별 완료). */}
        <section className="today-sec">
          <div className="today-sec-head">
            <Repeat className="size-4 text-wr-subtle" />
            <span className="today-sec-name">루틴</span>
            <span className="today-sec-count">{routineList.length}</span>
          </div>
          {routineList.length === 0 && <div className="today-hint">오늘 해당하는 루틴이 없습니다.</div>}
          {routineList.map((r) => (
            <div key={r.id} className={`today-row${r.done ? " today-done" : ""}`}>
              <button
                type="button"
                className="today-check"
                aria-label={r.done ? "완료 취소" : "완료"}
                onClick={() =>
                  toggleRoutine.mutate({ routineId: r.id, date: today, done: !r.done })
                }
              >
                {r.done ? (
                  <CheckCircle2 className="size-4 text-q2" />
                ) : (
                  <Circle className="size-4 text-wr-subtle" />
                )}
              </button>
              <span className="today-row-title">{r.title}</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function DebtTile({
  label,
  value,
  icon,
  tone,
  onClick,
}: {
  label: string;
  value: number | undefined;
  icon: React.ReactNode;
  tone: "urgent" | "warn" | "muted";
  onClick: () => void;
}) {
  return (
    <button type="button" className={`today-tile today-tile-${tone}`} onClick={onClick}>
      <span className="today-tile-top">
        {icon}
        <span className="today-tile-label">{label}</span>
      </span>
      <span className="today-tile-val">{value ?? "—"}</span>
    </button>
  );
}

function EventChip({ ev, allDay }: { ev: CalendarEvent; allDay?: boolean }) {
  return (
    <button
      type="button"
      className="today-allday-chip"
      onClick={() => ev.url && void openExternal(ev.url)}
      title={ev.calendarSummary}
    >
      {allDay && <span className="today-allday-tag">종일</span>}
      {ev.title}
    </button>
  );
}
