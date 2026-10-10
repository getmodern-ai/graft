import type { ToolCallEvent } from "@graft/mcp";
import type { AnalyticsProperties } from "@graft/observability";

/**
 * `tool_called`'s properties off the MCP hook's event (GRA-100), flat, as an analytics backend
 * indexes them, and never the input. A run of a stock copy or a remix of one (GRA-244; ADR 0025)
 * adds `stock_tool_id`, `stock_version_id`, `stock_remix`, and `failure_kind` and `vendor_status`
 * (null on a run that did not fail): what a hosted monitor of a stock version's failure rate cuts
 * by. Every other call carries exactly the six it did before. `events.ts` names them.
 */
export function toolCalledProperties(event: ToolCallEvent): AnalyticsProperties {
  return {
    tool: event.tool,
    kind: event.kind,
    agent_id: event.agentId,
    outcome: event.outcome,
    reason: event.reason ?? null,
    latency_ms: event.latencyMs,
    ...(event.stock
      ? {
          stock_tool_id: event.stock.toolId,
          stock_version_id: event.stock.versionId,
          stock_remix: event.stock.remix,
          failure_kind: event.stock.failureKind ?? null,
          vendor_status: event.stock.vendorStatus ?? null,
        }
      : {}),
  };
}
