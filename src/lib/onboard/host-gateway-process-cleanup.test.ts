// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { stopHostOpenShellGatewayProcesses } from "./host-gateway-process-cleanup";

function environ(entries: string[]): string {
  return entries.join("\0");
}

describe("stopHostOpenShellGatewayProcesses", () => {
  it("skips openshell-gateway candidates that are not NemoClaw Docker gateways", () => {
    const kill = vi.fn();

    stopHostOpenShellGatewayProcesses({
      kill,
      pgrep: () => "111\n",
      platform: "linux",
      readFileSync: () =>
        environ([
          "OPENSHELL_DRIVERS=docker",
          "OPENSHELL_DB_URL=sqlite:/home/alice/.local/state/openshell/openshell.db",
        ]),
    });

    expect(kill).not.toHaveBeenCalled();
  });

  it("stops NemoClaw Docker-driver openshell-gateway candidates", () => {
    const kill = vi.fn();

    stopHostOpenShellGatewayProcesses({
      kill,
      pidExists: () => false,
      pgrep: () => "111\n222\n",
      platform: "linux",
      readFileSync: (target) =>
        target === "/proc/222/environ"
          ? environ([
              "OPENSHELL_DRIVERS=docker",
              "OPENSHELL_DB_URL=sqlite:/home/alice/.local/state/nemoclaw/openshell-docker-gateway/openshell.db",
            ])
          : environ([
              "OPENSHELL_DRIVERS=podman",
              "OPENSHELL_DB_URL=sqlite:/home/alice/.local/state/nemoclaw/openshell-docker-gateway/openshell.db",
            ]),
    });

    expect(kill).toHaveBeenCalledWith(222, "SIGTERM");
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
