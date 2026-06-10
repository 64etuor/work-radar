import { z } from "zod";
import { createTask } from "../handlers.ts";
import { startTask, blockTask, cancelTask, listTasks, taskTrail } from "../../task/handlers.ts";
import { completeTaskTool } from "../taskCompletion.ts";
import { okOrRefused } from "../response.ts";
import type { ToolContext } from "./context.ts";

/** Task lifecycle tools: create_task, start_task, block_task, complete_task, cancel_task, tasks, task. */
export function registerTaskTools(ctx: ToolContext): void {
  const { server, workspace: WORKSPACE, now: nowFn, rand: randFn } = ctx;

  server.registerTool(
    "create_task",
    {
      description: "할 일을 L0 task_created 이벤트로 기록",
      inputSchema: { description: z.string() },
    },
    async ({ description }) => {
      const r = await createTask(WORKSPACE, { description }, nowFn(), randFn());
      return { content: [{ type: "text", text: `task recorded: ${r.id}` }] };
    },
  );

  server.registerTool(
    "start_task",
    {
      description: "task를 active로 전이 (ready/blocked→active)",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const r = await startTask(WORKSPACE, { taskId }, nowFn(), randFn());
      return okOrRefused("started", r);
    },
  );

  server.registerTool(
    "block_task",
    {
      description: "task를 blocked로 전이 (사유 기록)",
      inputSchema: { taskId: z.string(), reason: z.string() },
    },
    async ({ taskId, reason }) => {
      const r = await blockTask(WORKSPACE, { taskId, reason }, nowFn(), randFn());
      return okOrRefused("blocked", r);
    },
  );

  server.registerTool(
    "complete_task",
    {
      description: "executor가 완료/정상 종료를 보고하는 verdict-free 힌트 (완료 판정 아님)",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const r = await completeTaskTool(WORKSPACE, { taskId }, nowFn(), randFn());
      return okOrRefused("reported", r);
    },
  );

  server.registerTool(
    "cancel_task",
    { description: "task를 cancelled로 전이 (terminal)", inputSchema: { taskId: z.string() } },
    async ({ taskId }) => {
      const r = await cancelTask(WORKSPACE, { taskId }, nowFn(), randFn());
      return okOrRefused("cancelled", r);
    },
  );

  server.registerTool(
    "tasks",
    { description: "비종료(non-terminal) task 목록", inputSchema: {} },
    async () => {
      const list = await listTasks(WORKSPACE);
      const text = list.length
        ? list.map((t) => `${t.taskId} [${t.phase}] ${t.title}`).join("\n")
        : "(no open tasks)";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "task",
    { description: "task 상태 + audit chain", inputSchema: { taskId: z.string() } },
    async ({ taskId }) => {
      const t = await taskTrail(WORKSPACE, { taskId });
      const chain = t.chain.map((c) => `  ${c.type} (${c.actor})`).join("\n");
      return { content: [{ type: "text", text: `${t.taskId} [${t.phase}] ${t.title}\n${chain}` }] };
    },
  );
}
