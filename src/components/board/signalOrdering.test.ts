import { describe, expect, it } from "vitest";

import { sortSignalsForBoard } from "@/components/board/signalOrdering";

describe("sortSignalsForBoard", () => {
  it("keeps newly captured unclassified cards after the existing stack", () => {
    const signals = [
      { id: "old-1", quadrant: "unclassified" },
      { id: "new-2", quadrant: "unclassified" },
      { id: "old-2", quadrant: "unclassified" },
      { id: "new-1", quadrant: "unclassified" },
    ] as never[];

    const sorted = sortSignalsForBoard(
      signals,
      new Map([
        ["new-1", 1],
        ["new-2", 2],
      ]),
    );

    expect(sorted.map((s) => s.id)).toEqual(["old-1", "old-2", "new-1", "new-2"]);
  });

  it("does not reorder classified cards", () => {
    const signals = [
      { id: "classified", quadrant: "q1_do_now" },
      { id: "new-1", quadrant: "unclassified" },
      { id: "old-1", quadrant: "unclassified" },
    ] as never[];

    const sorted = sortSignalsForBoard(signals, new Map([["new-1", 1]]));

    expect(sorted.map((s) => s.id)).toEqual(["classified", "old-1", "new-1"]);
  });
});
