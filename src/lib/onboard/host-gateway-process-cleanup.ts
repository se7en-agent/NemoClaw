// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sleepMs } from "../core/wait";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface HostOpenShellGatewayCleanupDeps {
  commandExists?: (command: string) => boolean;
  currentUsername?: string;
  env?: NodeJS.ProcessEnv;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  log?: (message: string) => void;
  readFileSync?: (target: string, encoding: BufferEncoding) => string;
  run?: (command: string, args: string[], options?: SpawnSyncOptions) => RunResult;
  warn?: (message: string) => void;
}

export interface HostOpenShellGatewayCleanupResult {
  stopped: number[];
  skippedNonMatchingPids: number[];
}

const TERM_WAIT_MS = 1000;
const KILL_WAIT_MS = 1000;

function toRunResult(result: ReturnType<typeof spawnSync>): RunResult {
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function defaultRun(command: string, args: string[], options: SpawnSyncOptions = {}): RunResult {
  return toRunResult(spawnSync(command, args, { encoding: "utf-8", ...options }));
}

function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  return defaultRun("sh", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], { env }).status === 0;
}

function defaultKill(pid: number, signal?: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function defaultStateDir(env: NodeJS.ProcessEnv): string {
  const configured = env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  const home = env.HOME || os.homedir();
  return path.join(home, ".local", "state", "nemoclaw", "openshell-docker-gateway");
}

function parsePidLines(output: string): number[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
}

function readProcessEnv(
  pid: number,
  deps: Required<Pick<HostOpenShellGatewayCleanupDeps, "readFileSync">>,
): Record<string, string> | null {
  try {
    const raw = deps.readFileSync(`/proc/${pid}/environ`, "utf-8");
    const env: Record<string, string> = {};
    for (const entry of raw.split("\0")) {
      if (!entry) continue;
      const idx = entry.indexOf("=");
      if (idx <= 0) continue;
      env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return env;
  } catch {
    return null;
  }
}

function pidExists(pid: number, deps: Required<Pick<HostOpenShellGatewayCleanupDeps, "env" | "run">>): boolean {
  return deps.run("ps", ["-p", String(pid), "-o", "pid="], { env: deps.env }).status === 0;
}

function waitForExit(
  pid: number,
  deps: Required<Pick<HostOpenShellGatewayCleanupDeps, "env" | "run">>,
  timeoutMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid, deps)) return true;
    sleepMs(50);
  }
  return !pidExists(pid, deps);
}

function pidCmdlineMatches(pid: number, deps: Required<Pick<HostOpenShellGatewayCleanupDeps, "env" | "run">>): boolean {
  const result = deps.run("ps", ["-p", String(pid), "-o", "args="], { env: deps.env });
  return result.status === 0 && result.stdout.includes("openshell-gateway");
}

function envMatchesNemoclawDockerGateway(processEnv: Record<string, string>, expectedStateDir: string): boolean {
  if (processEnv.OPENSHELL_DRIVERS !== "docker") return false;
  const dbUrl = processEnv.OPENSHELL_DB_URL || "";
  const expectedDbUrl = `sqlite:${path.join(expectedStateDir, "openshell.db")}`;
  return dbUrl === expectedDbUrl || dbUrl.endsWith("/nemoclaw/openshell-docker-gateway/openshell.db");
}

function isNemoclawHostGatewayPid(
  pid: number,
  deps: Required<Pick<HostOpenShellGatewayCleanupDeps, "env" | "readFileSync" | "run">>,
): boolean {
  if (!pidCmdlineMatches(pid, deps)) return false;
  const processEnv = readProcessEnv(pid, deps);
  if (!processEnv) return false;
  return envMatchesNemoclawDockerGateway(processEnv, defaultStateDir(deps.env));
}

function tryStopPid(
  pid: number,
  deps: Required<Pick<HostOpenShellGatewayCleanupDeps, "env" | "kill" | "log" | "run" | "warn">>,
): boolean {
  deps.kill(pid, "SIGTERM");
  if (waitForExit(pid, deps, TERM_WAIT_MS)) {
    deps.log(`Stopped host openshell-gateway process ${pid}`);
    return true;
  }
  deps.kill(pid, "SIGKILL");
  if (waitForExit(pid, deps, KILL_WAIT_MS)) {
    deps.log(`Stopped host openshell-gateway process ${pid} (after SIGKILL)`);
    return true;
  }
  deps.warn(`Failed to stop host openshell-gateway process ${pid}`);
  return false;
}

export function stopHostOpenShellGatewayProcesses(
  depsOverrides: HostOpenShellGatewayCleanupDeps = {},
): HostOpenShellGatewayCleanupResult {
  const env = depsOverrides.env ?? process.env;
  const deps = {
    commandExists: depsOverrides.commandExists ?? ((command: string) => defaultCommandExists(command, env)),
    currentUsername: depsOverrides.currentUsername ?? os.userInfo().username,
    env,
    kill: depsOverrides.kill ?? defaultKill,
    log: depsOverrides.log ?? ((message: string) => console.log(message)),
    readFileSync:
      depsOverrides.readFileSync ??
      ((target: string, encoding: BufferEncoding) => fs.readFileSync(target, encoding)),
    run: depsOverrides.run ?? defaultRun,
    warn: depsOverrides.warn ?? ((message: string) => console.warn(message)),
  };
  const result: HostOpenShellGatewayCleanupResult = {
    stopped: [],
    skippedNonMatchingPids: [],
  };
  if (!deps.commandExists("pgrep")) return result;

  const user =
    deps.currentUsername === "root"
      ? ""
      : deps.env.SUDO_USER || deps.env.LOGNAME || deps.env.USER || deps.currentUsername;
  const pgrepArgs = user ? ["-u", user, "-f", "openshell-gateway"] : ["-f", "openshell-gateway"];
  const pgrep = deps.run("pgrep", pgrepArgs, { env: deps.env });
  for (const pid of parsePidLines(pgrep.stdout)) {
    if (!isNemoclawHostGatewayPid(pid, deps)) {
      result.skippedNonMatchingPids.push(pid);
      continue;
    }
    if (tryStopPid(pid, deps)) result.stopped.push(pid);
  }
  return result;
}
