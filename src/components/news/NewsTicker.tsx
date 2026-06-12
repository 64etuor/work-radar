// 전역 하단 뉴스 티커 (PR C, spec §6).
//
// 좌측 스크롤 마퀴(30s linear infinite). hover 일시정지. 클릭→OS 기본 브라우저(`openUrl`).
// `prefers-reduced-motion: reduce` 폴백은 CSS에서 정적 fade pagination(처음 5개)으로 처리.
// INVARIANT #1: 표시 전용 — 큐/매트릭스 무관.

import "./NewsTicker.css";

import { openUrl } from "@tauri-apps/plugin-opener";
import { type CSSProperties, useLayoutEffect, useRef } from "react";

import type { NewsItem } from "@/bindings";
import {
  isHotTrendingNews,
  newsSourceClass,
  newsSourceLabel,
  newsTickerItemKey,
} from "@/lib/newsTicker";
import { useNewsFilters, useNewsList, useNewsOptions } from "@/lib/query/news";

/**
 * 뉴스 티커. 활성 소스에서 받은 최근 아이템을 좌측 스크롤 마퀴로 흘린다.
 * App 글로벌 크롬 하단에 한 번만 마운트해 CaptureBoard뿐 아니라 모든 뷰에서 보이게 한다.
 * 같은 콘텐츠를 두 번 렌더 → `transform: translateX(0) → translateX(-50%)`로 seamless 루프.
 * 한쪽 트랙만 aria-label 노출(스크린리더 중복 방지), 사본 트랙은 `aria-hidden`.
 */
export function NewsTicker() {
  const q = useNewsList();
  const filters = useNewsFilters();
  const options = useNewsOptions();
  const items = q.data ?? [];
  const hasFilters = (filters.data ?? []).length > 0;
  const marqueeSeconds = options.data?.marqueeSeconds ?? 60;
  const hotOnly = options.data?.hotOnly ?? false;

  // 콘텐츠 폭에 비례해 duration을 잡아 항목 수와 무관하게 일정한 스크롤 속도(px/초)를 유지한다.
  // (고정 duration이면 항목이 많을수록 더 먼 거리를 같은 시간에 흘러 "최저 속도도 빠름".)
  // 체감 속도 = REF_PX / marqueeSeconds px/s (콘텐츠 폭 무관). React state 없이 측정 후
  // CSS 변수를 직접 써 리렌더를 피한다. 트랙은 동일 콘텐츠 2벌(-50%) → 스크롤 거리 = scrollWidth/2.
  const trackRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const REF_PX = 2400;
    const MIN_DURATION_S = 20;
    const apply = () => {
      const contentPx = el.scrollWidth / 2;
      const dur =
        contentPx > 0
          ? Math.max(MIN_DURATION_S, (marqueeSeconds * contentPx) / REF_PX)
          : marqueeSeconds;
      el.style.setProperty("--news-marquee-duration", `${dur}s`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
    // q.data = 트랙 마운트/콘텐츠 변경 트리거(안정 참조). 폭 변화 자체는 ResizeObserver가 잡는다.
  }, [q.data, marqueeSeconds]);

  // 빈 상태 — 로딩/실패/소스 0개/아이템 0개 모두 동일 톤으로 subtle 안내.
  if (q.isLoading) {
    return <div className="news-ticker is-empty">뉴스 불러오는 중…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="news-ticker is-empty">
        {hotOnly
          ? "핫 뉴스가 없습니다 — 설정에서 핫 뉴스만 표시를 끄거나 댓글 있는 소스를 켜세요"
          : hasFilters
            ? "필터에 매치되는 뉴스가 없습니다 — 설정에서 키워드 조정"
            : "뉴스 소스가 꺼져 있거나 아직 수신된 항목이 없습니다 — 설정 → 뉴스에서 선택"}
      </div>
    );
  }

  return (
    <section className="news-ticker" aria-label="외부 뉴스 티커">
      <div
        ref={trackRef}
        className="news-ticker-track"
        // 초기 fallback — 마운트 후 useLayoutEffect가 콘텐츠 폭 기준으로 덮어쓴다.
        style={{ "--news-marquee-duration": `${marqueeSeconds}s` } as CSSProperties}
      >
        <NewsTrack items={items} />
        <NewsTrack items={items} ariaHidden />
      </div>
    </section>
  );
}

function NewsTrack({ items, ariaHidden }: { items: NewsItem[]; ariaHidden?: boolean }) {
  return (
    <ul className="news-ticker-set" aria-hidden={ariaHidden ? true : undefined}>
      {items.map((it) => (
        <li key={newsTickerItemKey(it)} className="news-ticker-li">
          {/* 사본(seamless 마퀴 위한 두 번째 트랙)은 키보드 포커스/클릭 대상 제외 — critic Minor #2 */}
          <NewsTickerItem item={it} items={items} tabbable={!ariaHidden} />
        </li>
      ))}
    </ul>
  );
}

function NewsTickerItem({
  item,
  items,
  tabbable,
}: {
  item: NewsItem;
  items: NewsItem[];
  tabbable: boolean;
}) {
  const hot = isHotTrendingNews(item, items);
  return (
    <button
      type="button"
      className="news-ticker-item"
      onClick={
        tabbable
          ? () => {
              openUrl(item.url).catch((e) => {
                console.error("[news-ticker] openUrl failed", item.url, e);
              });
            }
          : undefined
      }
      title={item.title}
      tabIndex={tabbable ? 0 : -1}
    >
      <span className={`news-src-badge ${newsSourceClass(item.source)}`}>
        {newsSourceLabel(item.source)}
      </span>
      {hot && (
        <span className="news-hot" aria-label="핫 트렌딩" title="핫 트렌딩">
          🔥
        </span>
      )}
      <span className="news-title">{item.title}</span>
      {item.commentCount != null && <span className="news-cmt">💬 {item.commentCount}</span>}
    </button>
  );
}
