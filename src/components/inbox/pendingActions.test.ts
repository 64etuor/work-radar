import { describe, expect, it } from "vitest";

import type { PendingAction } from "../../bindings";
import {
  formatActionKind,
  groupPendingByOrigin,
  isExternalWriteKind,
  serviceOf,
} from "./pendingActions";

const mk = (over: Partial<PendingAction>): PendingAction => ({
  id: "1",
  kind: "noop",
  projectRef: null,
  preview: null,
  origin: "mcp:claude",
  status: "awaiting_approval",
  createdAt: "2026-06-04",
  ...over,
});

describe("pendingActions", () => {
  it("groups by origin agent", () => {
    const groups = groupPendingByOrigin([
      mk({ id: "a", origin: "mcp:claude" }),
      mk({ id: "b", origin: "mcp:codex" }),
      mk({ id: "c", origin: "mcp:claude" }),
    ]);
    expect(groups.get("mcp:claude")?.length).toBe(2);
    expect(groups.get("mcp:codex")?.length).toBe(1);
  });

  it("formats action kind for display", () => {
    expect(formatActionKind("github.comment")).toBe("GitHub · comment");
    expect(formatActionKind("noop")).toBe("noop");
  });

  it("flags external write kinds (dot) but not noop", () => {
    expect(isExternalWriteKind("github.issue_comment")).toBe(true);
    expect(isExternalWriteKind("github.create_issue")).toBe(true);
    expect(isExternalWriteKind("noop")).toBe(false);
  });

  it("extracts the service segment (null for non-dotted kinds)", () => {
    expect(serviceOf("github.issue_comment")).toBe("github");
    expect(serviceOf("notion.create_page")).toBe("notion");
    expect(serviceOf("noop")).toBeNull();
  });
});
