import { describe, expect, it } from "vitest";

/**
 * Gmail's stock modules run against a fake `ctx.fetch` (Greptile on #197): what the recordings
 * cannot show, since a recording is one test input and every write stops at the proxy's preview.
 * The modules are imported by a path held in a variable, so the type program never reads them;
 * their `Input` and `Context` are the check's, not this package's.
 */

type Call = { path: string; init?: RequestInit };
type Route = (path: string, init?: RequestInit) => unknown;
type Module = (input: Record<string, unknown>, ctx: { fetch: typeof fetch }) => Promise<unknown>;

async function gmailTool(name: string): Promise<Module> {
  const url = new URL(`../tools/gmail/${name}/index.ts`, import.meta.url).href;
  return ((await import(url)) as { default: Module }).default;
}

function fakeGmail(route: Route): { ctx: { fetch: typeof fetch }; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFake = async (path: string | URL | Request, init?: RequestInit) => {
    const text = String(path);
    calls.push({ path: text, init });
    return Response.json(route(text, init));
  };
  return { ctx: { fetch: fetchFake as typeof fetch }, calls };
}

/** The MIME message a send or draft posted, decoded from its `raw`. */
function postedMime(calls: Call[]): string {
  const post = calls.find((call) => call.init?.method === "POST");
  const body = JSON.parse(String(post?.init?.body)) as { raw?: string; message?: { raw: string } };
  return Buffer.from(body.raw ?? body.message?.raw ?? "", "base64url").toString("utf8");
}

function headerLine(mime: string, name: string): string | undefined {
  return mime.split("\r\n").find((line) => line.startsWith(`${name}: `));
}

function thread(headers: Record<string, string>) {
  return {
    id: "t1",
    messages: [
      {
        id: "m1",
        payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
      },
    ],
  };
}

describe("gmail__reply-to-thread", () => {
  const profile = { emailAddress: "me@example.com" };

  it("follows up the person's own last message to the people it went to, not to the person", async () => {
    const reply = await gmailTool("reply-to-thread");
    const { ctx, calls } = fakeGmail((path) => {
      if (path.startsWith("/users/me/threads/")) {
        return thread({
          From: "Me <me@example.com>",
          To: "Partner <partner@example.com>",
          Subject: "Plans",
          "Message-ID": "<m1@example.com>",
        });
      }
      if (path === "/users/me/profile") return profile;
      return { id: "sent", threadId: "t1" };
    });

    const result = await reply({ threadId: "t1", body: "Any news?" }, ctx);

    expect(result).toMatchObject({ to: ["Partner <partner@example.com>"] });
    expect(headerLine(postedMime(calls), "To")).toBe("To: Partner <partner@example.com>");
  });

  it("answers another sender's last message to its Reply-To, and replyAll leaves the person out", async () => {
    const reply = await gmailTool("reply-to-thread");
    const { ctx } = fakeGmail((path) => {
      if (path.startsWith("/users/me/threads/")) {
        return thread({
          From: "Partner <partner@example.com>",
          "Reply-To": "List <list@example.com>",
          To: "Me <me@example.com>, Other <other@example.com>",
          Cc: "ME@example.com",
          Subject: "Re: Plans",
          "Message-ID": "<m2@example.com>",
        });
      }
      if (path === "/users/me/profile") return profile;
      return { id: "sent", threadId: "t1" };
    });

    expect(await reply({ threadId: "t1", body: "Yes" }, ctx)).toMatchObject({
      to: ["List <list@example.com>"],
    });
    expect(await reply({ threadId: "t1", body: "Yes", replyAll: true }, ctx)).toMatchObject({
      to: ["List <list@example.com>", "Other <other@example.com>"],
    });
  });
});

describe("gmail__create-draft", () => {
  it("files a draft in a conversation with its reply headers and its subject", async () => {
    const draft = await gmailTool("create-draft");
    const { ctx, calls } = fakeGmail((path) => {
      if (path.startsWith("/users/me/threads/t1?")) {
        return thread({
          Subject: "Plans",
          "Message-ID": "<m2@example.com>",
          References: "<m1@example.com>",
        });
      }
      return { id: "d1", message: { id: "m3", threadId: "t1" } };
    });

    const result = await draft({ to: "partner@example.com", body: "Draft", threadId: "t1" }, ctx);

    expect(result).toEqual({ draftId: "d1", messageId: "m3", threadId: "t1" });
    const mime = postedMime(calls);
    expect(headerLine(mime, "Subject")).toBe("Subject: Re: Plans");
    expect(headerLine(mime, "In-Reply-To")).toBe("In-Reply-To: <m2@example.com>");
    expect(headerLine(mime, "References")).toBe("References: <m1@example.com> <m2@example.com>");
    const posted = JSON.parse(String(calls.at(-1)?.init?.body)) as {
      message: { threadId: string };
    };
    expect(posted.message.threadId).toBe("t1");
  });

  it("refuses a draft with neither a subject nor a threadId", async () => {
    const draft = await gmailTool("create-draft");
    const { ctx, calls } = fakeGmail(() => ({}));
    await expect(draft({ to: "a@example.com", body: "x" }, ctx)).rejects.toThrow(/subject/);
    expect(calls).toEqual([]);
  });
});

describe("gmail__send-email", () => {
  it("answers the sent message's ids from Gmail's response", async () => {
    const send = await gmailTool("send-email");
    const { ctx } = fakeGmail(() => ({ id: "m1", threadId: "t1", labelIds: ["SENT"] }));
    expect(await send({ to: "a@example.com", subject: "Hi", body: "Hello" }, ctx)).toEqual({
      id: "m1",
      threadId: "t1",
      labelIds: ["SENT"],
    });
  });

  it("refuses a response without the sent message's ids", async () => {
    const send = await gmailTool("send-email");
    const { ctx } = fakeGmail(() => ({ id: "m1" }));
    await expect(send({ to: "a@example.com", subject: "Hi", body: "Hello" }, ctx)).rejects.toThrow(
      /invalid sent-message response/,
    );
  });

  it("splits a long non-ASCII subject into encoded words of at most 75 characters", async () => {
    const send = await gmailTool("send-email");
    const { ctx, calls } = fakeGmail(() => ({ id: "m1", threadId: "t1", labelIds: [] }));
    const subject = "会议记录".repeat(10);
    await send({ to: "a@example.com", subject, body: "Hello" }, ctx);

    const mime = postedMime(calls);
    const start = mime.indexOf("Subject: ");
    const end = mime.indexOf("\r\nMIME-Version");
    const words = mime.slice(start + "Subject: ".length, end).split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    const decoded = words
      .map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(subject);
  });
});

describe("the HTML readers", () => {
  const html = '<p>a &amp;lt; b</p><script>x()</script ><style type="t">.c{}</style\n>done';
  const data = Buffer.from(html, "utf8").toString("base64url");

  it("gmail__get-message decodes each entity once and drops every script and style", async () => {
    const getMessage = await gmailTool("get-message");
    const { ctx } = fakeGmail((path) =>
      path.includes("format=metadata")
        ? { id: "m1", threadId: "t1", labelIds: [], payload: { headers: [] } }
        : { id: "m1", payload: { mimeType: "text/html", body: { data } } },
    );
    const result = (await getMessage({ messageId: "m1" }, ctx)) as { text: string };
    expect(result.text).toBe("a &lt; b\n  done");
  });

  it("gmail__get-thread decodes each entity once and drops every script and style", async () => {
    const getThread = await gmailTool("get-thread");
    const { ctx } = fakeGmail((path) =>
      path.startsWith("/users/me/threads/")
        ? { id: "t1", messages: [{ id: "m1", payload: { headers: [] } }] }
        : { id: "m1", payload: { mimeType: "text/html", body: { data } } },
    );
    const result = (await getThread({ threadId: "t1" }, ctx)) as { messages: { text: string }[] };
    expect(result.messages[0]?.text).toBe("a &lt; b\n  done");
  });
});

describe("the declared charset", () => {
  const latin1 = Buffer.from("café", "latin1").toString("base64url");

  it("gmail__get-message decodes a single-part body by the message's Content-Type", async () => {
    const getMessage = await gmailTool("get-message");
    const { ctx, calls } = fakeGmail((path) =>
      path.includes("format=metadata")
        ? {
            id: "m1",
            payload: {
              headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }],
            },
          }
        : { id: "m1", payload: { mimeType: "text/plain", body: { data: latin1 } } },
    );
    const result = (await getMessage({ messageId: "m1" }, ctx)) as { text: string };
    expect(result.text).toBe("café");
    expect(calls[0]?.path).toContain("metadataHeaders=Content-Type");
  });

  it("gmail__get-thread decodes a nested part by its own Content-Type", async () => {
    const getThread = await gmailTool("get-thread");
    const { ctx } = fakeGmail((path) =>
      path.startsWith("/users/me/threads/")
        ? { id: "t1", messages: [{ id: "m1", payload: { headers: [] } }] }
        : {
            id: "m1",
            payload: {
              mimeType: "multipart/mixed",
              parts: [
                {
                  mimeType: "multipart/alternative",
                  parts: [
                    {
                      mimeType: "text/plain",
                      headers: [
                        { name: "Content-Type", value: "text/plain; charset=windows-1252" },
                      ],
                      body: { data: latin1 },
                    },
                  ],
                },
              ],
            },
          },
    );
    const result = (await getThread({ threadId: "t1" }, ctx)) as { messages: { text: string }[] };
    expect(result.messages[0]?.text).toBe("café");
  });
});

describe("a text part answered by reference", () => {
  const data = Buffer.from("the long body", "utf8").toString("base64url");
  const referenced = {
    mimeType: "text/plain",
    filename: "",
    body: { attachmentId: "a1", size: 13 },
  };
  const file = {
    mimeType: "application/pdf",
    filename: "report.pdf",
    body: { attachmentId: "a2", size: 99 },
  };

  it("gmail__get-message reads its bytes as the text and lists only the file", async () => {
    const getMessage = await gmailTool("get-message");
    const { ctx, calls } = fakeGmail((path) => {
      if (path.includes("format=metadata")) return { id: "m1", payload: { headers: [] } };
      if (path.startsWith("/users/me/messages/m1/attachments/a1")) return { data };
      return { id: "m1", payload: { mimeType: "multipart/mixed", parts: [referenced, file] } };
    });
    const result = (await getMessage({ messageId: "m1" }, ctx)) as {
      text: string;
      attachments: { attachmentId: string }[];
    };
    expect(result.text).toBe("the long body");
    expect(result.attachments.map((attachment) => attachment.attachmentId)).toEqual(["a2"]);
    expect(calls.some((call) => call.path.includes("/attachments/a2"))).toBe(false);
  });

  it("gmail__get-thread reads its bytes as the text and lists only the file", async () => {
    const getThread = await gmailTool("get-thread");
    const { ctx } = fakeGmail((path) => {
      if (path.startsWith("/users/me/threads/")) {
        return { id: "t1", messages: [{ id: "m1", payload: { headers: [] } }] };
      }
      if (path.startsWith("/users/me/messages/m1/attachments/a1")) return { data };
      return { id: "m1", payload: { mimeType: "multipart/mixed", parts: [referenced, file] } };
    });
    const result = (await getThread({ threadId: "t1" }, ctx)) as {
      messages: { text: string; attachments: { attachmentId: string }[] }[];
    };
    expect(result.messages[0]?.text).toBe("the long body");
    expect(result.messages[0]?.attachments.map((attachment) => attachment.attachmentId)).toEqual([
      "a2",
    ]);
  });
});

describe("gmail__get-thread", () => {
  it("leaves out the oldest messages past the result budget and counts them", async () => {
    const getThread = await gmailTool("get-thread");
    const ids = Array.from({ length: 200 }, (_, index) => `m${index}`);
    const snippet = "s".repeat(400);
    const { ctx } = fakeGmail((path) =>
      path.startsWith("/users/me/threads/")
        ? { id: "t1", messages: ids.map((id) => ({ id, snippet, payload: { headers: [] } })) }
        : { id: "m", payload: { mimeType: "text/plain", body: { data: "" } } },
    );

    const result = (await getThread({ threadId: "t1" }, ctx)) as {
      omittedMessages: number;
      messages: { id: string }[];
    };

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(60_000);
    expect(result.omittedMessages).toBeGreaterThan(0);
    expect(result.omittedMessages + result.messages.length).toBe(200);
    expect(result.messages.at(-1)?.id).toBe("m199");
  });

  it("keeps a long conversation's text within one budget, the newest messages first", async () => {
    const getThread = await gmailTool("get-thread");
    const long = Buffer.from("a".repeat(20_000), "utf8").toString("base64url");
    const ids = ["m1", "m2", "m3", "m4"];
    const { ctx } = fakeGmail((path) =>
      path.startsWith("/users/me/threads/")
        ? { id: "t1", messages: ids.map((id) => ({ id, payload: { headers: [] } })) }
        : { id: "m", payload: { mimeType: "text/plain", body: { data: long } } },
    );

    const result = (await getThread({ threadId: "t1" }, ctx)) as { messages: { text: string }[] };

    expect(result.messages.map((message) => message.text.length)).toEqual([0, 0, 20_000, 20_000]);
    expect(JSON.stringify(result).length).toBeLessThan(64_000);
  });
});
