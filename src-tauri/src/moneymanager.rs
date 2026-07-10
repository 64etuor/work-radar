//! MoneyManager(.mmbak) 백업 리더 + 순수 매핑.
//!
//! .mmbak = MoneyManager 안드로이드 앱의 plain SQLite 3 백업. 이 모듈은 의도적으로
//! 의존성이 가볍다: std + serde 계열 + sqlx **읽기 전용**만. db.rs/keychain/commands를
//! import하지 않는다 — 영속화·리뷰큐 정책(existing-wins upsert, needs_review 유입)은
//! 커맨드 레이어(`commands/bookkeeping/mmbak.rs`)가 소유한다.
//!
//! ⚠️ 호출자 계약: `open_read_only`에는 반드시 **사본** 경로를 넘긴다. 원본은
//! Google Drive 동기화 폴더에 있어 lock/부수효과가 없어야 한다(사본 생성은 커맨드
//! 레이어 책임). read_only(true)라 WAL 파일 생성 등 쓰기 부수효과도 없다.

use std::collections::HashMap;
use std::path::Path;

use chrono::{Datelike, TimeZone};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};

/// KRW 등 원본 통화 정보가 없을 때의 기본값(레포 정본 DEFAULT_CURRENCY와 동일 값).
const FALLBACK_CURRENCY: &str = "KRW";
/// 분류를 전혀 결정할 수 없을 때의 카테고리 라벨(수기 입력 NOT NULL CHECK 충족용).
const FALLBACK_CATEGORY_LABEL: &str = "미분류";
/// ZCONTENT·카테고리 모두 비었을 때의 상호 placeholder(merchant NOT NULL + nonempty CHECK).
const FALLBACK_MERCHANT: &str = "(무기명)";

// ── Raw row structs ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MmInoutcomeRow {
    /// UUID 또는 legacy int 문자열. 실데이터 전 행 non-empty — source_ref로 사용.
    pub uid: String,
    pub asset_uid: String,
    pub ctg_uid: String,
    /// ZCONTENT — 상호/내용.
    pub content: String,
    /// ZDATE — epoch ms.
    pub zdate_ms: i64,
    /// WDATE — 'YYYY-MM-DD'.
    pub wdate: String,
    /// DO_TYPE — '0'=income, '1'=expense, 그 외(이체 등)는 스킵.
    pub do_type: String,
    /// ZMONEY — REAL-as-string (예: "170764.0").
    pub zmoney: String,
    pub to_asset_uid: String,
    pub tx_uid_trans: String,
    pub is_del: i64,
    /// UTIME — epoch ms 최종 수정(증분 커서 키).
    pub utime_ms: i64,
    pub currency_uid: String,
    /// ZDATA — 거래 메모(사용자 자유 텍스트). MEMO 테이블과 무관 — 거래 메모는 이 컬럼이다.
    pub zdata: String,
}

#[derive(Debug, Clone)]
pub struct MmCategory {
    pub uid: String,
    pub name: String,
    /// TYPE — 0=income, 1=expense.
    pub type_code: i64,
    /// pUid — '0'/''/NULL = 최상위.
    pub parent_uid: String,
    /// C_IS_DEL — 1이면 앱에서 삭제된 카테고리(라벨 해석에는 여전히 유효, taxonomy 동기화 비대상).
    pub is_del: i64,
}

#[derive(Debug, Clone)]
pub struct MmAsset {
    pub uid: String,
    /// NIC_NAME (예: 하나카드).
    pub nic_name: String,
}

#[derive(Debug, Clone)]
pub struct MmCurrency {
    /// 예: 'KRW_KRW'.
    pub uid: String,
    pub iso: String,
    /// KRW=0. 소수 통화(USD 등)=2.
    pub decimal_point: i64,
}

/// REPEATTRANSACTION 한 행 — MoneyManager의 반복(정기) 거래 규칙. 앱의 고정비 정의
/// (`bookkeeping_recurring_expenses`)와 대응한다.
#[derive(Debug, Clone)]
pub struct MmRepeatRow {
    /// uid — (source='moneymanager', source_ref) 업서트 키.
    pub uid: String,
    pub is_del: i64,
    /// USETIME — epoch ms. 규칙 생성/최종수정 시각. **최초 삽입 시 start_month 파생에만**
    /// 쓴다(MM에서 규칙을 수정하면 값이 앞으로 밀리므로 갱신 시 재파생하면 과거 월이 사라진다).
    pub usetime_ms: i64,
    /// END_DATE — epoch ms. 0/음수 = 종료일 없음.
    pub end_date_ms: i64,
    /// NEXT_DATE — epoch ms. 다음 예정일 — 이 날짜의 day-of-month가 결제일이다
    /// (REPEATTRANSACTION에 결제일 컬럼이 따로 없다).
    pub next_date_ms: i64,
    /// DO_TYPE — 0=income, 1=expense.
    pub do_type: i64,
    /// REPEAT_TYPE — 1=monthly. 앱 고정비 스키마가 (결제일 + 월) 기반이라 월 반복만 지원한다.
    pub repeat_type: i64,
    pub asset_uid: String,
    pub to_asset_uid: String,
    pub ctg_uid: String,
    pub currency_uid: String,
    /// AMOUNT_SUB — REAL.
    pub amount: f64,
    /// MEMO — 규칙 이름으로 쓰이는 사용자 텍스트(비면 PAYEE 폴백).
    pub memo: String,
    /// PAYEE — 수취인/상호.
    pub payee: String,
}

/// 실백업 REPEATTRANSACTION의 컬럼 부분집합 DDL. 이 모듈과 커맨드 레이어의 픽스처가
/// 공유한다(스키마가 한 곳에만 있어야 드리프트가 안 생긴다).
#[cfg(test)]
pub(crate) const REPEAT_TRANSACTION_DDL: &str =
    "CREATE TABLE REPEATTRANSACTION (uid TEXT, IS_DEL INTEGER, USETIME INTEGER, MARK INTEGER, \
     END_DATE INTEGER, NEXT_DATE INTEGER, DO_TYPE INTEGER, REPEAT_TYPE INTEGER, assetUid TEXT, \
     toAssetUid TEXT, ctgUid TEXT, currencyUid TEXT, AMOUNT_SUB REAL, MEMO TEXT, PAYEE TEXT)";

/// `REPEAT_TRANSACTION_DDL`과 짝을 이루는 INSERT 컬럼 목록(픽스처가 위치 인자로 넣는다).
/// DDL 옆에 둬야 컬럼을 추가할 때 둘이 같이 바뀐다.
#[cfg(test)]
pub(crate) const REPEAT_TRANSACTION_COLUMNS: &str =
    "(uid, IS_DEL, USETIME, MARK, END_DATE, NEXT_DATE, DO_TYPE, REPEAT_TYPE, assetUid, \
     toAssetUid, ctgUid, currencyUid, AMOUNT_SUB, MEMO, PAYEE)";

// ── Mapped output ──────────────────────────────────────────────────────────────────────────────

/// 매핑된 거래 방향. models 레이어를 import하지 않기 위한 로컬 미러(순수 모듈 유지).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MmDirection {
    Income,
    Expense,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MappedMmTransaction {
    /// INOUTCOME.uid — (source='moneymanager', source_ref) upsert 키.
    pub source_ref: String,
    pub direction: MmDirection,
    pub merchant: String,
    /// 통화 최소단위 정수. 매핑에서 1..=i32::MAX 보장(범위 밖은 skip).
    pub amount_minor: i64,
    /// 3자리 ISO. 원본 통화를 못 찾으면 KRW.
    pub currency: String,
    /// YYYY-MM-DD.
    pub spent_at: String,
    /// HH:MM:SS — ZDATE가 실제 시각으로 보일 때만(합성 자정 제외).
    pub spent_at_time: Option<String>,
    /// 원본 카테고리 uid(트림; 빈 값이면 미분류). 임포터가 mm-<uid> 코드를 결정론적으로
    /// 직접 배정하는 데 쓴다 — 라벨/alias 추측이 아니라 원본 identity가 정본.
    pub ctg_uid: String,
    /// 상위 카테고리 NAME(2단계면 parent).
    pub category_label: String,
    /// 2단계 분류일 때 child NAME.
    pub subcategory_label: Option<String>,
    /// 'parent > child' 또는 단일 카테고리 NAME. taxonomy alias 해석의 raw 힌트.
    pub raw_category: Option<String>,
    /// ASSETS.NIC_NAME.
    pub account: Option<String>,
    /// ZDATA 메모(트림, 비면 None) — 앱 note로 유입.
    pub note: Option<String>,
    /// 증분 커서용 UTIME(epoch ms).
    pub utime_ms: i64,
}

/// 행 하나의 매핑 결과. IS_DEL 행은 skip이 아니라 `Deleted`로 분리 보고해
/// 임포터가 기존 행에 source_deleted 사유를 달 수 있게 한다.
#[derive(Debug, Clone, PartialEq)]
pub enum MmRowOutcome {
    Mapped(Box<MappedMmTransaction>),
    Deleted { uid: String },
    Skipped { uid: String, reason: &'static str },
}

/// 백업 전체 매핑 결과(집계 편의).
#[derive(Debug, Default)]
pub struct MmMappedBackup {
    pub transactions: Vec<MappedMmTransaction>,
    pub deleted_uids: Vec<String>,
    pub skipped: Vec<(String, &'static str)>,
}

/// 매핑된 고정비 규칙. 백업이 정본인 필드만 담는다 — `project_id` / `expense_kind` /
/// `payment_method_kind` / `note` / `paused` 상태는 백업에 대응물이 없어 앱이 소유한다.
#[derive(Debug, Clone, PartialEq)]
pub struct MappedMmRecurring {
    /// REPEATTRANSACTION.uid.
    pub source_ref: String,
    /// MEMO → (비면) PAYEE → (비면) 카테고리 라벨. NOT NULL + nonempty CHECK 충족.
    pub name: String,
    pub merchant: Option<String>,
    /// 통화 최소단위 정수. `scale_amount`가 1..=i32::MAX를 보장하므로 그대로 바인딩된다.
    pub amount_minor: i32,
    pub currency: String,
    /// 상위 카테고리 NAME(2단계면 parent) — 거래의 `category` 컬럼과 같은 시맨틱스.
    pub category_label: String,
    /// NEXT_DATE의 Seoul 로컬 day-of-month. `Datelike::day()`라 항상 1..=31 —
    /// 스키마 CHECK(1..=31)를 타입 수준에서 만족한다.
    pub schedule_day: u32,
    /// USETIME의 Seoul 로컬 'YYYY-MM' — **최초 삽입 시에만** 반영한다.
    pub start_month: String,
    /// END_DATE의 Seoul 로컬 'YYYY-MM'. 종료 없음이면 None.
    pub end_month: Option<String>,
    /// ASSETS.NIC_NAME — 최초 삽입 시 결제수단 라벨로만 싣는다(이후 사용자 소유).
    pub account: Option<String>,
}

/// REPEATTRANSACTION 한 행의 매핑 결과. IS_DEL 행은 `Deleted`로 분리해 임포터가 기존
/// 고정비를 archived로 미러링할 수 있게 한다.
#[derive(Debug)]
enum MmRepeatOutcome {
    Mapped(Box<MappedMmRecurring>),
    Deleted { uid: String },
    Skipped { uid: String, reason: &'static str },
}

/// REPEATTRANSACTION 전체 매핑 결과.
#[derive(Debug, Default)]
pub struct MmMappedRepeats {
    pub recurring: Vec<MappedMmRecurring>,
    pub deleted_uids: Vec<String>,
    pub skipped: Vec<(String, &'static str)>,
}

// ── Read-only backup handle ────────────────────────────────────────────────────────────────────

pub struct MoneyManagerBackup {
    conn: SqliteConnection,
}

impl MoneyManagerBackup {
    /// 읽기 전용으로 연다. `create_if_missing(false)` + `read_only(true)` — 소스 파일에
    /// 어떤 쓰기 부수효과(WAL/journal 생성 포함)도 없다.
    pub async fn open_read_only(path: &Path) -> Result<Self, sqlx::Error> {
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false);
        let conn = SqliteConnection::connect_with(&opts).await?;
        Ok(Self { conn })
    }

    pub async fn close(self) -> Result<(), sqlx::Error> {
        self.conn.close().await
    }

    /// INOUTCOME 전체. SQLite 동적 타이핑(legacy int uid, REAL DO_TYPE 등) 방어를 위해
    /// 전 컬럼을 CAST로 정규화해 읽는다. SMS_ORIGIN/SMS_PARSE_CONTENT는 **선택하지 않는다**
    /// (원문 SMS 본문 미저장 — PII 규율).
    pub async fn load_inoutcome(&mut self) -> Result<Vec<MmInoutcomeRow>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT CAST(COALESCE(uid,'') AS TEXT) AS uid, \
                    CAST(COALESCE(assetUid,'') AS TEXT) AS asset_uid, \
                    CAST(COALESCE(ctgUid,'') AS TEXT) AS ctg_uid, \
                    CAST(COALESCE(ZCONTENT,'') AS TEXT) AS content, \
                    CAST(COALESCE(ZDATE,0) AS INTEGER) AS zdate_ms, \
                    CAST(COALESCE(WDATE,'') AS TEXT) AS wdate, \
                    CAST(COALESCE(DO_TYPE,'') AS TEXT) AS do_type, \
                    CAST(COALESCE(ZMONEY,'') AS TEXT) AS zmoney, \
                    CAST(COALESCE(toAssetUid,'') AS TEXT) AS to_asset_uid, \
                    CAST(COALESCE(txUidTrans,'') AS TEXT) AS tx_uid_trans, \
                    CAST(COALESCE(IS_DEL,0) AS INTEGER) AS is_del, \
                    CAST(COALESCE(UTIME,0) AS INTEGER) AS utime_ms, \
                    CAST(COALESCE(currencyUid,'') AS TEXT) AS currency_uid, \
                    CAST(COALESCE(ZDATA,'') AS TEXT) AS zdata \
             FROM INOUTCOME",
        )
        .fetch_all(&mut self.conn)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(MmInoutcomeRow {
                    uid: row.try_get("uid")?,
                    asset_uid: row.try_get("asset_uid")?,
                    ctg_uid: row.try_get("ctg_uid")?,
                    content: row.try_get("content")?,
                    zdate_ms: row.try_get("zdate_ms")?,
                    wdate: row.try_get("wdate")?,
                    do_type: row.try_get("do_type")?,
                    zmoney: row.try_get("zmoney")?,
                    to_asset_uid: row.try_get("to_asset_uid")?,
                    tx_uid_trans: row.try_get("tx_uid_trans")?,
                    is_del: row.try_get("is_del")?,
                    utime_ms: row.try_get("utime_ms")?,
                    currency_uid: row.try_get("currency_uid")?,
                    zdata: row.try_get("zdata")?,
                })
            })
            .collect()
    }

    /// ZCATEGORY 전체(uid 키 맵). 삭제 표시(C_IS_DEL=1) 카테고리도 포함한다 —
    /// 과거 거래가 여전히 참조하므로 라벨 해석에는 유효하다.
    pub async fn load_categories(&mut self) -> Result<HashMap<String, MmCategory>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT CAST(COALESCE(uid,'') AS TEXT) AS uid, \
                    CAST(COALESCE(NAME,'') AS TEXT) AS name, \
                    CAST(COALESCE(TYPE,-1) AS INTEGER) AS type_code, \
                    CAST(COALESCE(pUid,'') AS TEXT) AS parent_uid, \
                    CAST(COALESCE(C_IS_DEL,0) AS INTEGER) AS is_del \
             FROM ZCATEGORY",
        )
        .fetch_all(&mut self.conn)
        .await?;
        let mut out = HashMap::with_capacity(rows.len());
        for row in rows {
            let cat = MmCategory {
                uid: row.try_get("uid")?,
                name: row.try_get("name")?,
                type_code: row.try_get("type_code")?,
                parent_uid: row.try_get("parent_uid")?,
                is_del: row.try_get("is_del")?,
            };
            if !cat.uid.is_empty() {
                out.insert(cat.uid.clone(), cat);
            }
        }
        Ok(out)
    }

    pub async fn load_assets(&mut self) -> Result<HashMap<String, MmAsset>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT CAST(COALESCE(uid,'') AS TEXT) AS uid, \
                    CAST(COALESCE(NIC_NAME,'') AS TEXT) AS nic_name \
             FROM ASSETS",
        )
        .fetch_all(&mut self.conn)
        .await?;
        let mut out = HashMap::with_capacity(rows.len());
        for row in rows {
            let asset = MmAsset {
                uid: row.try_get("uid")?,
                nic_name: row.try_get("nic_name")?,
            };
            if !asset.uid.is_empty() {
                out.insert(asset.uid.clone(), asset);
            }
        }
        Ok(out)
    }

    /// REPEATTRANSACTION 전체. 이 커맨드는 `.sqlite`도 받으므로(임의의 MM 아닌 파일)
    /// 테이블이 없으면 빈 목록으로 graceful degrade한다 — 거래 임포트는 계속돼야 한다.
    pub async fn load_repeat_transactions(&mut self) -> Result<Vec<MmRepeatRow>, sqlx::Error> {
        let exists: Option<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name=?1")
                .bind("REPEATTRANSACTION")
                .fetch_optional(&mut self.conn)
                .await?;
        if exists.is_none() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(
            "SELECT CAST(COALESCE(uid,'') AS TEXT) AS uid, \
                    CAST(COALESCE(IS_DEL,0) AS INTEGER) AS is_del, \
                    CAST(COALESCE(USETIME,0) AS INTEGER) AS usetime_ms, \
                    CAST(COALESCE(END_DATE,0) AS INTEGER) AS end_date_ms, \
                    CAST(COALESCE(NEXT_DATE,0) AS INTEGER) AS next_date_ms, \
                    CAST(COALESCE(DO_TYPE,-1) AS INTEGER) AS do_type, \
                    CAST(COALESCE(REPEAT_TYPE,-1) AS INTEGER) AS repeat_type, \
                    CAST(COALESCE(assetUid,'') AS TEXT) AS asset_uid, \
                    CAST(COALESCE(toAssetUid,'') AS TEXT) AS to_asset_uid, \
                    CAST(COALESCE(ctgUid,'') AS TEXT) AS ctg_uid, \
                    CAST(COALESCE(currencyUid,'') AS TEXT) AS currency_uid, \
                    CAST(COALESCE(AMOUNT_SUB,0) AS REAL) AS amount, \
                    CAST(COALESCE(MEMO,'') AS TEXT) AS memo, \
                    CAST(COALESCE(PAYEE,'') AS TEXT) AS payee \
             FROM REPEATTRANSACTION",
        )
        .fetch_all(&mut self.conn)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(MmRepeatRow {
                    uid: row.try_get("uid")?,
                    is_del: row.try_get("is_del")?,
                    usetime_ms: row.try_get("usetime_ms")?,
                    end_date_ms: row.try_get("end_date_ms")?,
                    next_date_ms: row.try_get("next_date_ms")?,
                    do_type: row.try_get("do_type")?,
                    repeat_type: row.try_get("repeat_type")?,
                    asset_uid: row.try_get("asset_uid")?,
                    to_asset_uid: row.try_get("to_asset_uid")?,
                    ctg_uid: row.try_get("ctg_uid")?,
                    currency_uid: row.try_get("currency_uid")?,
                    amount: row.try_get("amount")?,
                    memo: row.try_get("memo")?,
                    payee: row.try_get("payee")?,
                })
            })
            .collect()
    }

    pub async fn load_currencies(&mut self) -> Result<HashMap<String, MmCurrency>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT CAST(COALESCE(uid,'') AS TEXT) AS uid, \
                    CAST(COALESCE(ISO,'') AS TEXT) AS iso, \
                    CAST(COALESCE(DECIMAL_POINT,0) AS INTEGER) AS decimal_point \
             FROM CURRENCY",
        )
        .fetch_all(&mut self.conn)
        .await?;
        let mut out = HashMap::with_capacity(rows.len());
        for row in rows {
            let currency = MmCurrency {
                uid: row.try_get("uid")?,
                iso: row.try_get("iso")?,
                decimal_point: row.try_get("decimal_point")?,
            };
            if !currency.uid.is_empty() {
                out.insert(currency.uid.clone(), currency);
            }
        }
        Ok(out)
    }
}

// ── Pure mapping ───────────────────────────────────────────────────────────────────────────────

/// MoneyManager의 '0' 센티널('' / NULL과 함께 "없음" 의미 — pUid 관례와 동일)을 걸러낸
/// 유효 참조값. 이체 판정(toAssetUid/txUidTrans)에도 같은 관례를 적용한다.
pub(crate) fn nonempty_ref(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed != "0").then_some(trimmed)
}

/// DO_TYPE 정규화: "0"/"0.0"→income, "1"/"1.0"→expense, 그 외(이체 등)→None.
fn parse_do_type(raw: &str) -> Option<MmDirection> {
    let value: f64 = raw.trim().parse().ok()?;
    if value == 0.0 {
        Some(MmDirection::Income)
    } else if value == 1.0 {
        Some(MmDirection::Expense)
    } else {
        None
    }
}

/// YYYY-MM-DD 구조 검사(10자 + 자릿수 + 월/일 범위).
fn is_valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if value.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !value
        .bytes()
        .enumerate()
        .all(|(idx, b)| idx == 4 || idx == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let month: u32 = match value[5..7].parse() {
        Ok(m) => m,
        Err(_) => return false,
    };
    let day: u32 = match value[8..10].parse() {
        Ok(d) => d,
        Err(_) => return false,
    };
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// ZDATE(epoch ms)를 주입된 타임존의 로컬로 변환. MoneyManager 백업의 wall-clock 의미는
/// 백업을 만든 기기의 타임존을 따르므로, 커맨드 레이어가 `user_timezone()` SSOT로 tz를
/// 주입한다(이 모듈은 commands를 import하지 않는 순수 매핑 계층 — 파라미터 주입).
/// 이전엔 Asia/Seoul 고정이라 비KST 사용자의 날짜/월 버킷이 UTC 오프셋만큼 어긋났다.
fn local_datetime(zdate_ms: i64, tz: chrono_tz::Tz) -> Option<chrono::DateTime<chrono_tz::Tz>> {
    if zdate_ms <= 0 {
        return None;
    }
    match tz.timestamp_millis_opt(zdate_ms) {
        chrono::LocalResult::Single(dt) => Some(dt),
        _ => None,
    }
}

/// ZDATE/USETIME 계열 epoch ms → 주입 tz 로컬 'YYYY-MM'.
fn local_month(ms: i64, tz: chrono_tz::Tz) -> Option<String> {
    local_datetime(ms, tz).map(|dt| dt.format("%Y-%m").to_string())
}

/// currencyUid → (3자리 ISO, 최소단위 지수). 원본 통화를 못 찾으면 (KRW, 0).
fn resolve_currency(currency_uid: &str, currencies: &HashMap<String, MmCurrency>) -> (String, i64) {
    let row = nonempty_ref(currency_uid).and_then(|c| currencies.get(c));
    let exponent = row.map(|c| c.decimal_point.clamp(0, 6)).unwrap_or(0);
    let iso = row
        .map(|c| c.iso.trim().to_ascii_uppercase())
        .filter(|iso| iso.len() == 3 && iso.bytes().all(|b| b.is_ascii_uppercase()))
        .unwrap_or_else(|| FALLBACK_CURRENCY.to_string());
    (iso, exponent)
}

/// 금액 × 10^exponent → 최소단위 정수. 0/음수/NaN/i32::MAX 초과는 스키마 CHECK
/// (amount_minor > 0 AND <= i32::MAX) 위반이라 None. 반환 타입이 i32라 호출자가
/// 방어적으로 다시 좁힐 필요가 없다.
#[allow(clippy::cast_possible_truncation)]
fn scale_amount(money: f64, exponent: i64) -> Option<i32> {
    let scaled = (money * 10f64.powi(exponent as i32)).round();
    (scaled >= 1.0 && scaled <= i32::MAX as f64).then_some(scaled as i32)
}

/// 트림 후 비어 있지 않은 값만.
fn nonblank(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// 카테고리 라벨 해석: (category_label, subcategory_label, raw_category).
fn resolve_category_labels(
    ctg_uid: &str,
    categories: &HashMap<String, MmCategory>,
) -> (String, Option<String>, Option<String>) {
    let Some(cat) = nonempty_ref(ctg_uid).and_then(|uid| categories.get(uid)) else {
        return (FALLBACK_CATEGORY_LABEL.to_string(), None, None);
    };
    let name = cat.name.trim();
    if name.is_empty() {
        return (FALLBACK_CATEGORY_LABEL.to_string(), None, None);
    }
    let parent = nonempty_ref(&cat.parent_uid)
        .and_then(|uid| categories.get(uid))
        .filter(|parent| !parent.name.trim().is_empty());
    match parent {
        // 2단계: ctgUid는 child → parent NAME이 category, child NAME이 subcategory.
        Some(parent) => {
            let parent_name = parent.name.trim().to_string();
            let raw = format!("{parent_name} > {name}");
            (parent_name, Some(name.to_string()), Some(raw))
        }
        None => (name.to_string(), None, Some(name.to_string())),
    }
}

/// INOUTCOME 한 행 → 매핑/삭제/스킵. 순수 함수 — DB·시계 접근 없음(tz도 파라미터 주입).
pub fn map_inoutcome_row(
    row: &MmInoutcomeRow,
    categories: &HashMap<String, MmCategory>,
    assets: &HashMap<String, MmAsset>,
    currencies: &HashMap<String, MmCurrency>,
    tz: chrono_tz::Tz,
) -> MmRowOutcome {
    let uid = row.uid.trim().to_string();
    if uid.is_empty() {
        return MmRowOutcome::Skipped {
            uid,
            reason: "missing_uid",
        };
    }
    if row.is_del != 0 {
        return MmRowOutcome::Deleted { uid };
    }
    // 이체는 가계부 수입/지출이 아니다(자산 간 이동). 카드 할부 분할행
    // (cardDivideUid/CARDDIVIDMONTH, 미래 일자 가능)은 이체가 아니므로 그대로 임포트된다.
    if nonempty_ref(&row.to_asset_uid).is_some() || nonempty_ref(&row.tx_uid_trans).is_some() {
        return MmRowOutcome::Skipped {
            uid,
            reason: "transfer",
        };
    }
    let Some(direction) = parse_do_type(&row.do_type) else {
        return MmRowOutcome::Skipped {
            uid,
            reason: "unsupported_do_type",
        };
    };

    // 금액: ZMONEY(f64 문자열) × 10^DECIMAL_POINT → 최소단위 정수. KRW exp 0.
    let Ok(money) = row.zmoney.trim().parse::<f64>() else {
        return MmRowOutcome::Skipped {
            uid,
            reason: "invalid_amount",
        };
    };
    let (currency, exponent) = resolve_currency(&row.currency_uid, currencies);
    let Some(amount_minor) = scale_amount(money, exponent) else {
        return MmRowOutcome::Skipped {
            uid,
            reason: "amount_out_of_range",
        };
    };

    // 날짜: WDATE 우선, 불량이면 ZDATE의 로컬(주입 tz) 날짜로 폴백.
    let wdate = row.wdate.trim();
    let spent_at = if is_valid_date(wdate) {
        wdate.to_string()
    } else if let Some(local) = local_datetime(row.zdate_ms, tz) {
        local.format("%Y-%m-%d").to_string()
    } else {
        return MmRowOutcome::Skipped {
            uid,
            reason: "invalid_date",
        };
    };

    // 시간: ZDATE가 실제 시각으로 보일 때만(합성 자정 00:00:00 제외 — 앱이 시간 미입력
    // 거래를 자정으로 저장한다).
    let spent_at_time = local_datetime(row.zdate_ms, tz)
        .map(|local| local.format("%H:%M:%S").to_string())
        .filter(|t| t != "00:00:00");

    let (category_label, subcategory_label, raw_category) =
        resolve_category_labels(&row.ctg_uid, categories);

    // 상호: ZCONTENT → (비면) 카테고리 라벨 → (그래도 비면) placeholder.
    // merchant는 NOT NULL + nonempty CHECK라 빈 값으로 내보낼 수 없다.
    let content = row.content.trim();
    let merchant = if !content.is_empty() {
        content.to_string()
    } else if let Some(sub) = subcategory_label.as_deref() {
        sub.to_string()
    } else if raw_category.is_some() {
        category_label.clone()
    } else {
        FALLBACK_MERCHANT.to_string()
    };

    // 메모: ZDATA 트림, 비면 None. '0' 센티널 관례는 참조 컬럼 전용이라 적용하지 않는다
    // (메모 "0"도 유효한 사용자 텍스트).
    let note = nonblank(&row.zdata);

    let account = nonempty_ref(&row.asset_uid)
        .and_then(|uid| assets.get(uid))
        .and_then(|asset| nonblank(&asset.nic_name));

    MmRowOutcome::Mapped(Box::new(MappedMmTransaction {
        source_ref: uid,
        direction,
        ctg_uid: row.ctg_uid.trim().to_string(),
        merchant,
        amount_minor: i64::from(amount_minor),
        currency,
        spent_at,
        spent_at_time,
        category_label,
        subcategory_label,
        raw_category,
        account,
        note,
        utime_ms: row.utime_ms,
    }))
}

/// 전체 백업 매핑 집계. `min_utime_exclusive`(증분 커서)보다 새 행만 매핑하되,
/// IS_DEL 행은 **항상** 수집한다 — MoneyManager의 삭제는 UTIME을 신뢰성 있게 올리지
/// 않으므로 삭제 감지는 매 임포트 full-scan이어야 한다.
pub fn map_backup(
    rows: &[MmInoutcomeRow],
    categories: &HashMap<String, MmCategory>,
    assets: &HashMap<String, MmAsset>,
    currencies: &HashMap<String, MmCurrency>,
    min_utime_exclusive: Option<i64>,
    tz: chrono_tz::Tz,
) -> MmMappedBackup {
    let mut out = MmMappedBackup::default();
    for row in rows {
        // 삭제행 판별은 커서와 무관하게 먼저 수행(full-scan 계약).
        if row.is_del != 0 {
            let uid = row.uid.trim().to_string();
            if !uid.is_empty() {
                out.deleted_uids.push(uid);
            }
            continue;
        }
        if let Some(cursor) = min_utime_exclusive {
            if row.utime_ms <= cursor {
                out.skipped
                    .push((row.uid.trim().to_string(), "cursor_not_newer"));
                continue;
            }
        }
        match map_inoutcome_row(row, categories, assets, currencies, tz) {
            MmRowOutcome::Mapped(tx) => out.transactions.push(*tx),
            MmRowOutcome::Deleted { uid } => out.deleted_uids.push(uid),
            MmRowOutcome::Skipped { uid, reason } => out.skipped.push((uid, reason)),
        }
    }
    out
}

// ── Recurring (REPEATTRANSACTION) mapping ──────────────────────────────────────────────────────

/// DO_TYPE 지출.
const REPEAT_DO_TYPE_EXPENSE: i64 = 1;
/// REPEAT_TYPE 월 반복. 앱 고정비는 (schedule_day + start_month) 모델이라 월 반복만 대응된다.
const REPEAT_TYPE_MONTHLY: i64 = 1;

/// REPEATTRANSACTION 한 행 → 고정비 매핑/삭제/스킵. 순수 함수 — DB·시계 접근 없음.
///
/// 지출·월반복만 고정비로 본다. 수입 반복(DO_TYPE=0), 이체 반복(toAssetUid), 월이 아닌
/// 주기는 앱 스키마에 대응물이 없어 스킵하고 사유를 보고한다(조용한 누락 금지).
fn map_repeat_row(
    row: &MmRepeatRow,
    categories: &HashMap<String, MmCategory>,
    assets: &HashMap<String, MmAsset>,
    currencies: &HashMap<String, MmCurrency>,
    tz: chrono_tz::Tz,
) -> MmRepeatOutcome {
    let uid = row.uid.trim().to_string();
    if uid.is_empty() {
        return MmRepeatOutcome::Skipped {
            uid,
            reason: "missing_uid",
        };
    }
    if row.is_del != 0 {
        return MmRepeatOutcome::Deleted { uid };
    }
    if nonempty_ref(&row.to_asset_uid).is_some() {
        return MmRepeatOutcome::Skipped {
            uid,
            reason: "transfer",
        };
    }
    if row.do_type != REPEAT_DO_TYPE_EXPENSE {
        return MmRepeatOutcome::Skipped {
            uid,
            reason: "not_expense",
        };
    }
    if row.repeat_type != REPEAT_TYPE_MONTHLY {
        return MmRepeatOutcome::Skipped {
            uid,
            reason: "unsupported_repeat_type",
        };
    }

    let (currency, exponent) = resolve_currency(&row.currency_uid, currencies);
    let Some(amount_minor) = scale_amount(row.amount, exponent) else {
        return MmRepeatOutcome::Skipped {
            uid,
            reason: "amount_out_of_range",
        };
    };
    // 결제일: NEXT_DATE의 로컬 day-of-month.
    //
    // 한계: REPEATTRANSACTION엔 결제일 컬럼이 없어 "다음 예정일"에서 역산한다. 말일(31일)
    // 규칙이 짧은 달을 다음 예정일로 가리키면 그 달의 말일(28/30)로 읽힌다. 앱 쪽
    // `due_date_for_month`가 매월 말일로 clamp하므로 청구일이 틀어지진 않지만, 저장된
    // schedule_day는 백업을 뜬 시점에 따라 28↔31로 흔들릴 수 있다.
    let Some(schedule_day) = local_datetime(row.next_date_ms, tz).map(|dt| dt.day()) else {
        return MmRepeatOutcome::Skipped {
            uid,
            reason: "invalid_next_date",
        };
    };
    let Some(start_month) = local_month(row.usetime_ms, tz) else {
        return MmRepeatOutcome::Skipped {
            uid,
            reason: "invalid_usetime",
        };
    };
    // END_DATE 0/음수 = 종료 없음(무기한).
    let end_month = (row.end_date_ms > 0)
        .then(|| local_month(row.end_date_ms, tz))
        .flatten();

    let (category_label, _subcategory, _raw) = resolve_category_labels(&row.ctg_uid, categories);
    let merchant = nonblank(&row.payee);
    // 규칙 이름: MEMO(사용자가 붙인 이름) → PAYEE → 카테고리 라벨. 셋 다 비어도
    // category_label은 FALLBACK_CATEGORY_LABEL이라 non-empty가 보장된다.
    let name = nonblank(&row.memo)
        .or_else(|| merchant.clone())
        .unwrap_or_else(|| category_label.clone());
    let account = nonempty_ref(&row.asset_uid)
        .and_then(|uid| assets.get(uid))
        .and_then(|asset| nonblank(&asset.nic_name));

    MmRepeatOutcome::Mapped(Box::new(MappedMmRecurring {
        source_ref: uid,
        name,
        merchant,
        amount_minor,
        currency,
        category_label,
        schedule_day,
        start_month,
        end_month,
        account,
    }))
}

/// REPEATTRANSACTION 전체 매핑 집계. 거래와 달리 증분 커서를 쓰지 않는다 — 규칙은
/// 수십 건 규모이고, 매 임포트 full-scan이라야 백업이 정본이라는 계약이 성립한다.
pub fn map_repeats(
    rows: &[MmRepeatRow],
    categories: &HashMap<String, MmCategory>,
    assets: &HashMap<String, MmAsset>,
    currencies: &HashMap<String, MmCurrency>,
    tz: chrono_tz::Tz,
) -> MmMappedRepeats {
    let mut out = MmMappedRepeats::default();
    for row in rows {
        match map_repeat_row(row, categories, assets, currencies, tz) {
            MmRepeatOutcome::Mapped(rule) => out.recurring.push(*rule),
            MmRepeatOutcome::Deleted { uid } => out.deleted_uids.push(uid),
            MmRepeatOutcome::Skipped { uid, reason } => out.skipped.push((uid, reason)),
        }
    }
    out
}

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 실백업 스키마의 정확한 부분집합 DDL로 임시 .sqlite 픽스처를 만든다.
    async fn fixture_db(dir: &tempfile::TempDir) -> std::path::PathBuf {
        let path = dir.path().join("backup.mmbak");
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&opts).await.expect("open");
        for ddl in [
            "CREATE TABLE INOUTCOME (uid TEXT, assetUid TEXT, ctgUid TEXT, ZCONTENT TEXT, \
             ZDATE INTEGER, WDATE TEXT, DO_TYPE TEXT, ZMONEY TEXT, toAssetUid TEXT, \
             txUidTrans TEXT, cardDivideUid TEXT, CARDDIVIDMONTH TEXT, IS_DEL INTEGER, \
             UTIME INTEGER, currencyUid TEXT, ZDATA TEXT)",
            "CREATE TABLE ZCATEGORY (uid TEXT, NAME TEXT, TYPE INTEGER, pUid TEXT, \
             C_IS_DEL INTEGER, STATUS INTEGER)",
            "CREATE TABLE ASSETS (uid TEXT, NIC_NAME TEXT, groupUid TEXT)",
            "CREATE TABLE CURRENCY (uid TEXT, ISO TEXT, DECIMAL_POINT INTEGER)",
            REPEAT_TRANSACTION_DDL,
        ] {
            sqlx::query(ddl).execute(&mut conn).await.expect("ddl");
        }
        for seed in [
            "INSERT INTO ZCATEGORY VALUES ('10','식비',1,'0',0,0)",
            "INSERT INTO ZCATEGORY VALUES ('11','카페',1,'10',0,0)",
            "INSERT INTO ZCATEGORY VALUES ('20','급여',0,'',0,0)",
            "INSERT INTO ASSETS VALUES ('a1','하나카드','g1')",
            "INSERT INTO CURRENCY VALUES ('KRW_KRW','KRW',0)",
            "INSERT INTO CURRENCY VALUES ('USD_USD','USD',2)",
        ] {
            sqlx::query(seed).execute(&mut conn).await.expect("seed");
        }
        conn.close().await.expect("close");
        path
    }

    async fn insert_row(path: &std::path::Path, sql: &str) {
        let opts = SqliteConnectOptions::new().filename(path);
        let mut conn = SqliteConnection::connect_with(&opts).await.expect("open");
        sqlx::query(sql).execute(&mut conn).await.expect("insert");
        conn.close().await.expect("close");
    }

    async fn load_all(
        path: &std::path::Path,
    ) -> (
        Vec<MmInoutcomeRow>,
        HashMap<String, MmCategory>,
        HashMap<String, MmAsset>,
        HashMap<String, MmCurrency>,
    ) {
        let mut backup = MoneyManagerBackup::open_read_only(path)
            .await
            .expect("open read-only");
        let rows = backup.load_inoutcome().await.expect("inoutcome");
        let cats = backup.load_categories().await.expect("categories");
        let assets = backup.load_assets().await.expect("assets");
        let currencies = backup.load_currencies().await.expect("currencies");
        backup.close().await.expect("close");
        (rows, cats, assets, currencies)
    }

    fn kst_millis(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
        chrono_tz::Asia::Seoul
            .with_ymd_and_hms(y, mo, d, h, mi, s)
            .single()
            .expect("kst datetime")
            .timestamp_millis()
    }

    #[tokio::test]
    async fn maps_expense_and_income_with_time_conversion() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        let lunch_ms = kst_millis(2026, 6, 15, 13, 45, 30);
        insert_row(&path, &format!(
            "INSERT INTO INOUTCOME VALUES ('uuid-1','a1','11','스타벅스',{lunch_ms},'2026-06-15','1','5500.0','','','','',0,100,'KRW_KRW',' 맥주, 아몬드 ')"
        )).await;
        let midnight_ms = kst_millis(2026, 6, 1, 0, 0, 0);
        insert_row(&path, &format!(
            "INSERT INTO INOUTCOME VALUES ('uuid-2','a1','20','회사',{midnight_ms},'2026-06-01','0','3000000.0','','','','',0,200,'KRW_KRW','')"
        )).await;

        let (rows, cats, assets, curs) = load_all(&path).await;
        let mapped = map_backup(&rows, &cats, &assets, &curs, None, chrono_tz::Asia::Seoul);
        assert_eq!(mapped.transactions.len(), 2);
        assert!(mapped.deleted_uids.is_empty());
        assert!(mapped.skipped.is_empty());

        let expense = &mapped.transactions[0];
        assert_eq!(expense.source_ref, "uuid-1");
        assert_eq!(expense.direction, MmDirection::Expense);
        assert_eq!(expense.merchant, "스타벅스");
        assert_eq!(expense.amount_minor, 5500);
        assert_eq!(expense.currency, "KRW");
        assert_eq!(expense.spent_at, "2026-06-15");
        // 실시각 ZDATE → Seoul HH:MM:SS.
        assert_eq!(expense.spent_at_time.as_deref(), Some("13:45:30"));
        assert_eq!(expense.category_label, "식비");
        assert_eq!(expense.subcategory_label.as_deref(), Some("카페"));
        assert_eq!(expense.raw_category.as_deref(), Some("식비 > 카페"));
        assert_eq!(expense.account.as_deref(), Some("하나카드"));
        // ZDATA 메모는 트림되어 note로.
        assert_eq!(expense.note.as_deref(), Some("맥주, 아몬드"));
        assert_eq!(expense.utime_ms, 100);

        let income = &mapped.transactions[1];
        assert_eq!(income.direction, MmDirection::Income);
        assert_eq!(income.category_label, "급여");
        assert_eq!(income.subcategory_label, None);
        assert_eq!(income.raw_category.as_deref(), Some("급여"));
        // 합성 자정 → 시간 없음.
        assert_eq!(income.spent_at_time, None);
        // 빈 ZDATA → note 없음.
        assert_eq!(income.note, None);
    }

    #[tokio::test]
    async fn skips_transfers_and_reports_deleted_uids() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        // 이체(toAssetUid) / 이체(txUidTrans) / DO_TYPE=3 / 삭제행.
        for sql in [
            "INSERT INTO INOUTCOME VALUES ('t1','a1','10','계좌이체',0,'2026-06-10','1','10000.0','a2','','','',0,10,'KRW_KRW','')",
            "INSERT INTO INOUTCOME VALUES ('t2','a1','10','이체링크',0,'2026-06-10','1','10000.0','','tx-9','','',0,11,'KRW_KRW','')",
            "INSERT INTO INOUTCOME VALUES ('t3','a1','10','기타타입',0,'2026-06-10','3','10000.0','','','','',0,12,'KRW_KRW','')",
            "INSERT INTO INOUTCOME VALUES ('del-1','a1','10','지워진거래',0,'2026-06-09','1','9000.0','','','','',1,13,'KRW_KRW','')",
        ] {
            insert_row(&path, sql).await;
        }
        let (rows, cats, assets, curs) = load_all(&path).await;
        let mapped = map_backup(&rows, &cats, &assets, &curs, None, chrono_tz::Asia::Seoul);
        assert!(mapped.transactions.is_empty());
        assert_eq!(mapped.deleted_uids, vec!["del-1".to_string()]);
        let reasons: Vec<&str> = mapped.skipped.iter().map(|(_, r)| *r).collect();
        assert_eq!(reasons, vec!["transfer", "transfer", "unsupported_do_type"]);
    }

    #[tokio::test]
    async fn skips_zero_negative_and_unparsable_amounts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        for sql in [
            "INSERT INTO INOUTCOME VALUES ('z1','a1','10','제로',0,'2026-06-10','1','0.0','','','','',0,10,'KRW_KRW','')",
            "INSERT INTO INOUTCOME VALUES ('z2','a1','10','음수',0,'2026-06-10','1','-100.0','','','','',0,11,'KRW_KRW','')",
            "INSERT INTO INOUTCOME VALUES ('z3','a1','10','불량',0,'2026-06-10','1','abc','','','','',0,12,'KRW_KRW','')",
            "INSERT INTO INOUTCOME VALUES ('z4','a1','10','과대',0,'2026-06-10','1','9999999999.0','','','','',0,13,'KRW_KRW','')",
        ] {
            insert_row(&path, sql).await;
        }
        let (rows, cats, assets, curs) = load_all(&path).await;
        let mapped = map_backup(&rows, &cats, &assets, &curs, None, chrono_tz::Asia::Seoul);
        assert!(mapped.transactions.is_empty());
        let reasons: Vec<&str> = mapped.skipped.iter().map(|(_, r)| *r).collect();
        assert_eq!(
            reasons,
            vec![
                "amount_out_of_range",
                "amount_out_of_range",
                "invalid_amount",
                "amount_out_of_range"
            ]
        );
    }

    #[tokio::test]
    async fn missing_category_and_asset_fall_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        // 미지 카테고리/자산 + 빈 ZCONTENT → 카테고리 폴백 라벨 + placeholder 상호.
        insert_row(
            &path,
            "INSERT INTO INOUTCOME VALUES ('m1','missing','missing','',0,'2026-06-10','1','1000.0','','','','',0,10,'KRW_KRW','   ')",
        )
        .await;
        // 카테고리는 있고 ZCONTENT만 빈 경우 → 카테고리 라벨이 상호.
        insert_row(
            &path,
            "INSERT INTO INOUTCOME VALUES ('m2','a1','11','',0,'2026-06-10','1','1000.0','','','','',0,11,'KRW_KRW','')",
        )
        .await;
        let (rows, cats, assets, curs) = load_all(&path).await;
        let mapped = map_backup(&rows, &cats, &assets, &curs, None, chrono_tz::Asia::Seoul);
        assert_eq!(mapped.transactions.len(), 2);
        let m1 = &mapped.transactions[0];
        assert_eq!(m1.category_label, "미분류");
        assert_eq!(m1.merchant, "(무기명)");
        assert_eq!(m1.account, None);
        assert_eq!(m1.raw_category, None);
        // 공백뿐인 ZDATA → note 없음.
        assert_eq!(m1.note, None);
        let m2 = &mapped.transactions[1];
        assert_eq!(m2.merchant, "카페");
    }

    #[tokio::test]
    async fn legacy_int_uid_and_currency_scaling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        // legacy int uid(정수 리터럴 저장) + USD exp 2 스케일링.
        insert_row(
            &path,
            "INSERT INTO INOUTCOME VALUES (12345,'a1','10','환전샵',0,'2026-06-10','1','170764.0','','','','',0,10,'KRW_KRW','')",
        )
        .await;
        insert_row(
            &path,
            "INSERT INTO INOUTCOME VALUES ('usd-1','a1','10','Amazon',0,'2026-06-11','1','12.34','','','','',0,11,'USD_USD','')",
        )
        .await;
        let (rows, cats, assets, curs) = load_all(&path).await;
        let mapped = map_backup(&rows, &cats, &assets, &curs, None, chrono_tz::Asia::Seoul);
        assert_eq!(mapped.transactions.len(), 2);
        assert_eq!(mapped.transactions[0].source_ref, "12345");
        assert_eq!(mapped.transactions[0].amount_minor, 170764);
        assert_eq!(mapped.transactions[0].currency, "KRW");
        assert_eq!(mapped.transactions[1].amount_minor, 1234);
        assert_eq!(mapped.transactions[1].currency, "USD");
    }

    // ── REPEATTRANSACTION → 고정비 매핑 ────────────────────────────────────────

    async fn load_repeats(
        path: &std::path::Path,
    ) -> (
        Vec<MmRepeatRow>,
        HashMap<String, MmCategory>,
        HashMap<String, MmAsset>,
        HashMap<String, MmCurrency>,
    ) {
        let mut backup = MoneyManagerBackup::open_read_only(path)
            .await
            .expect("open read-only");
        let repeats = backup.load_repeat_transactions().await.expect("repeats");
        let cats = backup.load_categories().await.expect("categories");
        let assets = backup.load_assets().await.expect("assets");
        let currencies = backup.load_currencies().await.expect("currencies");
        backup.close().await.expect("close");
        (repeats, cats, assets, currencies)
    }

    #[tokio::test]
    async fn maps_monthly_expense_repeats_to_recurring_rules() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        // 실백업 형태: MEMO가 이름, PAYEE가 상호. 결제일은 NEXT_DATE의 로컬 day.
        let usetime = kst_millis(2026, 6, 23, 13, 49, 21);
        let next = kst_millis(2026, 7, 22, 18, 53, 57);
        insert_row(&path, &format!(
            "INSERT INTO REPEATTRANSACTION {REPEAT_TRANSACTION_COLUMNS} VALUES ('rep-1',0,{usetime},0,0,{next},1,1,'a1','','11','KRW_KRW',100000.0,'주택청약','청약(49)')"
        )).await;
        // MEMO 없음 → PAYEE가 이름. 종료일 있음.
        let usetime2 = kst_millis(2026, 6, 21, 14, 8, 59);
        let next2 = kst_millis(2026, 7, 21, 15, 1, 14);
        let end2 = kst_millis(2027, 3, 21, 0, 0, 0);
        insert_row(&path, &format!(
            "INSERT INTO REPEATTRANSACTION {REPEAT_TRANSACTION_COLUMNS} VALUES ('rep-2',0,{usetime2},0,{end2},{next2},1,1,'a1','','20','KRW_KRW',17050.0,'','DB손')"
        )).await;

        let (rows, cats, assets, curs) = load_repeats(&path).await;
        let mapped = map_repeats(&rows, &cats, &assets, &curs, chrono_tz::Asia::Seoul);
        assert_eq!(mapped.recurring.len(), 2);
        assert!(mapped.deleted_uids.is_empty());
        assert!(mapped.skipped.is_empty());

        let first = &mapped.recurring[0];
        assert_eq!(first.source_ref, "rep-1");
        assert_eq!(first.name, "주택청약");
        assert_eq!(first.merchant.as_deref(), Some("청약(49)"));
        assert_eq!(first.amount_minor, 100_000);
        assert_eq!(first.currency, "KRW");
        // ctgUid '11'(카페)은 2단계 → parent NAME(식비)이 category.
        assert_eq!(first.category_label, "식비");
        assert_eq!(first.schedule_day, 22, "결제일은 NEXT_DATE의 로컬 day");
        assert_eq!(first.start_month, "2026-06", "start_month는 USETIME의 월");
        assert_eq!(first.end_month, None, "END_DATE=0 → 무기한");
        assert_eq!(first.account.as_deref(), Some("하나카드"));

        let second = &mapped.recurring[1];
        assert_eq!(second.name, "DB손", "MEMO 비면 PAYEE가 이름");
        assert_eq!(second.schedule_day, 21);
        assert_eq!(second.end_month.as_deref(), Some("2027-03"));
        // 최상위 카테고리는 그대로.
        assert_eq!(second.category_label, "급여");
    }

    #[tokio::test]
    async fn repeat_deleted_and_unsupported_rows_are_reported_not_mapped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        let usetime = kst_millis(2026, 6, 1, 0, 0, 0);
        let next = kst_millis(2026, 7, 15, 12, 0, 0);
        for (uid, is_del, do_type, repeat_type, to_asset, amount) in [
            ("del-1", 1, 1, 1, "", 1000.0),
            ("inc-1", 0, 0, 1, "", 1000.0),    // 수입 반복
            ("xfer-1", 0, 1, 1, "a2", 1000.0), // 이체 반복
            ("weekly-1", 0, 1, 2, "", 1000.0), // 월 반복 아님
            ("zero-1", 0, 1, 1, "", 0.0),      // 금액 0
        ] {
            insert_row(&path, &format!(
                "INSERT INTO REPEATTRANSACTION {REPEAT_TRANSACTION_COLUMNS} VALUES ('{uid}',{is_del},{usetime},0,0,{next},{do_type},{repeat_type},'a1','{to_asset}','10','KRW_KRW',{amount},'','')"
            )).await;
        }

        let (rows, cats, assets, curs) = load_repeats(&path).await;
        let mapped = map_repeats(&rows, &cats, &assets, &curs, chrono_tz::Asia::Seoul);
        assert!(mapped.recurring.is_empty());
        assert_eq!(mapped.deleted_uids, vec!["del-1".to_string()]);
        let reasons: Vec<&str> = mapped.skipped.iter().map(|(_, r)| *r).collect();
        assert_eq!(
            reasons,
            vec![
                "not_expense",
                "transfer",
                "unsupported_repeat_type",
                "amount_out_of_range"
            ]
        );
    }

    /// 고정비도 거래와 같은 `scale_amount`를 타므로 소수 통화(USD exp 2)가 최소단위로 스케일된다.
    #[tokio::test]
    async fn repeat_scales_foreign_currency_to_minor_units() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        let usetime = kst_millis(2026, 6, 1, 0, 0, 0);
        let next = kst_millis(2026, 7, 9, 9, 0, 0);
        insert_row(&path, &format!(
            "INSERT INTO REPEATTRANSACTION {REPEAT_TRANSACTION_COLUMNS} VALUES ('rep-usd',0,{usetime},0,0,{next},1,1,'a1','','10','USD_USD',12.34,'Netflix','')"
        )).await;

        let (rows, cats, assets, curs) = load_repeats(&path).await;
        let mapped = map_repeats(&rows, &cats, &assets, &curs, chrono_tz::Asia::Seoul);
        assert_eq!(mapped.recurring.len(), 1);
        assert_eq!(mapped.recurring[0].amount_minor, 1234);
        assert_eq!(mapped.recurring[0].currency, "USD");
        assert_eq!(mapped.recurring[0].schedule_day, 9);
    }

    #[tokio::test]
    async fn repeat_falls_back_to_category_label_when_memo_and_payee_blank() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        let usetime = kst_millis(2026, 6, 1, 0, 0, 0);
        let next = kst_millis(2026, 7, 5, 9, 0, 0);
        // MEMO/PAYEE 공백 + 미지 카테고리/자산 → 이름은 폴백 라벨, merchant/account 없음.
        insert_row(&path, &format!(
            "INSERT INTO REPEATTRANSACTION {REPEAT_TRANSACTION_COLUMNS} VALUES ('rep-blank',0,{usetime},0,0,{next},1,1,'missing','','missing','KRW_KRW',5000.0,'  ','  ')"
        )).await;

        let (rows, cats, assets, curs) = load_repeats(&path).await;
        let mapped = map_repeats(&rows, &cats, &assets, &curs, chrono_tz::Asia::Seoul);
        assert_eq!(mapped.recurring.len(), 1);
        let rule = &mapped.recurring[0];
        assert_eq!(rule.name, "미분류");
        assert_eq!(rule.category_label, "미분류");
        assert_eq!(rule.merchant, None);
        assert_eq!(rule.account, None);
        assert_eq!(rule.schedule_day, 5);
    }

    #[tokio::test]
    async fn missing_repeat_table_degrades_to_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("no-repeat.sqlite");
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&opts).await.expect("open");
        sqlx::query("CREATE TABLE INOUTCOME (uid TEXT)")
            .execute(&mut conn)
            .await
            .expect("ddl");
        conn.close().await.expect("close");

        let mut backup = MoneyManagerBackup::open_read_only(&path)
            .await
            .expect("open read-only");
        let repeats = backup
            .load_repeat_transactions()
            .await
            .expect("missing table must not error");
        assert!(repeats.is_empty());
        backup.close().await.expect("close");
    }

    #[tokio::test]
    async fn installment_future_dated_rows_import_and_cursor_filters() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_db(&dir).await;
        // 카드 할부 분할행(cardDivideUid, 미래 일자) — 그대로 임포트.
        insert_row(
            &path,
            "INSERT INTO INOUTCOME VALUES ('inst-1','a1','10','할부 3/12',0,'2027-01-15','1','50000.0','','','div-1','2027-01',0,500,'KRW_KRW','')",
        )
        .await;
        insert_row(
            &path,
            "INSERT INTO INOUTCOME VALUES ('old-1','a1','10','과거행',0,'2026-01-01','1','1000.0','','','','',0,100,'KRW_KRW','')",
        )
        .await;
        // 삭제행은 커서와 무관하게 항상 보고(full-scan 계약).
        insert_row(
            &path,
            "INSERT INTO INOUTCOME VALUES ('del-old','a1','10','오래된삭제',0,'2026-01-02','1','1000.0','','','','',1,50,'KRW_KRW','')",
        )
        .await;
        let (rows, cats, assets, curs) = load_all(&path).await;
        let mapped = map_backup(
            &rows,
            &cats,
            &assets,
            &curs,
            Some(100),
            chrono_tz::Asia::Seoul,
        );
        assert_eq!(mapped.transactions.len(), 1);
        assert_eq!(mapped.transactions[0].source_ref, "inst-1");
        assert_eq!(mapped.transactions[0].spent_at, "2027-01-15");
        assert_eq!(mapped.deleted_uids, vec!["del-old".to_string()]);
        assert_eq!(
            mapped.skipped,
            vec![("old-1".to_string(), "cursor_not_newer")]
        );
    }
}
