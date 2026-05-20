// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "nemoclaw-ssh-proxy.sh");
const SSH_CONFIG = path.join(ROOT, "scripts", "nemoclaw-ssh-config");
const OPENCLAW_DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");
const HERMES_DOCKERFILE_BASE = path.join(ROOT, "agents", "hermes", "Dockerfile.base");

function read(relativePath: string) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

function runProxyHelper(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [SCRIPT, "github.com", "22"], {
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH ?? "",
      ...env,
    },
    timeout: 5000,
  });
}

describe("SSH proxy helper", () => {
  it("is executable and valid Bash", () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);

    const result = spawnSync("bash", ["-n", SCRIPT], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("is copied into both sandbox base images with executable permissions", () => {
    for (const dockerfilePath of [OPENCLAW_DOCKERFILE_BASE, HERMES_DOCKERFILE_BASE]) {
      const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");

      expect(dockerfile).toContain(
        "COPY scripts/nemoclaw-ssh-proxy.sh /usr/local/bin/nemoclaw-ssh-proxy",
      );
      expect(dockerfile).toContain(
        "COPY scripts/nemoclaw-ssh-config /etc/ssh/ssh_config.d/90-nemoclaw-proxy.conf",
      );
      expect(dockerfile).toContain("chmod 755 /usr/local/bin/nemoclaw-ssh-proxy");
      expect(dockerfile).toContain("chmod 644 /etc/ssh/ssh_config.d/90-nemoclaw-proxy.conf");
      expect(dockerfile).not.toMatch(/\b(netcat|nc-openbsd|ncat|netcat-traditional)\b/);
    }
  });

  it("configures OpenSSH to use the proxy helper by default after local exclusions", () => {
    const config = fs.readFileSync(SSH_CONFIG, "utf-8");
    const localHostIndex = config.indexOf("Host localhost 127.* ::1 ip6-localhost *.localhost");
    const proxyNoneIndex = config.indexOf("ProxyCommand none");
    const hostAllIndex = config.indexOf("Host *");
    const proxyHelperIndex = config.indexOf(
      "ProxyCommand /usr/local/bin/nemoclaw-ssh-proxy %h %p",
    );

    expect(localHostIndex).toBeGreaterThanOrEqual(0);
    expect(proxyNoneIndex).toBeGreaterThan(localHostIndex);
    expect(hostAllIndex).toBeGreaterThan(proxyNoneIndex);
    expect(proxyHelperIndex).toBeGreaterThan(hostAllIndex);
  });

  it("selects supported proxy env vars in the expected order", () => {
    const script = read("scripts/nemoclaw-ssh-proxy.sh");
    const httpsIndex = script.indexOf('proxy_env_name="HTTPS_PROXY"');
    const httpIndex = script.indexOf('proxy_env_name="HTTP_PROXY"');
    const allIndex = script.indexOf('proxy_env_name="ALL_PROXY"');

    expect(httpsIndex).toBeGreaterThanOrEqual(0);
    expect(httpIndex).toBeGreaterThan(httpsIndex);
    expect(allIndex).toBeGreaterThan(httpIndex);
  });

  it("contains the HTTP CONNECT tunnel mechanics without nc or netcat", () => {
    const script = read("scripts/nemoclaw-ssh-proxy.sh");

    expect(script).toContain('/dev/tcp/${proxy_host}/${proxy_port}');
    expect(script).toContain("CONNECT %s:%s HTTP/1.1\\r\\n");
    expect(script).toContain("Host: %s:%s\\r\\n");
    expect(script).toContain('status_code" != "200"');
    expect(script).toContain("cat >&3 &");
    expect(script).toContain("cat <&3");
    expect(script).not.toMatch(/\b(nc|netcat|ncat)\b/);
  });

  it("fails clearly when no proxy is configured", () => {
    const result = runProxyHelper({
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      ALL_PROXY: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No proxy configured");
  });

  it("rejects unsupported proxy schemes without leaking proxy credentials", () => {
    const result = runProxyHelper({
      HTTPS_PROXY: "https://user:token@proxy.example:443",
      HTTP_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Proxy URL in HTTPS_PROXY must use http://");
    expect(result.stderr).not.toContain("user");
    expect(result.stderr).not.toContain("token");
    expect(result.stderr).not.toContain("https://user");
  });
});
