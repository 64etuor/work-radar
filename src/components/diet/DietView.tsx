import "./DietView.css";

import { cn } from "@/components/ui/cn";
import { useViewSessionState } from "@/lib/useViewSessionState";

import { HistorySection } from "./HistorySection";
import { LibrarySection } from "./LibrarySection";
import { PantrySection } from "./PantrySection";

type DietTab = "history" | "pantry" | "library";

const TABS: readonly { readonly id: DietTab; readonly label: string }[] = [
  { id: "history", label: "히스토리" },
  { id: "pantry", label: "재고·장보기" },
  { id: "library", label: "라이브러리" },
];

/**
 * 식단 뷰. 오늘/계획 생성·섭취 기록은 Hermes(MCP)가 담당하고, 이 표면은
 * **히스토리 열람 + 재고/주문 관리 + 식품·레시피 편집**만 맡는다(2026-07-17 사용자 결정).
 * 데이터는 전부 로컬 SQLite(diet 도메인) — 외부 변경 없음.
 */
export function DietView() {
  const [tab, setTab] = useViewSessionState<DietTab>("diet.tab", "history");

  return (
    <div className="diet">
      <header className="diet-head">
        <div className="diet-head-copy">
          <span className="typo-mono-label">DIET</span>
          <h1 className="typo-title-md">식단</h1>
          <p className="typo-body-md">
            섭취 히스토리는 읽기 전용 — 기록은 Hermes가 남긴다. 재고와 라이브러리는 여기서 관리.
          </p>
        </div>
        <div className="diet-tabs" role="tablist" aria-label="식단 탭">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`diet-panel-${t.id}`}
              className={cn("diet-tab typo-label-md", tab === t.id && "is-active")}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div className="diet-body" role="tabpanel" id={`diet-panel-${tab}`}>
        {tab === "history" && <HistorySection />}
        {tab === "pantry" && <PantrySection />}
        {tab === "library" && <LibrarySection />}
      </div>
    </div>
  );
}
