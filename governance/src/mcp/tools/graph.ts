import { z } from "zod";
import type { GraphStore } from "../../graph/types.ts";
import { rebuildIndex } from "../../graph/ingest.ts";
import type { ToolContext } from "./context.ts";

export type GraphDeps = {
  graphStore: GraphStore;
};

/** Derived graph index tools: rebuild_index, index_status, graph_node, graph_neighbors. */
export function registerGraphTools(ctx: ToolContext, deps: GraphDeps): void {
  const { server, workspace: WORKSPACE } = ctx;
  const { graphStore } = deps;

  server.registerTool(
    "rebuild_index",
    {
      description: "L0 마크다운 이벤트 → 파생 그래프 인덱스(events+nodes+edges) 멱등 재구축",
      inputSchema: {},
    },
    async () => {
      const st = await rebuildIndex(WORKSPACE, graphStore);
      return {
        content: [
          {
            type: "text",
            text: `index rebuilt: ${st.events} events, ${st.nodes} nodes, ${st.edges} edges (checksum ${st.checksum.slice(0, 8)})`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "index_status",
    { description: "그래프 인덱스 행 수 + 투영 checksum", inputSchema: {} },
    async () => {
      const st = await graphStore.status();
      const text =
        st.events === 0 && st.nodes === 0
          ? "index not built (run rebuild_index)"
          : `events ${st.events} · nodes ${st.nodes} · edges ${st.edges} · checksum ${st.checksum.slice(0, 8)}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "graph_node",
    {
      description: "노드 1개 조회 (node_id = `type:canonical_id`)",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const n = await graphStore.getNode(id);
      return {
        content: [{ type: "text", text: n ? JSON.stringify(n, null, 2) : `unknown node: ${id}` }],
      };
    },
  );

  server.registerTool(
    "graph_neighbors",
    { description: "노드 + 1-hop 인접 엣지/노드", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const nb = await graphStore.getNeighbors(id);
      return {
        content: [{ type: "text", text: nb ? JSON.stringify(nb, null, 2) : `unknown node: ${id}` }],
      };
    },
  );
}
