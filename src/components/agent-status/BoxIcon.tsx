import { Bot, MessagesSquare, PanelsTopLeft, Sparkles, SquareTerminal } from "lucide-react";

import type { SessionBox } from "./shared";

/**
 * box → lucide thin-line 아이콘.
 * cmux 세션은 engine="claude"로 들어오지만 멀티플렉서 정체성을 위해 별도 식별(분할 패널).
 * 식별은 key 접두사("cmux:")로 — openBox 라우팅과 동일 규약.
 */
export function BoxIcon({ box, size = 13 }: { box: SessionBox; size?: number }) {
  if (box.key.startsWith("cmux:")) return <PanelsTopLeft size={size} strokeWidth={1.5} />;
  switch (box.engine) {
    case "codex":
      return <SquareTerminal size={size} strokeWidth={1.5} />;
    case "hermes":
      return <MessagesSquare size={size} strokeWidth={1.5} />;
    case "claude":
      return <Sparkles size={size} strokeWidth={1.5} />;
    default:
      return <Bot size={size} strokeWidth={1.5} />;
  }
}
