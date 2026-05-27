import { describe, expect, it } from "vitest";

import appSource from "../App.tsx?raw";

declare const __dirname: string;
declare const require: (moduleName: string) => {
  readFileSync?: (path: string, encoding: string) => string;
  resolve?: (...paths: string[]) => string;
};

const { readFileSync } = require("fs");
const { resolve } = require("path");
const motionSource = readFileSync?.(resolve?.(__dirname, "../styles/motion.css") ?? "", "utf8") ?? "";

describe("app view motion", () => {
  it("preserves Cmd+arrow navigation direction as the view-shell motion class", () => {
    expect(appSource).toContain('type ViewMotion = "forward" | "back" | "neutral"');
    expect(appSource).toContain('const motion = dir > 0 ? "forward" : "back"');
    expect(appSource).toContain("navigateView(adjacentView(view, dir), motion)");
    expect(appSource).toContain('className={`view-shell view-shell-${viewMotion}`}');
  });

  it("uses native view transitions for Apple-style bidirectional workspace slides", () => {
    expect(appSource).toContain("startViewTransition");
    expect(appSource).toContain("root.dataset.viewMotion = motion");
    expect(appSource).toContain("root.dataset.viewMotionId = motionId");
    expect(appSource).toContain("delete root.dataset.viewMotion");
    expect(appSource).toContain("delete root.dataset.viewMotionId");
    expect(motionSource).toContain("view-transition-name: wr-view-shell");
    expect(motionSource).toContain("view-transition-name: none");
    expect(motionSource).toContain("::view-transition-old(root)");
    expect(motionSource).toContain("::view-transition-old(wr-view-shell)");
    expect(motionSource).toContain("::view-transition-new(wr-view-shell)");
    expect(motionSource).toContain("mix-blend-mode: normal");
    expect(motionSource).not.toContain("block-size: 100%");
    expect(motionSource).not.toContain("inline-size: 100%");
    expect(motionSource).toContain("wr-space-old-forward");
    expect(motionSource).toContain("wr-space-new-back");
  });
});
