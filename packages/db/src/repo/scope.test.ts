import { drizzle } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it } from "vitest";

import type { DbOrTx } from "../index";
import {
  addAcquireJobTokenSpend,
  claimAcquireJob,
  findAcquireJob,
  heartbeatAcquireJob,
  insertAcquireTrace,
  listAcquireAttempts,
  listAcquireTraces,
  listRunnableAcquireJobs,
  updateAcquireAttempt,
} from "./acquire-job";
import {
  listAgentConnectionIds,
  listAllActiveAgents,
  replaceAgentConnections,
  revokeAgent,
} from "./agent";
import { deleteApproval, deleteApprovalsForVendor, findApproval, relaxApproval } from "./approval";
import { findConnection, findConnectionByIdUnscoped, revokeConnection } from "./connection";
import {
  answerPendingAction,
  consumePendingAction,
  expirePendingActionsForConnection,
  findPendingAction,
  listPendingActionsByKind,
} from "./pending-action";
import { countPersons } from "./person";
import { findToolVersion, listToolVersions, setCurrentToolVersion } from "./tool";
import { listUsage, listUsageForVendor } from "./usage";
import { deleteWorkingSetEntry, listWorkingSet, touchWorkingSetUsed } from "./working-set";

/**
 * **The scope is in the SQL** — GRA-6's acceptance criterion, asserted on the statements
 * themselves. Rendered rather than executed: a fake `pg` client records what drizzle would send and
 * answers nothing, so what is pinned here is the predicate, not Postgres's evaluation of it. Every
 * agent-scoped statement must name both the agent and the person (`repo/scope.ts`), and every
 * person-scoped statement the person; a mis-scoped call then matches nothing, which is a 404 and
 * not a disclosure (ADR 0007).
 *
 * The semantics were checked against a real Postgres by `apps/server`'s integration suite, which
 * reads one agent's working set through another's scope and gets nothing.
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

const SCOPE = { personId: "person_1", agentId: "agent_1" };

/** The one shape every agent-scoped predicate takes: `agent_id IN (agents of this person named this)`. */
const SCOPED_AGENT =
  /"agent_id" in \(select "id" from "agent" where \("agent"\."id" = \$\d+ and "agent"\."person_id" = \$\d+\)\)/;

const only = () => {
  expect(statements).toHaveLength(1);
  return statements[0] ?? { sql: "", params: [] };
};

describe("agent-scoped reads take both ids of the scope in the statement", () => {
  it("the working set", async () => {
    await listWorkingSet(db, SCOPE);
    const s = only();
    expect(s.sql).toMatch(SCOPED_AGENT);
    expect(s.params).toEqual(["agent_1", "person_1"]);
  });

  it("the agent's scope", async () => {
    await listAgentConnectionIds(db, SCOPE);
    expect(only().sql).toMatch(SCOPED_AGENT);
  });

  it("an approval", async () => {
    await findApproval(db, SCOPE, "tool_1");
    const s = only();
    expect(s.sql).toMatch(SCOPED_AGENT);
    expect(s.params).toEqual(["tool_1", "agent_1", "person_1", 1]);
  });

  it("a pending action", async () => {
    await findPendingAction(db, SCOPE, "pa_1");
    expect(only().sql).toMatch(SCOPED_AGENT);
  });

  it("the agent's answerable actions of a kind — unconsumed and in time, the JSON unread", async () => {
    await listPendingActionsByKind(db, SCOPE, "tool", new Date("2026-09-09T00:00:00Z"));
    const s = only();
    expect(s.sql).toMatch(SCOPED_AGENT);
    expect(s.sql).toContain('"pending_action"."kind" = $');
    expect(s.sql).toContain('"pending_action"."consumed_at" is null');
    expect(s.sql).toContain('"pending_action"."expires_at" > $');
    expect(s.sql.slice(s.sql.indexOf(" where "))).not.toContain("payload");
  });

  it("the ledger", async () => {
    await listUsage(db, SCOPE, { limit: 10 });
    expect(only().sql).toMatch(SCOPED_AGENT);
  });

  it("an acquire job, its attempts and its trace", async () => {
    await findAcquireJob(db, SCOPE, "job_1");
    expect(only().sql).toMatch(SCOPED_AGENT);
    statements = [];
    await listAcquireAttempts(db, SCOPE, "job_1");
    const attempts = only();
    expect(attempts.sql).toMatch(SCOPED_AGENT);
    expect(attempts.sql).toContain('"acquire_attempt"."job_id" = $');
    statements = [];
    await listAcquireTraces(db, SCOPE, "job_1", 100);
    const traces = only();
    expect(traces.sql).toMatch(SCOPED_AGENT);
    expect(traces.sql).toContain('"acquire_trace"."job_id" = $');
    expect(traces.sql).toMatch(/order by "acquire_trace"\."sequence" asc limit \$\d+$/);
  });
});

describe("agent-scoped writes take both ids too, so a mis-scoped write edits nothing", () => {
  it("demotion", async () => {
    await deleteWorkingSetEntry(db, SCOPE, "tool_1");
    const s = only();
    expect(s.sql).toMatch(/^delete from "working_set"/);
    expect(s.sql).toMatch(SCOPED_AGENT);
    expect(s.params).toEqual(["tool_1", "agent_1", "person_1"]);
  });

  it("the last-used stamp", async () => {
    await touchWorkingSetUsed(db, SCOPE, "tool_1", new Date("2026-09-09T00:00:00Z"));
    expect(only().sql).toMatch(SCOPED_AGENT);
  });

  it("relaxing an approval", async () => {
    await relaxApproval(db, SCOPE, "tool_1");
    expect(only().sql).toMatch(SCOPED_AGENT);
  });

  it("withdrawing an approval", async () => {
    await deleteApproval(db, SCOPE, "tool_1");
    const s = only();
    expect(s.sql).toMatch(/^delete from "approval"/);
    expect(s.sql).toMatch(SCOPED_AGENT);
    expect(s.params).toEqual(["tool_1", "agent_1", "person_1"]);
  });

  it("consuming a pending action, which also demands it be answered and not yet consumed", async () => {
    await consumePendingAction(db, SCOPE, "pa_1", new Date());
    const s = only();
    expect(s.sql).toMatch(SCOPED_AGENT);
    expect(s.sql).toContain('"pending_action"."answered_at" is not null');
    expect(s.sql).toContain('"pending_action"."consumed_at" is null');
  });

  it("the acquire loop's writes: tokens, the heartbeat, an attempt's end", async () => {
    await addAcquireJobTokenSpend(db, SCOPE, "job_1", 120);
    const tokens = only();
    expect(tokens.sql).toMatch(
      /^update "acquire_job" set "token_spend" = "acquire_job"\."token_spend" \+ \$1/,
    );
    expect(tokens.sql).toMatch(SCOPED_AGENT);
    statements = [];
    await heartbeatAcquireJob(db, SCOPE, "job_1", new Date("2026-09-09T00:00:00Z"));
    expect(only().sql).toMatch(SCOPED_AGENT);
    statements = [];
    await updateAcquireAttempt(db, SCOPE, "att_1", { outcome: "passed" });
    const attempt = only();
    expect(attempt.sql).toMatch(/^update "acquire_attempt" set/);
    expect(attempt.sql).toMatch(SCOPED_AGENT);
  });

  it("a trace line is numbered in the statement, over the job's own lines", async () => {
    // The fake client answers no row, which the insert reports as a throw once the statement is out.
    await insertAcquireTrace(db, {
      id: "tr_1",
      jobId: "job_1",
      agentId: "agent_1",
      kind: "progress",
      text: "Reading the docs",
    }).catch(() => null);
    const s = only();
    expect(s.sql).toMatch(/^insert into "acquire_trace"/);
    expect(s.sql).toContain(
      '(select coalesce(max("acquire_trace"."sequence"), 0) + 1 from "acquire_trace" where "acquire_trace"."job_id" = $',
    );
  });

  it("replacing the scope deletes under the pair before inserting", async () => {
    await replaceAgentConnections(db, SCOPE, ["conn_1", "conn_2"]);
    expect(statements[0]?.sql).toMatch(/^delete from "agent_connection"/);
    expect(statements[0]?.sql).toMatch(SCOPED_AGENT);
    expect(statements[1]?.sql).toMatch(/^insert into "agent_connection"/);
    expect(statements[1]?.params).toEqual(["agent_1", "conn_1", "agent_1", "conn_2"]);
  });
});

describe("person-scoped statements take the person", () => {
  /** The console's "recent vendor calls" (GRA-26) reads across the person's agents, under the person. */
  it("a vendor's ledger lines, through the agent's owner", async () => {
    await listUsageForVendor(db, "person_1", {
      vendor: "demo",
      toolNames: ["execute__conn_1"],
      limit: 10,
    });
    const s = only();
    expect(s.sql).toContain('"agent"."person_id" = $');
    expect(s.sql).toContain('"authored_tool"."vendor" = $');
    expect(s.params).toEqual(["person_1", "demo", "execute__conn_1", 10]);
  });

  it("a connection read", async () => {
    await findConnection(db, "person_1", "conn_1");
    const s = only();
    expect(s.sql).toContain('"connection"."person_id" = $');
    expect(s.params).toEqual(["conn_1", "person_1", 1]);
  });

  /** The proxy's read is the one deliberate exception and must stay recognisable as such. */
  it("the proxy's connection read is unscoped, by name", async () => {
    await findConnectionByIdUnscoped(db, "conn_1");
    const s = only();
    expect(s.sql).toMatch(/where "connection"\."id" = \$1 limit \$2$/);
    expect(s.params).toEqual(["conn_1", 1]);
  });

  /** The sweep's roster is the other one (ADR 0009): every person's live agents, recognisable as such. */
  it("the sweep's roster of active agents is unscoped, by name, and takes only the revoked filter", async () => {
    await listAllActiveAgents(db);
    const s = only();
    expect(s.sql).toMatch(/^select .* from "agent" where "agent"\."revoked_at" is null order by/);
    expect(s.sql).not.toContain('person_id" =');
    expect(s.params).toEqual([]);
  });

  /** The boot's count of persons is the third (GRA-33): whether anybody exists yet, before the admin is opened. */
  it("the boot's count of persons is unscoped, by name, over Better Auth's table alone", async () => {
    await countPersons(db);
    const s = only();
    expect(s.sql).toMatch(/^select count\(\*\) from "user"$/);
    expect(s.sql).not.toContain("where");
    expect(s.params).toEqual([]);
  });

  /**
   * The acquire runner's two (GRA-29): the roster of what may be run, joined to the agent for the
   * person, and the claim, whose predicate is the roster's so two runners cannot both take a job.
   */
  it("the acquire runner's roster is unscoped, by name, joined to the agent for the person, and takes only the runnable predicate", async () => {
    const stale = new Date("2026-09-09T00:00:00Z");
    await listRunnableAcquireJobs(db, { staleBefore: stale, limit: 2 });
    const s = only();
    expect(s.sql).toMatch(
      /^select .* from "acquire_job" inner join "agent" on "agent"\."id" = "acquire_job"\."agent_id" where/,
    );
    expect(s.sql).toContain('"acquire_job"."status" = $');
    expect(s.sql).toContain('"acquire_job"."heartbeat_at" is null');
    expect(s.sql).toContain('"acquire_job"."heartbeat_at" < $');
    expect(s.sql).not.toContain('person_id" =');
    expect(s.params).toEqual(["queued", "running", stale.toISOString(), 2]);
  });

  it("the acquire runner's claim carries the runnable predicate into the update, so a second claim matches nothing", async () => {
    const now = new Date("2026-09-09T00:01:00Z");
    const stale = new Date("2026-09-09T00:00:00Z");
    await claimAcquireJob(db, "job_1", { now, staleBefore: stale });
    const s = only();
    expect(s.sql).toMatch(
      /^update "acquire_job" set "status" = \$1, "started_at" = coalesce\("acquire_job"\."started_at", \$2\), "heartbeat_at" = \$3/,
    );
    expect(s.sql).toContain('"acquire_job"."id" = $');
    expect(s.sql).toContain('"acquire_job"."status" = $');
    expect(s.sql).toContain('"acquire_job"."heartbeat_at" < $');
    expect(s.sql).not.toContain("person_id");
  });

  it("a revoke clears every secret column and stamps the moment, under the person", async () => {
    await revokeConnection(db, "person_1", "conn_1", new Date("2026-09-09T00:00:00Z"));
    const s = only();
    expect(s.sql).toMatch(/^update "connection" set/);
    for (const column of [
      "credential_ciphertext",
      "credential_set_at",
      "oauth_client_secret_ciphertext",
      "oauth_refresh_state",
      "revoked_at",
    ]) {
      expect(s.sql).toContain(`"${column}" = `);
    }
    expect(s.sql).toContain('"connection"."person_id" = $');
  });

  it("revoking an agent is guarded on it not being revoked already", async () => {
    await revokeAgent(db, "person_1", "agent_1", new Date());
    const s = only();
    expect(s.sql).toContain('"agent"."person_id" = $');
    expect(s.sql).toContain('"agent"."revoked_at" is null');
  });

  it("answering a pending action refuses an answered or expired one in the predicate", async () => {
    await answerPendingAction(db, "person_1", "pa_1", {
      answer: { decision: "allow" },
      answeredAt: new Date("2026-09-09T00:00:00Z"),
    });
    const s = only();
    expect(s.sql).toContain('in (select "id" from "agent" where "agent"."person_id" = $');
    expect(s.sql).toContain('"pending_action"."answered_at" is null');
    expect(s.sql).toContain('"pending_action"."expires_at" > $');
  });

  /** A revoke's third sweep (GRA-28): by the column, under the person, both clocks stamped, the JSON unread. */
  it("closing a connection's open asks takes the connection and the person, and stamps expiry and consumption", async () => {
    await expirePendingActionsForConnection(
      db,
      "person_1",
      "conn_1",
      new Date("2026-09-09T00:00:00Z"),
    );
    const s = only();
    expect(s.sql).toMatch(/^update "pending_action" set/);
    expect(s.sql).toContain('"expires_at" = $');
    expect(s.sql).toContain('"consumed_at" = $');
    expect(s.sql).toContain('"pending_action"."connection_id" = $');
    expect(s.sql).toContain('in (select "id" from "agent" where "agent"."person_id" = $');
    expect(s.sql).toContain('"pending_action"."consumed_at" is null');
    expect(s.sql).toContain('"pending_action"."expires_at" > $');
    // The predicate alone — `returning` lists every column, the JSON among them.
    expect(s.sql.slice(s.sql.indexOf(" where "), s.sql.indexOf(" returning"))).not.toContain(
      "payload",
    );
  });

  it("the vendor-wide approval delete reaches only the person's tools", async () => {
    await deleteApprovalsForVendor(db, "person_1", "unleashed");
    const s = only();
    expect(s.sql).toMatch(/^delete from "approval"/);
    expect(s.sql).toContain(
      '"tool_id" in (select "id" from "authored_tool" where ("authored_tool"."person_id" = $1 and "authored_tool"."vendor" = $2))',
    );
  });
});

describe("a version is reached through its tool", () => {
  it("listing versions scopes by the tool's person", async () => {
    await listToolVersions(db, "person_1", "tool_1");
    expect(only().sql).toContain(
      '"tool_id" in (select "id" from "authored_tool" where ("authored_tool"."id" = $1 and "authored_tool"."person_id" = $2))',
    );
  });

  it("finding a version scopes by the person's tools", async () => {
    await findToolVersion(db, "person_1", "ver_1");
    expect(only().sql).toContain(
      'select "id" from "authored_tool" where "authored_tool"."person_id" = $',
    );
  });

  it("moving the pointer demands the version belong to the tool", async () => {
    await setCurrentToolVersion(db, "person_1", "tool_1", "ver_2");
    const s = only();
    expect(s.sql).toMatch(/^update "authored_tool" set "current_version_id" = \$1/);
    expect(s.sql).toContain('"authored_tool"."person_id" = $');
    expect(s.sql).toContain('select "tool_id" from "tool_version" where "tool_version"."id" = $');
  });
});
