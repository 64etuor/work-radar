import { useEffect, useState } from "react";

import type { Kind, LifeWheelTagConfig, WorkSignal } from "@/bindings";

export function CardTagEditor({
  signal,
  tags,
  onSetKind,
  onOpenAreaPalette,
}: {
  signal: WorkSignal;
  tags: LifeWheelTagConfig[];
  onSetKind: (id: string, kind: Kind | null) => void;
  onOpenAreaPalette: (button: HTMLButtonElement) => void;
}) {
  const selectedAreas = parseAreaTagKeys(signal.areaTags, signal.area);
  const kind = signal.kind === "personal" ? "personal" : "work";
  const nextKind = kind === "work" ? "personal" : "work";
  const selectedArea = selectedAreas[0] ?? null;
  const selectedTag = selectedArea ? tags.find((tag) => tag.id === selectedArea) : null;
  const areaColor = selectedTag?.color ?? "#75758a";
  const areaLabelText = selectedTag?.label ?? selectedArea ?? "미분류";
  return (
    <div className="postit-tags" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`postit-tag-button postit-kind ${kind}`}
        onClick={() => onSetKind(signal.id, nextKind)}
        aria-label="personal/work 전환"
      >
        {kind === "work" ? "업무" : "개인"}
      </button>
      <button
        type="button"
        className={`postit-tag-button postit-area-button${selectedAreas.length === 0 ? " empty" : ""}`}
        style={
          {
            "--area-color": areaColor,
            "--area-text-color": readableTextColor(areaColor),
          } as React.CSSProperties
        }
        onClick={(e) => onOpenAreaPalette(e.currentTarget)}
        aria-label="Life wheel tag 선택"
      >
        {areaLabelText}
      </button>
    </div>
  );
}

export function AreaRadialPalette({
  signal,
  tags,
  anchor,
  onClose,
  onSetAreaTagKey,
}: {
  signal: WorkSignal;
  tags: LifeWheelTagConfig[];
  anchor: { x: number; y: number };
  onClose: () => void;
  onSetAreaTagKey: (id: string, tagKey: string | null) => void;
}) {
  const selectedAreas = parseAreaTagKeys(signal.areaTags, signal.area);
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
    onSetAreaTagKey(signal.id, tagKey);
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
      className={`area-radial-layer wr-radial-effect-layer${closing ? " closing" : ""}`}
      onPointerDown={closePalette}
    >
      <div
        className={`area-radial wr-radial-effect${closing ? " closing" : ""}`}
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
          className={`area-radial-core${!selectedArea ? " active" : ""}${closing ? " closing" : ""}`}
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
                className={`area-wheel-segment${active ? " active" : ""}${closing ? " closing" : ""}`}
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
