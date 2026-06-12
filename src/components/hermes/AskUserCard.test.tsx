import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AskUserCard } from "./AskUserCard";

const base = {
  id: "m1",
  role: "ask" as const,
  requestId: "7",
  toolName: "Write foo.txt",
  options: [
    { id: "allow", label: "Allow" },
    { id: "reject", label: "Reject" },
  ],
  ts: 0,
};

describe("AskUserCard", () => {
  it("renders the tool name and every option label", () => {
    const html = renderToStaticMarkup(<AskUserCard message={base} onRespond={() => {}} />);
    expect(html).toContain("Write foo.txt");
    expect(html).toContain("Allow");
    expect(html).toContain("Reject");
    // pending → buttons enabled. shadcn Button's cva base contains the `disabled:`
    // utility class, so assert on the rendered disabled ATTRIBUTE (`disabled=""`),
    // which is distinct from the `disabled:` class utility (trailing colon).
    expect(html).not.toContain('disabled=""');
  });

  it("disables options and marks the chosen one once resolved", () => {
    const html = renderToStaticMarkup(
      <AskUserCard message={{ ...base, resolved: "allow" }} onRespond={() => {}} />,
    );
    expect(html).toContain('disabled=""');
    // chosen option is flagged for the user (aria-pressed truthy)
    expect(html).toContain('aria-pressed="true"');
    // unchosen options are explicitly not-pressed once resolved (not omitted)
    expect(html).toContain('aria-pressed="false"');
  });

  it("groups the options with a native fieldset and accessible label", () => {
    const html = renderToStaticMarkup(<AskUserCard message={base} onRespond={() => {}} />);
    expect(html).toContain("<fieldset");
    expect(html).toContain('aria-label="Write foo.txt"');
  });

  it("falls back to a generic group label when toolName is absent", () => {
    const html = renderToStaticMarkup(
      <AskUserCard message={{ ...base, toolName: undefined }} onRespond={() => {}} />,
    );
    expect(html).toContain('aria-label="에이전트 선택 요청"');
  });

  it("renders a cancelled state when resolved='cancelled'", () => {
    const html = renderToStaticMarkup(
      <AskUserCard message={{ ...base, resolved: "cancelled" }} onRespond={() => {}} />,
    );
    expect(html).toContain("취소");
    expect(html).toContain('disabled=""');
  });
});
