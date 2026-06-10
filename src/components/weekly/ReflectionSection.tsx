// src/components/weekly/ReflectionSection.tsx
import { CheckCircle2, Sparkles, ThumbsDown } from "lucide-react";
import { useMemo } from "react";

import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";
import { KindAreaChips } from "@/components/board/LifeWheelPalette";
import { cn } from "@/components/ui/cn";
import { useSetSignalImpact, useSetSignalRegret } from "@/lib/query";

function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

interface Props {
  items: WorkSignal[]; // 선택 주 완료 신호(todayDoneAt DESC)
  tags: LifeWheelTagConfig[];
}

export function ReflectionSection({ items, tags }: Props) {
  const setImpact = useSetSignalImpact();
  const setRegret = useSetSignalRegret();

  const impactful = useMemo(() => items.filter((s) => s.impactHigh), [items]);
  const wasteful = useMemo(() => items.filter((s) => s.regret), [items]);
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
    <div className="wk-reflect">
      <div className="wk-rank">
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
              <div className="wk-group-date">{md(date)}</div>
              <div className="wk-group-items">
                {rows.map((s) => (
                  <div key={s.id} className="wk-item">
                    <div className="wk-item-body">
                      <div className="wk-item-ttl">{s.title}</div>
                      <KindAreaChips target={s} tags={tags} />
                    </div>
                    <div className="wk-item-tags">
                      <button
                        type="button"
                        className={cn("wk-tag-btn impact", s.impactHigh && "on")}
                        title="고임팩트 ⭐"
                        aria-label="고임팩트 토글"
                        aria-pressed={!!s.impactHigh}
                        disabled={setImpact.isPending}
                        onClick={() => setImpact.mutate({ id: s.id, value: !s.impactHigh })}
                      >
                        <Sparkles className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className={cn("wk-tag-btn regret", s.regret && "on")}
                        title="하지말걸"
                        aria-label="하지말걸 토글"
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
    </div>
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
        <div className="wk-rank-empty">아직 없음. 아래 목록에서 태깅하세요.</div>
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
