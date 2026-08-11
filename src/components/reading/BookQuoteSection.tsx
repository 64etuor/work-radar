import { Pencil, Quote, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { BookQuote } from "@/bindings";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAddBookQuote, useDeleteBookQuote, useUpdateBookQuote } from "@/lib/query";

import { type BookQuoteDraft, buildBookQuoteUpdate } from "./readingEditDrafts";

/** 발췌 섹션 — 드래프트 로컬 소유(부모의 `key={book.id}` 리마운트로 책 전환 시 리셋). */
export function BookQuoteSection({ bookId, quotes }: { bookId: string; quotes: BookQuote[] }) {
  const addQuote = useAddBookQuote();
  const deleteQuote = useDeleteBookQuote();
  const updateQuote = useUpdateBookQuote();
  const [quoteDraft, setQuoteDraft] = useState("");
  const [pageDraft, setPageDraft] = useState("");
  const [thoughtDraft, setThoughtDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<BookQuoteDraft | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (quoteDraft.trim() === "") return;
    const page = Number(pageDraft);
    addQuote.mutate(
      {
        bookId,
        quote: quoteDraft.trim(),
        page: Number.isInteger(page) && page >= 0 && pageDraft.trim() !== "" ? page : null,
        thought: thoughtDraft.trim() === "" ? null : thoughtDraft.trim(),
        favorite: null,
      },
      {
        onSuccess: () => {
          setQuoteDraft("");
          setPageDraft("");
          setThoughtDraft("");
        },
      },
    );
  };

  return (
    <section className="rd-detail-section" aria-label="발췌">
      <h3 className="typo-label-lg">
        발췌 <Quote size={12} aria-hidden />
      </h3>
      <form className="rd-quote-form" onSubmit={submit}>
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
            value={pageDraft}
            onChange={(e) => setPageDraft(e.target.value)}
          />
          <Input
            placeholder="내 생각 (선택)"
            value={thoughtDraft}
            onChange={(e) => setThoughtDraft(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={addQuote.isPending || quoteDraft.trim() === ""}>
            채록
          </Button>
        </div>
      </form>
      {quotes.length === 0 ? (
        <EmptyState className="rd-empty">아직 채록한 문장이 없습니다.</EmptyState>
      ) : (
        <ul className="rd-quote-list">
          {quotes.map((q) => (
            <li key={q.id} className="rd-quote-item">
              {editingId === q.id && editDraft != null ? (
                <form
                  className="rd-quote-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (editDraft.quote.trim().length === 0) return;
                    updateQuote.mutate(buildBookQuoteUpdate(q.id, editDraft), {
                      onSuccess: () => {
                        setEditingId(null);
                        setEditDraft(null);
                      },
                    });
                  }}
                >
                  <label className="rd-edit-field typo-label-sm">
                    발췌문
                    <Textarea
                      rows={2}
                      value={editDraft.quote}
                      onChange={(event) =>
                        setEditDraft((current) =>
                          current == null ? current : { ...current, quote: event.target.value },
                        )
                      }
                    />
                  </label>
                  <div className="rd-quote-form-row">
                    <label className="rd-edit-field typo-label-sm">
                      페이지
                      <Input
                        type="number"
                        min={0}
                        value={editDraft.page}
                        onChange={(event) =>
                          setEditDraft((current) =>
                            current == null ? current : { ...current, page: event.target.value },
                          )
                        }
                      />
                    </label>
                    <label className="rd-edit-field typo-label-sm">
                      내 생각
                      <Input
                        value={editDraft.thought}
                        onChange={(event) =>
                          setEditDraft((current) =>
                            current == null ? current : { ...current, thought: event.target.value },
                          )
                        }
                      />
                    </label>
                    <div className="rd-edit-actions">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={updateQuote.isPending || editDraft.quote.trim().length === 0}
                      >
                        저장
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingId(null);
                          setEditDraft(null);
                        }}
                      >
                        취소
                      </Button>
                    </div>
                  </div>
                  <label className="rd-favorite-check typo-label-sm">
                    <input
                      type="checkbox"
                      checked={editDraft.favorite}
                      onChange={(event) =>
                        setEditDraft((current) =>
                          current == null
                            ? current
                            : { ...current, favorite: event.target.checked },
                        )
                      }
                    />
                    즐겨찾기
                  </label>
                </form>
              ) : (
                <>
                  <blockquote className="typo-body-md">“{q.quote}”</blockquote>
                  <div className="rd-quote-meta typo-label-sm rd-card-dim">
                    {q.page != null && <span>p.{q.page}</span>}
                    {q.thought && <span>{q.thought}</span>}
                    {q.favorite && <span>즐겨찾기</span>}
                    <button
                      type="button"
                      className="rd-icon-btn"
                      aria-label="발췌 수정"
                      onClick={() => {
                        setEditingId(q.id);
                        setEditDraft({
                          quote: q.quote,
                          page: q.page?.toString() ?? "",
                          thought: q.thought ?? "",
                          favorite: q.favorite,
                        });
                      }}
                    >
                      <Pencil size={13} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="rd-icon-btn"
                      aria-label="발췌 삭제"
                      onClick={() => deleteQuote.mutate(q.id)}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
