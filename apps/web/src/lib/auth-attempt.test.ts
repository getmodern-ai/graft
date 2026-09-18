import { describe, expect, it, vi } from "vitest";

import {
  attemptEmailSignIn,
  attemptEmailSignUp,
  attemptSocialSignIn,
  NETWORK_FAILURE_MESSAGE,
} from "./auth-attempt";
import { ALREADY_REGISTERED_MESSAGE } from "./email-auth-outcome";

const credentials = { email: "alice@corp.com", password: "correct horse" };
const registration = {
  ...credentials,
  callbackURL: "https://app.example/login?redirect=%2Fagents",
};

describe("attemptEmailSignIn", () => {
  it("reports signed in on a successful sign-in", async () => {
    expect(
      await attemptEmailSignIn(credentials, () => Promise.resolve({ error: undefined })),
    ).toEqual({
      signedIn: true,
    });
  });

  it("surfaces the server's own failure message, and a usable sentence when it sends none", async () => {
    expect(
      await attemptEmailSignIn(credentials, () =>
        Promise.resolve({
          error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        }),
      ),
    ).toEqual({ signedIn: false, error: "Invalid email or password" });
    expect(await attemptEmailSignIn(credentials, () => Promise.resolve({ error: {} }))).toEqual({
      signedIn: false,
      error: "We couldn't sign you in. Try again.",
    });
  });

  it("reads an unverified address as verification pending, not as a refusal", async () => {
    expect(
      await attemptEmailSignIn(credentials, () =>
        Promise.resolve({ error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" } }),
      ),
    ).toEqual({ signedIn: false, error: null, emailNotVerified: true });
  });

  it("turns a thrown network failure into an actionable outcome", async () => {
    expect(
      await attemptEmailSignIn(credentials, () => Promise.reject(new TypeError("Failed to fetch"))),
    ).toEqual({ signedIn: false, error: NETWORK_FAILURE_MESSAGE });
  });
});

describe("attemptEmailSignUp", () => {
  it("reports signed in on a registration that opened a session", async () => {
    expect(
      await attemptEmailSignUp(registration, () =>
        Promise.resolve({ data: { token: "session-token" }, error: null }),
      ),
    ).toEqual({ signedIn: true });
  });

  it("reads a 200 that opened no session as a verification email on its way", async () => {
    expect(
      await attemptEmailSignUp(registration, () =>
        Promise.resolve({ data: { token: null }, error: null }),
      ),
    ).toEqual({ signedIn: false, error: null, verificationSent: true });
  });

  it("registers under the address's local part, carrying the door's callback URL", async () => {
    const signUp = vi.fn(() => Promise.resolve({ data: { token: "session-token" } }));
    await attemptEmailSignUp(registration, signUp);
    expect(signUp).toHaveBeenCalledWith({ ...registration, name: "alice" });
  });

  it("points a residual taken-address refusal at the sign-in door, and passes a fixable reason through", async () => {
    for (const code of ["USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"]) {
      expect(
        await attemptEmailSignUp(registration, () =>
          Promise.resolve({ error: { code, message: "User already exists" } }),
        ),
      ).toEqual({ signedIn: false, error: ALREADY_REGISTERED_MESSAGE });
    }
    expect(
      await attemptEmailSignUp(registration, () =>
        Promise.resolve({
          error: { code: "PASSWORD_TOO_SHORT", message: "Password must be at least 8 characters" },
        }),
      ),
    ).toEqual({ signedIn: false, error: "Password must be at least 8 characters" });
  });

  it("turns a thrown network failure into an actionable outcome", async () => {
    expect(
      await attemptEmailSignUp(registration, () =>
        Promise.reject(new TypeError("Failed to fetch")),
      ),
    ).toEqual({ signedIn: false, error: NETWORK_FAILURE_MESSAGE });
  });
});

describe("attemptSocialSignIn", () => {
  it("reports no error on a handoff, the provider's message on a refusal, and a named fallback", async () => {
    expect(
      await attemptSocialSignIn("google", () => Promise.resolve({ error: undefined })),
    ).toEqual({ error: null });
    expect(
      await attemptSocialSignIn("google", () =>
        Promise.resolve({ error: { message: "Provider not found" } }),
      ),
    ).toEqual({ error: "Provider not found" });
    expect(await attemptSocialSignIn("github", () => Promise.resolve({ error: {} }))).toEqual({
      error: "Could not continue with github.",
    });
    expect(await attemptSocialSignIn("google", () => Promise.reject(new Error("down")))).toEqual({
      error: NETWORK_FAILURE_MESSAGE,
    });
  });
});
