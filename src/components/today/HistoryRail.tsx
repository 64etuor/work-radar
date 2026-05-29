import { useEffect, useMemo, useRef, useState } from "react";

import type { TimelineNote, WorkSignal } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { Textarea } from "@/components/ui/textarea";
import { defaultProjectCalendarColor, normalizeHexColor } from "@/lib/projectCalendarColor";
import {
  IpcError,
  useCompletedHistory,
  useProjects,
  useTimelineNotesForDate,
  useUpsertTimelineNote,
} from "@/lib/query";
import { useToastStore } from "@/lib/toast";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";

/**
 * Today 우측 320px "완료 이력" 패널.
 * - 데이터: today_done_at DESC, 7일 윈도로 무한 페이징(하단 sentinel에서 더 과거 fetch).
 * - 표시: 일자 헤더 + dot · 제목 · 완료시각 badge · 메모 인라인 항상 노출(클릭 0회).
 * - 시각: signals.updated_at(toggle done 시 datetime('now') UTC) → 로컬 HH:MM.
 *   메모 upsert는 timeline_notes 테이블이라 signals.updated_at을 건드리지 않음 → 충돌 없음.
 *   주의: archive/snooze/태깅 등 후속 mutation이 있으면 updated_at이 갱신되므로 approximate.
 * - 메모: timeline_notes(target_kind='signal', date=today_done_at), 그룹 batch fetch로 N+1 회피.
 * INVARIANT #1: 자동 분류 0 — 표시 + 사람 입력만.
 */
export function HistoryRail({ today }: { today: string }) {
  const history = useCompletedHistory(today);
  const projectsQ = useProjects();

  const projectColor = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsQ.data ?? []) {
      map.set(p.id, normalizeHexColor(p.calendarColor) ?? defaultProjectCalendarColor(p.id));
    }
    return map;
  }, [projectsQ.data]);

  const groups = useMemo(() => {
    const m = new Map<string, WorkSignal[]>();
    for (const page of history.data?.pages ?? []) {
      for (const s of page.rows) {
        const d = s.todayDoneAt;
        if (!d) continue;
        const bucket = m.get(d) ?? [];
        bucket.push(s);
        m.set(d, bucket);
      }
    }
    return Array.from(m.entries());
  }, [history.data]);

  const totalCount = useMemo(
    () => groups.reduce((sum, [, items]) => sum + items.length, 0),
    [groups],
  );
  const todayCount = useMemo(
    () => groups.find(([d]) => d === today)?.[1].length ?? 0,
    [groups, today],
  );

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && history.hasNextPage && !history.isFetchingNextPage) {
        void history.fetchNextPage();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [history]);

  return (
    <aside className="today-history" aria-label="이전 완료 이력">
      <header className="today-history-head">
        <span className="today-history-title">완료 이력</span>
        <Badge
          variant="outline"
          className="ml-auto h-[18px] gap-1 rounded-full px-2 font-mono text-[10px] font-semibold tracking-wide"
          title={`오늘 ${todayCount}건 · 이력 ${totalCount}건`}
        >
          <span className="text-wr-fg">{todayCount}</span>
          <span className="text-wr-subtle">/</span>
          <span className="text-wr-subtle">{totalCount}</span>
        </Badge>
      </header>
      <div className="today-history-list">
        {history.isLoading ? (
          <div className="today-history-hint">불러오는 중…</div>
        ) : groups.length === 0 ? (
          <div className="today-history-empty">
            <div className="today-history-empty-title">아직 완료된 항목이 없습니다</div>
            <div className="today-history-empty-sub">
              Today 항목을 ✓ 체크하면 여기에 시간순으로 쌓입니다.
            </div>
          </div>
        ) : (
          groups.map(([date, items]) => (
            <HistoryGroup
              key={date}
              date={date}
              items={items}
              today={today}
              colorOf={projectColor}
            />
          ))
        )}
        <div ref={sentinelRef} className="today-history-sentinel">
          {history.isFetchingNextPage
            ? "더 불러오는 중…"
            : !history.hasNextPage && groups.length > 0
              ? "더 이상 기록이 없습니다"
              : null}
        </div>
      </div>
    </aside>
  );
}

function HistoryGroup({
  date,
  items,
  today,
  colorOf,
}: {
  date: string;
  items: WorkSignal[];
  today: string;
  colorOf: Map<string, string>;
}) {
  const notesQ = useTimelineNotesForDate(date);
  const bodyById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of (notesQ.data ?? []) as TimelineNote[]) {
      if (n.targetKind === "signal") m.set(n.targetId, n.body);
    }
    return m;
  }, [notesQ.data]);

  return (
    <section className="today-history-group">
      <div className="today-history-date">{formatDateHeader(date, today)}</div>
      <ul className="today-history-items">
        {items.map((s) => (
          <HistoryItem
            key={s.id}
            signal={s}
            initialBody={bodyById.get(s.id) ?? ""}
            colorOf={colorOf}
          />
        ))}
      </ul>
    </section>
  );
}

function HistoryItem({
  signal,
  initialBody,
  colorOf,
}: {
  signal: WorkSignal;
  initialBody: string;
  colorOf: Map<string, string>;
}) {
  const date = signal.todayDoneAt as string;
  const upsert = useUpsertTimelineNote();
  const [body, setBody] = useState(initialBody);
  const dirtyRef = useRef(false);

  // 사용자가 타이핑 중이면 외부 invalidation으로 인한 initialBody 갱신이 덮지 않음.
  useEffect(() => {
    if (!dirtyRef.current) setBody(initialBody);
  }, [initialBody]);

  const debounced = useDebouncedCallback((next: string) => {
    upsert.mutate(
      { targetKind: "signal", targetId: signal.id, date, body: next },
      {
        onSuccess: () => {
          dirtyRef.current = false;
        },
        // client.ts:39 — mutations 글로벌 onError 없음. 침묵 실패 방지.
        onError: (err) => {
          useToastStore
            .getState()
            .pushError("memo.save", err instanceof IpcError ? err.app : String(err));
        },
      },
    );
  }, 500);

  const color = signal.projectId ? (colorOf.get(signal.projectId) ?? null) : null;
  const hhmm = formatLocalHHMM(signal.updatedAt);

  return (
    <li className="today-history-item">
      <div className="today-history-item-head">
        <span
          className="today-history-dot"
          style={{ background: color ?? "var(--color-wr-border-light)" }}
          aria-hidden
        />
        <span className="today-history-item-title">{signal.title}</span>
        {hhmm && (
          <Badge
            variant="outline"
            className="text-wr-subtle ml-auto h-[18px] shrink-0 rounded-full px-1.5 font-mono text-[10px] font-semibold tracking-tight"
            title="완료 시각"
          >
            {hhmm}
          </Badge>
        )}
      </div>
      <Textarea
        value={body}
        placeholder="메모…"
        rows={1}
        aria-label={`${signal.title} 메모`}
        className={cn(
          // shadcn 기본 chrome 제거 — 인라인 텍스트처럼 보이게.
          "field-sizing-content min-h-0 resize-none rounded-none border-0 bg-transparent px-0 py-0",
          "text-wr-subtle placeholder:text-wr-subtle/55 pl-3.5 text-[11.5px] leading-[1.45] placeholder:italic",
          "focus-visible:text-wr-fg shadow-none ring-0 focus:ring-0 focus-visible:shadow-[inset_2px_0_0_0_var(--color-wr-accent)]",
          "hover:text-wr-fg",
        )}
        onChange={(e) => {
          dirtyRef.current = true;
          setBody(e.target.value);
          debounced.run(e.target.value);
        }}
        onBlur={() => debounced.flushNow(body)}
      />
    </li>
  );
}

/** SQLite `datetime('now')` (UTC `YYYY-MM-DD HH:MM:SS`) → 로컬 `HH:MM`. 파싱 실패 시 null. */
function formatLocalHHMM(updatedAt: string): string | null {
  if (!updatedAt) return null;
  // UTC marker 명시 — Date 생성자는 공백 포맷에서 환경별 해석이 갈리니 `T...Z` 정규화.
  const iso = updatedAt.includes("T") ? updatedAt : `${updatedAt.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDateHeader(date: string, today: string): string {
  if (date === today) return "오늘";
  const [ty, tm, td] = today.split("-").map(Number);
  const y = new Date(ty, tm - 1, td - 1);
  const yyyy = y.getFullYear();
  const mm = String(y.getMonth() + 1).padStart(2, "0");
  const dd = String(y.getDate()).padStart(2, "0");
  if (date === `${yyyy}-${mm}-${dd}`) return "어제";
  const [, pm, pd] = date.split("-").map(Number);
  const dt = new Date(Number(date.slice(0, 4)), pm - 1, pd);
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][dt.getDay()];
  return `${pm}/${pd} (${weekday})`;
}
