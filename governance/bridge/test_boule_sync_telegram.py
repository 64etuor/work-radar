import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

import boule_sync_telegram as bridge


def _esc(decision_id="evt_d", blocked_id="evt_b", session_id=None):
    return {
        "decisionId": decision_id,
        "blockedEventId": blocked_id,
        "question": "DB: sqlite or postgres?",
        "options": [
            {"token": "opt0", "label": "sqlite", "reply": f"BOULE:{blocked_id}:{decision_id}:opt0"},
            {"token": "opt1", "label": "postgres", "reply": f"BOULE:{blocked_id}:{decision_id}:opt1"},
        ],
        "sessionId": session_id,
        "agentRecommendation": None,
    }


class BuildNormalizedEvent(unittest.TestCase):
    def test_routable_and_carries_title_detail_and_tokens(self):
        ne = bridge.build_normalized_event(_esc())
        self.assertTrue(ne["routable"])
        self.assertIn("sqlite or postgres", ne["title"])
        self.assertIn("BOULE:evt_b:evt_d:opt0", ne["detail"])
        self.assertIn("BOULE:evt_b:evt_d:opt1", ne["detail"])

    def test_topic_key_reuses_session_when_present_else_dedicated_boule_topic(self):
        self.assertEqual(bridge.build_normalized_event(_esc(session_id="sess-9"))["key"], "session:sess-9")
        ne = bridge.build_normalized_event(_esc())  # no session
        self.assertEqual(ne["key"], "boule:evt_d")
        self.assertEqual(ne["workspace_title"], "Boule")


class RenderDetail(unittest.TestCase):
    """Compact format: numbered option + its full reply token on ONE line, no blank lines
    between options, recommendation inline. The reply token stays the exact 4-field string
    (the inbound interceptor matches it by equality), so it must survive verbatim."""

    def test_token_is_on_same_line_as_numbered_label(self):
        detail = bridge._render_detail(_esc())
        self.assertIn("1) sqlite  BOULE:evt_b:evt_d:opt0", detail)
        self.assertIn("2) postgres  BOULE:evt_b:evt_d:opt1", detail)

    def test_no_blank_lines_between_options(self):
        esc = _esc()
        esc["agentRecommendation"] = "sqlite"
        body = bridge._render_detail(esc).splitlines()
        opt_idx = [i for i, ln in enumerate(body) if ln.startswith(("1)", "2)"))]
        self.assertEqual(opt_idx, [3, 4])  # contiguous: question, blank, prompt, opt1, opt2
        self.assertEqual(body[-1], "(추천: sqlite)")

    def test_omits_recommendation_line_when_absent(self):
        self.assertNotIn("추천", bridge._render_detail(_esc()))

    def test_renders_description_as_indented_subline_when_present(self):
        esc = _esc()
        esc["options"][0]["description"] = "단일 파일, 가벼움"
        detail = bridge._render_detail(esc)
        self.assertIn("1) sqlite  BOULE:evt_b:evt_d:opt0\n   단일 파일, 가벼움", detail)

    def test_omits_description_subline_when_absent_or_blank(self):
        esc = _esc()
        esc["options"][1]["description"] = "   "  # whitespace-only → omitted
        self.assertNotIn("\n   ", bridge._render_detail(esc))


class Dedup(unittest.TestCase):
    def test_already_sent_blocked_ids_are_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            marker = pathlib.Path(d) / "telegram-sent.json"
            marker.write_text(json.dumps({"evt_b": {"sent_at": "x"}}), encoding="utf-8")
            sent = bridge.load_sent(marker)
            self.assertEqual(
                bridge.select_unsent([_esc(blocked_id="evt_b"), _esc(blocked_id="evt_z")], sent, limit=10),
                [_esc(blocked_id="evt_z")],
            )

    def test_limit_bounds_the_batch(self):
        batch = [_esc(blocked_id=f"evt_{i}") for i in range(5)]
        self.assertEqual(len(bridge.select_unsent(batch, {}, limit=2)), 2)


class SendModeGuard(unittest.TestCase):
    """A real send must be explicit (--live) AND target a persistent workspace; everything
    else stays dry-run. This is what stops a smoke/test workspace reaching the live sink."""

    REPO_WS = pathlib.Path(__file__).resolve().parent  # persistent: not under a temp root

    def test_default_no_flags_is_dry_run(self):
        self.assertTrue(bridge.resolve_send_mode(live=False, dry_run=False, workspace=self.REPO_WS))

    def test_explicit_dry_run_stays_dry_run(self):
        self.assertTrue(bridge.resolve_send_mode(live=False, dry_run=True, workspace=self.REPO_WS))

    def test_live_on_persistent_workspace_sends(self):
        self.assertFalse(bridge.resolve_send_mode(live=True, dry_run=False, workspace=self.REPO_WS))

    def test_live_on_throwaway_workspace_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit):
                bridge.resolve_send_mode(live=True, dry_run=False, workspace=pathlib.Path(d))

    def test_live_and_dry_run_are_mutually_exclusive(self):
        with self.assertRaises(SystemExit):
            bridge.resolve_send_mode(live=True, dry_run=True, workspace=self.REPO_WS)

    def test_is_ephemeral_workspace_detects_tmp_vs_repo(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(bridge.is_ephemeral_workspace(pathlib.Path(d)))
        self.assertFalse(bridge.is_ephemeral_workspace(self.REPO_WS))


class MainWiring(unittest.TestCase):
    """Pins that main() routes the COMPUTED send-mode into post_to_sink — not the raw
    a.dry_run. resolve_send_mode being correct is worthless if main() ignores it; a future
    edit reintroducing a.dry_run at the sink call site would leak past every other test."""

    REPO_WS = pathlib.Path(__file__).resolve().parent  # persistent: --live is allowed here

    def _captured_dry_run(self, argv):
        captured = {}

        def fake_post(ne, *, dry_run):
            captured.setdefault("dry_run", dry_run)
            return True

        with mock.patch.object(sys, "argv", argv), mock.patch.dict(
            os.environ, {"BOULE_WORKSPACE": str(self.REPO_WS)}
        ), mock.patch.object(bridge, "fetch_pending", lambda ws: [_esc()]), mock.patch.object(
            bridge, "load_sent", lambda p: {}
        ), mock.patch.object(
            bridge, "save_sent", lambda p, d: None
        ), mock.patch.object(
            bridge, "post_to_sink", fake_post
        ):
            bridge.main()
        return captured["dry_run"]

    def test_live_flag_reaches_sink_as_send(self):
        self.assertFalse(self._captured_dry_run(["boule_sync_telegram", "--live"]))

    def test_no_flags_reaches_sink_as_dry_run(self):
        self.assertTrue(self._captured_dry_run(["boule_sync_telegram"]))


if __name__ == "__main__":
    unittest.main()
