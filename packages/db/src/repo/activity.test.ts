import { drizzle } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it } from "vitest";

import type { DbOrTx } from "../index";
import { activityBranches, countAgentActivity, findAgentLastRun, listActivity } from "./activity";

/**
 * **The person is in every statement** of the console's activity (GRA-308; ADR 0007), pinned as
 * `scope.test.ts` pins the rest: rendered by a fake `pg` client that records what drizzle would
 * send. Each branch of the stream names the person on the agent it joins, and again on the tool
 * and the connection it joins, so another person's agent, vendor or connection matches nothing; a
 * filter is a predicate in the statement, or a branch left out of it, and never a page the client
 * narrows.
 */

let statements: { sql: string; params: readonly unknown[] }[] = [];

const db = drizzle({
  client: {
    query: async (config: { text?: string }, params: readonly unknown[] = []) => {
      statements.push({ sql: config.text ?? "", params });
      return { rows: [], rowCount: 0, fields: [], command: "", oid: 0 };
    },
  } as never,
}) as unknown as DbOrTx;

beforeEach(() => {
  statements = [];
});

const only = () => {
  expect(statements).toHaveLength(1);
  return statements[0] ?? { sql: "", params: [] };
};

const SCOPE = { personId: "person_1", agentId: "agent_1" };

/** The one shape every agent-scoped predicate takes, as `scope.test.ts` spells it. */
const SCOPED_AGENT =
  /"agent_id" in \(select "id" from "agent" where \("agent"\."id" = \$\d+ and "agent"\."person_id" = \$\d+\)\)/;

const RUN_KEY = `('run:' || "usage_ledger"."id") collate "C"`;
const TOOL_APPROVAL_KEY = `('tool_approval:' || "approval"."agent_id" || ':' || "approval"."tool_id") collate "C"`;
const VENDOR_APPROVAL_KEY = `('vendor_approval:' || "vendor_approval"."agent_id" || ':' || "vendor_approval"."vendor") collate "C"`;
const ASK_KEY = `('ask:' || "pending_action"."id") collate "C"`;
const EVENT_KEY = `('event:' || "approval_event"."id") collate "C"`;
const RUN_VENDOR = `coalesce("authored_tool"."vendor", "connection"."vendor")`;
const ASK_CONNECTION = `coalesce("pending_action"."connection_id", "pending_action"."answer" ->> 'connectionId')`;

describe("the activity stream names the person in every branch", () => {
  it("merges runs, tool approvals, integration approvals, answered asks and approval events, each ordered and limited under the person", async () => {
    await listActivity(db, "person_1", { filter: {}, limit: 51 });
    const s = only();
    const branches = s.sql.split(") union all (");
    expect(branches).toHaveLength(5);
    const [runs, tools, vendors, asks, events] = branches as [
      string,
      string,
      string,
      string,
      string,
    ];

    expect(runs).toMatch(/^select \* from \(\(select 'run' as kind, /);
    expect(runs).toContain(
      'from "usage_ledger" inner join "agent" on "usage_ledger"."agent_id" = "agent"."id" left join "authored_tool" on ("usage_ledger"."tool_id" = "authored_tool"."id" and "authored_tool"."person_id" = $1) left join "connection" on ("usage_ledger"."connection_id" = "connection"."id" and "connection"."person_id" = $2)',
    );
    // Dry runs and meta-tool lines are left out by default; a meta-tool's name has no separator.
    expect(runs).toContain(
      `where ("agent"."person_id" = $3 and "usage_ledger"."dry_run" = $4 and strpos("usage_ledger"."tool_name", '__') > 0) order by "usage_ledger"."created_at" desc, ${RUN_KEY} desc limit $5`,
    );

    expect(tools).toMatch(/^select 'approval' as kind, /);
    expect(tools).toContain(
      'from "approval" inner join "agent" on "approval"."agent_id" = "agent"."id" inner join "authored_tool" on ("approval"."tool_id" = "authored_tool"."id" and "authored_tool"."person_id" = $6)',
    );
    // GRA-341: a standing answer is the record only where no answer event, under the person,
    // covers it: one given before the events existed.
    expect(tools).toContain(
      `where ("agent"."person_id" = $7 and not exists (select 1 from "approval_event" where "approval_event"."person_id" = $8 and "approval_event"."agent_id" = "approval"."agent_id" and "approval_event"."kind" = 'tool' and "approval_event"."tool_id" = "approval"."tool_id" and "approval_event"."action" in ('allowed', 'denied') and "approval_event"."at" >= "approval"."decided_at")) order by "approval"."decided_at" desc, ${TOOL_APPROVAL_KEY} desc limit $9`,
    );

    expect(vendors).toContain(
      `from "vendor_approval" inner join "agent" on "vendor_approval"."agent_id" = "agent"."id" where ("agent"."person_id" = $10 and not exists (select 1 from "approval_event" where "approval_event"."person_id" = $11 and "approval_event"."agent_id" = "vendor_approval"."agent_id" and "approval_event"."kind" = 'vendor' and "approval_event"."vendor" = "vendor_approval"."vendor" and "approval_event"."action" in ('allowed', 'widened', 'narrowed') and "approval_event"."at" >= "vendor_approval"."granted_at")) order by "vendor_approval"."granted_at" desc, ${VENDOR_APPROVAL_KEY} desc limit $12`,
    );

    // A tool ask's answer is the standing row it wrote, so the asks branch leaves `tool` out; an
    // ask an event names as the one it answered is shown as that event.
    expect(asks).toContain(
      `from "pending_action" inner join "agent" on "pending_action"."agent_id" = "agent"."id" where ("agent"."person_id" = $13 and "pending_action"."answered_at" is not null and "pending_action"."kind" <> 'tool' and not exists (select 1 from "approval_event" where "approval_event"."person_id" = $14 and "approval_event"."pending_action_id" = "pending_action"."id")) order by "pending_action"."answered_at" desc, ${ASK_KEY} desc limit $15`,
    );

    // The events, under the person on the row; the agent and the tool joined under the person,
    // left, since a connection's revoke names no agent and a gone tool leaves its event.
    expect(events).toContain(
      `from "approval_event" left join "agent" on ("approval_event"."agent_id" = "agent"."id" and "agent"."person_id" = $16) left join "authored_tool" on ("approval_event"."tool_id" = "authored_tool"."id" and "authored_tool"."person_id" = $17) where "approval_event"."person_id" = $18 order by "approval_event"."at" desc, ${EVENT_KEY} desc limit $19`,
    );
    expect(events).toMatch(
      /\)\) as activity order by activity\.at desc, activity\.key collate "C" desc limit \$20$/,
    );

    expect(s.params).toEqual([
      "person_1",
      "person_1",
      "person_1",
      false,
      51,
      "person_1",
      "person_1",
      "person_1",
      51,
      "person_1",
      "person_1",
      51,
      "person_1",
      "person_1",
      51,
      "person_1",
      "person_1",
      "person_1",
      51,
      51,
    ]);
  });

  it("every branch lists the same columns in the same order", async () => {
    await listActivity(db, "person_1", { filter: {}, limit: 10 });
    const columns = only()
      .sql.split(") union all (")
      .map((branch) =>
        [
          ...(branch.replace(/^select \* from \(\(/, "").split(" from ")[0] ?? "").matchAll(
            / as ([a-z_]+)(?:,|$)/g,
          ),
        ].map((m) => m[1]),
      );
    expect(new Set(columns.map((list) => list.join(","))).size).toBe(1);
    expect(columns[0]).toEqual([
      "kind",
      "key",
      "at",
      "agent_id",
      "agent_name",
      "vendor",
      "connection_id",
      "id",
      "wire_name",
      "tool_id",
      "tool_vendor",
      "tool_short_name",
      "tool_description",
      "outcome",
      "reason",
      "asked",
      "latency_ms",
      "dry_run",
      "source",
      "decision",
      "includes_destructive",
      "ask_kind",
      "answer",
      "event_kind",
      "event_action",
      "event_via",
    ]);
  });

  it("the cursor is a row comparison on each branch's own moment and key, before the limits", async () => {
    await listActivity(db, "person_1", {
      filter: {},
      limit: 51,
      after: { at: "2026-10-14 09:00:00.123456", key: "run:u_9" },
    });
    const s = only();
    expect(s.sql).toContain(
      `("usage_ledger"."created_at", ${RUN_KEY}) < ($5::timestamp, $6)) order by`,
    );
    expect(s.sql).toContain(`("approval"."decided_at", ${TOOL_APPROVAL_KEY}) < ($`);
    expect(s.sql).toContain(`("vendor_approval"."granted_at", ${VENDOR_APPROVAL_KEY}) < ($`);
    expect(s.sql).toContain(`("pending_action"."answered_at", ${ASK_KEY}) < ($`);
    expect(s.sql).toContain(`("approval_event"."at", ${EVENT_KEY}) < ($`);
    expect(s.params.filter((p) => p === "2026-10-14 09:00:00.123456")).toHaveLength(5);
    expect(s.params.filter((p) => p === "run:u_9")).toHaveLength(5);
  });
});

describe("a filter changes the statement", () => {
  it("an agent is a predicate on every branch, beside the person", async () => {
    await listActivity(db, "person_1", { filter: { agentId: "agent_1" }, limit: 10 });
    const s = only();
    expect(s.sql).toContain('("agent"."person_id" = $3 and "usage_ledger"."agent_id" = $4 and');
    expect(s.sql).toContain('"approval"."decided_at") and "approval"."agent_id" = $10)');
    expect(s.sql).toContain(
      '"vendor_approval"."granted_at") and "vendor_approval"."agent_id" = $14)',
    );
    expect(s.sql).toContain('"pending_action"."agent_id" = $');
    // An agent leaves out the events that name none, a connection's revoke.
    expect(s.sql).toContain('("approval_event"."person_id" = $');
    expect(s.sql).toContain('and "approval_event"."agent_id" = $');
    expect(s.params.filter((p) => p === "agent_1")).toHaveLength(5);
  });

  it("a vendor is read off the tool or the connection for a run, the tool for an approval, the row for an integration approval and the payload for an ask", async () => {
    await listActivity(db, "person_1", { filter: { vendor: "gmail" }, limit: 10 });
    const s = only();
    expect(s.sql).toContain(`${RUN_VENDOR} = $`);
    expect(s.sql).toContain('"authored_tool"."vendor" = $');
    expect(s.sql).toContain('"vendor_approval"."vendor" = $');
    expect(s.sql).toContain(`"pending_action"."payload" ->> 'vendor' = $`);
    expect(s.sql).toContain('"approval_event"."vendor" = $');
    expect(s.params.filter((p) => p === "gmail")).toHaveLength(5);
  });

  it("a connection keeps the runs, the asks and the events, which record one, and leaves the standing approvals out", async () => {
    await listActivity(db, "person_1", { filter: { connectionId: "conn_1" }, limit: 10 });
    const s = only();
    expect(s.sql.split(") union all (")).toHaveLength(3);
    expect(s.sql).toContain('"usage_ledger"."connection_id" = $');
    expect(s.sql).toContain(`${ASK_CONNECTION} = $`);
    expect(s.sql).toContain('"approval_event"."connection_id" = $');
    expect(s.sql).not.toContain('from "approval"');
    expect(s.sql).not.toContain('from "vendor_approval"');
  });

  it("an outcome is a run's, so the statement is the runs alone", async () => {
    await listActivity(db, "person_1", { filter: { outcome: "refused" }, limit: 10 });
    const s = only();
    expect(s.sql).not.toContain("union all");
    expect(s.sql).toContain('"usage_ledger"."outcome" = $5');
    expect(s.params).toEqual(["person_1", "person_1", "person_1", false, "refused", 10, 10]);
  });

  it("the approval kind leaves the ledger out", async () => {
    await listActivity(db, "person_1", { filter: { kind: "approval" }, limit: 10 });
    const s = only();
    expect(s.sql).not.toContain('"usage_ledger"');
    expect(s.sql.split(") union all (")).toHaveLength(4);
  });

  it("dry runs and meta-tools come back only when asked for, by dropping their predicates", async () => {
    await listActivity(db, "person_1", {
      filter: { kind: "run", includeDryRuns: true, includeMetaTools: true },
      limit: 10,
    });
    const s = only();
    expect(s.sql).not.toContain('"dry_run" = $');
    expect(s.sql).not.toContain("strpos(");
    expect(s.sql).toContain(`where "agent"."person_id" = $3 order by`);
  });

  it("an approval kind with an outcome keeps nothing and sends no statement", async () => {
    expect(activityBranches({ kind: "approval", outcome: "ok" })).toEqual([]);
    expect(
      await listActivity(db, "person_1", {
        filter: { kind: "approval", outcome: "ok" },
        limit: 10,
      }),
    ).toEqual([]);
    expect(statements).toHaveLength(0);
  });
});

describe("the agent page's figures are agent-scoped", () => {
  it("counts the window's runs, the ones that ran without asking and the approved, meta-tools and dry runs left out", async () => {
    await countAgentActivity(db, SCOPE, { since: new Date("2026-10-07T10:00:00Z") });
    const s = only();
    expect(s.sql).toBe(
      `select count(*) filter (where "outcome" <> 'refused'), count(*) filter (where "outcome" = 'ok' and "asked" = false), count(*) filter (where "outcome" = 'ok' and "asked" = true) from "usage_ledger" where ("usage_ledger"."agent_id" in (select "id" from "agent" where ("agent"."id" = $1 and "agent"."person_id" = $2)) and "usage_ledger"."dry_run" = $3 and strpos("usage_ledger"."tool_name", '__') > 0 and "usage_ledger"."created_at" >= $4)`,
    );
    expect(s.params).toEqual(["agent_1", "person_1", false, "2026-10-07T10:00:00.000Z"]);
  });

  it("reads the newest run with its tool joined under the person", async () => {
    await findAgentLastRun(db, SCOPE);
    const s = only();
    expect(s.sql).toMatch(SCOPED_AGENT);
    expect(s.sql).toContain(
      'left join "authored_tool" on ("usage_ledger"."tool_id" = "authored_tool"."id" and "authored_tool"."person_id" = $1)',
    );
    expect(s.sql).toMatch(
      /order by "usage_ledger"\."created_at" desc, "usage_ledger"\."id" desc limit \$5$/,
    );
    expect(s.params).toEqual(["person_1", "agent_1", "person_1", false, 1]);
  });
});
