import "./RetroView.css";

import { Archive, CheckCircle2, RotateCcw, Sparkles, ThumbsDown } from "lucide-react";
import { useMemo, useState } from "react";

import type { WorkSignal } from "@/bindings";
import { KindAreaChips } from "@/components/board/LifeWheelPalette";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  localToday,
  useArchivedSnoozed,
  useCompleted,
  useLifeWheelTags,
  useRestoreSignal,
  useSetSignalImpact,
  useSetSignalRegret,
} from "@/lib/query";

/** YYYY-MM-DD → M/D (짧은 라벨). */
function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/** N일 전 로컬 날짜(YYYY-MM-DD). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

type Period = 7 | 30 | 90;
const PERIODS: { value: Period; label: string }[] = [
  { value: 7, label: "지난 7일" },
  { value: 30, label: "지난 30일" },
  { value: 90, label: "지난 90일" },
];

/**
 * 전용 회고 뷰 (Phase 17, item 13) + 보관함(item 14). 전부 로컬 read + 사람 태깅 —
 * 자동 분류 0(INVARIANT #1), 외부 변경 0(INVARIANT #2). 완료 todo는 today_done_at 범위로 잡는다.
 */
export function RetroView() {
  const [tab, setTab] = useState<"retro" | "archive">("retro");

  return (
    <div className="rt">
      <header className="rt-head" data-tauri-drag-region>
        <span className="rt-title">회고</span>
        <div className="rt-tabs">
          <Button
            variant={tab === "retro" ? "default" : "outline"}
            size="sm"
            className="gap-1.5 rounded-full"
            aria-pressed={tab === "retro"}
            onClick={() => setTab("retro")}
          >
            <Sparkles className="size-3.5" />
            회고
          </Button>
          <Button
            variant={tab === "archive" ? "default" : "outline"}
            size="sm"
            className="gap-1.5 rounded-full"
            aria-pressed={tab === "archive"}
            onClick={() => setTab("archive")}
          >
            <Archive className="size-3.5" />
            보관함
          </Button>
        </div>
      </header>

      {tab === "retro" ? <RetroTab /> : <ArchiveTab />}
    </div>
  );
}

/** 회고 탭: 기간 피커 → 완료 todo 타임라인 + impact/regret 태깅 + 랭킹 집계. */
function RetroTab() {
  const [period, setPeriod] = useState<Period>(7);
  const start = daysAgo(period - 1);
  const end = localToday();
  const completed = useCompleted(start, end);
  const setImpact = useSetSignalImpact();
  const setRegret = useSetSignalRegret();
  const lifeWheelTagsQ = useLifeWheelTags();
  const lifeWheelTags = lifeWheelTagsQ.data ?? [];
  const items = useMemo(() => completed.data ?? [], [completed.data]);

  // 랭킹 집계(로컬 — 자동화 아님): 사람이 단 impact/regret만 모은다.
  const impactful = useMemo(() => items.filter((s) => s.impactHigh), [items]);
  const wasteful = useMemo(() => items.filter((s) => s.regret), [items]);

  // 완료일별 그룹(내림차순 — 쿼리가 정렬해 주므로 순서 보존).
  const groups = useMemo(() => {
    const map = new Map<string, WorkSignal[]>();
    for (const s of items) {
      const key = s.todayDoneAt ?? "—";
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div className="rt-scroll">
      <div className="rt-periods">
        {PERIODS.map((p) => (
          <Button
            key={p.value}
            variant="outline"
            size="sm"
            aria-pressed={period === p.value}
            className={cn(
              "rounded-full",
              period === p.value &&
                "border-wr-accent bg-wr-accent-soft text-wr-accent hover:bg-wr-accent-soft",
            )}
            onClick={() => setPeriod(p.value)}
          >
            {p.label}
          </Button>
        ))}
        <span className="rt-range">
          {md(start)} – {md(end)}
        </span>
      </div>

      {completed.isError && (
        <div className="rt-hint">
          집계를 불러오지 못했습니다: {(completed.error as Error).message}
        </div>
      )}

      {/* 랭킹 집계 */}
      <div className="rt-rank">
        <RankCard
          icon={<Sparkles className="size-4" />}
          title="고임팩트"
          tone="impact"
          items={impactful}
        />
        <RankCard
          icon={<ThumbsDown className="size-4" />}
          title="하지말걸"
          tone="regret"
          items={wasteful}
        />
      </div>

      {/* 완료 todo 타임라인 */}
      <section className="rt-sec">
        <div className="rt-sec-head">
          <CheckCircle2 className="text-wr-subtle size-4" />
          <span className="rt-sec-name">완료한 일</span>
          <span className="rt-sec-count">{items.length}</span>
        </div>
        {items.length === 0 ? (
          <div className="rt-hint">이 기간에 완료한 항목이 없습니다.</div>
        ) : (
          groups.map(([date, rows]) => (
            <div key={date} className="rt-group">
              <div className="rt-group-date">{md(date)}</div>
              <div className="rt-group-items">
                {rows.map((s) => (
                  <div key={s.id} className="rt-item">
                    <div className="rt-item-body">
                      <div className="rt-item-ttl">{s.title}</div>
                      <KindAreaChips target={s} tags={lifeWheelTags} />
                    </div>
                    <div className="rt-item-tags">
                      <button
                        type="button"
                        className={cn("rt-tag-btn impact", s.impactHigh && "on")}
                        title="고임팩트 ⭐"
                        disabled={setImpact.isPending}
                        onClick={() => setImpact.mutate({ id: s.id, value: !s.impactHigh })}
                      >
                        <Sparkles className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className={cn("rt-tag-btn regret", s.regret && "on")}
                        title="하지말걸"
                        disabled={setRegret.isPending}
                        onClick={() => setRegret.mutate({ id: s.id, value: !s.regret })}
                      >
                        <ThumbsDown className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

/** 랭킹 카드(고임팩트 / 하지말걸 목록). */
function RankCard({
  icon,
  title,
  tone,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  tone: "impact" | "regret";
  items: WorkSignal[];
}) {
  return (
    <div className={`rt-rank-card ${tone}`}>
      <div className="rt-rank-head">
        {icon}
        <span className="rt-rank-title">{title}</span>
        <span className="rt-rank-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="rt-rank-empty">아직 없음. 아래 목록에서 태깅하세요.</div>
      ) : (
        <ol className="rt-rank-list">
          {items.map((s) => (
            <li key={s.id} className="rt-rank-item">
              {s.title}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 보관함 탭: archived + snoozed 열람 + 복원. */
function ArchiveTab() {
  const list = useArchivedSnoozed();
  const restore = useRestoreSignal();
  const lifeWheelTagsQ = useLifeWheelTags();
  const lifeWheelTags = lifeWheelTagsQ.data ?? [];
  const items = list.data ?? [];

  return (
    <div className="rt-scroll">
      {list.isError && (
        <div className="rt-hint">목록을 불러오지 못했습니다: {(list.error as Error).message}</div>
      )}
      {items.length === 0 && !list.isError && (
        <div className="rt-hint">보관(archived)·미루기(snoozed)된 항목이 없습니다.</div>
      )}
      {items.map((s) => (
        <div key={s.id} className="rt-arc-item">
          <div className="rt-arc-body">
            <div className="rt-item-ttl">{s.title}</div>
            <div className="rt-arc-meta">
              <span className={`rt-arc-badge ${s.status}`}>
                {s.status === "archived" ? "보관됨" : "미룸"}
              </span>
              {s.status === "snoozed" && s.snoozeUntil && (
                <span className="rt-arc-sub">복귀 {md(s.snoozeUntil)}</span>
              )}
              <KindAreaChips target={s} tags={lifeWheelTags} />
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5 rounded-full"
            title="복원"
            disabled={restore.isPending}
            onClick={() => restore.mutate(s.id)}
          >
            <RotateCcw className="size-3.5" />
            복원
          </Button>
        </div>
      ))}
    </div>
  );
}
