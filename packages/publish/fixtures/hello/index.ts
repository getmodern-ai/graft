/**
 * A fixture module for the publish: no dependencies, one read through the proxy, so the check
 * derives read-only annotations and the publish writes a version with no install step.
 */
export default async (input: Input, ctx: Context) => {
  const res = await ctx.fetch(`/greetings?name=${encodeURIComponent(input.name)}`);
  return { ok: res.ok, status: res.status, name: input.name };
};
