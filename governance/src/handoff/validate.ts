/** The 7 required handoff sections (master design §8). A handoff missing any of these — or with
 *  any of them empty — is structurally invalid. Matching is case-insensitive on a markdown heading
 *  line (#/##/### …) whose text starts with the section name; the section's content is the text up
 *  to the next heading. PURE: no I/O. */
export const REQUIRED_SECTIONS = [
  "Mission",
  "Completed",
  "Current failing point",
  "Important implicit knowledge",
  "Next exact steps",
  "Do not do",
  "Open questions",
] as const;

export interface ValidationResult {
  ok: boolean;
  missing: string[]; // section names absent OR present-but-empty
}

interface Section {
  name: string;
  content: string;
}

/** Split a markdown body into heading→content sections. A heading line is `#{1,6} <text>`. */
function sections(body: string): Section[] {
  const lines = body.split("\n");
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of lines) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { name: m[1], content: "" };
    } else if (cur) {
      cur.content += line + "\n";
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function validateHandoff(body: string): ValidationResult {
  const found = sections(body);
  const foundByLowerName = new Map(found.map((section) => [section.name.toLowerCase(), section]));
  const missing: string[] = [];
  for (const required of REQUIRED_SECTIONS) {
    const requiredLower = required.toLowerCase();
    let match: Section | undefined;
    for (const [name, section] of foundByLowerName) {
      if (name.startsWith(requiredLower)) {
        match = section;
        break;
      }
    }
    if (!match || match.content.trim().length === 0) missing.push(required);
  }
  return { ok: missing.length === 0, missing };
}
