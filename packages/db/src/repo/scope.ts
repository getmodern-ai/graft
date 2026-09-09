/**
 * The pair every agent-scoped query takes — the person *and* the agent (ADR 0007).
 *
 * Both ids go into the SQL, never into a check afterwards: a read scoped by the pair matches
 * nothing for another person's agent, and a write matches nothing rather than editing it, so the
 * failure mode of a mis-scoped call is an empty answer and not a disclosure. The agent-scoped
 * tables carry `agent_id` alone — the person is one join away on `agent.person_id` — so every
 * such query goes through `scopedAgentIds` in `repo/agent.ts`, which is the one statement that
 * turns this pair into a set of agent ids. Letting a function take one id and infer the other is
 * what makes the guarantee depend on the caller remembering.
 *
 * `requireAgent` in `@graft/core` is the one place a bearer token becomes this pair, and it
 * returns this type rather than one of its own, so the shape a guard produces and the shape a
 * query consumes cannot drift.
 *
 * This file holds no queries and names no table on purpose: it is the vocabulary the other
 * `repo/*.ts` files share.
 */
export type AgentScope = { personId: string; agentId: string };
