import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

import type { AcpCommand } from "./types";

interface Props {
  items: AcpCommand[];
  activeIdx: number;
  onPick: (cmd: AcpCommand) => void;
  onHover: (idx: number) => void;
}

export function HermesSlashMenu({ items, activeIdx, onPick, onHover }: Props) {
  const ref = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const li = ref.current?.children[activeIdx] as HTMLElement | undefined;
    li?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (items.length === 0) return null;

  return (
    <ul
      ref={ref}
      className="bg-popover absolute right-3 bottom-full left-3 mb-2 max-h-56 overflow-auto rounded-md border text-sm shadow-md"
    >
      {items.map((c, i) => (
        <li
          key={c.name}
          className={cn("cursor-pointer px-3 py-1.5", i === activeIdx && "bg-accent")}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // avoid blur of textarea
            onPick(c);
          }}
        >
          <span className="font-mono">/{c.name}</span>
          {c.description && (
            <span className="text-muted-foreground ml-2 text-xs">{c.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
