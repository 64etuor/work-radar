import { describe, expect, it, vi } from "vitest";
import { openConfiguredGraphStore, resolveGraphStoreConfig } from "../../src/graph/config.js";
import type { GraphStore } from "../../src/graph/types.js";

function fakeStore(): GraphStore {
  return {
    async rebuild() {},
    async upsert() {},
    async status() { return { events: 0, nodes: 0, edges: 0, checksum: "empty" }; },
    async getNode() { return null; },
    async getNeighbors() { return null; },
    async close() {},
  };
}

describe("graph store config", () => {
  it("defaults to the workspace PGlite cache", () => {
    expect(resolveGraphStoreConfig({ workspaceDir: "/tmp/gov", env: {} })).toEqual({
      kind: "pglite",
      loc: "/tmp/gov/index/pglite",
    });
  });

  it("accepts an explicit PGlite location for tests", () => {
    expect(resolveGraphStoreConfig({
      workspaceDir: "/tmp/gov",
      env: { BOULE_GRAPH_STORE: "pglite", BOULE_GRAPH_PGLITE_LOC: ":memory:" },
    })).toEqual({ kind: "pglite", loc: ":memory:" });
  });

  it("rejects an unknown graph store mode", () => {
    expect(() => resolveGraphStoreConfig({
      workspaceDir: "/tmp/gov",
      env: { BOULE_GRAPH_STORE: "sqlite" },
    })).toThrow("Unsupported graph store mode");
  });

  it("fails closed when Postgres mode has no credential ref", async () => {
    await expect(openConfiguredGraphStore({
      workspaceDir: "/tmp/gov",
      config: { kind: "postgres", connectionRef: "work-radar/dev", credentialRef: "" },
    })).rejects.toThrow("Postgres graph store requires credential_ref");
  });

  it("fails closed when Postgres mode has no keyring credential resolver", async () => {
    await expect(openConfiguredGraphStore({
      workspaceDir: "/tmp/gov",
      config: { kind: "postgres", connectionRef: "work-radar/dev", credentialRef: "pg/dev" },
    })).rejects.toThrow("Postgres graph store requires a keyring credential resolver");
  });

  it("fails closed when keyring returns an empty credential", async () => {
    await expect(openConfiguredGraphStore({
      workspaceDir: "/tmp/gov",
      config: { kind: "postgres", connectionRef: "work-radar/dev", credentialRef: "pg/dev" },
      credentialResolver: async () => "   ",
    })).rejects.toThrow("keyring credential was empty");
  });

  it("passes only the connection ref and resolved keyring credential to the injected Postgres opener", async () => {
    const store = fakeStore();
    const openPostgresStore = vi.fn(async () => store);
    const credentialResolver = vi.fn(async () => "postgres://resolved-by-keyring");

    await expect(openConfiguredGraphStore({
      workspaceDir: "/tmp/gov",
      config: { kind: "postgres", connectionRef: "work-radar/dev", credentialRef: "pg/dev" },
      credentialResolver,
      openPostgresStore,
    })).resolves.toBe(store);

    expect(credentialResolver).toHaveBeenCalledWith("pg/dev");
    expect(openPostgresStore).toHaveBeenCalledWith({
      connectionRef: "work-radar/dev",
      credential: "postgres://resolved-by-keyring",
    });
  });
});
