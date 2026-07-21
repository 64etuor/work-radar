import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const wrapper = new URL("./tauri-wrapper.mjs", import.meta.url);

function runWrapper(platform, args, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "work-radar-tauri-wrapper-"));
  const capture = join(dir, "args.json");
  const fakeCli = join(dir, "fake-tauri.mjs");
  writeFileSync(
    fakeCli,
    'import { writeFileSync } from "node:fs"; writeFileSync(process.env.TAURI_CAPTURE, JSON.stringify(process.argv.slice(2)));',
  );

  try {
    const result = spawnSync(process.execPath, [fileURLToPath(wrapper), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...extraEnv,
        TAURI_CAPTURE: capture,
        TAURI_CLI_JS: fakeCli,
        WORK_RADAR_FORCE_PLATFORM: platform,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(capture, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Windows forwards Tauri arguments without a POSIX shell or signing runner", () => {
  assert.deepEqual(runWrapper("win32", ["dev", "--verbose"]), ["dev", "--verbose"]);
});

test("macOS dev injects the repository signing runner", () => {
  const args = runWrapper("darwin", ["dev", "--verbose"]);
  assert.equal(args[0], "dev");
  assert.equal(args[1], "--runner");
  assert.equal(args[2].endsWith(join("scripts", "dev-codesign-runner.sh")), true);
  assert.equal(args[3], "--verbose");
});

test("macOS preserves explicit runner and unsigned escape hatch", () => {
  assert.deepEqual(runWrapper("darwin", ["dev", "--runner", "custom-runner"]), [
    "dev",
    "--runner",
    "custom-runner",
  ]);
  assert.deepEqual(runWrapper("darwin", ["dev"], { WORK_RADAR_UNSIGNED_DEV: "1" }), ["dev"]);
});
