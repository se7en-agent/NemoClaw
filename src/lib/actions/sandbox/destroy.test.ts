// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { cleanupGatewayAfterLastSandbox } from "./destroy";

describe("cleanupGatewayAfterLastSandbox", () => {
  it("sweeps NemoClaw host openshell-gateway processes during Linux gateway cleanup", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const dockerRemoveVolumesByPrefix = vi.fn();
    const stopDockerDriverGatewayProcess = vi.fn();
    const stopHostOpenShellGatewayProcesses = vi.fn();
    const stopStaleDashboardListeners = vi.fn();

    cleanupGatewayAfterLastSandbox({
      dockerRemoveVolumesByPrefix,
      platform: "linux",
      runOpenshell,
      stopDockerDriverGatewayProcess,
      stopHostOpenShellGatewayProcesses,
      stopStaleDashboardListeners,
    });

    expect(stopStaleDashboardListeners).toHaveBeenCalledOnce();
    expect(stopDockerDriverGatewayProcess).toHaveBeenCalledOnce();
    expect(stopHostOpenShellGatewayProcesses).toHaveBeenCalledOnce();
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(dockerRemoveVolumesByPrefix).toHaveBeenCalledWith("openshell-cluster-nemoclaw", {
      ignoreError: true,
    });
  });
});
