/**
 * 지연 언마운트 표면(radix Presence 없이 usePresence/leaving 으로 exit을 붙인 곳)의 계약 가드.
 *
 * 이 계약을 깨면 증상이 조용하다: exit 중인 전면 오버레이가 닫힘 직후의 클릭을 삼켜
 * "가끔 클릭이 안 먹는" 버그가 되고(click-shield), reduced-motion 사용자에겐 닫은 표면이
 * 유지시간 동안 그대로 보인다. 둘 다 스냅샷/렌더 테스트로는 안 잡혀서 소스 단언으로 고정한다.
 * (소스 단언 가드는 appMotion.test.ts / MissionView.copy.test.ts 선례.)
 */
import { describe, expect, it } from "vitest";

import appSource from "../App.tsx?raw";

declare const __dirname: string;
declare const require: (moduleName: string) => {
  readFileSync?: (path: string, encoding: string) => string;
  resolve?: (...paths: string[]) => string;
};

const { readFileSync } = require("fs");
const { resolve } = require("path");

const read = (rel: string): string => readFileSync?.(resolve?.(__dirname, rel) ?? "", "utf8") ?? "";

const paletteCss = read("../components/CommandPalette.css");
const toastCss = read("../components/ToastHost.css");
const toastSource = read("../components/ToastHost.tsx");

/** `selector { … }` 블록 본문. */
function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`규칙 없음: ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

/**
 * reduced-motion 블록 안에서 `selector { … opacity: 0 … }` 규칙이 실제로 존재하는가.
 * "selector가 있다" + "어딘가에 opacity: 0이 있다"를 따로 단언하면 서로 다른 규칙으로 만족돼
 * vacuous해진다(그 블록엔 `animation: none` 규칙이 먼저 온다) — 같은 규칙 안을 요구한다.
 */
function reducedMotionHides(css: string, selector: string): boolean {
  const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{[^}]*opacity:\\s*0`).test(reduced);
}

describe("CommandPalette exit 계약", () => {
  it("팔레트를 presence 래퍼로 감싸 exit 동안 노드를 유지한다(하드 컷 금지)", () => {
    expect(appSource).not.toContain("{paletteOpen && <CommandPalette />}");
    expect(appSource).toContain("usePresence(paletteOpen, PALETTE_EXIT_MS)");
    expect(appSource).toContain("{palette.mounted && (");
    expect(appSource).toContain("data-state={palette.state}");
  });

  it("closed 동안 inert — pointer-events 차단 + cmdk 입력의 포커스/키 캡처 해제", () => {
    expect(appSource).toContain('inert={palette.state === "closed"}');
  });

  it("열림 세대를 key로 걸어 재오픈 시 자식을 새로 마운트한다(autoFocus/검색어 초기화)", () => {
    expect(appSource).toContain("<CommandPalette key={palette.openKey} />");
  });

  it("팔레트는 overlay-stack에 등록하지 않는다 — 등록하면 exit이 마커 수명을 늘려 Esc가 샌다", () => {
    const paletteSource = read("../components/CommandPalette.tsx");
    expect(paletteSource).not.toContain("overlay-stack");
    expect(paletteSource).not.toContain("OVERLAY_OPEN_ATTR");
  });

  it("closed 오버레이/패널은 pointer-events: none (click-shield 방지)", () => {
    expect(ruleBlock(paletteCss, '.cmdk-presence[data-state="closed"] .cmdk-overlay')).toContain(
      "pointer-events: none",
    );
    expect(ruleBlock(paletteCss, '.cmdk-presence[data-state="closed"] .cmdk-panel')).toContain(
      "pointer-events: none",
    );
  });

  it("reduced-motion에서 closed 오버레이를 즉시 감춘다(animation:none만으론 잔상)", () => {
    expect(
      reducedMotionHides(paletteCss, '.cmdk-presence[data-state="closed"] .cmdk-overlay'),
    ).toBe(true);
  });

  it("presence 래퍼는 레이아웃에 박스를 만들지 않는다", () => {
    expect(ruleBlock(paletteCss, ".cmdk-presence")).toContain("display: contents");
  });
});

describe("Toast exit 계약", () => {
  it("나가는 토스트를 data-leaving으로 표시한다", () => {
    expect(toastSource).toContain('data-leaving={t.leavingSeq !== undefined ? "" : undefined}');
  });

  it("나가는 토스트는 pointer-events: none (버튼이 클릭을 삼키지 않도록)", () => {
    expect(ruleBlock(toastCss, ".toast-item[data-leaving]")).toContain("pointer-events: none");
  });

  it("reduced-motion에서 나가는 토스트를 즉시 감춘다", () => {
    expect(reducedMotionHides(toastCss, ".toast-item[data-leaving]")).toBe(true);
  });
});

describe("Hermes 패널 exit 계약", () => {
  const motionCss = read("../styles/motion.css");
  const hermesSource = read("../components/hermes/HermesPanel.tsx");

  it("presence 훅을 쓴다 — 인라인 effect 방식은 닫힘 첫 커밋에 서브트리를 갈아버린다", () => {
    expect(hermesSource).toContain("usePresence(state.open, HERMES_EXIT_MS)");
    expect(hermesSource).toContain("if (!presence.mounted) return null;");
    expect(hermesSource).not.toContain("setIsClosing");
  });

  it("closed 패널은 pointer-events: none (fixed z-50 패널의 click-shield 방지)", () => {
    expect(ruleBlock(motionCss, '.hermes-panel-root[data-state="closed"]')).toContain(
      "pointer-events: none",
    );
  });

  it("closed 동안 inert — 채팅 입력이 포커스/키를 계속 먹지 않도록", () => {
    expect(hermesSource).toContain('inert={presence.state === "closed"}');
  });

  it("reduced-motion에서 closed 패널을 즉시 감춘다(animation:none만으론 260ms 잔상)", () => {
    expect(reducedMotionHides(motionCss, '.hermes-panel-root[data-state="closed"]')).toBe(true);
  });
});

describe("툴팁은 여전히 enter-only", () => {
  it("exit을 달면 data-wr-overlay-open 마커가 살아남아 전역 키가 죽는다", () => {
    const motionCss = read("../styles/motion.css");
    expect(motionCss).not.toContain('.wr-tooltip-content[data-state="closed"]');
  });
});
