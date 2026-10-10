import { describe, expect, it } from "vitest";

import {
  parseRecording,
  recordedResponseOf,
  redactRecording,
  type StockRecording,
} from "./recording";

const RECORDING: StockRecording = {
  format: 1,
  tool: "demo__list-items",
  recordedAt: "2026-10-09T00:00:00Z",
  input: { q: "red" },
  exchanges: [
    {
      kind: "read",
      method: "GET",
      url: "https://api.example.com/v1/items?q=red",
      response: { status: 200, headers: {}, body: { json: { items: [] } } },
    },
  ],
};

describe("parseRecording", () => {
  it("reads a recording in the format", () => {
    expect(parseRecording(JSON.stringify(RECORDING), "demo/list-items/recording.json")).toEqual(
      RECORDING,
    );
  });

  it("refuses with a sentence naming the file and the first thing wrong", () => {
    const where = "demo/list-items/recording.json";
    expect(() => parseRecording("nope", where)).toThrow(
      /^demo\/list-items\/recording\.json is not JSON/,
    );
    expect(() =>
      parseRecording(
        JSON.stringify({
          ...RECORDING,
          exchanges: [{ ...RECORDING.exchanges[0], method: "POST" }],
        }),
        where,
      ),
    ).toThrow(`${where} exchange 1 is a read, so its method is GET or HEAD`);
    expect(() =>
      parseRecording(
        JSON.stringify({
          ...RECORDING,
          exchanges: [{ kind: "write", method: "POST", url: "/v1/notes" }],
        }),
        where,
      ),
    ).toThrow(`${where} exchange 1's url is not an absolute URL`);
    expect(() =>
      parseRecording(
        JSON.stringify({
          ...RECORDING,
          exchanges: [
            { kind: "write", method: "POST", url: "https://a.example.com/", body: { a: 1 } },
          ],
        }),
        where,
      ),
    ).toThrow(`${where} exchange 1's body must carry exactly one of json, text or base64`);
  });
});

describe("redactRecording", () => {
  it("redacts the credential by value wherever it appears, and by shape and field name", () => {
    const leaky: StockRecording = {
      ...RECORDING,
      exchanges: [
        {
          kind: "read",
          method: "GET",
          url: "https://api.example.com/v1/items?key=k3y-v4lue-0001&q=red",
          response: {
            status: 401,
            headers: {},
            body: {
              json: {
                echoed: "you sent k3y-v4lue-0001",
                header: "Authorization: Bearer abcdefghijkl",
                session: { access_token: "opaque" },
              },
            },
          },
        },
      ],
    };
    const { recording, redacted } = redactRecording(leaky, { secretValues: ["k3y-v4lue-0001"] });
    expect(redacted).toBe(true);
    const text = JSON.stringify(recording);
    expect(text).not.toContain("k3y-v4lue-0001");
    expect(text).not.toContain("abcdefghijkl");
    expect(text).not.toContain("opaque");
    expect(recording.exchanges[0]).toMatchObject({
      url: "https://api.example.com/v1/items?key=[redacted]&q=red",
      response: { body: { json: { session: { access_token: "[redacted]" } } } },
    });
    // A committed recording is a fixed point: redacting it again changes nothing.
    expect(redactRecording(recording)).toEqual({ recording, redacted: false });
  });

  it("leaves a recording with nothing secret alone", () => {
    expect(redactRecording(RECORDING)).toEqual({ recording: RECORDING, redacted: false });
  });
});

describe("recordedResponseOf", () => {
  it("keeps the status, the listed headers and the body as JSON, text or base64", async () => {
    const json = new Response('{"a":1}', {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "s=1", link: "<x>; rel=next" },
    });
    expect(await recordedResponseOf(json)).toEqual({
      status: 200,
      headers: { "content-type": "application/json", link: "<x>; rel=next" },
      body: { json: { a: 1 } },
    });
    expect(await recordedResponseOf(new Response("plain"))).toMatchObject({
      body: { text: "plain" },
    });
    expect(await recordedResponseOf(new Response(new Uint8Array([0xff, 0x00])))).toMatchObject({
      body: { base64: "/wA=" },
    });
    expect(await recordedResponseOf(new Response(null, { status: 204 }))).toEqual({
      status: 204,
      headers: {},
    });
  });
});
