import "./CmdKnob.css";

import { useEffect, useRef, useState } from "react";

import { armedDirection, clampToThrow, type KnobDir } from "@/lib/knobGeometry";
import { useCmdKnob } from "@/lib/useCmdKnob";

const THROW_RADIUS = 46; // px — 스틱 최대 편향
const ARM_RATIO = 0.55; // 임계 = 반경 * 0.55
const TILT_DEG = 22; // 풀 편향 시 최대 틸트 각

const GLYPH: Record<KnobDir, string> = { up: "↑", down: "↓", left: "←", right: "→" };
const CENTER: { x: number; y: number } = { x: 0, y: 0 };

/**
 * 전역 오락실 조이스틱(설계 §3). useCmdKnob이 visible/origin/발사를 관리하고,
 * 여기선 포인터 드래그 → clampToThrow/armedDirection으로 스틱 위치·armed 방향을 계산한다.
 * mouseup 시 armed면 fire(dir), 항상 중앙으로 스프링백. 트리거 release는 훅이 dismiss.
 *
 * 전역 mouse 리스너는 visible 세션당 1회만 구독한다(armed/fire 변동으로 재구독되면 드래그가
 * 끊긴다) — 핸들러가 읽어야 하는 최신값은 ref로 동기화한다(useViewShortcuts와 동일 idiom).
 */
export function CmdKnob() {
  const { visible, origin, dirEnabled, fire } = useCmdKnob();
  const [offset, setOffset] = useState(CENTER);
  const [armed, setArmed] = useState<KnobDir | null>(null);
  const [dragging, setDragging] = useState(false);

  // 전역 핸들러가 읽을 최신값 ref(커밋마다 동기화). draggingRef는 핸들러 가드 전용.
  const draggingRef = useRef(false);
  const originRef = useRef(origin);
  const dirEnabledRef = useRef(dirEnabled);
  const fireRef = useRef(fire);
  const armedRef = useRef<KnobDir | null>(null);
  useEffect(() => {
    originRef.current = origin;
    dirEnabledRef.current = dirEnabled;
    fireRef.current = fire;
  });

  useEffect(() => {
    if (!visible) return;
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const o = originRef.current;
      const { x, y } = clampToThrow(e.clientX - o.x, e.clientY - o.y, THROW_RADIUS);
      const dir = armedDirection(x, y, THROW_RADIUS, ARM_RATIO, dirEnabledRef.current);
      armedRef.current = dir;
      setOffset({ x, y });
      setArmed(dir);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (armedRef.current) fireRef.current(armedRef.current);
      armedRef.current = null;
      setDragging(false); // shownOffset → 중앙, CSS transition으로 스프링백
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // 세션 종료(트리거 release 등) — 중단된 드래그 상태를 리셋(다음 세션 깨끗하게).
      draggingRef.current = false;
      armedRef.current = null;
      setDragging(false);
    };
  }, [visible]);

  if (!visible) return null;

  // 드래그 중이 아닐 땐 항상 중앙(스프링백 + 세션 간 stale 방지) — raw state는 드래그 중에만 반영.
  const shown = dragging ? offset : CENTER;
  const shownArmed = dragging ? armed : null;
  const tiltX = (shown.y / THROW_RADIUS) * TILT_DEG; // 위로 밀면 -y → 앞으로 기울기
  const tiltY = (shown.x / THROW_RADIUS) * TILT_DEG;

  return (
    <div
      className="cmd-knob"
      style={{ left: origin.x, top: origin.y }}
      role="presentation"
      aria-hidden
    >
      <div className="cmd-knob-base">
        {(Object.keys(GLYPH) as KnobDir[]).map((dir) => (
          <span
            key={dir}
            className="cmd-knob-guide"
            data-dir={dir}
            data-enabled={dirEnabled[dir] || undefined}
            data-armed={shownArmed === dir || undefined}
          >
            {GLYPH[dir]}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="cmd-knob-stick"
        data-dragging={dragging || undefined}
        style={{
          transform: `translate(-50%, -50%) translate(${shown.x}px, ${shown.y}px) perspective(220px) rotateX(${-tiltX}deg) rotateY(${tiltY}deg)`,
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          armedRef.current = null;
          setOffset(CENTER);
          setArmed(null);
          setDragging(true);
        }}
        aria-label="조이스틱 — 방향으로 밀어 단축키 실행"
      />
    </div>
  );
}
