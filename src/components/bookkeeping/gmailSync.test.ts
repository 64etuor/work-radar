import { describe, expect, it } from "vitest";

import { GMAIL_DEFAULT_QUERY, GMAIL_FULL_RESCAN_QUERY, normalizeGmailQuery } from "./gmailSync";

describe("gmail sync query defaults", () => {
  it("defaults to an empty query so the durable per-project cursor drives incremental sync", () => {
    expect(GMAIL_DEFAULT_QUERY).toBe("");
  });

  it("offers a 90-day window as the explicit full-rescan override", () => {
    expect(GMAIL_FULL_RESCAN_QUERY).toBe("newer_than:90d");
  });
});

describe("normalizeGmailQuery", () => {
  it("maps an empty or whitespace query to null so the server uses the cursor", () => {
    expect(normalizeGmailQuery("")).toBeNull();
    expect(normalizeGmailQuery("   ")).toBeNull();
  });

  it("keeps an explicit query (trimmed) as a one-shot cursor override", () => {
    expect(normalizeGmailQuery("newer_than:90d")).toBe("newer_than:90d");
    expect(normalizeGmailQuery("  after:123  ")).toBe("after:123");
  });
});
