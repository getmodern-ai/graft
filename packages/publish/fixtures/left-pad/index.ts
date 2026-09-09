/**
 * A fixture module declaring one package, so the publish runs the install step (ADR 0013) and a run
 * afterwards imports the vendored copy with no route to the registry. `left-pad` is not on the
 * allowlist; a test admits it through `GRAFT_PACKAGE_ALLOWLIST`'s extra-names option.
 */
import leftPad from "left-pad";

export default async (input: Input, _ctx: Context) => {
  return { padded: leftPad(input.word, input.width, "-") };
};
