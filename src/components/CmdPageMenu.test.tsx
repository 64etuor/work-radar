import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "@/lib/nav";

import { CmdPageMenu } from "./CmdPageMenu";

describe("CmdPageMenu", () => {
  it("모든 NAV_ITEMS 라벨을 칩으로 렌더한다", () => {
    const html = renderToStaticMarkup(<CmdPageMenu origin={{ x: 0, y: 0 }} />);
    for (const item of NAV_ITEMS) {
      expect(html).toContain(item.label);
    }
  });

  it("초기(측정 전)엔 visibility hidden으로 렌더한다(flash 방지)", () => {
    const html = renderToStaticMarkup(<CmdPageMenu origin={{ x: 0, y: 0 }} />);
    expect(html).toContain("visibility:hidden");
  });
});
