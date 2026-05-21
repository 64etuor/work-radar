//! Agent 잡 실행기 (Phase 7, 뼈대). 자동화는 제안/실행 레일에만 붙고 결정 레일엔 들어가지 않는다(INVARIANT #1).
//!
//! 핵심 규칙:
//!  - INVARIANT #5: 모든 잡은 bound된다. 제네릭 timeout/kill은 `jobs.rs`의 JobManager가
//!    `tokio::select!`로 강제(어느 엔진이든 보장)하고, codex 전용 max_turns/cost_cap은
//!    `CodexRunner`의 JSONL consume 루프(`BoundsTracker`)가 강제해 초과 시 Err로 빠진다(드롭 → kill).
//!  - INVARIANT #6: 코드 잡은 git worktree에 격리(사용자 워킹트리 무손상). 샌드박스 기본 read_only,
//!    `danger_full`은 타입에 아예 없음(`Sandbox` enum). 제안 레일 잡은 종료 시 worktree 폐기.
//!  - INVARIANT #2: codex 출력은 외부를 직접 mutate하지 못한다 — `AgentOutcome.proposal`(draft)일 뿐.
//!  - 테스트 가능 seam: 코어(JobManager)는 `AgentRunner` 트레잇에만 의존(GitProvider/PrProvider 패턴,
//!    RPITIT — async_trait 무의존). 단위 테스트는 EchoRunner(실 셸아웃) 라이프사이클 + 순수 함수
//!    (`parse_codex_event`, `BoundsTracker`)로 검증. 실 codex 실행은 사용자 관찰 항목(Phase 2~6과 동일).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::models::{AgentRail, CodexAvailability, Engine, Sandbox};

/// codex 감지/worktree 등 보조 서브프로세스 호출 상한 (무한 대기 금지 — INVARIANT #5).
const AUX_TIMEOUT: Duration = Duration::from_secs(20);

/// 잡 bounds (INVARIANT #5). timeout/kill은 JobManager가, max_turns/cost_cap은 러너가 강제.
#[derive(Debug, Clone, Copy)]
pub struct Bounds {
    pub timeout: Duration,
    pub max_turns: u32,
    pub cost_cap_usd: f64,
}

/// 잡 산출물. codex 출력은 외부 직접 mutate 금지 → proposal(draft)일 뿐(INVARIANT #2).
#[derive(Debug, Clone, Default)]
pub struct AgentOutcome {
    /// 사람이 읽을 성공 요약.
    pub detail: String,
    pub cost_tokens: Option<u32>,
    pub cost_usd: Option<f64>,
    /// suggestion 산출물(JSON 문자열). Phase 7은 codex 최종 메시지만 담는다(Acceptance 전 draft).
    pub proposal: Option<String>,
}

/// 잡 실패/종료 사유. 모두 terminal로 노출(삼키지 않음).
#[derive(Debug, Clone)]
pub enum AgentError {
    /// JobManager timeout 초과 → kill.
    Timeout,
    /// kill switch(사용자 취소 또는 큐 대기 중 취소).
    Cancelled,
    /// max_turns 초과 → kill (codex).
    MaxTurnsExceeded(u32),
    /// cost cap(USD) 초과 → kill (codex).
    CostCapExceeded(f64),
    /// 프로세스 시작 실패(미설치/권한/worktree 준비 실패 등).
    Spawn(String),
    /// 비0 종료 또는 런타임 오류.
    Failed(String),
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentError::Timeout => write!(f, "timeout 초과로 kill됨"),
            AgentError::Cancelled => write!(f, "사용자가 취소(kill)함"),
            AgentError::MaxTurnsExceeded(n) => write!(f, "max_turns({n}) 초과로 kill됨"),
            AgentError::CostCapExceeded(c) => write!(f, "cost cap(${c:.4}) 초과로 kill됨"),
            AgentError::Spawn(m) => write!(f, "잡 시작 실패: {m}"),
            AgentError::Failed(m) => write!(f, "잡 실패: {m}"),
        }
    }
}

impl std::error::Error for AgentError {}

/// JobManager가 의존하는 유일한 실행 계약. 러너는 자기 설정을 보유하고 run()은 bounds/취소/로그경로만 받는다.
/// (RPITIT — async fn in trait. async_trait 의존성 없이 제네릭으로만 소비, GitProvider/PrProvider 패턴.)
pub trait AgentRunner: Send {
    /// 엔진 식별(architecture §5 계약). DB engine은 현재 커맨드가 명시 설정하고, 이 메서드는
    /// 멀티엔진 디스패치(Hermes/Claude, Phase 8+)에서 쓰인다. (Phase 0 keychain의 dead_code 선례)
    #[allow(dead_code)]
    fn engine(&self) -> Engine;

    /// 잡을 실행하고 stdout/stderr를 `log_path`에 스트림 캡처한다. max_turns/cost_cap은
    /// 러너가 강제(초과 시 Err). 제네릭 timeout/kill은 호출자(JobManager)가 select!로 감싼다.
    fn run(
        &self,
        bounds: Bounds,
        cancel: CancellationToken,
        log_path: PathBuf,
    ) -> impl std::future::Future<Output = Result<AgentOutcome, AgentError>> + Send;
}

// ── 로그 캡처 헬퍼 ────────────────────────────────────────────────────────────────

/// 자식 프로세스 stdout 줄을 로그 파일에 append하며 콜백으로 흘린다. 줄마다 flush해
/// timeout/kill로 future가 drop돼도 부분 로그가 남는다. EOF 시 줄 수를 반환.
async fn stream_to_log<F>(
    stdout: tokio::process::ChildStdout,
    log_path: &Path,
    mut on_line: F,
) -> Result<u32, AgentError>
where
    F: FnMut(&str) -> Option<AgentError>,
{
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .await
        .map_err(|e| AgentError::Failed(format!("로그 파일 열기 실패: {e}")))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut count: u32 = 0;
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let _ = file.write_all(line.as_bytes()).await;
                let _ = file.write_all(b"\n").await;
                let _ = file.flush().await;
                count = count.saturating_add(1);
                if let Some(err) = on_line(&line) {
                    return Err(err);
                }
            }
            Ok(None) => break,
            Err(e) => return Err(AgentError::Failed(format!("로그 스트림 읽기 실패: {e}"))),
        }
    }
    Ok(count)
}

/// 자식 stderr 마지막 일부를 모아 실패 사유로 쓴다(bounded — 통째로 들고 있지 않음).
async fn collect_stderr_tail(stderr: tokio::process::ChildStderr) -> String {
    let mut lines = BufReader::new(stderr).lines();
    let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    while let Ok(Some(line)) = lines.next_line().await {
        tail.push_back(line);
        if tail.len() > 20 {
            tail.pop_front();
        }
    }
    tail.into_iter().collect::<Vec<_>>().join("\n")
}

// ── EchoRunner (codex 없이 bound/kill/로그 캡처 검증) ───────────────────────────────

/// 테스트 잡 러너. 고정 셸 스크립트 + 위치 인자(인젝션 방지)로 `seconds`초 동안 1초 틱을 출력한다.
/// happy = 짧은 seconds(즉시 완료) / timeout 테스트 = 긴 seconds + 짧은 timeout(JobManager가 kill).
/// engine은 codex 스파인의 테스트 하네스라 `Engine::Codex`로 보고한다(실제 DB engine은 커맨드가 결정).
pub struct EchoRunner {
    pub seconds: u32,
    pub message: String,
}

impl AgentRunner for EchoRunner {
    fn engine(&self) -> Engine {
        Engine::Codex
    }

    async fn run(
        &self,
        _bounds: Bounds,
        _cancel: CancellationToken,
        log_path: PathBuf,
    ) -> Result<AgentOutcome, AgentError> {
        // 스크립트는 상수, seconds/message는 위치 인자($1/$2) → 셸 인젝션 없음.
        const SCRIPT: &str = r#"printf '%s\n' "$2"; n="$1"; i=0; while [ "$i" -lt "$n" ]; do printf 'tick %s\n' "$i"; i=$((i+1)); sleep 1; done"#;
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(SCRIPT)
            .arg("sh") // $0
            .arg(self.seconds.to_string()) // $1
            .arg(&self.message) // $2
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AgentError::Spawn(format!("echo 잡 시작 실패: {e}")))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::Failed("echo stdout 캡처 실패".into()))?;
        // 틱은 통과(bounds 강제는 JobManager의 timeout/kill이 담당).
        let count = stream_to_log(stdout, &log_path, |_| None).await?;

        let status = child
            .wait()
            .await
            .map_err(|e| AgentError::Failed(format!("echo wait 실패: {e}")))?;
        if !status.success() {
            return Err(AgentError::Failed(format!("echo 비정상 종료: {status}")));
        }
        Ok(AgentOutcome {
            detail: format!("echo 잡 완료 ({count} 줄 캡처)"),
            ..Default::default()
        })
    }
}

// ── codex JSONL 파싱 + bounds 추적 (순수 — 단위 테스트 대상) ─────────────────────────

/// `codex exec --json`의 JSONL 한 줄에서 도출한 관심 이벤트. 스키마는 버전마다 다를 수 있어
/// 방어적으로 파싱한다(실 스키마는 사용자 관찰로 확정 — Phase 2~6 선례).
#[derive(Debug, Clone, PartialEq)]
pub enum CodexEvent {
    /// 에이전트 턴 경계.
    Turn,
    /// 누적 토큰 사용량.
    Usage(u32),
    /// 누적 비용(USD).
    Cost(f64),
    /// 최종/중간 에이전트 메시지 텍스트(턴으로도 집계).
    Message(String),
    /// 관심 밖.
    Other,
}

/// JSON value에서 후보 키들 중 첫 정수를 찾는다(중첩 객체도 1단계 탐색).
fn find_u64(v: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    if let Some(obj) = v.as_object() {
        for (k, val) in obj {
            if keys.contains(&k.as_str()) {
                if let Some(n) = val.as_u64() {
                    return Some(n);
                }
            }
            if let Some(n) = find_u64(val, keys) {
                return Some(n);
            }
        }
    }
    None
}

/// JSON value에서 후보 키들 중 첫 실수를 찾는다(중첩 1단계 탐색).
fn find_f64(v: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    if let Some(obj) = v.as_object() {
        for (k, val) in obj {
            if keys.contains(&k.as_str()) {
                if let Some(n) = val.as_f64() {
                    return Some(n);
                }
            }
            if let Some(n) = find_f64(val, keys) {
                return Some(n);
            }
        }
    }
    None
}

/// JSONL 한 줄 → CodexEvent. 비-JSON/빈 줄은 None(로그엔 이미 raw로 남는다).
pub fn parse_codex_event(line: &str) -> Option<CodexEvent> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;

    // 비용 우선(cap 트립이 가장 중요).
    if let Some(c) = find_f64(&v, &["cost_usd", "total_cost_usd", "usd"]) {
        return Some(CodexEvent::Cost(c));
    }
    if let Some(t) = find_u64(
        &v,
        &[
            "total_tokens",
            "total_token_usage",
            "tokens",
            "token_count",
            "total",
        ],
    ) {
        return Some(CodexEvent::Usage(t as u32));
    }

    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let is_turn = ty.contains("agent_message")
        || ty.contains("assistant")
        || ty == "item.completed"
        || ty == "message";
    if is_turn {
        if let Some(m) = v
            .get("message")
            .and_then(|x| x.as_str())
            .or_else(|| v.pointer("/msg/message").and_then(|x| x.as_str()))
            .or_else(|| v.pointer("/item/text").and_then(|x| x.as_str()))
        {
            return Some(CodexEvent::Message(m.to_string()));
        }
        return Some(CodexEvent::Turn);
    }
    Some(CodexEvent::Other)
}

/// codex 전용 bounds(max_turns/cost_cap) 추적기. observe가 초과를 감지하면 AgentError를 반환해
/// consume 루프가 즉시 빠지고(드롭 → kill) 잡이 failed로 마감된다(INVARIANT #5).
#[derive(Debug)]
pub struct BoundsTracker {
    max_turns: u32,
    cost_cap_usd: f64,
    pub turns: u32,
    pub tokens: Option<u32>,
    pub usd: Option<f64>,
    pub last_message: Option<String>,
}

impl BoundsTracker {
    pub fn new(max_turns: u32, cost_cap_usd: f64) -> Self {
        Self {
            max_turns,
            cost_cap_usd,
            turns: 0,
            tokens: None,
            usd: None,
            last_message: None,
        }
    }

    pub fn observe(&mut self, ev: CodexEvent) -> Option<AgentError> {
        match ev {
            CodexEvent::Turn => {
                self.turns = self.turns.saturating_add(1);
                if self.turns > self.max_turns {
                    return Some(AgentError::MaxTurnsExceeded(self.max_turns));
                }
            }
            CodexEvent::Message(m) => {
                self.turns = self.turns.saturating_add(1);
                self.last_message = Some(m);
                if self.turns > self.max_turns {
                    return Some(AgentError::MaxTurnsExceeded(self.max_turns));
                }
            }
            CodexEvent::Usage(t) => self.tokens = Some(t),
            CodexEvent::Cost(c) => {
                self.usd = Some(c);
                if c > self.cost_cap_usd {
                    return Some(AgentError::CostCapExceeded(self.cost_cap_usd));
                }
            }
            CodexEvent::Other => {}
        }
        None
    }

    /// 성공 시 사람이 읽을 요약.
    fn summary(&self) -> String {
        let mut parts = vec![format!("{} 턴", self.turns)];
        if let Some(t) = self.tokens {
            parts.push(format!("{t} 토큰"));
        }
        if let Some(u) = self.usd {
            parts.push(format!("${u:.4}"));
        }
        parts.join(" · ")
    }
}

/// codex 최종 메시지 → proposal JSON 문자열(항상 유효한 JSON 객체). 메시지가 JSON 객체(또는
/// ```json 펜스로 감싼 객체)면 그대로 보존하고, 아니면 `{"raw": <message>}`로 감싼다(스키마-관용 fallback).
/// Acceptance 전 draft일 뿐이라 검증은 소비 측(commands `pr_proposal`)에서 한다(INVARIANT #2).
pub fn proposal_from_message(message: &str) -> String {
    let trimmed = message.trim();
    // ```json … ``` 또는 ``` … ``` 펜스 제거.
    let unfenced = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.trim_start())
        .and_then(|s| s.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);
    if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(unfenced)
    {
        return serde_json::Value::Object(obj).to_string();
    }
    serde_json::json!({ "raw": message }).to_string()
}

// ── CodexRunner (codex exec --json, read_only 샌드박스, worktree 격리) ──────────────

/// 코드 잡 실행 시 자동 정리되는 worktree. 제안 레일은 종료 시 폐기(keep=false),
/// 실행 레일(Phase 10)은 diff 검수용으로 보존(keep=true). Drop은 await 불가 → 동기 best-effort 정리.
struct WorktreeGuard {
    repo_path: PathBuf,
    wt_path: PathBuf,
    keep: bool,
}

impl Drop for WorktreeGuard {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        // best-effort: 실패해도 다음 실행에서 prune 가능(orphan 허용).
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&self.repo_path)
            .args(["worktree", "remove", "--force"])
            .arg(&self.wt_path)
            .output();
    }
}

/// `codex exec --json` 러너. read_only 샌드박스 기본, 코드 잡은 worktree 격리(INVARIANT #6).
pub struct CodexRunner {
    pub codex_bin: PathBuf,
    /// 고유 run id (worktree 경로/식별).
    pub run_id: String,
    pub prompt: String,
    pub sandbox: Sandbox,
    pub rail: AgentRail,
    /// 코드 잡이면 베이스 레포 경로(여기서 worktree 분기). 비-레포 잡이면 None.
    pub repo_path: Option<PathBuf>,
    /// worktree 생성 루트.
    pub worktree_root: PathBuf,
    /// 비-레포 잡의 작업 디렉터리(scratch).
    pub scratch_dir: PathBuf,
    /// 잡 시작 전 cwd에 써둘 입력 파일들 (상대 이름, 내용). codex가 read_only로 읽는다.
    /// Phase 8 = PR diff(`pr.diff`). Rust가 쓰므로 read_only 샌드박스와 무관(샌드박스는 codex 쓰기만 제한).
    pub input_files: Vec<(String, String)>,
}

impl CodexRunner {
    /// 코드 잡이면 `git worktree add --detach`로 격리 트리를 만들고 (경로, 정리가드)를 돌려준다.
    /// 비-레포 잡은 scratch_dir + 가드 없음.
    async fn prepare_cwd(&self) -> Result<(PathBuf, Option<WorktreeGuard>), AgentError> {
        match &self.repo_path {
            Some(rp) => {
                let wt = self.worktree_root.join(&self.run_id);
                let wt_str = wt
                    .to_str()
                    .ok_or_else(|| AgentError::Spawn("worktree 경로 인코딩 실패".into()))?;
                let out = tokio::time::timeout(
                    AUX_TIMEOUT,
                    Command::new("git")
                        .arg("-C")
                        .arg(rp)
                        .args(["worktree", "add", "--detach"])
                        .arg(wt_str)
                        .arg("HEAD")
                        .output(),
                )
                .await
                .map_err(|_| AgentError::Spawn("git worktree add 타임아웃".into()))?
                .map_err(|e| AgentError::Spawn(format!("git worktree add 실행 실패: {e}")))?;
                if !out.status.success() {
                    return Err(AgentError::Spawn(format!(
                        "git worktree add 실패: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    )));
                }
                let keep = matches!(self.rail, AgentRail::Execution);
                Ok((
                    wt.clone(),
                    Some(WorktreeGuard {
                        repo_path: rp.clone(),
                        wt_path: wt,
                        keep,
                    }),
                ))
            }
            None => {
                tokio::fs::create_dir_all(&self.scratch_dir).await.ok();
                Ok((self.scratch_dir.clone(), None))
            }
        }
    }
}

impl AgentRunner for CodexRunner {
    fn engine(&self) -> Engine {
        Engine::Codex
    }

    async fn run(
        &self,
        bounds: Bounds,
        _cancel: CancellationToken,
        log_path: PathBuf,
    ) -> Result<AgentOutcome, AgentError> {
        // worktree 격리(코드 잡) — 가드는 run 스코프 동안 살아있다가 종료/드롭 시 정리(제안 레일).
        let (cwd, _guard) = self.prepare_cwd().await?;

        // 입력 파일(예: PR diff)을 cwd에 써둔다 — codex가 read_only로 읽는다.
        for (name, content) in &self.input_files {
            tokio::fs::write(cwd.join(name), content)
                .await
                .map_err(|e| AgentError::Spawn(format!("입력 파일 쓰기 실패({name}): {e}")))?;
        }

        let cwd_str = cwd
            .to_str()
            .ok_or_else(|| AgentError::Spawn("작업 디렉터리 인코딩 실패".into()))?;
        // codex exec --json --sandbox <flag> --color never -C <cwd> --skip-git-repo-check -- <prompt>
        // (실 설치본 0.125 플래그 검증.) `--`로 prompt가 플래그로 오인되지 않게 한다.
        let mut child = Command::new(&self.codex_bin)
            .arg("exec")
            .arg("--json")
            .arg("--sandbox")
            .arg(self.sandbox.as_codex_flag())
            .arg("--color")
            .arg("never")
            .arg("-C")
            .arg(cwd_str)
            .arg("--skip-git-repo-check")
            .arg("--")
            .arg(&self.prompt)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AgentError::Spawn(format!("codex 시작 실패(설치/PATH 확인): {e}")))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::Failed("codex stdout 캡처 실패".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AgentError::Failed("codex stderr 캡처 실패".into()))?;

        let mut tracker = BoundsTracker::new(bounds.max_turns, bounds.cost_cap_usd);
        // JSONL을 로그에 raw로 남기면서 이벤트를 추적, max_turns/cost_cap 초과 시 즉시 Err(드롭→kill).
        let stream = stream_to_log(stdout, &log_path, |line| {
            parse_codex_event(line).and_then(|ev| tracker.observe(ev))
        });
        let stderr_fut = collect_stderr_tail(stderr);
        let (stream_res, stderr_tail) = tokio::join!(stream, stderr_fut);
        stream_res?;

        let status = child
            .wait()
            .await
            .map_err(|e| AgentError::Failed(format!("codex wait 실패: {e}")))?;
        if !status.success() {
            return Err(AgentError::Failed(format!(
                "codex 비정상 종료({status}): {}",
                stderr_tail.trim()
            )));
        }

        let proposal = tracker.last_message.as_deref().map(proposal_from_message);
        Ok(AgentOutcome {
            detail: tracker.summary(),
            cost_tokens: tracker.tokens,
            cost_usd: tracker.usd,
            proposal,
        })
    }
}

// ── codex 가용성 감지 (graceful degrade) ───────────────────────────────────────────

/// PATH 또는 알려진 경로에서 codex 바이너리를 찾는다(GUI 앱은 launchd PATH가 셸과 다를 수 있음).
/// `--version`이 도는 첫 후보를 반환. 못 찾으면 None → 자동화 UI 비활성(graceful degrade).
pub async fn resolve_codex_bin() -> Option<PathBuf> {
    let candidates = ["codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
    for c in candidates {
        if codex_version(Path::new(c)).await.is_some() {
            return Some(PathBuf::from(c));
        }
    }
    None
}

/// `codex --version` (bounded). 성공 시 버전 문자열.
async fn codex_version(bin: &Path) -> Option<String> {
    let out = tokio::time::timeout(AUX_TIMEOUT, Command::new(bin).arg("--version").output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `codex login status` (bounded) exit 0 = 로그인됨.
async fn codex_login_ok(bin: &Path) -> bool {
    matches!(
        tokio::time::timeout(
            AUX_TIMEOUT,
            Command::new(bin).args(["login", "status"]).output(),
        )
        .await,
        Ok(Ok(out)) if out.status.success()
    )
}

/// codex 설치/인증 상태를 종합(graceful degrade 판정용). installed=false면 authed도 false.
pub async fn codex_availability(bin: Option<&Path>) -> CodexAvailability {
    match bin {
        None => CodexAvailability {
            installed: false,
            authed: false,
            version: None,
            detail: "codex CLI를 찾을 수 없습니다 — 자동화 기능 비활성. 설치 후 재시작하세요."
                .into(),
        },
        Some(b) => {
            let version = codex_version(b).await;
            if version.is_none() {
                return CodexAvailability {
                    installed: false,
                    authed: false,
                    version: None,
                    detail: "codex 실행 실패 — 자동화 기능 비활성.".into(),
                };
            }
            let authed = codex_login_ok(b).await;
            let detail = if authed {
                "codex 설치·로그인됨 — 자동화 가능.".into()
            } else {
                "codex 설치됨 / 미인증 — `codex login` 후 사용 가능.".into()
            };
            CodexAvailability {
                installed: true,
                authed,
                version,
                detail,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_event_cost_and_usage() {
        // 비용은 cost 이벤트로.
        assert_eq!(
            parse_codex_event(r#"{"type":"token_count","cost_usd":0.12}"#),
            Some(CodexEvent::Cost(0.12))
        );
        // 토큰 누적(중첩 usage).
        assert_eq!(
            parse_codex_event(r#"{"type":"token_count","usage":{"total_tokens":2048}}"#),
            Some(CodexEvent::Usage(2048))
        );
        // 메시지 턴.
        assert_eq!(
            parse_codex_event(r#"{"type":"agent_message","message":"done"}"#),
            Some(CodexEvent::Message("done".into()))
        );
        // 메시지 없는 턴.
        assert_eq!(
            parse_codex_event(r#"{"type":"item.completed"}"#),
            Some(CodexEvent::Turn)
        );
        // 관심 밖 / 비-JSON.
        assert_eq!(
            parse_codex_event(r#"{"type":"task_started"}"#),
            Some(CodexEvent::Other)
        );
        assert_eq!(parse_codex_event("not json"), None);
        assert_eq!(parse_codex_event(""), None);
    }

    #[test]
    fn bounds_tracker_trips_on_cost_cap() {
        let mut t = BoundsTracker::new(10, 0.50);
        assert!(t.observe(CodexEvent::Cost(0.10)).is_none());
        assert!(t.observe(CodexEvent::Usage(100)).is_none());
        // cap 초과 → CostCapExceeded.
        match t.observe(CodexEvent::Cost(0.75)) {
            Some(AgentError::CostCapExceeded(c)) => assert_eq!(c, 0.50),
            other => panic!("expected CostCapExceeded, got {other:?}"),
        }
        assert_eq!(t.usd, Some(0.75));
        assert_eq!(t.tokens, Some(100));
    }

    #[test]
    fn bounds_tracker_trips_on_max_turns() {
        let mut t = BoundsTracker::new(2, 100.0);
        assert!(t.observe(CodexEvent::Turn).is_none()); // 1
        assert!(t.observe(CodexEvent::Message("a".into())).is_none()); // 2
                                                                       // 3번째 턴 → 초과.
        match t.observe(CodexEvent::Turn) {
            Some(AgentError::MaxTurnsExceeded(n)) => assert_eq!(n, 2),
            other => panic!("expected MaxTurnsExceeded, got {other:?}"),
        }
        assert_eq!(t.last_message.as_deref(), Some("a"));
    }

    #[test]
    fn proposal_from_message_handles_json_fences_and_raw() {
        // 순수 JSON 객체는 보존(키 유지).
        let p = proposal_from_message(r#"{"summary":"hi","selfChecks":[]}"#);
        let v: serde_json::Value = serde_json::from_str(&p).unwrap();
        assert_eq!(v["summary"], "hi");
        // ```json 펜스로 감싼 객체도 추출.
        let fenced = "```json\n{\"summary\":\"x\"}\n```";
        let v2: serde_json::Value = serde_json::from_str(&proposal_from_message(fenced)).unwrap();
        assert_eq!(v2["summary"], "x");
        // 비-JSON은 raw로 감싸 항상 유효한 객체를 보장.
        let v3: serde_json::Value =
            serde_json::from_str(&proposal_from_message("not json at all")).unwrap();
        assert_eq!(v3["raw"], "not json at all");
        // JSON 배열(객체 아님)도 raw fallback.
        let v4: serde_json::Value =
            serde_json::from_str(&proposal_from_message("[1,2,3]")).unwrap();
        assert_eq!(v4["raw"], "[1,2,3]");
    }

    #[tokio::test]
    async fn echo_runner_captures_log_and_completes() {
        let dir = std::env::temp_dir().join(format!(
            "wr-echo-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("echo.log");
        let runner = EchoRunner {
            seconds: 0,
            message: "hello-radar".into(),
        };
        let bounds = Bounds {
            timeout: Duration::from_secs(10),
            max_turns: 1,
            cost_cap_usd: 1.0,
        };
        let outcome = runner
            .run(bounds, CancellationToken::new(), log.clone())
            .await
            .expect("echo job should succeed");
        assert!(outcome.detail.contains("완료"));
        let logged = std::fs::read_to_string(&log).unwrap();
        assert!(
            logged.contains("hello-radar"),
            "log should capture message, got: {logged:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
