import json
import pathlib
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
