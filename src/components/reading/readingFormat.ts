import type { Book, ReadingStatus, UpdateBookInput } from "@/bindings";
import { APP_LOCALE } from "@/lib/localeFormat";

/** 전-null 패치 골격 — 소비처는 스프레드 후 바꿀 필드만 지정한다(20필드 널 리터럴 중복 제거). */
export function emptyBookPatch(id: string): UpdateBookInput {
  return {
    id,
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
    rating: null,
    clearRating: null,
    review: null,
    clearReview: null,
    currentPage: null,
    favorite: null,
    startedOn: null,
    finishedOn: null,
  };
}

/** 상태 → 표시 라벨. */
export const READING_STATUS_LABEL: Record<ReadingStatus, string> = {
  to_read: "읽을 책",
  reading: "읽는 중",
  finished: "완독",
  abandoned: "중단",
};

/** 명예의 전당 티어 — 옵시디언 대시보드 규칙 그대로(rating 0..10). */
export const RATING_TIERS = [
  { label: "S", min: 9, max: 10 },
  { label: "A", min: 7, max: 8.9 },
  { label: "B", min: 5, max: 6.9 },
  { label: "C", min: 3, max: 4.9 },
  { label: "D", min: 1, max: 2.9 },
] as const;

export type RatingTier = (typeof RATING_TIERS)[number]["label"] | "none";

export function tierOf(rating: number | null): RatingTier {
  if (rating == null || rating < 1) return "none";
  for (const tier of RATING_TIERS) {
    if (rating >= tier.min && rating <= tier.max) return tier.label;
  }
  return "none";
}

/** 별 5개 채움 비율(%) — rating 0..10을 별 5개로(옵시디언 my_rate/2 규칙). */
export function starFills(rating: number): number[] {
  const stars = rating / 2;
  return Array.from({ length: 5 }, (_, i) => Math.round(Math.max(Math.min(stars - i, 1), 0) * 100));
}

/** 진행률 % (0..100) — 쪽수 정보가 없으면 null. */
export function progressPct(currentPage: number, pageCount: number | null): number | null {
  if (pageCount == null || pageCount <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((currentPage / pageCount) * 100)));
}

export interface PaceInfo {
  /** 목표 달성률 % (0..100 클램프). */
  pct: number;
  /** 연 경과 기준 기대 완독 수. */
  expected: number;
  /** 실제 − 기대 (양수 = 앞서감). */
  diff: number;
  remaining: number;
  monthlyGoal: number;
}

/**
 * 연간 목표 페이스 — 옵시디언 대시보드 공식 이식: 연 경과율 × 목표 = 기대 권수.
 * `today`는 프런트 주입 로컬 날짜(YYYY-MM-DD).
 */
export function paceInfo(finished: number, goal: number, today: string): PaceInfo {
  const [y, m, d] = today.split("-").map(Number);
  const year = y ?? new Date().getFullYear();
  const now = new Date(year, (m ?? 1) - 1, d ?? 1, 12).getTime();
  const start = new Date(year, 0, 1).getTime();
  const end = new Date(year, 11, 31).getTime();
  const yearProgress = end > start ? Math.max(0, Math.min(1, (now - start) / (end - start))) : 0;
  const expected = Math.round(goal * yearProgress);
  return {
    pct: Math.min(Math.round((finished / goal) * 100), 100),
    expected,
    diff: finished - expected,
    remaining: Math.max(goal - finished, 0),
    monthlyGoal: Math.ceil(goal / 12),
  };
}

const monthFormat = new Intl.DateTimeFormat(APP_LOCALE, { month: "short" });

/** 1..12 → 로케일 짧은 월 라벨("1월" ko / "Jan" en) — 하드코딩 금지 규율. */
export function monthShortLabel(month: number): string {
  return monthFormat.format(new Date(2000, month - 1, 1));
}

/** 저자 목록 표시 라벨. */
export function authorsLabel(authors: string[]): string {
  return authors.join(", ");
}

/** 'YYYY-MM-DD' 로컬 오늘에서 연도만. */
export function yearOf(today: string): number {
  const y = Number(today.slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : new Date().getFullYear();
}

/**
 * 매칭용 정규화 — 소문자 + 문자/숫자만(공백·문장부호·'：' 제거). Rust 커널
 * `normalize_for_match`와 동일 규칙: 띄어쓰기가 달라도 같은 책을 찾는다.
 */
export function normalizeForMatch(s: string): string {
  return [...s]
    .filter((c) => /[\p{L}\p{N}]/u.test(c))
    .join("")
    .toLowerCase();
}

/** 서재 책이 검색어와 맞는가 — 제목/부제/저자를 정규화 포함 매칭(양방향). */
export function bookMatchesQuery(
  book: Pick<Book, "title" | "subtitle" | "authors">,
  query: string,
): boolean {
  const q = normalizeForMatch(query);
  if (q.length < 2) return false;
  const normTitle = normalizeForMatch(book.title);
  const haystack = normalizeForMatch([book.title, book.subtitle ?? "", ...book.authors].join(" "));
  return haystack.includes(q) || (normTitle.length >= 2 && q.includes(normTitle));
}
