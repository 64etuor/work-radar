import { BookOpen, Quote, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { ReadingStatus } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  useAddBookQuote,
  useBookDetail,
  useDeleteBook,
  useDeleteBookQuote,
  useDeleteReadingSession,
  useLogReadingSession,
  useSetBookStatus,
  useUpdateBook,
} from "@/lib/query";

import { RatingStars } from "./BookShelf";
import { authorsLabel, progressPct, READING_STATUS_LABEL } from "./readingFormat";

const STATUS_ORDER: readonly ReadingStatus[] = ["to_read", "reading", "finished", "abandoned"];

/** 책 상세 시트 — 상태 전이·평점/리뷰·세션 기록·인용 채록·삭제. */
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
  const updateBook = useUpdateBook();
  const logSession = useLogReadingSession();
  const deleteSession = useDeleteReadingSession();
  const addQuote = useAddBookQuote();
  const deleteQuote = useDeleteBookQuote();
  const deleteBook = useDeleteBook();

  // 편집 드래프트 — 책이 바뀔 때만 서버값으로 리싱크(입력 중 리페치가 덮지 않게).
  const [ratingDraft, setRatingDraft] = useState("");
  const [reviewDraft, setReviewDraft] = useState("");
  const [pageDraft, setPageDraft] = useState("");
  const [minutesDraft, setMinutesDraft] = useState("");
  const [sessionNote, setSessionNote] = useState("");
  const [quoteDraft, setQuoteDraft] = useState("");
  const [quotePage, setQuotePage] = useState("");
  const [thoughtDraft, setThoughtDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const book = detail?.book ?? null;

  useEffect(() => {
    setRatingDraft(book?.rating != null ? String(book.rating) : "");
    setReviewDraft(book?.review ?? "");
    setPageDraft("");
    setMinutesDraft("");
    setSessionNote("");
    setQuoteDraft("");
    setQuotePage("");
    setThoughtDraft("");
    setConfirmDelete(false);
    // book?.id로만 리싱크 — 같은 책의 리페치가 입력 중 드래프트를 덮지 않게 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.id]);

  if (bookId == null) return null;

  const pct = book != null ? progressPct(book.currentPage, book.pageCount) : null;

  const saveRating = () => {
    if (book == null) return;
    const rating = ratingDraft.trim() === "" ? null : Number(ratingDraft);
    if (rating != null && (!Number.isFinite(rating) || rating < 0 || rating > 10)) return;
    updateBook.mutate({
      id: book.id,
      title: null,
      subtitle: null,
      authors: null,
      publisher: null,
      publishedDate: null,
      isbn13: null,
      isbn10: null,
      pageCount: null,
      coverUrl: null,
      description: null,
      categories: null,
      language: null,
      rating,
      clearRating: rating == null,
      review: reviewDraft.trim() === "" ? null : reviewDraft,
      clearReview: reviewDraft.trim() === "",
      currentPage: null,
      favorite: null,
      startedOn: null,
      finishedOn: null,
    });
  };

  const submitSession = (e: FormEvent) => {
    e.preventDefault();
    if (book == null) return;
    const endPage = pageDraft.trim() === "" ? null : Number(pageDraft);
    const minutes = minutesDraft.trim() === "" ? null : Number(minutesDraft);
    if (endPage == null && minutes == null && sessionNote.trim() === "") return;
    logSession.mutate(
      {
        bookId: book.id,
        date: today,
        endPage: endPage != null && Number.isInteger(endPage) && endPage >= 0 ? endPage : null,
        minutes: minutes != null && Number.isInteger(minutes) && minutes > 0 ? minutes : null,
        note: sessionNote.trim() === "" ? null : sessionNote.trim(),
      },
      {
        onSuccess: () => {
          setPageDraft("");
          setMinutesDraft("");
          setSessionNote("");
        },
      },
    );
  };

  const submitQuote = (e: FormEvent) => {
    e.preventDefault();
    if (book == null || quoteDraft.trim() === "") return;
    const page = Number(quotePage);
    addQuote.mutate(
      {
        bookId: book.id,
        quote: quoteDraft.trim(),
        page: Number.isInteger(page) && page >= 0 && quotePage.trim() !== "" ? page : null,
        thought: thoughtDraft.trim() === "" ? null : thoughtDraft.trim(),
        favorite: null,
      },
      {
        onSuccess: () => {
          setQuoteDraft("");
          setQuotePage("");
          setThoughtDraft("");
        },
      },
    );
  };

  return (
    <Sheet open={bookId != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="rd-detail">
        {book == null ? (
          <SheetTitle>불러오는 중…</SheetTitle>
        ) : (
          <div className="rd-detail-scroll">
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

            <section className="rd-detail-section" aria-label="오늘 기록">
              <h3 className="typo-label-lg">세션 기록</h3>
              <form className="rd-session-form" onSubmit={submitSession}>
                <Input
                  type="number"
                  min={0}
                  placeholder="현재 페이지"
                  value={pageDraft}
                  onChange={(e) => setPageDraft(e.target.value)}
                />
                <Input
                  type="number"
                  min={1}
                  placeholder="분"
                  value={minutesDraft}
                  onChange={(e) => setMinutesDraft(e.target.value)}
                />
                <Input
                  placeholder="메모 (선택)"
                  value={sessionNote}
                  onChange={(e) => setSessionNote(e.target.value)}
                />
                <Button type="submit" size="sm" disabled={logSession.isPending}>
                  기록
                </Button>
              </form>
              {detail != null && detail.sessions.length > 0 && (
                <ul className="rd-session-list">
                  {detail.sessions.map((s) => (
                    <li key={s.id} className="rd-session-item typo-label-md">
                      <span>{s.date}</span>
                      <span className="rd-card-dim">
                        {[
                          s.endPage != null ? `~${s.endPage}p` : null,
                          s.minutes != null ? `${s.minutes}분` : null,
                          s.note,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <button
                        type="button"
                        className="rd-icon-btn"
                        aria-label="세션 삭제"
                        onClick={() => deleteSession.mutate(s.id)}
                      >
                        <Trash2 size={13} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rd-detail-section" aria-label="평점과 리뷰">
              <h3 className="typo-label-lg">평점 · 리뷰</h3>
              <div className="rd-rating-row">
                <Input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  placeholder="0–10"
                  value={ratingDraft}
                  onChange={(e) => setRatingDraft(e.target.value)}
                  aria-label="평점 (0-10)"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveRating}
                  disabled={updateBook.isPending}
                >
                  저장
                </Button>
              </div>
              <Textarea
                placeholder="한 줄 감상 또는 리뷰"
                value={reviewDraft}
                onChange={(e) => setReviewDraft(e.target.value)}
                rows={3}
              />
            </section>

            <section className="rd-detail-section" aria-label="발췌">
              <h3 className="typo-label-lg">
                발췌 <Quote size={12} aria-hidden />
              </h3>
              <form className="rd-quote-form" onSubmit={submitQuote}>
                <Textarea
                  placeholder="기억하고 싶은 문장"
                  value={quoteDraft}
                  onChange={(e) => setQuoteDraft(e.target.value)}
                  rows={2}
                />
                <div className="rd-quote-form-row">
                  <Input
                    type="number"
                    min={0}
                    placeholder="페이지"
                    value={quotePage}
                    onChange={(e) => setQuotePage(e.target.value)}
                  />
                  <Input
                    placeholder="내 생각 (선택)"
                    value={thoughtDraft}
                    onChange={(e) => setThoughtDraft(e.target.value)}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={addQuote.isPending || quoteDraft.trim() === ""}
                  >
                    채록
                  </Button>
                </div>
              </form>
              {detail != null && detail.quotes.length === 0 ? (
                <EmptyState className="rd-empty">아직 채록한 문장이 없다.</EmptyState>
              ) : (
                <ul className="rd-quote-list">
                  {(detail?.quotes ?? []).map((q) => (
                    <li key={q.id} className="rd-quote-item">
                      <blockquote className="typo-body-md">“{q.quote}”</blockquote>
                      <div className="rd-quote-meta typo-label-sm rd-card-dim">
                        {q.page != null && <span>p.{q.page}</span>}
                        {q.thought && <span>{q.thought}</span>}
                        <button
                          type="button"
                          className="rd-icon-btn"
                          aria-label="발췌 삭제"
                          onClick={() => deleteQuote.mutate(q.id)}
                        >
                          <Trash2 size={13} aria-hidden />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

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
