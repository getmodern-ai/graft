import { describe, expect, it } from "vitest";

import { handoffUrl, signHandoffToken, verifyHandoff } from "./handoff";

/**
 * The handoff URL's three properties as ADR 0006 states them — signed, bound to the agent, expiring
 * — and the fourth GRA-23 adds, refused once used. Pure: a row-shaped subject in, a verdict out.
 */

const SECRET = "handoff-test-secret-that-is-long-enough-32";
const NOW = new Date("2026-09-09T10:00:00Z");
const subject = {
  id: "pa_1",
  agentId: "agent_1",
  expiresAt: new Date(NOW.getTime() + 60_000),
  consumedAt: null,
};

describe("the handoff URL", () => {
  it("is the console's URL, the pending path, the id and the token, whatever the console URL ends in", () => {
    const token = signHandoffToken(subject, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(handoffUrl("http://console.graft.test", "pa_1", token)).toBe(
      `http://console.graft.test/pending/pa_1?t=${token}`,
    );
    expect(handoffUrl("https://graft.example/console/", "pa 1", token)).toBe(
      `https://graft.example/console/pending/pa%201?t=${token}`,
    );
  });

  it("verifies the token Graft issued for the row", () => {
    const token = signHandoffToken(subject, SECRET);
    expect(verifyHandoff({ token, subject, secret: SECRET, now: NOW })).toEqual({ ok: true });
  });

  it("refuses a tampered link: another action, another agent, another expiry, another secret, or a mangled token", () => {
    const token = signHandoffToken(subject, SECRET);
    const tampered = [
      { token, subject: { ...subject, id: "pa_2" } },
      { token, subject: { ...subject, agentId: "agent_2" } },
      { token, subject: { ...subject, expiresAt: new Date(NOW.getTime() + 120_000) } },
      { token: signHandoffToken(subject, "another-secret-that-is-also-long-enough-32"), subject },
      { token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, subject },
      { token: token.slice(1), subject },
      { token: "", subject },
      { token: null, subject },
      { token: "not base64url!", subject },
    ];
    for (const attempt of tampered) {
      expect(verifyHandoff({ ...attempt, secret: SECRET, now: NOW })).toMatchObject({
        ok: false,
        reason: "tampered",
      });
    }
  });

  it("refuses a reused link — the action already consumed — before it says expired", () => {
    const token = signHandoffToken(subject, SECRET);
    const consumed = { ...subject, consumedAt: NOW };
    expect(verifyHandoff({ token, subject: consumed, secret: SECRET, now: NOW })).toMatchObject({
      ok: false,
      reason: "consumed",
    });
    const late = new Date(subject.expiresAt.getTime() + 1);
    expect(verifyHandoff({ token, subject: consumed, secret: SECRET, now: late })).toMatchObject({
      reason: "consumed",
    });
  });

  it("refuses an expired link, at the expiry and after it", () => {
    const token = signHandoffToken(subject, SECRET);
    for (const now of [subject.expiresAt, new Date(subject.expiresAt.getTime() + 1)]) {
      expect(verifyHandoff({ token, subject, secret: SECRET, now })).toMatchObject({
        ok: false,
        reason: "expired",
      });
    }
    expect(
      verifyHandoff({
        token,
        subject,
        secret: SECRET,
        now: new Date(subject.expiresAt.getTime() - 1),
      }),
    ).toEqual({ ok: true });
  });
});
