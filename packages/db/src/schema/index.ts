/**
 * Every table, for drizzle's relational query API and for drizzle-kit, which reads this directory.
 * Keep test files out of `src/schema/`: drizzle-kit loads every `.ts` it finds here and a `vitest`
 * import breaks `db:generate` with a stack trace naming the test rather than the cause.
 */
export * from "./acquire-job";
export * from "./agent";
export * from "./approval";
export * from "./auth";
export * from "./blob";
export * from "./columns";
export * from "./connection";
export * from "./mcp-oauth";
export * from "./pending-action";
export * from "./person-model-key";
export * from "./setup";
export * from "./tool";
export * from "./usage";
export * from "./working-set";
