// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { nextBrainDumpKind } from "@/components/board/brainDumpKind";
import { shouldOpenBrainDumpFromGlobalEnter } from "@/components/board/BrainDumpToggleEvents";

describe("nextBrainDumpKind", () => {
  it("toggles work and personal", () => {
    expect(nextBrainDumpKind("work")).toBe("personal");
    expect(nextBrainDumpKind("personal")).toBe("work");
  });
});

describe("shouldOpenBrainDumpFromGlobalEnter", () => {
  const enter = {
    key: "Enter",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
  };

  it("allows bare Enter when no control or overlay owns the event", () => {
    expect(shouldOpenBrainDumpFromGlobalEnter(enter, document.body, false)).toBe(true);
  });

  it("does not steal Enter from focused buttons", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    expect(shouldOpenBrainDumpFromGlobalEnter(enter, button, false)).toBe(false);
  });

  it("does not steal Enter after another handler already prevented default", () => {
    expect(
      shouldOpenBrainDumpFromGlobalEnter(
        { ...enter, defaultPrevented: true },
        document.body,
        false,
      ),
    ).toBe(false);
  });

  it("does not steal Enter while another overlay is open", () => {
    expect(shouldOpenBrainDumpFromGlobalEnter(enter, document.body, true)).toBe(false);
  });
});
