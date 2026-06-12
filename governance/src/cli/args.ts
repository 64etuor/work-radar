// Tiny shared CLI arg parser (extracted from boule.ts so subcommand modules — schedule.ts — can
// reuse it without importing the CLI entrypoint module itself).

export interface ParsedArgs {
  cmd: string;
  flags: Record<string, string | boolean>;
}

/** Tiny arg parser: `--key value` | `--key=value` | `--flag` (boolean). First non-flag = command. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      if (!cmd) cmd = a;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      flags[a.slice(2)] = argv[++i]!;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { cmd, flags };
}

/** Index of the COMMAND token (the first non-flag, honouring `--key value` consumption) — used by
 *  two-level commands (`boule schedule install …`) to slice the sub-argv after the command. */
export function commandTokenIndex(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) return i;
    if (!a.includes("=") && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) i++;
  }
  return -1;
}
