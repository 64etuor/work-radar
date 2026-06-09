import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LifeWheelTagConfig } from "@/bindings";
import { KindAreaChips } from "@/components/board/LifeWheelPalette";

const tags: LifeWheelTagConfig[] = [
  {
    id: "health",
    label: "건강",
    color: "#003c33",
    builtIn: true,
    enabled: true,
  },
];

describe("KindAreaChips", () => {
  it("renders read-only area tags as self-contained chips outside the board shell", () => {
    const html = renderToStaticMarkup(
      <KindAreaChips
        target={{ kind: "work", area: null, areaTags: JSON.stringify(["health"]) }}
        tags={tags}
      />,
    );

    expect(html).toContain("건강");
    expect(html).toContain("life-wheel-area-chip");
  });
});
