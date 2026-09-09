/**
 * Bounded body reads — the size cap on both legs, under the call's deadline.
 *
 * The proxy **buffers** rather than streams, deliberately. The wide event is the audit trail, and
 * it has to carry the byte counts; a body streamed through would only know its size after the
 * response had left, which is after the request logger has emitted. Buffering also makes the cap
 * a clean refusal — a 413 or a 502 with nothing yet sent — instead of a connection cut mid-body.
 * The cost is memory bounded by `maxBodyBytes` per in-flight call, which is what the cap is sized
 * against.
 *
 * The read honours the call's `AbortSignal`, so a caller that never finishes sending — or a vendor
 * that never finishes answering — cannot hold the buffer and the connection past the deadline.
 */

/**
 * `Uint8Array<ArrayBuffer>` rather than the bare `Uint8Array`, which TypeScript reads as
 * `ArrayBufferLike`-backed: the bytes are built here on a fresh `ArrayBuffer`, and saying so is what
 * lets them be a `Response` body under the DOM library's `BodyInit` as well as Node's — the console
 * (`apps/web`) typechecks this file through the server's exported route types.
 */
export type CappedRead =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: "too_large" | "aborted" };

/**
 * Read a stream to its end, or stop as soon as it exceeds `max` bytes — the excess is never
 * buffered — or as soon as `signal` aborts. Cancels the source on either refusal so the other side
 * is not left sending into a void.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
  signal?: AbortSignal,
): Promise<CappedRead> {
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };
  if (signal?.aborted) {
    await stream.cancel(signal.reason).catch(() => undefined);
    return { ok: false, reason: "aborted" };
  }

  const reader = stream.getReader();
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return { ok: false, reason: "aborted" };
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch (error) {
    // A cancelled reader rejects the pending read; that is the abort arriving, not a failure.
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * A declared `Content-Length` larger than the cap is refused on the header alone, before a byte
 * is read. Null when absent or unparsable, in which case the read itself enforces the cap.
 */
export function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
