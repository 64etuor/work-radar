# CI 실패 알림 (Phase 20 #17)

GitHub Actions의 CI 실패를 work-radar 앱 알림으로 받는다. **자동 triage 없음** — 앱은
**네이티브 알림 + Q1 결정 큐 escalate**까지만 하고, 실제 결정/수정은 사람이 한다(INVARIANT #1).

## 1차 경로 (기본 — 추가 인프라 없음): 앱-측 폴링 감지

PR Radar(`refresh_pr_radar`)가 기존 GitHub 폴링 cycle에서 PR의 CI 상태를 도출한다. 다음 조건을
만족하는 PR을 감지하면:

- open PR + CI 실패 + 링크 백로그 티켓 (= 기존 escalation 임계치, INVARIANT #4)

앱이 자동으로:

1. 해당 PR 신호를 **Q1 결정 큐로 escalate**(`suggested_quadrant=q1`, 항상 `unclassified` 진입 —
   자동 분류 0, INVARIANT #1). 기존 PR escalation 메커니즘 재사용.
2. **네이티브 알림**을 큐잉(Phase 13 `scheduled_notifications` 경로) → 백그라운드 스케줄러가
   다음 틱에 발사. 트레이 상주이므로 **창을 닫아도** 알림이 뜬다.

### Notify 캡 (dedup — INVARIANT #5)

같은 실패로 두 번 알리지 않는다. dedup 키는 **PR + head 커밋 SHA**:

```
source_id = pr:{owner}/{repo}:{number}:{head_sha}
```

- 같은 커밋이 계속 실패해도(폴링 N회) 알림은 **1회**.
- 새 커밋을 push했는데 **또** 실패하면 새 SHA → 알림 1회(별개 실패).
- 발사 마커는 로컬 SQLite(`scheduled_notifications`)에 영속(INVARIANT #7) — 재부팅해도 중복 0.

추가 폴링/busy-loop 없음 — 기존 PR Radar 폴링 cycle에 올라탄다.

## 보강 경로 (선택 — push 채널): GitHub Actions `if: failure()` 훅

1차 경로로 충분하지만, 실패 컨텍스트(잡명/로그 URL)를 더 빨리 받고 싶으면 워크플로에
`if: failure()` 스텝을 추가해 경량 푸시 채널로 보낸다. **권장 채널: [ntfy.sh](https://ntfy.sh)**
— 계정 불필요, topic 하나면 즉시 push/구독 가능.

CI 워크플로(`.github/workflows/ci.yml`) 각 job 끝에 추가:

```yaml
      # CI 실패 시 ntfy.sh로 컨텍스트 push (보강 채널 — 1차는 앱-측 폴링 감지).
      # WR_NTFY_TOPIC 은 추측 어려운 임의 문자열로(공개 토픽이므로 사실상 비밀).
      - name: Notify on failure (ntfy.sh)
        if: failure()
        run: |
          curl -fsS \
            -H "Title: CI 실패: ${{ github.repository }} #${{ github.run_number }}" \
            -H "Tags: rotating_light" \
            -H "Click: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            -d "job=${{ github.job }} ref=${{ github.ref_name }} by=${{ github.actor }}" \
            "https://ntfy.sh/${{ vars.WR_NTFY_TOPIC || 'work-radar-ci-CHANGE-ME' }}"
```

앱은 이 topic을 SSE(`https://ntfy.sh/<topic>/sse`)로 구독해 동일한 알림 경로로 띄울 수 있다.
단 **1차 경로는 앱-측 폴링 감지**이며, push 채널은 어디까지나 보강이다 — push 채널이 죽어도
앱은 폴링으로 실패를 감지한다(graceful).

> 푸시 채널을 과설계하지 않는다. ntfy 구독 SSE 클라이언트는 필요할 때만 추가한다.

## INVARIANT 적합성

| INVARIANT | 처리 |
|---|---|
| #1 (결정 레일 사람만) | CI 봇은 자동 분류/triage 0 — 알림 + Q1 escalate(결정 큐 항목)까지만. |
| #4 (임계치 escalate) | CI 실패 + 링크 티켓만 escalate(noise 0). |
| #5 (bounded + 캡) | 기존 폴링에 올라타고, PR+SHA dedup으로 중복 알림 0. |
| #7 (SQLite SSOT) | 발사 마커는 `scheduled_notifications` 로컬 영속. |
