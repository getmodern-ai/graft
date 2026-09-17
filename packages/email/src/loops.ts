import { createHash } from "node:crypto";

import { consoleTransport, type EmailTransport, type SendRequest } from "./transport";

/**
 * The Loops transport — the second implementation of the transport seam. Cando's `loops.ts`
 * (its CAN-167; ADR 0011 for the copy, ADR 0021 for the choice of Loops), GRA-82.
 *
 * One POST to Loops' transactional endpoint, deliberately without their SDK: the request is a
 * single call with bearer auth, and a dependency would be more surface than the integration.
 * The transport never throws to callers — same stance as the console transport, pinned by the
 * shared `SendResult` shape — because a failed send must never fail the operation that asked
 * for it (the reset hook's rule, and every future caller's). Failure is `delivered: false`
 * plus a log line with the template name, which is all the caller is entitled to know.
 */

export const LOOPS_TRANSACTIONAL_URL = "https://app.loops.so/api/v1/transactional";

/** Loops caps the `Idempotency-Key` header at 100 characters. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 100;

/**
 * Narrower than `typeof fetch` on purpose: it is exactly what the transport calls, so a test
 * can hand in a plain mock function without impersonating fetch's static surface.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A stable key for one logical send, so a retry cannot double-send (Loops dedupes for 24h).
 *
 * The key is a content hash of what identifies the send — the template's transactional id, the
 * recipient, and the validated data variables — prefixed with the template name so a duplicate
 * showing up in Loops' dashboard is attributable at a glance. Deliberately *not* random: a
 * random key is unique per attempt, which is exactly the property that makes it useless for
 * deduping a retried attempt. And deliberately not time-salted: two sends with identical
 * content inside the window *are* duplicates — a re-requested reset carries a fresh token in
 * its URL, so it hashes to a fresh key and goes through.
 *
 * The variables' key order comes from the registry schema's `parse`, so it is deterministic
 * for a given template — `JSON.stringify` is stable here. The slice keeps a long future
 * template name inside Loops' limit; sha256's 64 hex chars survive it comfortably today.
 */
export function idempotencyKey(request: SendRequest): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        transactionalId: request.transactionalId,
        to: request.to,
        dataVariables: request.dataVariables,
      }),
    )
    .digest("hex");
  return `${request.template}-${hash}`.slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
}

/**
 * Loops error bodies are JSON like `{ "success": false, "message": "..." }` when the API is
 * doing the rejecting, and anything at all when something in front of it is. Extract the
 * message where there is one, report the raw body where there is not — a log line that says
 * `undefined` is the one outcome this exists to avoid.
 */
function loopsErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.message === "string") return record.message;
      if (typeof record.error === "string") return record.error;
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body || "(empty response body)";
}

/**
 * Sends through `POST /v1/transactional` with bearer auth and an idempotency key per send.
 *
 * Every non-2xx maps to `delivered: false` and a log line, never a throw. The one worth naming:
 * a 400 for an *unpublished template* is the expected pre-rollout failure mode (ADR 0021 — the
 * registry ships placeholder ids until the rollout ticket publishes the real templates), which
 * is why the log carries the template name and Loops' own message rather than just a status.
 *
 * `fetchImpl` is deps-last like the façade's transport parameter: callers ignore it and get the
 * global fetch, tests replace it. There is no other HTTP-mocking precedent in the repo to match.
 */
export function createLoopsTransport(apiKey: string, fetchImpl: FetchLike = fetch): EmailTransport {
  return {
    name: "loops",
    async send(request) {
      try {
        const response = await fetchImpl(LOOPS_TRANSACTIONAL_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey(request),
          },
          body: JSON.stringify({
            transactionalId: request.transactionalId,
            email: request.to,
            dataVariables: request.dataVariables,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.error("Transactional mail failed — Loops rejected the send", {
            template: request.template,
            transactionalId: request.transactionalId,
            to: request.to,
            status: response.status,
            message: loopsErrorMessage(body),
          });
          return { delivered: false, transport: "loops" };
        }

        return { delivered: true, transport: "loops" };
      } catch (error) {
        console.error("Transactional mail failed — Loops was unreachable", {
          template: request.template,
          transactionalId: request.transactionalId,
          to: request.to,
          error,
        });
        return { delivered: false, transport: "loops" };
      }
    },
  };
}

/**
 * The environment switch (ADR 0021): `GRAFT_LOOPS_API_KEY` set → Loops, unset → console.
 *
 * The key arrives as a parameter rather than this package importing `@graft/env`, and that is a
 * choice, not an omission: `@graft/email` is deliberately dependency-free beyond zod, so its
 * tests need no env and no `SKIP_ENV_VALIDATION`, and `@graft/env/server` validates the real
 * `process.env` at import time — a cost every consumer of a mere email package should not
 * inherit. The caller that has the env feeds it in: `transportFromEnv(env.GRAFT_LOOPS_API_KEY)`
 * in `apps/server/src/index.ts`.
 */
export function transportFromEnv(loopsApiKey: string | undefined): EmailTransport {
  return loopsApiKey ? createLoopsTransport(loopsApiKey) : consoleTransport;
}
