import { drizzle } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it } from "vitest";

import type { DbOrTx } from "../index";
import {
  lastVendorUseByAgent,
  listAgentAccessForConnection,
  listBuildApprovalsForConnection,
  listVendorApprovalsForVendor,
  listVendorToolApprovals,
} from "./connection-access";

/**
 * **The person is in every statement** of a connection's access view (GRA-296; ADR 0007), pinned
 * as `scope.test.ts` pins the rest: rendered by a fake `pg` client that records what drizzle would
 * send, so what is asserted is the predicate. Each read names the person on the agent it joins and
 * again on the connection or the tool it reads, so another person's connection or vendor answers
 * nothing, and each is one statement whatever the number of agents.
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

describe("a connection's access view names the person in every statement", () => {
  it("reads the person's active agents with the scope resolved under each mode, the connection held to the person", async () => {
    await listAgentAccessForConnection(db, "person_1", "conn_1");
    const s = only();
    expect(s.sql).toMatch(/^select "id", "name", "scope_mode", .* from "agent" where/);
    expect(s.sql).toContain(
      'exists (select "id" from "connection" where ("connection"."id" = $1 and "connection"."person_id" = $2))',
    );
    expect(s.sql).toContain(
      '("agent"."scope_mode" = $3 or exists (select "agent_id" from "agent_connection" where ("agent_connection"."agent_id" = "agent"."id" and "agent_connection"."connection_id" = $4)))',
    );
    expect(s.sql).toMatch(
      /where \("agent"\."person_id" = \$5 and "agent"\."revoked_at" is null\) order by "agent"\."created_at" asc, "agent"\."id" asc$/,
    );
    expect(s.params).toEqual(["conn_1", "person_1", "all", "conn_1", "person_1"]);
  });

  it("reads each agent's last call against the vendor, dry runs excluded, under the person", async () => {
    await lastVendorUseByAgent(db, "person_1", {
      vendor: "gmail",
      toolNames: ["execute__conn_1"],
    });
    const s = only();
    expect(s.sql).toMatch(
      /^select "usage_ledger"\."agent_id", max\("usage_ledger"\."created_at"\) from "usage_ledger" inner join "agent"/,
    );
    expect(s.sql).toContain(
      'where ("agent"."person_id" = $1 and "usage_ledger"."dry_run" = $2 and ("authored_tool"."vendor" = $3 or "usage_ledger"."tool_name" in ($4)))',
    );
    expect(s.sql).toMatch(/group by "usage_ledger"\."agent_id"$/);
    expect(s.params).toEqual(["person_1", false, "gmail", "execute__conn_1"]);
  });

  it("matches by the vendor alone when no wire name is given", async () => {
    await lastVendorUseByAgent(db, "person_1", { vendor: "gmail", toolNames: [] });
    const s = only();
    expect(s.sql).not.toContain('"tool_name" in');
    expect(s.params).toEqual(["person_1", false, "gmail"]);
  });

  it("reads the vendor's tool approvals with the agent and the tool both held to the person", async () => {
    await listVendorToolApprovals(db, "person_1", "gmail");
    const s = only();
    expect(s.sql).toMatch(/^select "approval"\."agent_id", .* from "approval" inner join "agent"/);
    expect(s.sql).toContain(
      'inner join "authored_tool" on "approval"."tool_id" = "authored_tool"."id"',
    );
    expect(s.sql).toContain(
      'where ("agent"."person_id" = $1 and "agent"."revoked_at" is null and "authored_tool"."person_id" = $2 and "authored_tool"."vendor" = $3)',
    );
    expect(s.params).toEqual(["person_1", "person_1", "gmail"]);
  });

  it("reads the vendor's standing approvals for the person's active agents", async () => {
    await listVendorApprovalsForVendor(db, "person_1", "gmail");
    const s = only();
    expect(s.sql).toMatch(/^select .* from "vendor_approval" inner join "agent"/);
    expect(s.sql).toContain(
      'where ("agent"."person_id" = $1 and "agent"."revoked_at" is null and "vendor_approval"."vendor" = $2)',
    );
    expect(s.params).toEqual(["person_1", "gmail"]);
  });

  it("reads the connection's build approvals with the agent and the connection both held to the person", async () => {
    await listBuildApprovalsForConnection(db, "person_1", "conn_1");
    const s = only();
    expect(s.sql).toMatch(/^select .* from "build_approval" inner join "agent"/);
    expect(s.sql).toContain(
      'where ("agent"."person_id" = $1 and "agent"."revoked_at" is null and "connection"."person_id" = $2 and "connection"."id" = $3)',
    );
    expect(s.params).toEqual(["person_1", "person_1", "conn_1"]);
  });
});
