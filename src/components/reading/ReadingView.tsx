import "./ReadingView.css";

import { BookOpen, Flame, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import type { Book } from "@/bindings";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { localToday, useBooks, useReadingStats } from "@/lib/query";
import { useViewSessionState } from "@/lib/useViewSessionState";

import { BookDetailSheet } from "./BookDetailSheet";
import { BookSearchDialog } from "./BookSearchDialog";
import { BookCard, TierTable } from "./BookShelf";
import { yearOf } from "./readingFormat";
import { ReadingGoalCard } from "./ReadingGoalCard";
import { ReadingHeatmap } from "./ReadingHeatmap";

/**
 * 독서 기록 뷰 — 사용자 옵시디언 독서 대시보드의 앱 네이티브 이식(+세션 기반 개선).
 * 데이터는 전부 로컬 SQLite(reading 도메인), 카탈로그 검색만 Rust 고정 provider GET.
 * 등록/기록은 Hermes(MCP)로도 가능 — 이 표면은 열람 + 직접 편집을 맡는다.
 */
export function ReadingView() {
  const today = localToday();
  const year = yearOf(today);

  const [searchOpen, setSearchOpen] = useState(false);
  const [detailId, setDetailId] = useViewSessionState<string | null>("reading.detail", null);

  const { data: stats } = useReadingStats(year, today);
  const { data: books } = useBooks(null, "");

  const shelves = useMemo(() => {
    const all = books ?? [];
    const byRecency = (list: Book[]) => list; // list_books가 updated_at DESC 정렬을 보장.
    return {
      reading: byRecency(all.filter((b) => b.status === "reading")),
      toRead: byRecency(all.filter((b) => b.status === "to_read")),
      finished: [...all.filter((b) => b.status === "finished")].sort((a, b) =>
        (b.finishedOn ?? "").localeCompare(a.finishedOn ?? ""),
      ),
      abandoned: byRecency(all.filter((b) => b.status === "abandoned")),
    };
  }, [books]);

  const kpis = [
    { label: "전체", value: stats?.totalBooks ?? 0 },
    { label: "완독", value: stats?.finishedTotal ?? 0 },
    { label: "읽는 중", value: stats?.readingCount ?? 0 },
    { label: "읽을 책", value: stats?.toReadCount ?? 0 },
    {
      label: "평균 별점",
      value: stats?.avgRating != null ? stats.avgRating.toFixed(1) : "–",
    },
    { label: "총 페이지", value: (stats?.totalPagesRead ?? 0).toLocaleString() },
  ];

  return (
    <div className="rd">
      <header className="rd-head">
        <div className="rd-head-copy">
          <span className="typo-mono-label">READING</span>
          <h1 className="typo-title-md">독서</h1>
          <p className="typo-body-md">읽을 책을 쌓고, 세션으로 진행을 남기고, 완독을 트래킹한다.</p>
        </div>
        <div className="rd-head-actions">
          {(stats?.streakDays ?? 0) > 0 && (
            <span className="rd-streak typo-label-md" title="연속 독서 일수">
              <Flame size={14} aria-hidden />
              {stats?.streakDays}일 연속
            </span>
          )}
          <Button onClick={() => setSearchOpen(true)}>
            <Plus size={15} aria-hidden />책 추가
          </Button>
        </div>
      </header>

      <div className="rd-body">
        <section className="rd-kpis" aria-label="독서 통계">
          {kpis.map((k) => (
            <div key={k.label} className="rd-kpi">
              <div className="rd-kpi-value typo-title-sm">{k.value}</div>
              <div className="rd-kpi-label typo-label-sm">{k.label}</div>
            </div>
          ))}
        </section>

        <ReadingGoalCard stats={stats ?? null} year={year} today={today} />

        <section className="rd-shelf" aria-label="읽는 중">
          <h2 className="typo-label-lg rd-shelf-title">
            읽는 중 <span className="rd-shelf-count">{shelves.reading.length}</span>
          </h2>
          {shelves.reading.length === 0 ? (
            <EmptyState className="rd-empty">
              읽는 중인 책이 없다 — 읽을 책에서 한 권 시작하기.
            </EmptyState>
          ) : (
            <div className="rd-cards">
              {shelves.reading.map((b) => (
                <BookCard key={b.id} book={b} onOpen={() => setDetailId(b.id)} />
              ))}
            </div>
          )}
        </section>

        <section className="rd-shelf" aria-label="읽을 책">
          <h2 className="typo-label-lg rd-shelf-title">
            읽을 책 <span className="rd-shelf-count">{shelves.toRead.length}</span>
          </h2>
          {shelves.toRead.length === 0 ? (
            <EmptyState className="rd-empty">
              계획된 책이 없다 — 우상단 &ldquo;책 추가&rdquo;로 등록.
            </EmptyState>
          ) : (
            <div className="rd-cards">
              {shelves.toRead.map((b) => (
                <BookCard key={b.id} book={b} onOpen={() => setDetailId(b.id)} />
              ))}
            </div>
          )}
        </section>

        <section className="rd-shelf" aria-label="완독">
          <h2 className="typo-label-lg rd-shelf-title">
            완독 <span className="rd-shelf-count">{shelves.finished.length}</span>
          </h2>
          {shelves.finished.length === 0 ? (
            <EmptyState className="rd-empty">아직 완독한 책이 없다.</EmptyState>
          ) : (
            <div className="rd-cards">
              {shelves.finished.map((b) => (
                <BookCard key={b.id} book={b} onOpen={() => setDetailId(b.id)} />
              ))}
            </div>
          )}
        </section>

        {shelves.finished.length > 0 && (
          <section className="rd-shelf" aria-label="명예의 전당">
            <h2 className="typo-label-lg rd-shelf-title">명예의 전당</h2>
            <TierTable books={shelves.finished} onOpen={(id) => setDetailId(id)} />
          </section>
        )}

        <section className="rd-shelf" aria-label="독서 히트맵">
          <h2 className="typo-label-lg rd-shelf-title">{year}년 독서 히트맵</h2>
          <ReadingHeatmap days={stats?.heatmap ?? []} year={year} today={today} />
        </section>

        {shelves.abandoned.length > 0 && (
          <section className="rd-shelf" aria-label="중단한 책">
            <h2 className="typo-label-lg rd-shelf-title">
              중단 <span className="rd-shelf-count">{shelves.abandoned.length}</span>
            </h2>
            <div className="rd-cards">
              {shelves.abandoned.map((b) => (
                <BookCard key={b.id} book={b} onOpen={() => setDetailId(b.id)} />
              ))}
            </div>
          </section>
        )}

        {(books ?? []).length === 0 && (
          <EmptyState className="rd-empty rd-empty-hero" title="서재가 비어 있다">
            <span className="rd-empty-icon" aria-hidden>
              <BookOpen size={28} />
            </span>
            &ldquo;책 추가&rdquo;로 제목이나 ISBN을 검색해 첫 책을 등록해 보자.
          </EmptyState>
        )}
      </div>

      <BookSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        today={today}
        onOpenExisting={setDetailId}
      />
      <BookDetailSheet bookId={detailId} onClose={() => setDetailId(null)} today={today} />
    </div>
  );
}
