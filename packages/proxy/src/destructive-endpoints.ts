/**
 * The reviewed table of endpoints that are destructive despite their method (ADR 0008 as amended
 * 2026-10-10, GRA-267): a request matching an entry does something the person cannot take back, a
 * refund sent, an invoice voided, a message deleted, though it is a `POST`. Every `DELETE` is
 * destructive by its method already and has no entry here.
 *
 * Data alone, in `read-endpoints.ts`'s shape, read by `read-request.ts`'s `isDestructiveRequest`,
 * which the check (the tool's `destructive` annotation) and the proxy (the dry-run preview's
 * label) both call. **Adding an entry is a reviewed change**: name the vendor's documentation in
 * `reason` and say what cannot be undone. `host` is matched exactly and in lower case; `path`
 * segment by segment from the host's root, where `*` matches one plain segment (letters, digits,
 * `_` and `-`). Where the caller does not know the host (the check, for a relative path) the path
 * is matched as the entry's path under a base path, since a connection's base path (Stripe's
 * `/v1`, Slack's `/api`) sits in front of it: an over-reach there only asks more.
 */
export type DestructiveEndpoint = {
  host: string;
  method: "POST";
  path: string;
  reason: string;
};

export const DESTRUCTIVE_ENDPOINTS: readonly DestructiveEndpoint[] = [
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/refunds",
    reason:
      "Stripe Create a refund (docs.stripe.com/api/refunds/create): returns money to the customer; a refund that has succeeded cannot be reversed.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/charges/*/refund",
    reason:
      "Stripe's older Create a refund on a charge (in Stripe's OpenAPI spec, no longer on the reference pages): the same refund as /v1/refunds.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/charges/*/refunds",
    reason:
      "Stripe's older Create a refund under a charge's refunds list (in Stripe's OpenAPI spec): the same refund as /v1/refunds.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/invoices/*/void",
    reason:
      "Stripe Void an invoice (docs.stripe.com/api/invoices/void): permanent; a voided invoice cannot be reopened or paid.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/invoices/*/mark_uncollectible",
    reason:
      "Stripe Mark an invoice as uncollectible (docs.stripe.com/api/invoices/mark_uncollectible): writes the debt off and stops collection.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/credit_notes/*/void",
    reason:
      "Stripe Void a credit note (docs.stripe.com/api/credit_notes/void): permanent, as an invoice's void is.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/payment_intents/*/cancel",
    reason:
      "Stripe Cancel a PaymentIntent (docs.stripe.com/api/payment_intents/cancel): the intent cannot be confirmed again, and any held funds are released.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/subscription_schedules/*/cancel",
    reason:
      "Stripe Cancel a schedule (docs.stripe.com/api/subscription_schedules/cancel): ends the schedule and, by default, its subscription.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/payouts/*/cancel",
    reason:
      "Stripe Cancel a payout (docs.stripe.com/api/payouts/cancel): the payout cannot be resumed.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/payouts/*/reverse",
    reason:
      "Stripe Reverse a payout (docs.stripe.com/api/payouts/reverse): pulls paid-out funds back from the bank account.",
  },
  {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/disputes/*/close",
    reason:
      "Stripe Close a dispute (docs.stripe.com/api/disputes/close): concedes the dispute, irrevocably.",
  },
  {
    host: "slack.com",
    method: "POST",
    path: "/api/chat.delete",
    reason: "Slack chat.delete (docs.slack.dev/reference/methods/chat.delete): deletes a message.",
  },
  {
    host: "slack.com",
    method: "POST",
    path: "/api/files.delete",
    reason: "Slack files.delete (docs.slack.dev/reference/methods/files.delete): deletes a file.",
  },
  {
    host: "gmail.googleapis.com",
    method: "POST",
    path: "/gmail/v1/users/*/messages/batchDelete",
    reason:
      "Gmail users.messages.batchDelete (developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchDelete): deletes messages permanently, not to the trash.",
  },
];
