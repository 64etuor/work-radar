import { describe, expect, it } from "vitest";

import appSource from "../App.tsx?raw";
import captureBoardSource from "../components/CaptureBoard.tsx?raw";

describe("news ticker placement", () => {
  it("mounts the ticker in global bottom chrome outside the view shell", () => {
    expect(appSource).toContain('import { NewsTicker } from "@/components/news/NewsTicker"');
    expect(appSource).toContain("<AgentStatusBar />");
    expect(appSource).toContain("<NewsTicker />");
    expect(appSource.indexOf('<div key={view} className="view-shell">')).toBeLessThan(
      appSource.indexOf("<NewsTicker />"),
    );
  });

  it("does not keep the ticker inside CaptureBoard", () => {
    expect(captureBoardSource).not.toContain("NewsTicker");
    expect(captureBoardSource).not.toContain("news-ticker-slot");
  });
});
