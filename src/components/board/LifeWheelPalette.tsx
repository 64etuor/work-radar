import { useEffect, useState } from "react";

import type { AreaTag, Kind, LifeWheelTagConfig } from "@/bindings";
import { kindLabel } from "@/components/board/boardUtils";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";

/**
 * 정본 kind 칩 — 앱 전역 단일 색 컨벤션.
 * personal=`secondary`(베이지 #eeece7), work=`accent`(코랄 #ff7759).
 * 다른 색(pale-blue/pale-green)으로 kind를 표시하지 말 것.
 */
export function KindBadge({ kind, className }: { kind: Kind; className?: string }) {
  return (
    <Badge
      variant={kind === "work" ? "accent" : "secondary"}
      className={cn("font-semibold", className)}
    >
      {kindLabel(kind)}
    </Badge>
  );
}

/**
 * Read-only kind + area 칩 페어 (RetroView / RoutineTrackingView 등 비편집 컨텍스트용).
 * 인터랙티브 편집은 [[CardTagEditor]] 사용. area 색은 사용자 Life Wheel 팔레트에서 가져온다.
 */
export function KindAreaChips({
  target,
  tags,
}: {
  target: Pick<CardTagTarget, "kind" | "area" | "areaTags">;
  tags: LifeWheelTagConfig[];
}) {
  const areaKey = parseAreaTagKeys(target.areaTags, target.area)[0] ?? null;
  const areaTag = areaKey ? tags.find((t) => t.id === areaKey) : null;
  return (
    <>
      {target.kind && <KindBadge kind={target.kind} className="typo-micro h-4 px-1.5 py-0" />}
      {areaKey && (
        <span
          className={cn(
            "b-tag life-wheel-area-chip typo-micro inline-flex items-center rounded-full px-1.5 py-px font-semibold",
          )}
          style={{
            background: areaTag?.color ?? "#75758a",
            color: readableTextColor(areaTag?.color ?? "#75758a"),
            borderColor: "transparent",
          }}
          title={areaTag?.label ?? areaKey}
        >
          {areaTag?.label ?? areaKey}
        </span>
      )}
    </>
  );
}

/**
 * 카드 인라인 태그 편집 대상의 최소 모양 — kind 토글 + Life Wheel 버튼을 그리는 데 필요한 필드만.
 * WorkSignal/RoutineToday 모두 이 shape을 만족(BrainDump 카드 ≡ 루틴 카드 UX 통일).
 */
export type CardTagTarget = {
  id: string;
  kind: Kind | null;
  area: AreaTag | null;
  areaTags: string | null;
};

export function CardTagEditor({
  target,
  tags,
  onSetKind,
  onOpenAreaPalette,
}: {
  target: CardTagTarget;
  tags: LifeWheelTagConfig[];
  onSetKind: (id: string, kind: Kind | null) => void;
  onOpenAreaPalette: (button: HTMLButtonElement) => void;
}) {
  const selectedAreas = parseAreaTagKeys(target.areaTags, target.area);
  const kind = target.kind === "personal" ? "personal" : "work";
  const nextKind = kind === "work" ? "personal" : "work";
  const selectedArea = selectedAreas[0] ?? null;
  const selectedTag = selectedArea ? tags.find((tag) => tag.id === selectedArea) : null;
  const areaColor = selectedTag?.color ?? "#75758a";
  const areaLabelText = selectedTag?.label ?? selectedArea ?? "미분류";
  const areaAriaLabel =
    selectedAreas.length === 0 ? "Life wheel tag 선택: 미분류" : "Life wheel tag 선택";
  const keepCardDragPrimary = (event: React.PointerEvent<HTMLButtonElement>) => {
    // Keep button clicks available, but do not let pointer activation focus the
    // button or block the parent post-it drag handler.
    event.preventDefault();
  };

  return (
    <div className="postit-tags">
      <button
        type="button"
        className={`postit-tag-button postit-kind ${kind}`}
        draggable={false}
        onPointerDown={keepCardDragPrimary}
        onClick={() => onSetKind(target.id, nextKind)}
        aria-label="personal/work 전환"
      >
        {kind === "work" ? "업무" : "개인"}
      </button>
      <button
        type="button"
        className={cn(
          "postit-tag-button postit-area-button",
          selectedAreas.length === 0 && "empty",
        )}
        draggable={false}
        style={
          {
            "--area-color": areaColor,
            "--area-text-color": readableTextColor(areaColor),
          } as React.CSSProperties
        }
        onPointerDown={keepCardDragPrimary}
        onClick={(e) => onOpenAreaPalette(e.currentTarget)}
        aria-label={areaAriaLabel}
        title={selectedAreas.length === 0 ? "미분류" : areaLabelText}
      >
        {areaLabelText}
      </button>
    </div>
  );
}

export function AreaRadialPalette({
  target,
  tags,
  anchor,
  onClose,
  onSetAreaTagKey,
}: {
  target: CardTagTarget;
  tags: LifeWheelTagConfig[];
  anchor: { x: number; y: number };
  onClose: () => void;
  onSetAreaTagKey: (id: string, tagKey: string | null) => void;
}) {
  const selectedAreas = parseAreaTagKeys(target.areaTags, target.area);
  const selectedArea = selectedAreas[0] ?? null;
  const [closing, setClosing] = useState(false);
  const closePalette = () => setClosing(true);
  const closeDurationMs = 260 + Math.max(tags.length - 1, 0) * 18;
  useEffect(() => {
    if (!closing) return;
    const timeout = window.setTimeout(onClose, closeDurationMs);
    return () => window.clearTimeout(timeout);
  }, [closeDurationMs, closing, onClose]);
  const selectArea = (tagKey: string | null) => {
    onSetAreaTagKey(target.id, tagKey);
    closePalette();
  };
  const innerRadius = 82;
  const outerRadius = 124;
  const segmentCount = Math.max(tags.length, 1);
  const segmentStep = 360 / segmentCount;
  const segmentGap = Math.min(10, segmentStep * 0.22);
  const labelRadius = (innerRadius + outerRadius) / 2;

  return (
    <div
      className={cn("area-radial-layer wr-radial-effect-layer", closing && "closing")}
      onPointerDown={closePalette}
    >
      <div
        className={cn("area-radial wr-radial-effect", closing && "closing")}
        style={
          {
            left: anchor.x,
            top: anchor.y,
            "--area-close-duration": `${closeDurationMs}ms`,
          } as React.CSSProperties
        }
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={cn("area-radial-core", !selectedArea && "active", closing && "closing")}
          onClick={() => selectArea(null)}
          style={
            {
              "--area-color": "#75758a",
            } as React.CSSProperties
          }
        >
          <span className="area-radial-dot" aria-hidden="true" />
          <span>미분류</span>
        </button>
        <svg className="area-wheel" viewBox="-150 -150 300 300" aria-label="Life Wheel 태그">
          {tags.map((choice, index) => {
            const centerAngle = -90 + segmentStep * index;
            const startAngle = centerAngle - (segmentStep - segmentGap) / 2;
            const endAngle = centerAngle + (segmentStep - segmentGap) / 2;
            const labelPoint = polarPoint(centerAngle, labelRadius);
            const active = selectedArea === choice.id;
            return (
              <g
                key={choice.id}
                className={cn("area-wheel-segment", active && "active", closing && "closing")}
                role="button"
                tabIndex={0}
                aria-label={`${choice.label} 선택`}
                style={
                  {
                    "--area-color": choice.color,
                    "--area-text-color": readableTextColor(choice.color),
                    "--radial-delay": `${index * 18}ms`,
                    "--radial-close-delay": `${(tags.length - index - 1) * 18}ms`,
                  } as React.CSSProperties
                }
                onClick={() => selectArea(choice.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectArea(choice.id);
                  }
                }}
              >
                <title>{choice.label}</title>
                <path d={roundedRingSegmentPath(startAngle, endAngle, innerRadius, outerRadius)} />
                <text x={labelPoint.x} y={labelPoint.y}>
                  {choice.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function polarPoint(angle: number, radius: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  return {
    x: Math.cos(radians) * radius,
    y: Math.sin(radians) * radius,
  };
}

function roundedRingSegmentPath(
  startAngle: number,
  endAngle: number,
  innerRadius: number,
  outerRadius: number,
): string {
  const cornerRadius = Math.min(7, (outerRadius - innerRadius) * 0.24);
  const outerCornerAngle = (cornerRadius / outerRadius) * (180 / Math.PI);
  const innerCornerAngle = (cornerRadius / innerRadius) * (180 / Math.PI);
  const outerStart = polarPoint(startAngle + outerCornerAngle, outerRadius);
  const outerEnd = polarPoint(endAngle - outerCornerAngle, outerRadius);
  const rightOuter = polarPoint(endAngle, outerRadius - cornerRadius);
  const rightInner = polarPoint(endAngle, innerRadius + cornerRadius);
  const innerEnd = polarPoint(endAngle - innerCornerAngle, innerRadius);
  const innerStart = polarPoint(startAngle + innerCornerAngle, innerRadius);
  const leftInner = polarPoint(startAngle, innerRadius + cornerRadius);
  const leftOuter = polarPoint(startAngle, outerRadius - cornerRadius);
  const outerControlEnd = polarPoint(endAngle, outerRadius);
  const innerControlEnd = polarPoint(endAngle, innerRadius);
  const innerControlStart = polarPoint(startAngle, innerRadius);
  const outerControlStart = polarPoint(startAngle, outerRadius);
  const outerLargeArc = endAngle - startAngle - outerCornerAngle * 2 > 180 ? 1 : 0;
  const innerLargeArc = endAngle - startAngle - innerCornerAngle * 2 > 180 ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${outerLargeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `Q ${outerControlEnd.x} ${outerControlEnd.y} ${rightOuter.x} ${rightOuter.y}`,
    `L ${rightInner.x} ${rightInner.y}`,
    `Q ${innerControlEnd.x} ${innerControlEnd.y} ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${innerLargeArc} 0 ${innerStart.x} ${innerStart.y}`,
    `Q ${innerControlStart.x} ${innerControlStart.y} ${leftInner.x} ${leftInner.y}`,
    `L ${leftOuter.x} ${leftOuter.y}`,
    `Q ${outerControlStart.x} ${outerControlStart.y} ${outerStart.x} ${outerStart.y}`,
    "Z",
  ].join(" ");
}

function readableTextColor(hex: string): string {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const g = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const b = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 0.48 ? "#ffffff" : "#212121";
}

function parseAreaTagKeys(raw: string | null, primary: string | null): string[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Fall back to primary tag below.
    }
  }
  return primary ? [primary] : [];
}
