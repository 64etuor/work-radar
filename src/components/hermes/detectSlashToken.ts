export function detectSlashToken(
  text: string,
  caret: number,
): { active: boolean; query: string; start: number } {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  const start = i + 1;
  const token = text.slice(start, caret);
  return token.startsWith("/")
    ? { active: true, query: token.slice(1), start }
    : { active: false, query: "", start: -1 };
}
