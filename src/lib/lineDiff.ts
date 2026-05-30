/**
 * 라인 단위 diff(Phase 4 #18) — **순수 함수**(부수효과 없음, vitest 대상).
 *
 * 인앱 프롬프트의 사용자 편집본을 코드 상수 폴백(`Skill.fallbackPrompt`)과 비교해 Sheet에서 보여준다.
 * 신규 의존성 없이 LCS(최장 공통 부분수열)로 라인 정렬 — 프롬프트 템플릿은 작아 O(m*n) DP로 충분.
 * `base`=기본값(코드 상수), `current`=현재 편집본. remove=기본에만(=사용자가 지움), add=현재에만(=추가).
 */

export type DiffOp = "equal" | "add" | "remove";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** base(기본값) → current(편집본) 라인 diff. LCS 기반으로 equal/remove/add 시퀀스를 만든다. */
export function lineDiff(base: string, current: string): DiffLine[] {
  const a = base.split("\n");
  const b = current.split("\n");
  const m = a.length;
  const n = b.length;

  // dp[i][j] = a[i..]와 b[j..]의 LCS 길이.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: "remove", text: a[i] });
      i++;
    } else {
      out.push({ op: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) {
    out.push({ op: "remove", text: a[i] });
    i++;
  }
  while (j < n) {
    out.push({ op: "add", text: b[j] });
    j++;
  }
  return out;
}

/** diff에서 추가/삭제 라인 수 요약(표시용 배지). equal 제외. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "remove") removed++;
  }
  return { added, removed };
}
