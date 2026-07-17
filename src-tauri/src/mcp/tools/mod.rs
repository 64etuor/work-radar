//! MCP 툴 표면 — 도메인별 모듈. 각 모듈은 `#[tool_router(router = tool_router_<domain>)]`을 단 하나의
//! `impl WrServer` 블록에 붙이고, 자기 DTO·정제 로직·스키마 테스트를 소유한다.
//! 합성은 `crate::mcp::WrServer::tool_router()` — 툴 추가 시 그 함수도 함께 갱신한다.

pub mod bookkeeping;
pub mod calendar;
pub mod diet;
pub mod diet_manage;
pub mod github;
pub mod gmail;
pub mod notion;
pub mod okr;
pub mod queue;
pub mod signals;
pub mod today;

/// 도메인 모듈의 스키마 스냅샷 테스트가 공유하는 헬퍼(§8: 표면 drift = 테스트 실패).
#[cfg(test)]
pub(crate) mod schema_test_support {
    use std::collections::BTreeSet;

    pub(crate) fn prop_names(v: &serde_json::Value) -> BTreeSet<String> {
        v["properties"]
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub(crate) fn required_fields(v: &serde_json::Value) -> BTreeSet<String> {
        v["required"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn expect(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }
}
