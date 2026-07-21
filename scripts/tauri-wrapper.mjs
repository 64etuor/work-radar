#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

function hasRunnerArg(args) {
  return args.some((arg) => arg === "--runner" || arg === "-r" || arg.startsWith("--runner="));
}

export function buildTauriArgs(args, env, platform) {
  if (
    args[0] !== "dev" ||
    platform !== "darwin" ||
    env.WORK_RADAR_UNSIGNED_DEV === "1" ||
    hasRunnerArg(args)
  ) {
    return args;
  }

  return [
    args[0],
    "--runner",
    join(repoRoot, "scripts", "dev-codesign-runner.sh"),
    ...args.slice(1),
  ];
}

const platform = process.env.WORK_RADAR_FORCE_PLATFORM ?? process.platform;
const tauriCli =
  process.env.TAURI_CLI_JS ?? join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const args = buildTauriArgs(process.argv.slice(2), process.env, platform);
const result = spawnSync(process.execPath, [tauriCli, ...args], { stdio: "inherit" });

if (result.error) {
  process.stderr.write(`Tauri CLI 실행 실패: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
