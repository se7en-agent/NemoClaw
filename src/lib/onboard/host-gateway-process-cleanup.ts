// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { sleepMs } from "../core/wait";

export interface HostOpenShellGatewayCleanupDeps {
  env?: NodeJS.ProcessEnv;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => void;
  pidExists?: (pid: number) => boolean;
  pgrep?: (env: NodeJS.ProcessEnv) => string;
  platform?: NodeJS.Platform;
  readFileSync?: (target: string, encoding: BufferEncoding) => string;
}

type ResolvedCleanupDeps = Required<Omit<HostOpenShellGatewayCleanupDeps, "platform">>;

const NEMOCLAW_GATEWAY_DB_PATH = "/nemoclaw/openshell-docker-gateway/openshell.db";
const STOP_WAIT_MS = 1000;
const STOP_POLL_MS = 50;

function defaultPgrep(env: NodeJS.ProcessEnv): string {
  const result = spawnSync("pgrep", ["-f", "openshell-gateway"], {
    encoding: "utf-8",
    env,
  });
  return typeof result.stdout === "string" ? result.stdout : "";
}

function parsePids(output: string): number[] {
  return output
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function dbPathNeedles(env: NodeJS.ProcessEnv): string[] {
  const configured = env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim();
  return configured
    ? [path.join(path.resolve(configured), "openshell.db"), NEMOCLAW_GATEWAY_DB_PATH]
    : [NEMOCLAW_GATEWAY_DB_PATH];
}

function isNemoclawDockerGatewayEnv(raw: string, env: NodeJS.ProcessEnv): boolean {
  const entries = raw.split("\0");
  const dbUrl = entries
    .find((entry) => entry.startsWith("OPENSHELL_DB_URL="))
    ?.slice("OPENSHELL_DB_URL=".length);
  return (
    entries.includes("OPENSHELL_DRIVERS=docker") &&
    Boolean(dbUrl && dbPathNeedles(env).some((needle) => dbUrl.includes(needle)))
  );
}

function isNemoclawDockerGatewayPid(
  pid: number,
  deps: ResolvedCleanupDeps,
): boolean {
  try {
    const raw = deps.readFileSync(`/proc/${pid}/environ`, "utf-8");
    return isNemoclawDockerGatewayEnv(raw, deps.env);
  } catch {
    return false;
  }
}

function defaultPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(
  pid: number,
  deps: ResolvedCleanupDeps,
): boolean {
  for (let elapsed = 0; elapsed < STOP_WAIT_MS; elapsed += STOP_POLL_MS) {
    if (!deps.pidExists(pid)) return true;
    sleepMs(STOP_POLL_MS);
  }
  return !deps.pidExists(pid);
}

function stopPid(
  pid: number,
  deps: ResolvedCleanupDeps,
): void {
  try {
    deps.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (waitForExit(pid, deps)) return;
  try {
    deps.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  waitForExit(pid, deps);
}

export function stopHostOpenShellGatewayProcesses(
  depsOverrides: HostOpenShellGatewayCleanupDeps = {},
): void {
  const deps = {
    env: depsOverrides.env ?? process.env,
    kill: depsOverrides.kill ?? ((pid, signal) => process.kill(pid, signal)),
    pidExists: depsOverrides.pidExists ?? defaultPidExists,
    pgrep: depsOverrides.pgrep ?? defaultPgrep,
    readFileSync:
      depsOverrides.readFileSync ??
      ((target: string, encoding: BufferEncoding) => fs.readFileSync(target, encoding)),
  };
  if ((depsOverrides.platform ?? process.platform) !== "linux") return;

  for (const pid of parsePids(deps.pgrep(deps.env))) {
    if (!isNemoclawDockerGatewayPid(pid, deps)) continue;
    stopPid(pid, deps);
  }
}
