// 하단 풀폭 뉴스 티커 (PR C, spec §6).
//
// 좌측 스크롤 마퀴(30s linear infinite). hover 일시정지. 클릭→OS 기본 브라우저(`openUrl`).
// `prefers-reduced-motion: reduce` 폴백은 CSS에서 정적 fade pagination(처음 5개)으로 처리.
// INVARIANT #1: 표시 전용 — 큐/매트릭스 무관.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { NewsItem } from "@/bindings";
import { useNewsList } from "@/lib/query/news";

/** 소스별 사람-친화 라벨 + CSS 배지 modifier id. */
const SOURCE_LABEL: Record<string, string> = {
  hn: "HN",
  geeknews: "GEEK",
  lobsters: "LOBSTERS",
};

function sourceLabel(id: string): string {
  return SOURCE_LABEL[id] ?? id.toUpperCase();
}

/**
 * 뉴스 티커. 활성 소스에서 받은 최근 아이템을 좌측 스크롤 마퀴로 흘린다.
 * 같은 콘텐츠를 두 번 렌더 → `transform: translateX(0) → translateX(-50%)`로 seamless 루프.
 * 한쪽 트랙만 aria-label 노출(스크린리더 중복 방지), 사본 트랙은 `aria-hidden`.
 */
export function NewsTicker() {
  const q = useNewsList();
  const items = q.data ?? [];

  // 빈 상태 — 로딩/실패/소스 0개/아이템 0개 모두 동일 톤으로 subtle 안내.
  if (q.isLoading) {
    return <div className="news-ticker is-empty">뉴스 불러오는 중…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="news-ticker is-empty">
        뉴스 소스가 꺼져 있거나 아직 수신된 항목이 없습니다 — 설정 → 뉴스에서 선택
      </div>
    );
  }

  return (
    <div className="news-ticker" role="region" aria-label="외부 뉴스 티커">
      <div className="news-ticker-track">
        <NewsTrack items={items} />
        <NewsTrack items={items} ariaHidden />
      </div>
    </div>
  );
}

function NewsTrack({ items, ariaHidden }: { items: NewsItem[]; ariaHidden?: boolean }) {
  return (
    <ul
      className="news-ticker-set"
      aria-hidden={ariaHidden ? true : undefined}
    >
      {items.map((it) => (
        <li key={`${it.source}-${it.externalId}`} className="news-ticker-li">
          {/* 사본(seamless 마퀴 위한 두 번째 트랙)은 키보드 포커스/클릭 대상 제외 — critic Minor #2 */}
          <NewsTickerItem item={it} tabbable={!ariaHidden} />
        </li>
      ))}
    </ul>
  );
}

function NewsTickerItem({ item, tabbable }: { item: NewsItem; tabbable: boolean }) {
  return (
    <button
      type="button"
      className="news-ticker-item"
      onClick={tabbable ? () => void openUrl(item.url) : undefined}
      title={item.title}
      tabIndex={tabbable ? 0 : -1}
      aria-hidden={tabbable ? undefined : true}
    >
      <span className={`news-src-badge news-src-${item.source}`}>
        {sourceLabel(item.source)}
      </span>
      <span className="news-title">{item.title}</span>
      {item.commentCount != null && (
        <span className="news-cmt">💬 {item.commentCount}</span>
      )}
    </button>
  );
}
