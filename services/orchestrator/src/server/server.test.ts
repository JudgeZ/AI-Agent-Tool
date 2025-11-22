import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/ProviderRegistry.js", async () => {
  return {
    routeChat: vi.fn(),
    getSecretsStore: () => ({}),
    getVersionedSecretsManager: () => ({}),
  };
});

vi.mock("../policy/PolicyEnforcer.js", () => {
  class MockPolicyViolationError extends Error {
    status: number;
    details: unknown;
    constructor(message: string, details: unknown = [], status = 403) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  return {
    getPolicyEnforcer: () => ({ enforceHttpAction: vi.fn() }),
    PolicyViolationError: MockPolicyViolationError
  };
});

vi.mock("../queue/PlanQueueRuntime.js", () => {
  return {
    initializePlanQueueRuntime: vi.fn().mockResolvedValue(undefined),
  };
});

describe("createHttpServer", () => {
  const TEST_CERT = "-----BEGIN CERTIFICATE-----\nMIIBsjCCAVmgAwIBAgIUFRDummyCertExample000000000000000wDQYJKoZIhvcNAQELBQAwEzERMA8GA1UEAwwIdGVzdC1jYTAeFw0yNTAxMDEwMDAwMDBaFw0zNTAxMDEwMDAwMDBaMBMxETAPBgNVBAMMCHRlc3QtY2EwXDANBgkqhkiG9w0BAQEFAANLADBIAkEAxX0p+Qn3zX2Bqk9N0xYp7xIqh+apMI2vlA38nSxrdbidKdvUSsfx8bVsgcuyo6edSxnl2xe50Tzw9uQWGWpZJwIDAQABMA0GCSqGSIb3DQEBCwUAA0EAKtO2Qd6hw2yYB9H9n1tFoZT3zh0+BTtPlqvGjufH6G+jD/adJzi10BGSAdoo6gWQBaIj++ImQxGc1dQc5sKXc/w==\n-----END CERTIFICATE-----\n";
  const PEM_KEY_HEADER = "-----BEGIN " + "PRIVATE KEY-----";
  const PEM_KEY_FOOTER = "-----END " + "PRIVATE KEY-----";
  const TEST_KEY_LINES = [
    "MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAxX0p+Qn3zX2Bqk9N0xYp7xIqh+apMI2vlA38nSxrdbidKdvUSsfx8bVsgcuyo6edSxnl2xe50Tzw9uQWGWpZJwIDAQAB",
    "AkAy70dNDO7xjoMnIKh4j/wcgUp3NEPoPFcAckU4iigIvuXvYDn8ApX2HFqRSbuuSSMzdg3NofM8JrIoVNewc19AiEA6yF87o5iV/mQJu1WDVYj1WFJsbgx5caX5/C/PObbIV8",
    "CIQDPLOcAfeUeawuO/7dBDEuDfSU/EYEYVplpXCMVvjJPEwIhAJBgqsSVqSdz+CA0nVddOZXS6jttuPAHyBs+K6TfGsZ5AiBWlQt1zArhcXd1LSeX776BF3/f6/Dr7guPmyAnbcWfSQ",
    "IhAMAnbcWcCYwiVdc+GqOR/mdrIW6DCeU44yWiNysGEi2S"
  ];
  const TEST_KEY = [PEM_KEY_HEADER, ...TEST_KEY_LINES, PEM_KEY_FOOTER, ""].join("\n");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an HTTPS server that enforces client certificates", async () => {
    const { loadConfig } = await import("../config.js");
    const { createHttpServer } = await import("../index.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mtls-test-"));
    const keyPath = path.join(tmpDir, "server.key");
    const certPath = path.join(tmpDir, "server.crt");
    const caPath = path.join(tmpDir, "ca.crt");
    fs.writeFileSync(keyPath, TEST_KEY);
    fs.writeFileSync(certPath, TEST_CERT);
    fs.writeFileSync(caPath, TEST_CERT);

    const captured: https.ServerOptions[] = [];
    const fakeHttpsServer = { listen: vi.fn() } as unknown as https.Server;
    const httpsSpy = vi
      .spyOn(https, "createServer")
      .mockImplementation(((options: https.ServerOptions) => {
        captured.push(options);
        return fakeHttpsServer;
      }) as unknown as typeof https.createServer);
    const httpSpy = vi.spyOn(http, "createServer");

    const config = loadConfig();
    config.server.tls = {
      enabled: true,
      keyPath,
      certPath,
      caPaths: [caPath],
      requestClientCert: true
    };

    const app = express();
    const server = createHttpServer(app, config);

    expect(server).toBe(fakeHttpsServer);
    expect(httpsSpy).toHaveBeenCalledTimes(1);
    expect(httpSpy).not.toHaveBeenCalled();

    const options = captured[0]!;
    expect(options.requestCert).toBe(true);
    expect(options.rejectUnauthorized).toBe(true);
    const ca = options.ca;
    expect(ca).toBeDefined();
    expect(Array.isArray(ca)).toBe(true);
    if (Array.isArray(ca)) {
      expect(ca).toHaveLength(1);
    }
  });

  it("throws when TLS is enabled without key material", async () => {
    const { loadConfig } = await import("../config.js");
    const { createHttpServer } = await import("../index.js");

    const config = loadConfig();
    config.server.tls = {
      enabled: true,
      keyPath: "",
      certPath: "",
      caPaths: [],
      requestClientCert: true
    };

    expect(() => createHttpServer(express(), config)).toThrow("TLS is enabled but keyPath or certPath is undefined");
  });
});

