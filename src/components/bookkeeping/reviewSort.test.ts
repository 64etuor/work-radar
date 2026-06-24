import { describe, expect, it } from "vitest";

import { reviewOrderToQueryParam } from "./reviewSort";

describe("review sort mapping", () => {
  it("keeps default ordering backward compatible", () => {
    expect(reviewOrderToQueryParam("default")).toBeNull();
  });

  it("maps low-confidence ordering to the IPC parameter", () => {
    expect(reviewOrderToQueryParam("confidence_asc")).toBe("confidence_asc");
  });
});
