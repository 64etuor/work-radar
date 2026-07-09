-- 고정비(정기지출)에 출처를 부여한다. MoneyManager 백업의 REPEATTRANSACTION을
-- 정본으로 미러링하기 위한 (source, source_ref) 업서트 키.
--
-- 기존 행은 전부 사용자가 앱에서 만든 것이므로 source='manual', source_ref=NULL.
-- source_ref는 manual 행에서 NULL이라 부분 UNIQUE 인덱스(WHERE source_ref IS NOT NULL)로
-- 잡는다 — manual 행 여러 개가 NULL을 공유해도 충돌하지 않는다.

ALTER TABLE bookkeeping_recurring_expenses
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'moneymanager'));

ALTER TABLE bookkeeping_recurring_expenses
  ADD COLUMN source_ref TEXT;

-- ON CONFLICT(source, source_ref) WHERE source_ref IS NOT NULL 의 대상 인덱스.
CREATE UNIQUE INDEX bookkeeping_recurring_expenses_source_ref_idx
  ON bookkeeping_recurring_expenses(source, source_ref)
  WHERE source_ref IS NOT NULL;
