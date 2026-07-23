//! Reading 도메인 순수 커널 (docs/plans/2026-07-23-reading-domain.md).
//!
//! 카탈로그 provider(Google Books / Open Library) 응답 파싱, ISBN 정규화, 스트릭 계산 —
//! 전부 결정론 순수 함수. 네트워크/DB 글루는 `commands/reading/`에 있다(ipc-conventions
//! 의 도메인 vs 글루 경계).

use chrono::NaiveDate;
use serde::Deserialize;

use crate::models::CatalogBook;

pub const SOURCE_GOOGLE_BOOKS: &str = "google_books";
pub const SOURCE_OPEN_LIBRARY: &str = "open_library";
pub const SOURCE_ALADIN: &str = "aladin";

/// 입력 문자열이 ISBN-10/13이면 하이픈/공백 제거된 정규형을 돌려준다(검색어 → isbn 쿼리 분기).
/// 체크섬까지는 검증하지 않는다 — provider가 최종 판정하고, 오탐 비용은 빈 결과일 뿐이다.
pub fn normalize_isbn(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    let is_isbn10 = cleaned.len() == 10
        && cleaned[..9].bytes().all(|b| b.is_ascii_digit())
        && (cleaned.as_bytes()[9].is_ascii_digit() || cleaned.ends_with(['x', 'X']));
    let is_isbn13 = cleaned.len() == 13 && cleaned.bytes().all(|b| b.is_ascii_digit());
    if is_isbn10 || is_isbn13 {
        Some(cleaned.to_uppercase())
    } else {
        None
    }
}

/// 표지 URL 정규화 — Google Books 썸네일이 http로 오는 경우가 있어 https로 승격한다.
fn https_cover(url: String) -> String {
    match url.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => url,
    }
}

fn clean_opt(raw: Option<String>) -> Option<String> {
    raw.and_then(|v| {
        let t = v.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    })
}

// ── Google Books ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GbResponse {
    #[serde(default)]
    items: Vec<GbItem>,
}

#[derive(Deserialize)]
struct GbItem {
    id: Option<String>,
    #[serde(rename = "volumeInfo")]
    volume_info: Option<GbVolumeInfo>,
}

#[derive(Deserialize, Default)]
struct GbVolumeInfo {
    title: Option<String>,
    subtitle: Option<String>,
    #[serde(default)]
    authors: Vec<String>,
    publisher: Option<String>,
    #[serde(rename = "publishedDate")]
    published_date: Option<String>,
    description: Option<String>,
    #[serde(rename = "industryIdentifiers", default)]
    industry_identifiers: Vec<GbIdentifier>,
    #[serde(rename = "pageCount")]
    page_count: Option<i32>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(rename = "imageLinks")]
    image_links: Option<GbImageLinks>,
    language: Option<String>,
}

#[derive(Deserialize)]
struct GbIdentifier {
    #[serde(rename = "type")]
    kind: Option<String>,
    identifier: Option<String>,
}

#[derive(Deserialize)]
struct GbImageLinks {
    thumbnail: Option<String>,
    #[serde(rename = "smallThumbnail")]
    small_thumbnail: Option<String>,
}

/// Google Books volumes 응답 → 정규화 카탈로그 목록. 제목 없는 항목은 버린다.
pub fn parse_google_books(body: &str) -> Result<Vec<CatalogBook>, serde_json::Error> {
    let parsed: GbResponse = serde_json::from_str(body)?;
    Ok(parsed
        .items
        .into_iter()
        .filter_map(|item| {
            let info = item.volume_info?;
            let title = clean_opt(info.title)?;
            let mut isbn13 = None;
            let mut isbn10 = None;
            for id in info.industry_identifiers {
                match (id.kind.as_deref(), id.identifier) {
                    (Some("ISBN_13"), Some(v)) => isbn13 = normalize_isbn(&v),
                    (Some("ISBN_10"), Some(v)) => isbn10 = normalize_isbn(&v),
                    _ => {}
                }
            }
            let cover_url = info
                .image_links
                .and_then(|l| l.thumbnail.or(l.small_thumbnail))
                .map(https_cover);
            Some(CatalogBook {
                title,
                subtitle: clean_opt(info.subtitle),
                authors: info.authors,
                publisher: clean_opt(info.publisher),
                published_date: clean_opt(info.published_date),
                isbn13,
                isbn10,
                page_count: info.page_count.filter(|p| *p > 0),
                cover_url,
                description: clean_opt(info.description),
                categories: info.categories,
                language: clean_opt(info.language),
                source: SOURCE_GOOGLE_BOOKS.to_string(),
                source_ref: item.id,
            })
        })
        .collect())
}

// ── Open Library ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct OlResponse {
    #[serde(default)]
    docs: Vec<OlDoc>,
}

#[derive(Deserialize)]
struct OlDoc {
    key: Option<String>,
    title: Option<String>,
    #[serde(default)]
    author_name: Vec<String>,
    #[serde(default)]
    publisher: Vec<String>,
    first_publish_year: Option<i32>,
    #[serde(default)]
    isbn: Vec<String>,
    number_of_pages_median: Option<i32>,
    cover_i: Option<i64>,
    #[serde(default)]
    language: Vec<String>,
}

/// Open Library search 응답 → 정규화 카탈로그 목록(Google 폴백).
pub fn parse_open_library(body: &str) -> Result<Vec<CatalogBook>, serde_json::Error> {
    let parsed: OlResponse = serde_json::from_str(body)?;
    Ok(parsed
        .docs
        .into_iter()
        .filter_map(|doc| {
            let title = clean_opt(doc.title)?;
            let mut isbn13 = None;
            let mut isbn10 = None;
            for raw in &doc.isbn {
                if let Some(norm) = normalize_isbn(raw) {
                    match norm.len() {
                        13 if isbn13.is_none() => isbn13 = Some(norm),
                        10 if isbn10.is_none() => isbn10 = Some(norm),
                        _ => {}
                    }
                }
            }
            let cover_url = doc
                .cover_i
                .map(|id| format!("https://covers.openlibrary.org/b/id/{id}-M.jpg"));
            Some(CatalogBook {
                title,
                subtitle: None,
                authors: doc.author_name,
                publisher: doc.publisher.into_iter().next(),
                published_date: doc.first_publish_year.map(|y| y.to_string()),
                isbn13,
                isbn10,
                page_count: doc.number_of_pages_median.filter(|p| *p > 0),
                cover_url,
                description: None,
                categories: Vec::new(),
                language: doc.language.into_iter().next(),
                source: SOURCE_OPEN_LIBRARY.to_string(),
                source_ref: doc.key,
            })
        })
        .collect())
}

// ── Aladin TTB ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct AladinResponse {
    #[serde(default)]
    item: Vec<AladinItem>,
    #[serde(rename = "errorCode")]
    error_code: Option<i64>,
}

#[derive(Deserialize)]
struct AladinItem {
    title: Option<String>,
    author: Option<String>,
    #[serde(rename = "pubDate")]
    pub_date: Option<String>,
    description: Option<String>,
    isbn: Option<String>,
    isbn13: Option<String>,
    #[serde(rename = "itemId")]
    item_id: Option<i64>,
    cover: Option<String>,
    #[serde(rename = "categoryName")]
    category_name: Option<String>,
    publisher: Option<String>,
}

/// "칼 세이건 (지은이), 홍승수 (옮긴이)" → ["칼 세이건", "홍승수"] (역할 괄호 제거, 역자 유지 —
/// 옵시디언 임포트와 동일 표기).
fn parse_aladin_authors(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|part| {
            let part = part.trim();
            match part.find(" (") {
                Some(idx) => part[..idx].trim().to_string(),
                None => part.to_string(),
            }
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// Aladin ItemSearch/ItemLookUp 응답 → 정규화 카탈로그 목록.
/// API 에러(errorCode)는 `Err(코드)`로 구분한다(잘못된 키 등 — 파싱 실패와 별개).
pub fn parse_aladin(body: &str) -> Result<Vec<CatalogBook>, String> {
    let parsed: AladinResponse = serde_json::from_str(body).map_err(|e| format!("json: {e}"))?;
    if let Some(code) = parsed.error_code {
        return Err(format!("aladin api error {code}"));
    }
    Ok(parsed
        .item
        .into_iter()
        .filter_map(|item| {
            let title = clean_opt(item.title)?;
            let categories: Vec<String> = item
                .category_name
                .as_deref()
                .map(|c| c.split('>').map(|s| s.trim().to_string()).collect())
                .unwrap_or_default();
            let language = categories
                .first()
                .and_then(|top| (top == "국내도서").then(|| "ko".to_string()));
            let isbn13 = item.isbn13.as_deref().and_then(normalize_isbn13);
            let isbn10 = item.isbn.as_deref().and_then(normalize_isbn10);
            Some(CatalogBook {
                title,
                subtitle: None,
                authors: item
                    .author
                    .as_deref()
                    .map(parse_aladin_authors)
                    .unwrap_or_default(),
                publisher: clean_opt(item.publisher),
                published_date: clean_opt(item.pub_date),
                source_ref: isbn13
                    .clone()
                    .or_else(|| item.item_id.map(|id| id.to_string())),
                isbn13,
                isbn10,
                page_count: None,
                cover_url: clean_opt(item.cover).map(https_cover),
                description: clean_opt(item.description),
                categories,
                language,
                source: SOURCE_ALADIN.to_string(),
            })
        })
        .collect())
}

fn normalize_isbn13(raw: &str) -> Option<String> {
    normalize_isbn(raw).filter(|v| v.len() == 13)
}

fn normalize_isbn10(raw: &str) -> Option<String> {
    normalize_isbn(raw).filter(|v| v.len() == 10)
}

// ── 검색 쿼리 변형·유사도 랭킹 ───────────────────────────────────────

pub fn contains_hangul(s: &str) -> bool {
    s.chars()
        .any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c) || ('\u{1100}'..='\u{11FF}').contains(&c))
}

/// 매칭용 정규화 — 소문자 + 영숫자/한글만(공백·문장부호·'：' 등 제거).
/// "바보들은항상남의탓만한다" == "바보들은 항상 남의 탓만 한다".
pub fn normalize_for_match(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 검색 실패 시 시도할 쿼리 사다리: 원문 → 공백 제거 → 앞쪽 절반 토큰(3토큰 이상일 때).
/// 띄어쓰기가 달라도, 부제까지 다 입력하지 않아도 후보가 잡히게 한다.
pub fn query_variants(raw: &str) -> Vec<String> {
    let raw = raw.trim();
    let mut out = vec![raw.to_string()];
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let collapsed = tokens.join("");
    if collapsed != raw && !collapsed.is_empty() {
        out.push(collapsed);
    }
    if tokens.len() >= 3 {
        let half = tokens[..tokens.len().div_ceil(2)].join(" ");
        if !out.contains(&half) {
            out.push(half);
        }
    }
    out
}

fn char_bigrams(s: &str) -> std::collections::HashSet<(char, char)> {
    let chars: Vec<char> = s.chars().collect();
    chars.windows(2).map(|w| (w[0], w[1])).collect()
}

/// 쿼리 대비 제목 유사도: 3=정규화 일치, 2=포함, 1=문자 bigram Dice ≥ 0.4, 0=무관.
pub fn similarity_score(query: &str, title: &str) -> u8 {
    let q = normalize_for_match(query);
    let t = normalize_for_match(title);
    if q.is_empty() || t.is_empty() {
        return 0;
    }
    if q == t {
        return 3;
    }
    if t.contains(&q) || q.contains(&t) {
        return 2;
    }
    let qb = char_bigrams(&q);
    let tb = char_bigrams(&t);
    if qb.is_empty() || tb.is_empty() {
        return 0;
    }
    let inter = qb.intersection(&tb).count();
    let dice = (2 * inter) as f64 / (qb.len() + tb.len()) as f64;
    if dice >= 0.4 {
        1
    } else {
        0
    }
}

/// 카탈로그 결과 랭킹: 유사도 desc → (한글 쿼리면) 한국어판 우선 → 표지 있는 것 우선.
/// 결과를 버리지는 않는다(완화 variant의 낮은 점수 후보도 "비슷한 후보"로 보여준다).
pub fn rank_catalog_results(query: &str, results: Vec<CatalogBook>) -> Vec<CatalogBook> {
    let korean_first = contains_hangul(query);
    let mut scored: Vec<(u8, bool, bool, usize, CatalogBook)> = results
        .into_iter()
        .enumerate()
        .map(|(i, b)| {
            let full_title = match &b.subtitle {
                Some(sub) => format!("{} {sub}", b.title),
                None => b.title.clone(),
            };
            let score = similarity_score(query, &full_title).max(similarity_score(query, &b.title));
            let ko = korean_first && b.language.as_deref() == Some("ko");
            let cover = b.cover_url.is_some();
            (score, ko, cover, i, b)
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.1.cmp(&a.1))
            .then(b.2.cmp(&a.2))
            .then(a.3.cmp(&b.3))
    });
    scored.into_iter().map(|(_, _, _, _, b)| b).collect()
}

// ── 스트릭 ───────────────────────────────────────────────────────────

/// 세션이 있던 날짜 집합에서 오늘 기준 연속 일수를 센다. 오늘 세션이 없으면 어제부터
/// 세되(오늘 아직 안 읽었다고 스트릭이 0이 되지 않게), 어제도 없으면 0.
pub fn streak_days(mut dates: Vec<NaiveDate>, today: NaiveDate) -> i32 {
    dates.sort_unstable();
    dates.dedup();
    let set: std::collections::HashSet<NaiveDate> = dates.into_iter().collect();
    let mut cursor = if set.contains(&today) {
        today
    } else {
        let yesterday = today.pred_opt();
        match yesterday {
            Some(y) if set.contains(&y) => y,
            _ => return 0,
        }
    };
    let mut count = 0i32;
    while set.contains(&cursor) {
        count += 1;
        match cursor.pred_opt() {
            Some(prev) => cursor = prev,
            None => break,
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn isbn_normalization_accepts_10_and_13_with_hyphens() {
        assert_eq!(
            normalize_isbn("978-89-6626-042-9"),
            Some("9788966260429".into())
        );
        assert_eq!(normalize_isbn("89-6626-042-x"), Some("896626042X".into()));
        assert_eq!(normalize_isbn("하드씽"), None);
        assert_eq!(normalize_isbn("12345"), None);
        assert_eq!(normalize_isbn("978896626042"), None, "12자리는 ISBN 아님");
    }

    #[test]
    fn google_books_response_parses_to_catalog_books() {
        let body = r#"{
          "items": [{
            "id": "vol1",
            "volumeInfo": {
              "title": "하드씽",
              "subtitle": "경영의 난제를 푸는 최선의 한 수",
              "authors": ["벤 호로위츠", "안진환"],
              "publisher": "한국경제신문",
              "publishedDate": "2021-03-15",
              "description": "실리콘밸리 CEO의 경영 난제.",
              "industryIdentifiers": [
                {"type": "ISBN_13", "identifier": "9788965403302"},
                {"type": "ISBN_10", "identifier": "8965403308"}
              ],
              "pageCount": 412,
              "categories": ["Business"],
              "imageLinks": {"thumbnail": "http://books.google.com/thumb.jpg"},
              "language": "ko"
            }
          }, {
            "id": "no-title",
            "volumeInfo": {}
          }]
        }"#;
        let books = parse_google_books(body).unwrap();
        assert_eq!(books.len(), 1, "제목 없는 항목은 버린다");
        let b = &books[0];
        assert_eq!(b.title, "하드씽");
        assert_eq!(b.authors.len(), 2);
        assert_eq!(b.isbn13.as_deref(), Some("9788965403302"));
        assert_eq!(b.page_count, Some(412));
        assert_eq!(
            b.cover_url.as_deref(),
            Some("https://books.google.com/thumb.jpg"),
            "http 표지는 https로 승격"
        );
        assert_eq!(b.source, SOURCE_GOOGLE_BOOKS);
        assert_eq!(b.source_ref.as_deref(), Some("vol1"));
    }

    #[test]
    fn google_books_empty_response_is_ok() {
        assert!(parse_google_books("{}").unwrap().is_empty());
    }

    #[test]
    fn open_library_response_parses_with_cover_and_isbn_split() {
        let body = r#"{
          "docs": [{
            "key": "/works/OL123W",
            "title": "Show Your Work!",
            "author_name": ["Austin Kleon"],
            "publisher": ["Workman"],
            "first_publish_year": 2014,
            "isbn": ["9780761178972", "076117897X"],
            "number_of_pages_median": 215,
            "cover_i": 8091016,
            "language": ["eng"]
          }]
        }"#;
        let books = parse_open_library(body).unwrap();
        assert_eq!(books.len(), 1);
        let b = &books[0];
        assert_eq!(b.isbn13.as_deref(), Some("9780761178972"));
        assert_eq!(b.isbn10.as_deref(), Some("076117897X"));
        assert_eq!(
            b.cover_url.as_deref(),
            Some("https://covers.openlibrary.org/b/id/8091016-M.jpg")
        );
        assert_eq!(b.published_date.as_deref(), Some("2014"));
        assert_eq!(b.source, SOURCE_OPEN_LIBRARY);
    }

    #[test]
    fn aladin_response_parses_authors_categories_and_language() {
        let body = r#"{
          "version": "20131101",
          "item": [{
            "title": "코스모스",
            "author": "칼 세이건 (지은이), 홍승수 (옮긴이)",
            "pubDate": "2006-12-20",
            "description": "우주 교양의 고전.",
            "isbn": "8983711892",
            "isbn13": "9788983711892",
            "itemId": 888888,
            "cover": "http://image.aladin.co.kr/product/59/1/cover/8983711892_2.jpg",
            "categoryName": "국내도서>과학>기초과학/교양과학",
            "publisher": "사이언스북스"
          }]
        }"#;
        let books = parse_aladin(body).unwrap();
        assert_eq!(books.len(), 1);
        let b = &books[0];
        assert_eq!(b.authors, vec!["칼 세이건", "홍승수"], "역할 괄호 제거");
        assert_eq!(b.isbn13.as_deref(), Some("9788983711892"));
        assert_eq!(b.isbn10.as_deref(), Some("8983711892"));
        assert_eq!(b.language.as_deref(), Some("ko"), "국내도서 → ko");
        assert_eq!(b.categories[0], "국내도서");
        assert!(b.cover_url.as_deref().unwrap().starts_with("https://"));
        assert_eq!(b.source, SOURCE_ALADIN);
        assert_eq!(b.source_ref.as_deref(), Some("9788983711892"));
    }

    #[test]
    fn aladin_api_error_code_is_surfaced_not_swallowed() {
        let err = parse_aladin(r#"{"errorCode":100,"errorMessage":"잘못된 TTBKey"}"#);
        assert!(err.unwrap_err().contains("100"));
        assert!(parse_aladin("{}").unwrap().is_empty(), "빈 결과는 정상");
    }

    #[test]
    fn match_normalization_ignores_spacing_and_punctuation() {
        assert_eq!(
            normalize_for_match("바보들은 항상 남의 탓만 한다!"),
            normalize_for_match("바보들은항상남의탓만한다")
        );
        assert_eq!(normalize_for_match("Show Your Work!"), "showyourwork");
        assert!(contains_hangul("코스모스"));
        assert!(!contains_hangul("Cosmos"));
    }

    #[test]
    fn query_variants_ladder_relaxes_spacing_then_tokens() {
        let v = query_variants("바보들은 항상 남의 탓만 한다");
        assert_eq!(v[0], "바보들은 항상 남의 탓만 한다");
        assert_eq!(v[1], "바보들은항상남의탓만한다", "공백 제거 변형");
        assert_eq!(v[2], "바보들은 항상 남의", "앞쪽 절반 토큰");
        assert_eq!(
            query_variants("코스모스"),
            vec!["코스모스"],
            "단일 토큰은 원문만"
        );
    }

    #[test]
    fn similarity_and_ranking_prefer_close_korean_titles() {
        assert_eq!(
            similarity_score(
                "바보들은항상 남의 탓만 한다",
                "바보들은 항상 남의 탓만 한다"
            ),
            3
        );
        assert_eq!(similarity_score("코스모스", "코스모스 : 가능한 세계들"), 2);
        assert_eq!(similarity_score("코스모스", "완전히 다른 책"), 0);

        let mk = |title: &str, lang: Option<&str>| CatalogBook {
            title: title.to_string(),
            subtitle: None,
            authors: vec![],
            publisher: None,
            published_date: None,
            isbn13: None,
            isbn10: None,
            page_count: None,
            cover_url: None,
            description: None,
            categories: vec![],
            language: lang.map(str::to_string),
            source: SOURCE_GOOGLE_BOOKS.to_string(),
            source_ref: None,
        };
        let ranked = rank_catalog_results(
            "코스모스",
            vec![
                mk("Cosmos", Some("en")),
                mk("무관한 소설", Some("ko")),
                mk("코스모스", Some("ko")),
            ],
        );
        assert_eq!(ranked[0].title, "코스모스", "정확 일치 + 한국어판 최상단");
        // 나머지는 전부 무관(점수 0) — 동점끼리는 한국어판 우선 타이브레이크.
        assert_eq!(ranked[1].title, "무관한 소설");
        assert_eq!(ranked[2].title, "Cosmos");
    }

    #[test]
    fn streak_counts_back_from_today_or_yesterday() {
        let today = d("2026-07-23");
        // 오늘 포함 3일 연속.
        assert_eq!(
            streak_days(
                vec![d("2026-07-21"), d("2026-07-22"), d("2026-07-23")],
                today
            ),
            3
        );
        // 오늘은 아직 안 읽었지만 어제까지 2일 연속 → 스트릭 유지.
        assert_eq!(
            streak_days(vec![d("2026-07-21"), d("2026-07-22")], today),
            2
        );
        // 이틀 전이 마지막 → 끊김.
        assert_eq!(streak_days(vec![d("2026-07-21")], today), 0);
        assert_eq!(streak_days(vec![], today), 0);
        // 중복 날짜는 하루로 센다.
        assert_eq!(
            streak_days(vec![d("2026-07-23"), d("2026-07-23")], today),
            1
        );
    }
}
