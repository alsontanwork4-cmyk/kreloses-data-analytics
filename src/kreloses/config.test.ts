import { describe, expect, it } from "vitest";

import { KRELOSES_SEA_URL, KRELOSES_WWW_URL, readerOptionsFromEnv } from "./config";

describe("Reader configuration from the environment", () => {
  it("talks to the real Kreloses hosts by default", () => {
    expect(readerOptionsFromEnv({ NODE_ENV: "production" })).toEqual({});
    expect(KRELOSES_WWW_URL).toBe("https://www.kreloses.com");
    expect(KRELOSES_SEA_URL).toBe("https://sea.kreloses.com");
  });

  it("points at a local fake Kreloses outside production", () => {
    expect(
      readerOptionsFromEnv({
        NODE_ENV: "development",
        KRELOSES_BASE_URL_WWW: "http://127.0.0.1:5123",
        KRELOSES_BASE_URL_SEA: "http://localhost:5123/",
      }),
    ).toEqual({ baseUrls: { www: "http://127.0.0.1:5123", sea: "http://localhost:5123" } });
  });

  it("refuses the override in production, so credentials can never be redirected there", () => {
    expect(() =>
      readerOptionsFromEnv({
        NODE_ENV: "production",
        KRELOSES_BASE_URL_WWW: "http://127.0.0.1:5123",
        KRELOSES_BASE_URL_SEA: "http://127.0.0.1:5123",
      }),
    ).toThrow(/refused in production/);
    expect(() =>
      readerOptionsFromEnv({ NODE_ENV: "production", KRELOSES_BASE_URL_SEA: "http://127.0.0.1:5123" }),
    ).toThrow(/refused in production/);
  });

  it("also refuses the override on any Vercel deployment, whatever NODE_ENV says", () => {
    const override = { KRELOSES_BASE_URL_WWW: "http://127.0.0.1:5123", KRELOSES_BASE_URL_SEA: "http://127.0.0.1:5123" };
    expect(() => readerOptionsFromEnv({ NODE_ENV: "development", VERCEL: "1", ...override })).toThrow(/refused/);
    expect(() => readerOptionsFromEnv({ NODE_ENV: "development", VERCEL_ENV: "preview", ...override })).toThrow(/refused/);
  });

  it("only allows overrides that point at this machine, and needs both", () => {
    expect(() =>
      readerOptionsFromEnv({
        NODE_ENV: "development",
        KRELOSES_BASE_URL_WWW: "https://kreloses.evil.example",
        KRELOSES_BASE_URL_SEA: "http://127.0.0.1:5123",
      }),
    ).toThrow(/loopback/);
    expect(() =>
      readerOptionsFromEnv({ NODE_ENV: "test", KRELOSES_BASE_URL_WWW: "http://127.0.0.1:5123" }),
    ).toThrow(/both/);
  });
});
