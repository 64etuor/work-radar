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
  const ref = useRef<HTMLMenuElement>(null);

  useEffect(() => {
    const li = ref.current?.children[activeIdx] as HTMLElement | undefined;
    li?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (items.length === 0) return null;

  return (
    <menu
      ref={ref}
      className="bg-popover border-border/60 absolute right-0 bottom-full left-0 mb-2 max-h-56 list-none overflow-auto rounded-xl border py-1.5 text-sm shadow-lg"
      aria-label="Hermes 명령"
    >
      {items.map((c, i) => (
        <li key={c.name}>
          <button
            type="button"
            tabIndex={-1}
            aria-current={i === activeIdx}
            className={cn(
              "mx-1 block w-[calc(100%-0.5rem)] cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-inherit",
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
          </button>
        </li>
      ))}
    </menu>
  );
}
