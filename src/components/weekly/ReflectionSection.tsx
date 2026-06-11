// src/components/weekly/ReflectionSection.tsx
import { CheckCircle2, ThumbsDown, ThumbsUp } from "lucide-react";

import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";
import { KindAreaChips } from "@/components/board/LifeWheelPalette";
import { cn } from "@/components/ui/cn";
import { useSetSignalImpact, useSetSignalRegret } from "@/lib/query";
import { monthDay } from "@/lib/weekRange";

interface Props {
  items: WorkSignal[]; // 선택 주 완료 신호(todayDoneAt DESC)
  tags: LifeWheelTagConfig[];
}

/** 회고 랭크 카드 페어(좋아요/싫어요) — 대시보드 칼럼용. */
export function ReflectionRank({ items }: Pick<Props, "items">) {
  const impactful = items.filter((s) => s.impactHigh);
  const wasteful = items.filter((s) => s.regret);

  return (
    <div className="wk-rank">
      <RankCard
        icon={<ThumbsUp className="size-4" />}
        title="좋아요"
        tone="impact"
        items={impactful}
      />
      <RankCard
        icon={<ThumbsDown className="size-4" />}
        title="싫어요"
        tone="regret"
        items={wasteful}
      />
    </div>
  );
}

/** 이 주 완료한 일 목록(날짜 그룹 + 임팩트/후회 태깅) — 회고 칼럼용. */
export function CompletedList({ items, tags }: Props) {
  const setImpact = useSetSignalImpact();
  const setRegret = useSetSignalRegret();

  const groupsMap = new Map<string, WorkSignal[]>();
  for (const s of items) {
    const key = s.todayDoneAt ?? "—";
    const arr = groupsMap.get(key) ?? [];
    arr.push(s);
    groupsMap.set(key, arr);
  }
  const groups = [...groupsMap.entries()];

  return (
    <section className="wk-sec">
      <div className="wk-sec-head">
        <CheckCircle2 className="text-wr-subtle size-4" />
        <span className="wk-sec-name">완료한 일</span>
        <span className="wk-sec-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="wk-hint">이 주에 완료한 항목이 없습니다.</div>
      ) : (
        groups.map(([date, rows]) => (
          <div key={date} className="wk-group">
            <div className="wk-group-date">{monthDay(date)}</div>
            <div className="wk-group-items">
              {rows.map((s) => (
                <div key={s.id} className="wk-item">
                  <div className="wk-item-body">
                    <span className="wk-item-ttl">{s.title}</span>
                    <KindAreaChips target={s} tags={tags} />
                  </div>
                  <div className="wk-item-tags">
                    <button
                      type="button"
                      className={cn("wk-tag-btn impact", s.impactHigh && "on")}
                      title="좋아요"
                      aria-label="좋아요 토글"
                      aria-pressed={!!s.impactHigh}
                      disabled={setImpact.isPending}
                      onClick={() => setImpact.mutate({ id: s.id, value: !s.impactHigh })}
                    >
                      <ThumbsUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      className={cn("wk-tag-btn regret", s.regret && "on")}
                      title="싫어요"
                      aria-label="싫어요 토글"
                      aria-pressed={!!s.regret}
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
  );
}

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
    <div className={`wk-rank-card ${tone}`}>
      <div className="wk-rank-head">
        {icon}
        <span className="wk-rank-title">{title}</span>
        <span className="wk-rank-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="wk-rank-empty">아직 없음. 완료 목록에서 태깅하세요.</div>
      ) : (
        <ol className="wk-rank-list">
          {items.map((s) => (
            <li key={s.id} className="wk-rank-item">
              {s.title}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
