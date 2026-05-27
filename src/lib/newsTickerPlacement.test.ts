import { describe, expect, it } from "vitest";

import appSource from "../App.tsx?raw";
import captureBoardSource from "../components/CaptureBoard.tsx?raw";

declare const __dirname: string;
declare const require: (moduleName: string) => {
  readFileSync?: (path: string, encoding: string) => string;
  resolve?: (...paths: string[]) => string;
};

const { readFileSync } = require("fs");
const { resolve } = require("path");
const newsTickerCss =
  readFileSync?.(resolve?.(__dirname, "../components/news/NewsTicker.css") ?? "", "utf8") ?? "";

describe("news ticker placement", () => {
  it("mounts the ticker in global bottom chrome outside the view shell", () => {
    expect(appSource).toContain('import { NewsTicker } from "@/components/news/NewsTicker"');
    expect(appSource).toContain("<AgentStatusBar />");
    expect(appSource).toContain("<NewsTicker />");
    expect(appSource.indexOf('className="view-shell"')).toBeLessThan(
      appSource.indexOf("<NewsTicker />"),
    );
  });

  it("does not keep the ticker inside CaptureBoard", () => {
    expect(captureBoardSource).not.toContain("NewsTicker");
    expect(captureBoardSource).not.toContain("news-ticker-slot");
  });

  it("keeps the ticker outside manual view snapshots", () => {
    expect(newsTickerCss).toContain(".news-ticker-slot");
    expect(newsTickerCss).not.toContain("view-transition-name");
  });
});
