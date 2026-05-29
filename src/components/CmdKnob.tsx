import "./CmdKnob.css";

import { useEffect, useRef, useState } from "react";

import { armedDirection, clampToThrow, type KnobDir } from "@/lib/knobGeometry";
import { useCmdKnob } from "@/lib/useCmdKnob";

const THROW_RADIUS = 46; // px — 스틱 최대 편향
const ARM_RATIO = 0.55; // 임계 = 반경 * 0.55
const TILT_DEG = 22; // 풀 편향 시 최대 틸트 각

const GLYPH: Record<KnobDir, string> = { up: "↑", down: "↓", left: "←", right: "→" };

/**
 * 전역 오락실 조이스틱(설계 §3). useCmdKnob이 visible/origin/발사를 관리하고,
 * 여기선 포인터 드래그 → clampToThrow/armedDirection으로 스틱 위치·armed 방향을 계산한다.
 * mouseup 시 armed면 fire(dir), 항상 중앙으로 스프링백. 트리거 release는 훅이 dismiss.
 */
export function CmdKnob() {
  const { visible, origin, dirEnabled, fire } = useCmdKnob();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [armed, setArmed] = useState<KnobDir | null>(null);
  const draggingRef = useRef(false);

  // 보이지 않게 되면 드래그 상태 리셋.
  useEffect(() => {
    if (!visible) {
      draggingRef.current = false;
      setOffset({ x: 0, y: 0 });
      setArmed(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const { x, y } = clampToThrow(e.clientX - origin.x, e.clientY - origin.y, THROW_RADIUS);
      setOffset({ x, y });
      setArmed(armedDirection(x, y, THROW_RADIUS, ARM_RATIO, dirEnabled));
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (armed) fire(armed);
      setOffset({ x: 0, y: 0 });
      setArmed(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [visible, origin, dirEnabled, armed, fire]);

  if (!visible) return null;

  const tiltX = (offset.y / THROW_RADIUS) * TILT_DEG; // 위로 밀면 -y → 앞으로 기울기
  const tiltY = (offset.x / THROW_RADIUS) * TILT_DEG;

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
            data-armed={armed === dir || undefined}
          >
            {GLYPH[dir]}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="cmd-knob-stick"
        data-dragging={draggingRef.current || undefined}
        style={{
          transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) perspective(220px) rotateX(${-tiltX}deg) rotateY(${tiltY}deg)`,
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
        }}
        aria-label="조이스틱 — 방향으로 밀어 단축키 실행"
      />
    </div>
  );
}
