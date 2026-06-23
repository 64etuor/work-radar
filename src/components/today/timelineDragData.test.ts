import { describe, expect, it } from "vitest";

import { computeLayout, type TimedBlock } from "@/lib/timelineLayout";

import { dragDataForBox } from "./timelineDragData";

const ANCHOR = "2026-06-23";

function signalBlock(extra?: Partial<TimedBlock>): TimedBlock {
  return {
    id: "signal:s1",
    kind: "signal",
    title: "S1",
    startISO: "2026-06-23T09:00:00+09:00",
    endISO: "2026-06-23T10:00:00+09:00",
    calendarId: "calA",
    color: "#4a7bb8",
    signalId: "s1",
    ...extra,
  };
}

describe("dragDataForBox — signal", () => {
  it("carries linkedEventId when the signal block has one", () => {
    const block = signalBlock({ linkedEventId: "goog-evt-42" });
    const [box] = computeLayout([block], ANCHOR);
    const data = dragDataForBox(box, 60);
    expect(data.from).toBe("canvas");
    if (data.from === "canvas" && data.blockKind === "signal") {
      expect(data.linkedEventId).toBe("goog-evt-42");
    } else {
      throw new Error("unexpected drag data shape");
    }
  });

  it("leaves linkedEventId undefined when the signal block has none", () => {
    const block = signalBlock();
    const [box] = computeLayout([block], ANCHOR);
    const data = dragDataForBox(box, 60);
    if (data.from === "canvas" && data.blockKind === "signal") {
      expect(data.linkedEventId).toBeUndefined();
    } else {
      throw new Error("unexpected drag data shape");
    }
  });
});
