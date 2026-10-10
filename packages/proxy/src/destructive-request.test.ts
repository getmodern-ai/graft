import { describe, expect, it } from "vitest";

import { DESTRUCTIVE_ENDPOINTS } from "./destructive-endpoints";
import { classifyRequest, isDestructiveRequest, type RequestToClassify } from "./read-request";

const request = (over: Partial<RequestToClassify>): RequestToClassify => ({
  method: "POST",
  host: "api.stripe.com",
  path: "/v1/refunds",
  hasQuery: false,
  body: null,
  ...over,
});

/** An entry's path with each `*` filled, as a request would carry it. */
const concrete = (path: string): string => path.replaceAll("*", "x_1");

describe("isDestructiveRequest: the method", () => {
  it("calls every DELETE destructive, whatever the host or path", () => {
    for (const method of ["DELETE", "delete"]) {
      expect(isDestructiveRequest(request({ method, host: "api.example.com", path: "/x" }))).toBe(
        true,
      );
      expect(isDestructiveRequest(request({ method, host: null, path: "" }))).toBe(true);
    }
  });

  it("calls a read never destructive, and an ordinary write not destructive", () => {
    for (const method of ["GET", "HEAD", "PUT", "PATCH"]) {
      expect(isDestructiveRequest(request({ method })), method).toBe(false);
    }
    expect(isDestructiveRequest(request({ path: "/v1/customers" }))).toBe(false);
  });
});

describe("isDestructiveRequest: the reviewed table", () => {
  it("names its vendor's documentation in every entry, and every entry is a POST", () => {
    for (const entry of DESTRUCTIVE_ENDPOINTS) {
      expect(entry.reason.length, entry.path).toBeGreaterThan(20);
      expect(entry.method).toBe("POST");
      expect(entry.host).toBe(entry.host.toLowerCase());
      expect(entry.path.startsWith("/"), entry.path).toBe(true);
    }
  });

  it.each(DESTRUCTIVE_ENDPOINTS.map((entry) => [entry.host, entry.path] as const))(
    "calls %s POST %s destructive on its own host",
    (host, path) => {
      expect(isDestructiveRequest(request({ host, path: concrete(path) }))).toBe(true);
      // Never a read: the two tables cannot both claim an endpoint.
      expect(classifyRequest(request({ host, path: concrete(path) }))).toEqual({ read: false });
    },
  );

  it.each(DESTRUCTIVE_ENDPOINTS.map((entry) => [entry.host, entry.path] as const))(
    "calls %s POST %s an ordinary write on another host, or under another method",
    (host, path) => {
      expect(isDestructiveRequest(request({ host: "api.example.com", path: concrete(path) }))).toBe(
        false,
      );
      expect(isDestructiveRequest(request({ host, method: "PUT", path: concrete(path) }))).toBe(
        false,
      );
    },
  );

  it("seeds Stripe's refund paths and Slack's and Gmail's deletes", () => {
    const seeded = [
      ["api.stripe.com", "/v1/refunds"],
      ["api.stripe.com", "/v1/charges/ch_3Nx/refund"],
      ["api.stripe.com", "/v1/charges/ch_3Nx/refunds"],
      ["api.stripe.com", "/v1/invoices/in_1/void"],
      ["slack.com", "/api/chat.delete"],
      ["gmail.googleapis.com", "/gmail/v1/users/me/messages/batchDelete"],
    ] as const;
    for (const [host, path] of seeded) {
      expect(isDestructiveRequest(request({ host, path })), path).toBe(true);
    }
  });

  it("leaves a Stripe write the table does not name an ordinary write", () => {
    for (const path of [
      "/v1/customers",
      "/v1/invoices",
      "/v1/invoices/in_1",
      "/v1/invoices/in_1/finalize",
      "/v1/refunds/re_1",
      "/v1/charges/ch_1/capture",
    ]) {
      expect(isDestructiveRequest(request({ path })), path).toBe(false);
    }
  });

  it("errs toward destructive on the path's spelling: a doubled or trailing slash, an encoded id", () => {
    for (const path of [
      "/v1/refunds/",
      "//v1//refunds",
      "/v1/charges/ch%2F1/refund",
      "/v1/charges/../refund",
    ]) {
      expect(isDestructiveRequest(request({ path })), path).toBe(true);
    }
  });

  it("matches a host-known path from the host's root, never by its tail", () => {
    expect(isDestructiveRequest(request({ path: "/refunds" }))).toBe(false);
    expect(isDestructiveRequest(request({ path: "/v2/v1/refunds" }))).toBe(false);
  });
});

describe("isDestructiveRequest: no host (the check, a relative path)", () => {
  it("matches the entry's trailing segments, since the connection's base path sits in front", () => {
    for (const path of [
      "/refunds",
      "/v1/refunds",
      "/charges/ch_1/refund",
      "/subscription_schedules/sub_sched_1/cancel",
      "/chat.delete",
      "/users/me/messages/batchDelete",
    ]) {
      expect(isDestructiveRequest(request({ host: null, path })), path).toBe(true);
    }
  });

  it("matches nothing longer than an entry, an unread path, or a path that is not absolute", () => {
    for (const path of ["/api/v1/refunds", "", "refunds", "/", "/customers"]) {
      expect(isDestructiveRequest(request({ host: null, path })), path).toBe(false);
    }
  });

  it("never matches a tail that starts at a wildcard or drops one, so not every POST …/cancel", () => {
    for (const path of [
      "/cancel",
      "/pi_1/cancel",
      "/tickets/42/cancel",
      "/refund",
      "/ch_1/refund",
      "/messages/batchDelete",
      "/me/messages/batchDelete",
    ]) {
      expect(isDestructiveRequest(request({ host: null, path })), path).toBe(false);
    }
  });

  it.each(DESTRUCTIVE_ENDPOINTS.map((entry) => [entry.path] as const))(
    "matches %s with no host, whole and under its base path dropped",
    (path) => {
      const full = concrete(path);
      expect(isDestructiveRequest(request({ host: null, path: full }))).toBe(true);
      const underBase = `/${full.split("/").slice(2).join("/")}`;
      expect(isDestructiveRequest(request({ host: null, path: underBase }))).toBe(true);
    },
  );
});
