import { BookOpen, Library, Loader2, Search } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { CatalogBook, ReadingStatus } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { useAddBook, useAladinTtbStatus, useBooks, useCatalogSearch } from "@/lib/query";

import { authorsLabel, bookMatchesQuery, READING_STATUS_LABEL } from "./readingFormat";

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * 카탈로그 검색 + 등록 다이얼로그.
 * 1) 서재 우선: 이미 등록된 책은 정규화 매칭(띄어쓰기·문장부호 무시)으로 최상단에.
 * 2) 카탈로그: 알라딘(키 등록 시) → Google(한글은 한국어판 우선) → Open Library — Rust 사다리.
 * 3) 폴백: 못 찾으면 수기 등록(검색어를 제목으로 미리 채움).
 */
export function BookSearchDialog({
  open,
  onOpenChange,
  onOpenExisting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenExisting: (bookId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualAuthor, setManualAuthor] = useState("");
  const [manualPages, setManualPages] = useState("");
  const [notice, setNotice] = useState<{ msg: string; bookId: string } | null>(null);

  // IME 타이핑 중 과도한 외부 호출 방지(키리스 provider 일일 쿼터 보호).
  const debounced = useDebounced(query, 500);
  const search = useCatalogSearch(debounced);
  const addBook = useAddBook();
  const { data: aladinOn } = useAladinTtbStatus();

  // 서재 우선 매칭 — 로컬 전체 목록에서 정규화 매칭(개인 스케일이라 저비용).
  const { data: library } = useBooks(null, "");
  const libraryMatches = (library ?? []).filter((b) => bookMatchesQuery(b, debounced)).slice(0, 5);

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
            // 백엔드가 ISBN/정규화 제목으로 중복 판정 — 기존 책의 빈 서지는 백필됐다.
            setNotice({
              msg: `이미 서재에 있는 책입니다: ${result.book.title}`,
              bookId: result.book.id,
            });
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

  const searched = debounced.trim().length >= 2;
  const catalogEmpty = search.data != null && search.data.length === 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="rd-search">
        <DialogTitle>책 추가</DialogTitle>
        <div className="rd-search-box">
          <Search size={15} aria-hidden className="rd-search-icon" />
          <Input
            placeholder="제목·저자 또는 ISBN 검색 (띄어쓰기가 달라도 됩니다)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {search.isFetching && <Loader2 size={15} aria-hidden className="rd-search-spinner" />}
        </div>

        {notice && (
          <div className="rd-search-notice typo-label-md">
            <span>{notice.msg}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                handleOpenChange(false);
                onOpenExisting(notice.bookId);
              }}
            >
              열기
            </Button>
          </div>
        )}

        {!manualMode && libraryMatches.length > 0 && (
          <div className="rd-search-results" aria-label="서재에 이미 있는 책">
            {libraryMatches.map((b) => (
              <div key={b.id} className="rd-search-item rd-search-item-owned">
                {b.coverUrl ? (
                  <img className="rd-search-cover" src={b.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span className="rd-search-cover rd-card-cover-fallback" aria-hidden>
                    <BookOpen size={16} />
                  </span>
                )}
                <div className="rd-search-info">
                  <div className="typo-body-strong">{b.title}</div>
                  <div className="rd-search-owned-meta typo-label-sm rd-card-dim">
                    <Library size={11} aria-hidden /> 서재에 있음 · {READING_STATUS_LABEL[b.status]}
                    {b.authors.length > 0 && ` · ${authorsLabel(b.authors)}`}
                  </div>
                </div>
                <div className="rd-search-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      handleOpenChange(false);
                      onOpenExisting(b.id);
                    }}
                  >
                    열기
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!manualMode && (
          <div className="rd-search-results">
            {search.isError && (
              <EmptyState className="rd-empty">
                카탈로그 조회에 실패했습니다(무료 검색 한도일 수 있습니다).
                {aladinOn !== true &&
                  " 설정 → 통합에서 알라딘 TTB 키를 등록하면 국내 검색이 안정적입니다."}{" "}
                수기 등록은 아래에서 할 수 있습니다.
              </EmptyState>
            )}
            {searched && catalogEmpty && libraryMatches.length === 0 && (
              <EmptyState className="rd-empty">
                카탈로그에서 찾지 못했습니다 — 띄어쓰기를 바꾸거나 핵심 단어만, 또는 ISBN으로 검색해
                보세요.
                {aladinOn !== true &&
                  " 국내 도서는 알라딘 TTB 키를 등록(설정 → 통합)하면 훨씬 잘 검색됩니다."}
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
                  {c.source === "aladin" && <Badge variant="outline">알라딘</Badge>}
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
            onClick={() => {
              setManualTitle(query.trim());
              setManualMode(true);
            }}
          >
            검색에 없는 책은 수기로 등록하기
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}
