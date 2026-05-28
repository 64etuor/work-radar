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
      role="listbox"
      className="bg-popover border-border/60 absolute right-0 bottom-full left-0 mb-2 max-h-56 overflow-auto rounded-xl border py-1.5 text-sm shadow-lg"
    >
      {items.map((c, i) => (
        <li
          key={c.name}
          role="option"
          tabIndex={-1}
          aria-selected={i === activeIdx}
          className={cn(
            "mx-1 cursor-pointer rounded-md px-2.5 py-1.5",
            i === activeIdx ? "bg-muted/80" : "hover:bg-muted/50",
          )}
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
