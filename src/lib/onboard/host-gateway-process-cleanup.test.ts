// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { stopHostOpenShellGatewayProcesses } from "./host-gateway-process-cleanup";

function ok(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function notFound() {
  return { status: 1, stdout: "", stderr: "" };
}

describe("stopHostOpenShellGatewayProcesses", () => {
  it("stops only NemoClaw-managed Docker-driver openshell-gateway processes", () => {
    const killed = new Set<number>();
    const killSignals: Array<[number, NodeJS.Signals | number | undefined]> = [];
    const run = vi.fn((command: string, args: string[]) => {
      if (command === "pgrep") {
        expect(args).toEqual(["-u", "alice", "-f", "openshell-gateway"]);
        return ok("111\n222\n");
      }
      if (command === "ps" && args[3] === "args=") {
        return ok("/usr/local/bin/openshell-gateway\n");
      }
      if (command === "ps" && args[3] === "pid=") {
        return killed.has(Number(args[1])) ? notFound() : ok(`${args[1]}\n`);
      }
      return notFound();
    });
    const readFileSync = vi.fn((target: string) => {
      if (target === "/proc/111/environ") {
        return [
          "OPENSHELL_DRIVERS=docker",
          "OPENSHELL_DB_URL=sqlite:/home/alice/.local/state/openshell/openshell.db",
        ].join("\0");
      }
      if (target === "/proc/222/environ") {
        return [
          "OPENSHELL_DRIVERS=docker",
          "OPENSHELL_DB_URL=sqlite:/home/alice/.local/state/nemoclaw/openshell-docker-gateway/openshell.db",
        ].join("\0");
      }
      return "";
    });

    const result = stopHostOpenShellGatewayProcesses({
      commandExists: () => true,
      currentUsername: "alice",
      env: { HOME: "/home/alice", LOGNAME: "", SUDO_USER: "", USER: "alice" },
      kill: (pid, signal) => {
        killSignals.push([pid, signal]);
        killed.add(pid);
        return true;
      },
      log: vi.fn(),
      readFileSync,
      run,
      warn: vi.fn(),
    });

    expect(result.stopped).toEqual([222]);
    expect(result.skippedNonMatchingPids).toEqual([111]);
    expect(killSignals).toEqual([[222, "SIGTERM"]]);
  });

  it("skips candidates when process environment cannot prove NemoClaw ownership", () => {
    const kill = vi.fn();
    const result = stopHostOpenShellGatewayProcesses({
      commandExists: () => true,
      currentUsername: "alice",
      env: { HOME: "/home/alice", LOGNAME: "", SUDO_USER: "", USER: "alice" },
      kill,
      readFileSync: () => {
        throw new Error("permission denied");
      },
      run: (command, args) => {
        if (command === "pgrep") return ok("333\n");
        if (command === "ps" && args[3] === "args=") {
          return ok("/usr/local/bin/openshell-gateway\n");
        }
        return ok("333\n");
      },
    });

    expect(result).toEqual({ stopped: [], skippedNonMatchingPids: [333] });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not apply a user filter when cleanup runs as root", () => {
    const run = vi.fn((command: string, args: string[]) => {
      if (command === "pgrep") {
        expect(args).toEqual(["-f", "openshell-gateway"]);
        return ok("");
      }
      return notFound();
    });

    stopHostOpenShellGatewayProcesses({
      commandExists: () => true,
      currentUsername: "root",
      env: { HOME: "/root", SUDO_USER: "alice", USER: "root" },
      run,
    });

    expect(run).toHaveBeenCalledWith("pgrep", ["-f", "openshell-gateway"], {
      env: expect.objectContaining({ USER: "root" }),
    });
  });
});
