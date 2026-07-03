/** 확정 거래(원장) 카드의 클라이언트 페이지 크기. */
export const APPROVED_PAGE_SIZE = 20;

/** 백엔드 list 쿼리의 안전 상한(LIMIT 200)과 동일 값 — rows가 이 길이면 잘렸을 수 있다. */
export const BACKEND_LIST_CAP = 200;

export interface PageSlice {
  /** 유효 범위로 클램프된 0-기반 페이지. */
  page: number;
  /** 총 페이지 수(빈 목록도 1 — "0/0 페이지" 표기를 피한다). */
  pageCount: number;
  /** slice 시작(포함). */
  start: number;
  /** slice 끝(비포함). */
  end: number;
}

/**
 * 순수 페이지 계산. 요청 페이지가 범위를 벗어나면(스코프 전환으로 총량이 줄어든 직후 등)
 * 마지막 유효 페이지로 클램프한다 — 렌더 중 상태 보정 없이 항상 유효한 slice를 돌려준다.
 */
export function paginate(total: number, pageSize: number, requestedPage: number): PageSlice {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(safeTotal / safeSize));
  const page = Math.min(Math.max(0, Math.floor(requestedPage)), pageCount - 1);
  const start = Math.min(page * safeSize, safeTotal);
  const end = Math.min(start + safeSize, safeTotal);
  return { page, pageCount, start, end };
}
