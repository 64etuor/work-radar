import { BookOpen } from "lucide-react";

import type { Book } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";

import {
  authorsLabel,
  progressPct,
  RATING_TIERS,
  READING_STATUS_LABEL,
  starFills,
} from "./readingFormat";

/** 별 5개(부분 채움) — 옵시디언 rating/2 규칙. */
export function RatingStars({ rating }: { rating: number }) {
  return (
    <span className="rd-stars" role="img" aria-label={`별점 ${rating}/10`}>
      {starFills(rating).map((fill, i) => (
        <span key={i} className="rd-star" aria-hidden>
          <span className="rd-star-bg">★</span>
          <span className="rd-star-fill" style={{ width: `${fill}%` }}>
            ★
          </span>
        </span>
      ))}
      <span className="rd-stars-num typo-label-sm">{rating}/10</span>
    </span>
  );
}

/** 서가 카드 — 표지 + 제목/저자 + 상태별 메타(진행바/완독일/별점). */
export function BookCard({ book, onOpen }: { book: Book; onOpen: () => void }) {
  const pct = progressPct(book.currentPage, book.pageCount);
  return (
    <button type="button" className="rd-card" onClick={onOpen}>
      {book.coverUrl ? (
        <img className="rd-card-cover" src={book.coverUrl} alt="" loading="lazy" />
      ) : (
        <span className="rd-card-cover rd-card-cover-fallback" aria-hidden>
          <BookOpen size={20} />
        </span>
      )}
      <span className="rd-card-body">
        <span className="rd-card-title typo-body-strong">{book.title}</span>
        {book.authors.length > 0 && (
          <span className="rd-card-author typo-label-sm">{authorsLabel(book.authors)}</span>
        )}
        {book.status === "reading" && (
          <span className="rd-card-progress">
            <span className="rd-progress-bar">
              <span className="rd-progress-fill" style={{ width: `${pct ?? 0}%` }} />
            </span>
            <span className="rd-progress-label typo-label-sm">
              {pct != null
                ? `${pct}% · ${book.currentPage}/${book.pageCount}p`
                : `${book.currentPage}p`}
            </span>
          </span>
        )}
        {book.status === "finished" && (
          <span className="rd-card-meta">
            {book.rating != null && book.rating > 0 ? (
              <RatingStars rating={book.rating} />
            ) : (
              <span className="typo-label-sm rd-card-dim">별점 없음</span>
            )}
            {book.finishedOn && (
              <span className="typo-label-sm rd-card-dim">완독 {book.finishedOn}</span>
            )}
          </span>
        )}
        {book.status === "to_read" && book.categories.length > 0 && (
          <span className="typo-label-sm rd-card-dim">{book.categories.join(" · ")}</span>
        )}
        {book.status === "abandoned" && (
          <Badge variant="outline">{READING_STATUS_LABEL.abandoned}</Badge>
        )}
      </span>
    </button>
  );
}

/** 명예의 전당 — 완독 책을 별점 티어(S..D)로 묶는다(옵시디언 티어표 이식). */
export function TierTable({ books, onOpen }: { books: Book[]; onOpen: (id: string) => void }) {
  const rows = RATING_TIERS.map((tier) => ({
    tier,
    books: books
      .filter((b) => {
        const r = b.rating ?? 0;
        return r >= tier.min && r <= tier.max;
      })
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)),
  }));
  const unrated = books.filter((b) => (b.rating ?? 0) < 1);

  return (
    <div className="rd-tiers">
      {rows.map(({ tier, books: tierBooks }) => (
        <div key={tier.label} className="rd-tier-row">
          <div className={cn("rd-tier-label typo-title-sm", `rd-tier-${tier.label.toLowerCase()}`)}>
            {tier.label}
          </div>
          <div className="rd-tier-items">
            {tierBooks.length === 0 ? (
              <span className="rd-card-dim typo-label-sm">—</span>
            ) : (
              tierBooks.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="rd-tier-item"
                  onClick={() => onOpen(b.id)}
                >
                  {b.coverUrl && <img src={b.coverUrl} alt="" loading="lazy" />}
                  <span className="typo-label-md">{b.title}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ))}
      {unrated.length > 0 && (
        <div className="rd-tier-row">
          <div className="rd-tier-label rd-tier-none typo-title-sm">?</div>
          <div className="rd-tier-items">
            {unrated.map((b) => (
              <button
                key={b.id}
                type="button"
                className="rd-tier-item"
                onClick={() => onOpen(b.id)}
              >
                {b.coverUrl && <img src={b.coverUrl} alt="" loading="lazy" />}
                <span className="typo-label-md">{b.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
