import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useRef } from "react";

import type { ProjectTickerStatusRow } from "../../bindings";
import { projectDotTone } from "../../lib/controlRoom";

/** Per-project Control Room switcher. One tab per ticker row; the status dot mirrors the
 *  INFRA tone vocabulary (down/ok/advisory/muted) via the pure `projectDotTone` helper. */
export function ProjectTabs({
  rows,
  activeProjectId,
  onSelect,
}: {
  rows: ProjectTickerStatusRow[];
  activeProjectId: string | null;
  onSelect: (projectId: string) => void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const reduce = useReducedMotion();

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + delta + rows.length) % rows.length;
    onSelect(rows[next].projectId);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="cr-tabs" role="tablist" aria-label="Control Room 프로젝트">
      {rows.map((row, index) => {
        const selected = row.projectId === activeProjectId;
        return (
          <button
            key={row.projectId}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className="cr-tab"
            data-selected={selected || undefined}
            onClick={() => onSelect(row.projectId)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {selected && (
              <LazyMotion features={domAnimation}>
                <m.span
                  layoutId={reduce ? undefined : "cr-tab-active"}
                  className="cr-tab-active"
                  aria-hidden
                  transition={{ duration: 0.18, ease: "easeOut" }}
                />
              </LazyMotion>
            )}
            <span className="cr-tab-dot" data-tone={projectDotTone(row)} aria-hidden />
            <span className="cr-tab-name">{row.projectName}</span>
          </button>
        );
      })}
    </div>
  );
}
