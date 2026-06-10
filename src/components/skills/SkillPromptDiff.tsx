import { cn } from "@/components/ui/cn";
import type { DiffLine } from "@/lib/lineDiff";

/** 기본값(코드 상수) ↔ 현재 편집본 라인 diff 렌더(#18). remove=기본에만/add=현재에만/equal=공통.
 * 표시 전용 — 신규 의존성 없이 `lineDiff`(LCS) 결과를 +/− 거터로 보여준다. */
export function SkillPromptDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="skl-diff" role="region" aria-label="기본값과의 차이">
      {lines.map((l, idx) => (
        <div key={`${idx}-${l.op}`} className={cn("skl-diff-line", `skl-diff-${l.op}`)}>
          <span className="skl-diff-gutter" aria-hidden="true">
            {l.op === "add" ? "+" : l.op === "remove" ? "−" : " "}
          </span>
          <span className="skl-diff-text">{l.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
