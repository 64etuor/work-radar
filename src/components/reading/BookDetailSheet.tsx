import { BookOpen, Trash2 } from "lucide-react";
import { useState } from "react";

import type { ReadingStatus } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useBookDetail, useDeleteBook, useSetBookStatus } from "@/lib/query";

import { BookQuoteSection } from "./BookQuoteSection";
import { BookRatingSection } from "./BookRatingSection";
import { BookSessionSection } from "./BookSessionSection";
import { RatingStars } from "./BookShelf";
import { authorsLabel, progressPct, READING_STATUS_LABEL } from "./readingFormat";

const STATUS_ORDER: readonly ReadingStatus[] = ["to_read", "reading", "finished", "abandoned"];

/**
 * 책 상세 시트 — 헤더/상태 전이/진행바 + 섹션 컴포넌트 합성.
 * 본문을 `key={book.id}`로 마운트해 책 전환 시 섹션 드래프트가 자동 리셋된다
 * (keyed 리마운트 시딩 — effect 동기화 0, diet 다이얼로그 선례).
 */
export function BookDetailSheet({
  bookId,
  onClose,
  today,
}: {
  bookId: string | null;
  onClose: () => void;
  today: string;
}) {
  const { data: detail } = useBookDetail(bookId);
  const setStatus = useSetBookStatus();
  const deleteBook = useDeleteBook();
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (bookId == null) return null;
  const book = detail?.book ?? null;
  const pct = book != null ? progressPct(book.currentPage, book.pageCount) : null;

  return (
    <Sheet open={bookId != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="rd-detail">
        {book == null || detail == null ? (
          <SheetTitle>불러오는 중…</SheetTitle>
        ) : (
          <div className="rd-detail-scroll" key={book.id}>
            <header className="rd-detail-head">
              {book.coverUrl ? (
                <img className="rd-detail-cover" src={book.coverUrl} alt="" />
              ) : (
                <span className="rd-detail-cover rd-card-cover-fallback" aria-hidden>
                  <BookOpen size={24} />
                </span>
              )}
              <div className="rd-detail-copy">
                <SheetTitle className="typo-title-sm">{book.title}</SheetTitle>
                {book.subtitle && <div className="typo-body-md rd-card-dim">{book.subtitle}</div>}
                <div className="typo-label-sm rd-card-dim">
                  {[
                    authorsLabel(book.authors),
                    book.publisher,
                    book.publishedDate,
                    book.pageCount != null ? `${book.pageCount}p` : null,
                    book.isbn13,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {book.rating != null && book.rating > 0 && <RatingStars rating={book.rating} />}
              </div>
            </header>

            <div className="rd-detail-status" role="group" aria-label="독서 상태">
              {STATUS_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={cn("rd-status-btn typo-label-md", book.status === s && "is-active")}
                  disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate({ id: book.id, status: s, date: today })}
                >
                  {READING_STATUS_LABEL[s]}
                </button>
              ))}
            </div>

            {book.status === "reading" && (
              <div className="rd-detail-progress">
                <span className="rd-progress-bar">
                  <span className="rd-progress-fill" style={{ width: `${pct ?? 0}%` }} />
                </span>
                <span className="typo-label-sm rd-card-dim">
                  {pct != null
                    ? `${pct}% · ${book.currentPage}/${book.pageCount}p`
                    : `${book.currentPage}p`}
                </span>
              </div>
            )}

            <BookSessionSection bookId={book.id} today={today} sessions={detail.sessions} />
            <BookRatingSection book={book} />
            <BookQuoteSection bookId={book.id} quotes={detail.quotes} />

            <footer className="rd-detail-footer">
              {confirmDelete ? (
                <div className="rd-delete-confirm">
                  <span className="typo-label-md">세션·발췌까지 함께 지워진다.</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={deleteBook.isPending}
                    onClick={() =>
                      deleteBook.mutate(book.id, {
                        onSuccess: () => onClose(),
                      })
                    }
                  >
                    정말 삭제
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                    취소
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={13} aria-hidden />책 삭제
                </Button>
              )}
            </footer>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
