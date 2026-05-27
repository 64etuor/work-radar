import { describe, expect, it } from "vitest";

import appSource from "../App.tsx?raw";

declare const __dirname: string;
declare const require: (moduleName: string) => {
  readFileSync?: (path: string, encoding: string) => string;
  resolve?: (...paths: string[]) => string;
};

const { readFileSync } = require("fs");
const { resolve } = require("path");
const motionSource =
  readFileSync?.(resolve?.(__dirname, "../styles/motion.css") ?? "", "utf8") ?? "";

describe("app view motion", () => {
  it("preserves Cmd+arrow navigation direction as the view-shell motion class", () => {
    expect(appSource).toContain('type ViewMotion = "forward" | "back"');
    expect(appSource).toContain('const motion = dir > 0 ? "forward" : "back"');
    expect(appSource).toContain("navigateView(adjacentView(view, dir), motion)");
    expect(appSource).toContain("transitionRunningRef.current");
    expect(appSource).toContain('className="view-stage"');
    expect(appSource).toContain('className="view-shell"');
    expect(appSource).toContain('<div key={view} className="view-content">');
  });

  it("uses manual shell snapshots for workspace slides instead of webview-dependent transitions", () => {
    expect(appSource).not.toContain("startViewTransition");
    expect(appSource).toContain('document.querySelector<HTMLElement>(".view-shell")');
    expect(appSource).toContain("type ViewSnapshot");
    expect(appSource).toContain("setViewSnapshot({");
    expect(appSource).toContain("html: shell?.innerHTML ??");
    expect(appSource).toContain("dangerouslySetInnerHTML={{ __html: viewSnapshot.html }}");
    expect(appSource).toContain("const VIEW_SLIDE_CLEANUP_MS = 460");
    expect(appSource).toContain("transitionTimerRef.current");
    expect(motionSource).toContain(".view-stage");
    expect(motionSource).toContain(".view-snapshot");
    expect(motionSource).toContain(".view-content");
    expect(motionSource).toContain("background: var(--color-wr-bg)");
    expect(motionSource).not.toContain("view-transition-name");
    expect(motionSource).not.toContain("::view-transition");
    expect(motionSource).not.toContain("view-enter");
    expect(motionSource).not.toContain("view-shell-forward");
    expect(motionSource).not.toContain("view-shell-back");
    expect(appSource).toContain("data-slide-motion={viewSnapshot?.motion}");
    expect(motionSource).toContain('.view-stage[data-slide-motion="forward"] .view-snapshot');
    expect(motionSource).toContain('.view-stage[data-slide-motion="back"] .view-shell');
    expect(motionSource).not.toContain("data-fallback-motion");
    expect(motionSource).toContain("animation-play-state: paused !important");
    expect(motionSource).not.toContain(":root[data-view-motion] .view-shell *");
    expect(motionSource).not.toContain("animation: none !important");
    expect(motionSource).not.toContain(
      ":root[data-view-motion] .view-shell *::after {\n  animation-play-state",
    );
    expect(motionSource).toContain(".view-snapshot *::after {\n  animation-play-state");
    expect(motionSource).toContain("inline-size: 100%");
    expect(motionSource).toContain("wr-space-old-forward");
    expect(motionSource).toContain("wr-space-new-back");
  });
});
