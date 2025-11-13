import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../observability/logger.js", () => {
  const debug = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return {
    appLogger: {
      debug,
      warn,
      error,
    },
  };
});

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return {
    ...actual,
    loadConfig: vi.fn(),
  };
});

import { ensureEgressAllowed } from "./EgressGuard.js";
import { appLogger } from "../observability/logger.js";
import { DEFAULT_CONFIG, loadConfig, type AppConfig } from "../config.js";

const loadConfigMock = vi.mocked(loadConfig);

function cloneDefaultConfig(): AppConfig {
  if (typeof structuredClone === "function") {
    return structuredClone(DEFAULT_CONFIG);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
}

function buildConfig(egress: Partial<AppConfig["network"]["egress"]>): AppConfig {
  const config = cloneDefaultConfig();
  config.network.egress = {
    ...config.network.egress,
    ...egress,
  };
  return config;
}

describe("ensureEgressAllowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows targets present in the allow list when enforcing", () => {
    loadConfigMock.mockReturnValue(
      buildConfig({ mode: "enforce", allow: ["*.example.com", "localhost"] })
    );

    expect(() => ensureEgressAllowed("https://api.example.com/v1"))
      .not.toThrow();

    expect(appLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "egress.guard",
        target: "https://api.example.com/v1",
        mode: "enforce",
      }),
      "egress allowed",
    );
  });

  it("denies targets that are not permitted when enforcing", () => {
    loadConfigMock.mockReturnValue(buildConfig({ mode: "enforce", allow: ["localhost"] }));

    expect(() => ensureEgressAllowed("https://blocked.example.com"))
      .toThrow("Egress to 'https://blocked.example.com' is not permitted by network policy");

    expect(appLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "egress.guard",
        target: "https://blocked.example.com",
        mode: "enforce",
      }),
      "egress blocked by policy",
    );
  });

  it("reports violations when in report-only mode", () => {
    loadConfigMock.mockReturnValue(buildConfig({ mode: "report-only", allow: ["localhost"] }));

    expect(() => ensureEgressAllowed("https://blocked.example.com"))
      .not.toThrow();

    expect(appLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "egress.guard",
        target: "https://blocked.example.com",
        mode: "report-only",
      }),
      "egress would be blocked by policy",
    );
  });

  it("skips enforcement when the mode is allow", () => {
    loadConfigMock.mockReturnValue(buildConfig({ mode: "allow" }));

    expect(() => ensureEgressAllowed("https://blocked.example.com"))
      .not.toThrow();

    expect(appLogger.warn).not.toHaveBeenCalled();
    expect(appLogger.error).not.toHaveBeenCalled();
    expect(appLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "egress.guard",
        target: "https://blocked.example.com",
        mode: "allow",
      }),
      "egress policy disabled",
    );
  });
});

