-- Workstream F: remove the Hermes Telegram messenger bridge.
-- Reverts the 0012 bridge tables (the in-app ACP Hermes agent panel is unaffected —
-- it has no DB tables here). Drop messages first (standalone, safe order).
DROP TABLE IF EXISTS hermes_messages;
DROP TABLE IF EXISTS hermes_bridge;
