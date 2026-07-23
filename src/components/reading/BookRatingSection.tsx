import { useState } from "react";

import type { Book } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateBook } from "@/lib/query";

import { emptyBookPatch } from "./readingFormat";

/**
 * 평점(0..10)·리뷰 섹션 — 서버값은 마운트 시 한 번 시딩(부모의 `key={book.id}` 리마운트).
 * 입력 중 리페치가 드래프트를 덮지 않는다(diet 다이얼로그 keyed 시딩 선례).
 */
export function BookRatingSection({ book }: { book: Book }) {
  const updateBook = useUpdateBook();
  const [ratingDraft, setRatingDraft] = useState(book.rating != null ? String(book.rating) : "");
  const [reviewDraft, setReviewDraft] = useState(book.review ?? "");

  const save = () => {
    const rating = ratingDraft.trim() === "" ? null : Number(ratingDraft);
    if (rating != null && (!Number.isFinite(rating) || rating < 0 || rating > 10)) return;
    updateBook.mutate({
      ...emptyBookPatch(book.id),
      rating,
      clearRating: rating == null,
      review: reviewDraft.trim() === "" ? null : reviewDraft,
      clearReview: reviewDraft.trim() === "",
    });
  };

  return (
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
        <Button size="sm" variant="outline" onClick={save} disabled={updateBook.isPending}>
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
  );
}
