import { describe, expect, it } from "vitest";

import { connectionWords, toolAskAnsweredSentence } from "./ask-sentence";

describe("connectionWords", () => {
  it("names a connection once where it is named for its integration, never by the slug", () => {
    expect(connectionWords("Linear", "linear")).toBe("Linear");
  });

  it("puts a starter's integration name beside a connection named otherwise", () => {
    expect(connectionWords("Work mail", "gmail")).toBe("Work mail (Gmail)");
  });

  it("names the connection alone when no vendor is known", () => {
    expect(connectionWords("The connection", "")).toBe("The connection");
  });
});

describe("toolAskAnsweredSentence", () => {
  it("says a decline names the agent and the tool and holds until changed", () => {
    expect(
      toolAskAnsweredSentence({
        agentName: "Claude",
        tool: "linear__create_issue",
        allow: false,
        askEveryCall: false,
      }),
    ).toBe(
      "Declined. Claude will not run linear__create_issue, and that answer holds until you change it on the agent's page in the console.",
    );
  });

  it("says an allow holds for the agent's next calls", () => {
    expect(
      toolAskAnsweredSentence({
        agentName: "Claude",
        tool: "linear__create_issue",
        allow: true,
        askEveryCall: false,
      }),
    ).toBe(
      "Allowed. Claude may run linear__create_issue; the answer holds for its next calls until withdrawn on its page in the console.",
    );
  });

  it("says an allow is for this call alone when the tool asks every time", () => {
    expect(
      toolAskAnsweredSentence({
        agentName: "Claude",
        tool: "linear__create_issue",
        allow: true,
        askEveryCall: true,
      }),
    ).toBe(
      "Allowed for this call. linear__create_issue asks again next time; turn that off on the agent's page in the console.",
    );
  });
});
