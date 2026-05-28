import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";

import { clampToViewport, defaultBounds } from "./clampToViewport";
import { useHermesPanelState } from "./useHermesPanelState";

/**
 * Hermes 플로팅 패널 셸 (Phase A4).
 * - position:fixed, transform:translate3d(x,y,0) — GPU 합성, layout 무관.
 * - 헤더 드래그 + 우하단 리사이즈 그립 (PointerCapture 기반).
 * - "hermes:toggle" Tauri 이벤트 구독 → open 토글.
 * - Esc 키 닫기 (input/textarea 포커스 시 제외).
 * - children만 받는다 — onRestart는 D4에서 추가.
 */
export function HermesPanel({ children }: { children: React.ReactNode }) {
  const { state, setOpen, setBounds, isLoading } = useHermesPanelState();

  // 초기 배치: 로딩 완료 후 x=0,y=0,w=460,h=600(DEFAULT_PANEL_STATE)이면 defaultBounds로 초기화.
  // isLoading이 false로 바뀐 직후 한 번만 실행한다.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (isLoading) return;
    if (initializedRef.current) return;
    initializedRef.current = true;

    if (state.x === 0 && state.y === 0 && state.w === 460 && state.h === 600) {
      const db = defaultBounds(window.innerWidth, window.innerHeight);
      setBounds(db);
    }
  }, [isLoading, state.x, state.y, state.w, state.h, setBounds]);

  // "hermes:toggle" Tauri 이벤트 구독
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("hermes:toggle", () => {
      setOpen(!state.open);
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, [state.open, setOpen]);

  // Esc 키 닫기 — input/textarea에 포커스 중이면 패스.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOpen]);

  if (!state.open) return null;

  const x = state.x ?? 0;
  const y = state.y ?? 0;
  const w = state.w ?? 460;
  const h = state.h ?? 600;

  return (
    <div
      role="dialog"
      aria-label="Hermes"
      style={{
        position: "fixed",
        transform: `translate3d(${x}px, ${y}px, 0)`,
        width: w,
        height: h,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      className="bg-background border-border rounded-lg border shadow-lg"
    >
      {/* ── 헤더 드래그 핸들 ─────────────────────────────────────── */}
      <PanelHeader
        x={x}
        y={y}
        w={w}
        h={h}
        onBoundsChange={setBounds}
        onClose={() => setOpen(false)}
      />

      {/* ── 본문 ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: "auto" }}>{children}</div>

      {/* ── 리사이즈 그립 (우하단) ─────────────────────────────── */}
      <ResizeGrip x={x} y={y} w={w} h={h} onBoundsChange={setBounds} />
    </div>
  );
}

// ── 내부 컴포넌트 ──────────────────────────────────────────────────────────

interface BoundsProps {
  x: number;
  y: number;
  w: number;
  h: number;
  onBoundsChange: (b: Partial<{ x: number; y: number; w: number; h: number }>) => void;
}

function PanelHeader({
  x,
  y,
  w,
  h,
  onBoundsChange,
  onClose,
}: BoundsProps & { onClose: () => void }) {
  const dragRef = useRef<{
    startPx: number;
    startPy: number;
    startX: number;
    startY: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // data-no-drag 요소(닫기 버튼 등)에서 시작한 경우 드래그 금지
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startPx: e.clientX, startPy: e.clientY, startX: x, startY: y };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startPx;
    const dy = e.clientY - dragRef.current.startPy;
    const next = clampToViewport(
      { x: dragRef.current.startX + dx, y: dragRef.current.startY + dy, w, h },
      window.innerWidth,
      window.innerHeight,
    );
    onBoundsChange({ x: next.x, y: next.y });
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "8px 12px",
        cursor: "grab",
        userSelect: "none",
        flexShrink: 0,
      }}
      className="border-border border-b"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>Hermes</span>
      <Button
        variant="ghost"
        size="sm"
        data-no-drag=""
        onClick={onClose}
        aria-label="닫기"
        style={{ padding: "4px", height: "auto" }}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

function ResizeGrip({ x, y, w, h, onBoundsChange }: BoundsProps) {
  const resizeRef = useRef<{
    startPx: number;
    startPy: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { startPx: e.clientX, startPy: e.clientY, startW: w, startH: h };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    const dw = e.clientX - resizeRef.current.startPx;
    const dh = e.clientY - resizeRef.current.startPy;
    const next = clampToViewport(
      { x, y, w: resizeRef.current.startW + dw, h: resizeRef.current.startH + dh },
      window.innerWidth,
      window.innerHeight,
    );
    onBoundsChange({ w: next.w, h: next.h });
  };

  const onPointerUp = () => {
    resizeRef.current = null;
  };

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        right: 0,
        width: 16,
        height: 16,
        cursor: "se-resize",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      aria-hidden
    />
  );
}
