import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export interface RawCommit {
  sha: string; // full 40-hex commit hash (stable identity)
  committedAt: Date; // committer date
  author: string; // author name → event actor
  subject: string; // first line → event body
}

const US = "\x1f";
const RS = "\x1e";

/** Pure: parse `git log --pretty=format:%H%x1f%cI%x1f%an%x1f%s%x1e` stdout. */
export function parseGitLog(raw: string): RawCommit[] {
  const out: RawCommit[] = [];
  for (const record of raw.split(RS)) {
    const r = record.trim();
    if (!r) continue;
    const parts = r.split(US);
    if (parts.length < 4) continue;
    const [sha, iso, author, ...rest] = parts;
    if (!sha.trim() || !iso.trim()) continue;
    const committedAt = new Date(iso.trim());
    if (Number.isNaN(committedAt.getTime())) continue;
    out.push({
      sha: sha.trim(),
      committedAt,
      author: author.trim(),
      subject: rest.join(US).trim(),
    });
  }
  return out;
}

/** Impure boundary: run `git log` in repoRoot and return raw stdout. */
export async function realGitLog(repoRoot: string): Promise<string> {
  const { stdout } = await pexec(
    "git",
    ["-C", repoRoot, "log", "--no-color", `--pretty=format:%H${US}%cI${US}%an${US}%s${RS}`],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}
