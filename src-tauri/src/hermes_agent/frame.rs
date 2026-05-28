//! Newline-delimited JSON (NDJSON) frame codec for ACP (Agent Client Protocol) over stdio.
//!
//! # Wire-format discovery — 2026-05-28
//!
//! The task brief assumed LSP-style `Content-Length:` framing. Discovery against
//! `hermes acp` (hermes-agent v0.14.0, acp lib v0.11.2) proved this wrong.
//!
//! ## Source evidence
//! `acp/connection.py:62`: docstring reads "Minimal JSON-RPC 2.0 connection over
//! **newline-delimited JSON frames**."
//! `acp/connection.py:151`: receive loop calls `self._reader.readline()`.
//! `acp/task/sender.py:33`: write path is
//! `json.dumps(payload, separators=(",",":")) + "\n"` — compact JSON + LF, no headers.
//!
//! ## Live probe (python3 subprocess, real OS pipe — 2026-05-28)
//!
//! Request (→ stdin of `hermes acp`):
//! ```text
//! {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n
//! ```
//!
//! Response frame 1 (stdout, initialize result, hex prefix):
//! ```text
//! 7b 22 6a 73 6f 6e 72 70 63 22 3a 22 32 2e 30 22  {"jsonrpc":"2.0"
//! 2c 22 69 64 22 3a 31 2c 22 72 65 73 75 6c 74 22  ,"id":1,"result"
//! ...trailing LF (0x0a)
//! ```
//! Parsed: `{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{...},"agentInfo":{"name":"hermes-agent","version":"0.14.0"},"protocolVersion":1}}`
//!
//! After `session/new` request, server emits:
//! - id=2 result with `{"sessionId":"<uuid>","models":{...},"modes":{...}}`
//! - notification `session/update` with `availableCommands` array:
//!   `[{"name":"help","description":"List available commands"}, ...]`
//! - notification `session/update` with usage: `{"size":272000,"used":10456,"sessionUpdate":"usage_update"}`
//!
//! ## Frame format (confirmed)
//! Each frame is a single line: compact JSON followed by exactly one `\n` (0x0a).
//! No `Content-Length` headers. No `\r\n`. No framing envelope.
//!
//! ## Method names (from acp/meta.py, confirmed live)
//! - `initialize`
//! - `session/new`, `session/prompt`, `session/cancel`, `session/close`
//! - `session/list`, `session/load`, `session/resume`, `session/fork`
//! - notifications inbound: `session/update`

use crate::error::AppError;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt};

/// Read one NDJSON frame from `reader`.
///
/// Reads until `\n`, strips the trailing newline, and returns the raw UTF-8
/// bytes of the JSON object (without the terminating `\n`).
/// Returns an error on EOF before any data or on I/O failure.
#[allow(dead_code)]
pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, AppError> {
    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .await
        .map_err(|e| AppError::unexpected("hermes.acp.frame.read", e.to_string()))?;
    if n == 0 {
        return Err(AppError::unexpected(
            "hermes.acp.frame",
            "eof: hermes acp closed stdout".to_string(),
        ));
    }
    // Strip trailing \n (and optional \r for robustness)
    let trimmed = line.trim_end_matches(['\r', '\n']);
    Ok(trimmed.as_bytes().to_vec())
}

/// Encode one NDJSON frame for writing to `hermes acp` stdin.
///
/// Appends a single `\n` to `body` — no headers, no envelope.
#[allow(dead_code)]
pub fn encode_frame(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 1);
    out.extend_from_slice(body);
    out.push(b'\n');
    out
}

/// Write one NDJSON frame to `writer` and flush.
#[allow(dead_code)]
pub async fn write_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    body: &[u8],
) -> Result<(), AppError> {
    let frame = encode_frame(body);
    writer
        .write_all(&frame)
        .await
        .map_err(|e| AppError::unexpected("hermes.acp.frame.write", e.to_string()))?;
    writer
        .flush()
        .await
        .map_err(|e| AppError::unexpected("hermes.acp.frame.flush", e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn parse_single_frame() {
        let bytes = b"{\"jsonrpc\":\"2.0\"}\n";
        let mut r = BufReader::new(&bytes[..]);
        let frame = read_frame(&mut r).await.unwrap();
        assert_eq!(frame, b"{\"jsonrpc\":\"2.0\"}");
    }

    #[tokio::test]
    async fn parse_back_to_back_frames() {
        let bytes = b"{\"a\":1}\n{\"b\":2}\n";
        let mut r = BufReader::new(&bytes[..]);
        assert_eq!(read_frame(&mut r).await.unwrap(), b"{\"a\":1}");
        assert_eq!(read_frame(&mut r).await.unwrap(), b"{\"b\":2}");
    }

    #[test]
    fn encode_frame_format() {
        assert_eq!(&encode_frame(b"{\"x\":1}"), b"{\"x\":1}\n");
    }

    #[test]
    fn encode_frame_no_extra_bytes() {
        let body = b"{\"jsonrpc\":\"2.0\",\"id\":1}";
        let encoded = encode_frame(body);
        assert_eq!(encoded.len(), body.len() + 1);
        assert_eq!(encoded.last(), Some(&b'\n'));
    }

    #[tokio::test]
    async fn eof_returns_error() {
        let bytes: &[u8] = b"";
        let mut r = BufReader::new(bytes);
        assert!(read_frame(&mut r).await.is_err());
    }

    #[tokio::test]
    async fn strips_crlf() {
        let bytes = b"{\"ok\":true}\r\n";
        let mut r = BufReader::new(&bytes[..]);
        let frame = read_frame(&mut r).await.unwrap();
        assert_eq!(frame, b"{\"ok\":true}");
    }
}
