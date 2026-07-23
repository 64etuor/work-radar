import { Quote, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { BookQuote } from "@/bindings";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAddBookQuote, useDeleteBookQuote } from "@/lib/query";

/** 발췌 섹션 — 드래프트 로컬 소유(부모의 `key={book.id}` 리마운트로 책 전환 시 리셋). */
export function BookQuoteSection({ bookId, quotes }: { bookId: string; quotes: BookQuote[] }) {
  const addQuote = useAddBookQuote();
  const deleteQuote = useDeleteBookQuote();
  const [quoteDraft, setQuoteDraft] = useState("");
  const [pageDraft, setPageDraft] = useState("");
  const [thoughtDraft, setThoughtDraft] = useState("");

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
  );
}
