import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LifeWheelTagConfig } from "@/bindings";
import { AreaRadialPalette, KindAreaChips } from "@/components/board/LifeWheelPalette";

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

describe("AreaRadialPalette", () => {
  const paletteTags: LifeWheelTagConfig[] = [
    ...tags,
    { id: "legacy", label: "레거시", color: "#75758a", builtIn: false, enabled: false },
  ];
  const render = (areaTags: string) =>
    renderToStaticMarkup(
      <AreaRadialPalette
        target={{ id: "s1", kind: "work", area: null, areaTags }}
        tags={paletteTags}
        anchor={{ x: 200, y: 200 }}
        onClose={vi.fn()}
        onSetAreaTagKey={vi.fn()}
      />,
    );

  it("hides disabled tags from the wheel", () => {
    const html = render(JSON.stringify(["health"]));

    expect(html).toContain("건강");
    expect(html).not.toContain("레거시");
  });

  it("keeps a disabled tag visible when it is the current selection", () => {
    const html = render(JSON.stringify(["legacy"]));

    expect(html).toContain("레거시");
  });
});
