import { Pencil } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { Book } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateBook } from "@/lib/query";

import {
  type BookDetailsDraft,
  bookDetailsDraft,
  buildBookDetailsPatch,
} from "./readingEditDrafts";

export function BookDetailsSection({ book }: { book: Book }) {
  const updateBook = useUpdateBook();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => bookDetailsDraft(book));

  const field = (key: keyof BookDetailsDraft, value: string | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const cancel = () => {
    setDraft(bookDetailsDraft(book));
    setEditing(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.title.trim().length === 0) return;
    updateBook.mutate(buildBookDetailsPatch(book.id, draft), {
      onSuccess: () => setEditing(false),
    });
  };

  return (
    <section className="rd-detail-section" aria-label="책 정보">
      <div className="rd-section-title-row">
        <h3 className="typo-label-lg">책 정보</h3>
        {!editing && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(bookDetailsDraft(book));
              setEditing(true);
            }}
          >
            <Pencil size={13} aria-hidden />
            수정
          </Button>
        )}
      </div>
      {editing ? (
        <form className="rd-book-edit" onSubmit={submit}>
          <label className="rd-edit-field">
            <span className="typo-label-sm">제목</span>
            <Input
              value={draft.title}
              required
              onChange={(event) => field("title", event.target.value)}
            />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">부제</span>
            <Input
              value={draft.subtitle}
              onChange={(event) => field("subtitle", event.target.value)}
            />
          </label>
          <label className="rd-edit-field rd-edit-wide">
            <span className="typo-label-sm">저자 (쉼표로 구분)</span>
            <Input
              value={draft.authors}
              onChange={(event) => field("authors", event.target.value)}
            />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">출판사</span>
            <Input
              value={draft.publisher}
              onChange={(event) => field("publisher", event.target.value)}
            />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">출간일</span>
            <Input
              value={draft.publishedDate}
              placeholder="YYYY-MM-DD"
              onChange={(event) => field("publishedDate", event.target.value)}
            />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">전체 페이지</span>
            <Input
              type="number"
              min={1}
              value={draft.pageCount}
              onChange={(event) => field("pageCount", event.target.value)}
            />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">현재 페이지</span>
            <Input
              type="number"
              min={0}
              required
              value={draft.currentPage}
              onChange={(event) => field("currentPage", event.target.value)}
            />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">읽기 시작일</span>
            <Input
              type="date"
              value={draft.startedOn}
              onChange={(event) => field("startedOn", event.target.value)}
            />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">완독일</span>
            <Input
              type="date"
              value={draft.finishedOn}
              onChange={(event) => field("finishedOn", event.target.value)}
            />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">ISBN-13</span>
            <Input value={draft.isbn13} onChange={(event) => field("isbn13", event.target.value)} />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">ISBN-10</span>
            <Input value={draft.isbn10} onChange={(event) => field("isbn10", event.target.value)} />
          </label>
          <label className="rd-edit-field">
            <span className="typo-label-sm">언어</span>
            <Input
              value={draft.language}
              onChange={(event) => field("language", event.target.value)}
            />
          </label>
          <label className="rd-edit-field rd-edit-wide">
            <span className="typo-label-sm">분류 (쉼표로 구분)</span>
            <Input
              value={draft.categories}
              onChange={(event) => field("categories", event.target.value)}
            />
          </label>
          <label className="rd-edit-field rd-edit-wide">
            <span className="typo-label-sm">표지 URL</span>
            <Input
              type="url"
              value={draft.coverUrl}
              onChange={(event) => field("coverUrl", event.target.value)}
            />
          </label>
          <label className="rd-edit-field rd-edit-wide">
            <span className="typo-label-sm">설명</span>
            <Textarea
              rows={3}
              value={draft.description}
              onChange={(event) => field("description", event.target.value)}
            />
          </label>
          <label className="rd-favorite-check typo-label-md">
            <input
              type="checkbox"
              checked={draft.favorite}
              onChange={(event) => field("favorite", event.target.checked)}
            />
            즐겨찾기
          </label>
          <div className="rd-edit-actions">
            <Button
              type="submit"
              size="sm"
              disabled={updateBook.isPending || draft.title.trim().length === 0}
            >
              저장
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              취소
            </Button>
          </div>
        </form>
      ) : (
        <>
          {book.description && (
            <p className="typo-body-md rd-book-description">{book.description}</p>
          )}
          <div className="rd-book-facts typo-label-sm rd-card-dim">
            {book.categories.length > 0 && <span>{book.categories.join(", ")}</span>}
            {book.language && <span>언어 {book.language}</span>}
            {book.startedOn && <span>시작 {book.startedOn}</span>}
            {book.finishedOn && <span>완독 {book.finishedOn}</span>}
            {book.favorite && <span>즐겨찾기</span>}
          </div>
        </>
      )}
    </section>
  );
}
