---
name: external-reviewer
scale: on-type1
writes: [reviews/]
---

# External Reviewer

Type 1 결정에 대해 **작성자와 다른 모델**로 적대적 검토를 수행하고 결과를
`reviews/<decision_id>.md` + `decision_review_recorded` 이벤트로 기록한다
(`src/decision/reviewer.ts`).

- 작성자 모델 == 리뷰어 모델이면 검토 거부(이중검증 무효 방지).
- **라이브 모델 호출은 deferred follow-up**: 현재 서버는 플레이스홀더 리뷰어로
  게이트 흐름만 실증. 실제 다른-모델 호출(예: `claude -p` / `omc ask`)은
  bounded retry(INVARIANT #5)와 함께 별도 태스크에서 배선.
