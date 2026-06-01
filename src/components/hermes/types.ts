export type ToolCallSummary = { id?: string; title: string; kind?: string; status?: string };

export type HermesMessage =
  | { id: string; role: "user"; text: string; images: string[]; ts: number }
  | {
      id: string;
      role: "assistant";
      chunks: string[];
      toolCalls: ToolCallSummary[];
      ts: number;
      done: boolean;
    }
  | { id: string; role: "system"; text: string; level: "info" | "warn" | "error"; ts: number }
  | {
      id: string;
      role: "ask";
      requestId: string;
      toolName?: string;
      options: { id: string; label: string }[];
      /** chosen optionId, "cancelled", or undefined while pending */
      resolved?: string;
      ts: number;
    };

export type SessionStatus = "idle" | "starting" | "ready" | "error";

/** ACP slash command descriptor — mirrors the Rust AcpCommand struct. */
export type AcpCommand = { name: string; description: string | null };
