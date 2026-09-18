import { NO_ANALYTICS } from "@graft/observability";
import { describe, expect, it } from "vitest";

import { describeObservability, flushObservability } from "./observability";

/**
 * The open form's answer — nothing, named as such — and the hosted form's, through fakes standing
 * where the private package's backings would: the boot line says which, and the flush reaches
 * every one of them and never holds the stop past its bound.
 */

const OFF = { logDrain: null, analytics: NO_ANALYTICS, modelTelemetry: null };

describe("describeObservability", () => {
  it("names nothing in the open form", () => {
    expect(describeObservability(OFF)).toBe("logs stdout, analytics off, model telemetry off");
  });

  it("names each backing the hosted form answered", () => {
    expect(
      describeObservability({
        logDrain: { name: "drain-vendor", drain: () => undefined, flush: async () => undefined },
        analytics: {
          name: "analytics-vendor",
          capture: () => undefined,
          shutdown: async () => undefined,
        },
        modelTelemetry: {
          name: "tracing-vendor",
          telemetry: { integrations: [], traced: (_t, fn) => fn() },
          flush: async () => undefined,
          shutdown: async () => undefined,
        },
      }),
    ).toBe(
      "logs stdout and drain-vendor, analytics analytics-vendor, model telemetry tracing-vendor",
    );
  });
});

describe("flushObservability", () => {
  it("flushes every backing, shuts the telemetry down after its flush, and settles a rejection rather than throwing", async () => {
    const calls: string[] = [];
    await flushObservability(
      {
        logDrain: {
          name: "d",
          drain: () => undefined,
          flush: async () => {
            calls.push("drain");
          },
        },
        analytics: {
          name: "a",
          capture: () => undefined,
          shutdown: async () => {
            calls.push("analytics");
            throw new Error("endpoint down");
          },
        },
        modelTelemetry: {
          name: "t",
          telemetry: { integrations: [], traced: (_t, fn) => fn() },
          flush: async () => {
            calls.push("telemetry flush");
          },
          shutdown: async () => {
            calls.push("telemetry shutdown");
          },
        },
      },
      1_000,
    );
    expect(calls.indexOf("telemetry flush")).toBeLessThan(calls.indexOf("telemetry shutdown"));
    expect(calls.sort()).toEqual(["analytics", "drain", "telemetry flush", "telemetry shutdown"]);
  });

  it("does not hold the stop past its bound when a backing never settles", async () => {
    const started = Date.now();
    await flushObservability(
      {
        ...OFF,
        logDrain: { name: "d", drain: () => undefined, flush: () => new Promise(() => undefined) },
      },
      50,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("is instant in the open form", async () => {
    await expect(flushObservability(OFF, 50)).resolves.toBeUndefined();
  });
});
