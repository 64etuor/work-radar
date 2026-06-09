import { describe, expect, it } from "vitest";

import { nextBrainDumpKind } from "@/components/board/brainDumpKind";

describe("nextBrainDumpKind", () => {
  it("toggles work and personal", () => {
    expect(nextBrainDumpKind("work")).toBe("personal");
    expect(nextBrainDumpKind("personal")).toBe("work");
  });
});
