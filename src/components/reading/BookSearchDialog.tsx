import { BookOpen, Loader2, Search } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { CatalogBook, ReadingStatus } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { useAddBook, useCatalogSearch } from "@/lib/query";

import { authorsLabel } from "./readingFormat";

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** 카탈로그 검색 + 등록 다이얼로그. 검색 실패/미수록 도서는 수기 등록 폴백. */
export function BookSearchDialog({
  open,
  onOpenChange,
  today,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  today: string;
}) {
  const [query, setQuery] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualAuthor, setManualAuthor] = useState("");
  const [manualPages, setManualPages] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const debounced = useDebounced(query, 350);
  const search = useCatalogSearch(debounced);
  const addBook = useAddBook();

  // 닫힘 시 일회성 상태 리셋 — effect 대신 이벤트 지점에서(react-hooks/set-state-in-effect).
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setNotice(null);
      setManualMode(false);
    }
    onOpenChange(next);
  };

  const register = (candidate: CatalogBook, status: ReadingStatus) => {
    addBook.mutate(
      { ...candidate, status },
      {
        onSuccess: (result) => {
          if (!result.created) {
            setNotice(`이미 등록된 책이다: ${result.book.title}`);
            return;
          }
          handleOpenChange(false);
        },
      },
    );
  };

  const registerManual = (e: FormEvent) => {
    e.preventDefault();
    const title = manualTitle.trim();
    if (title.length === 0) return;
    const pages = Number(manualPages);
    addBook.mutate(
      {
        title,
        subtitle: null,
        authors: manualAuthor.trim().length > 0 ? [manualAuthor.trim()] : [],
        publisher: null,
        publishedDate: null,
        isbn13: null,
        isbn10: null,
        pageCount: Number.isInteger(pages) && pages > 0 ? pages : null,
        coverUrl: null,
        description: null,
        categories: [],
        language: null,
        source: "manual",
        sourceRef: null,
        status: "to_read",
      },
      { onSuccess: () => handleOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="rd-search">
        <DialogTitle>책 추가</DialogTitle>
        <div className="rd-search-box">
          <Search size={15} aria-hidden className="rd-search-icon" />
          <Input
            placeholder="제목·저자 또는 ISBN 검색 (Google Books)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {search.isFetching && <Loader2 size={15} aria-hidden className="rd-search-spinner" />}
        </div>

        {notice && <div className="rd-search-notice typo-label-md">{notice}</div>}

        {!manualMode && (
          <div className="rd-search-results">
            {search.isError && (
              <EmptyState className="rd-empty">
                카탈로그 조회에 실패했다 — 잠시 후 다시 시도하거나 수기로 등록.
              </EmptyState>
            )}
            {search.data != null && search.data.length === 0 && (
              <EmptyState className="rd-empty">
                검색 결과가 없다 — 철자를 바꾸거나 ISBN으로, 또는 수기로 등록.
              </EmptyState>
            )}
            {(search.data ?? []).map((c, i) => (
              <div key={`${c.source}-${c.sourceRef ?? i}`} className="rd-search-item">
                {c.coverUrl ? (
                  <img className="rd-search-cover" src={c.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span className="rd-search-cover rd-card-cover-fallback" aria-hidden>
                    <BookOpen size={16} />
                  </span>
                )}
                <div className="rd-search-info">
                  <div className="typo-body-strong">{c.title}</div>
                  <div className="typo-label-sm rd-card-dim">
                    {[
                      authorsLabel(c.authors),
                      c.publisher,
                      c.publishedDate,
                      c.pageCount != null ? `${c.pageCount}p` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <div className="rd-search-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={addBook.isPending}
                    onClick={() => register(c, "to_read")}
                  >
                    읽을 책
                  </Button>
                  <Button
                    size="sm"
                    disabled={addBook.isPending}
                    onClick={() => register(c, "reading")}
                  >
                    바로 시작
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {manualMode ? (
          <form className="rd-manual" onSubmit={registerManual}>
            <Input
              placeholder="제목 (필수)"
              value={manualTitle}
              onChange={(e) => setManualTitle(e.target.value)}
              autoFocus
            />
            <Input
              placeholder="저자"
              value={manualAuthor}
              onChange={(e) => setManualAuthor(e.target.value)}
            />
            <Input
              placeholder="총 페이지"
              type="number"
              min={1}
              value={manualPages}
              onChange={(e) => setManualPages(e.target.value)}
            />
            <div className="rd-manual-actions">
              <Button type="submit" disabled={addBook.isPending || manualTitle.trim() === ""}>
                등록
              </Button>
              <Button type="button" variant="ghost" onClick={() => setManualMode(false)}>
                검색으로 돌아가기
              </Button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="rd-manual-toggle typo-label-md"
            onClick={() => setManualMode(true)}
          >
            검색에 없나? 수기로 등록 ({today} 기준 서가에 추가)
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}
