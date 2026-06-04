import { join } from "node:path";
import { openStore } from "./store.ts";
import type { GraphCredentialResolver, GraphPostgresOpener, GraphStore, GraphStoreConfig } from "./types.ts";

type Env = Record<string, string | undefined>;

export interface ResolveGraphStoreConfigInput {
  workspaceDir: string;
  env?: Env;
}

export interface OpenConfiguredGraphStoreInput extends ResolveGraphStoreConfigInput {
  config?: GraphStoreConfig;
  credentialResolver?: GraphCredentialResolver;
  openPgliteStore?: (loc: string) => Promise<GraphStore>;
  openPostgresStore?: GraphPostgresOpener;
}

export function resolveGraphStoreConfig(input: ResolveGraphStoreConfigInput): GraphStoreConfig {
  const env = input.env ?? process.env;
  const mode = (env.BOULE_GRAPH_STORE ?? "pglite").trim().toLowerCase();
  if (mode === "pglite") {
    return {
      kind: "pglite",
      loc: env.BOULE_GRAPH_PGLITE_LOC?.trim() || join(input.workspaceDir, "index", "pglite"),
    };
  }
  if (mode === "postgres") {
    return {
      kind: "postgres",
      connectionRef: env.BOULE_GRAPH_POSTGRES_CONNECTION_REF?.trim() ?? "",
      credentialRef: env.BOULE_GRAPH_POSTGRES_CREDENTIAL_REF?.trim() ?? "",
    };
  }
  throw new Error(`Unsupported graph store mode: ${mode}`);
}

export async function openConfiguredGraphStore(input: OpenConfiguredGraphStoreInput): Promise<GraphStore> {
  const config = input.config ?? resolveGraphStoreConfig(input);
  if (config.kind === "pglite") {
    return (input.openPgliteStore ?? openStore)(config.loc);
  }

  const connectionRef = config.connectionRef.trim();
  const credentialRef = config.credentialRef.trim();
  if (!connectionRef) throw new Error("Postgres graph store requires connection_ref");
  if (!credentialRef) throw new Error("Postgres graph store requires credential_ref");
  if (!input.credentialResolver) {
    throw new Error("Postgres graph store requires a keyring credential resolver");
  }

  const credential = (await input.credentialResolver(credentialRef))?.trim() ?? "";
  if (!credential) throw new Error("Postgres graph store keyring credential was empty");
  if (!input.openPostgresStore) {
    throw new Error("Postgres graph store requires a Postgres adapter opener");
  }
  return input.openPostgresStore({ connectionRef, credential });
}
