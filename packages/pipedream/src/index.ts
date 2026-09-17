/**
 * `@graft/pipedream` — the Pipedream Connect client behind the Pipedream connection provider
 * (ADR 0019; GRA-59). The README says what it does and why it is its own package. The fakes are
 * reachable by path: `@graft/pipedream/fake` for the in-memory client, `@graft/pipedream/testing/
 * fake-pipedream` for Pipedream on a loopback port.
 */
export {
  CONNECT_TOKEN_TTL_SECONDS,
  type ConnectToken,
  connectLinkUrlFor,
  createPipedreamClient,
  PIPEDREAM_API_ORIGIN,
  type PipedreamAccount,
  type PipedreamClient,
  type PipedreamConfig,
  type PipedreamEnvironment,
  PipedreamError,
  type PipedreamRelayFields,
  TOKEN_SKEW_MS,
} from "./client";
export { EXTERNAL_USER_ID_PREFIX, externalUserIdFor, personIdOf } from "./external-user-id";
