-- 범용화: 코드 기본값 변경(geeknews 신규 설치 default-OFF, NewsSource::default_enabled)과 짝.
-- 뉴스가 실제로 흘렀던 기존 설치(news_items 행 존재 = fetcher가 이미 돌던 DB)는 구 기본값
-- (hn/geeknews/lobsters 3개 ON)을 explicit 행으로 고정해 동작을 보존한다.
-- 신규 설치는 이 시점에 news_items가 비어 있으므로(마이그레이션은 첫 fetch 전에 실행)
-- 아무것도 심지 않는다 → 코드 기본값 적용. 사용자가 명시로 끈 소스는 ON CONFLICT로 보존.
INSERT INTO news_source_pref (source, enabled)
SELECT legacy.source, 1
FROM (
    SELECT 'hn' AS source
    UNION ALL SELECT 'geeknews'
    UNION ALL SELECT 'lobsters'
) AS legacy
WHERE EXISTS (SELECT 1 FROM news_items LIMIT 1)
ON CONFLICT(source) DO NOTHING;
