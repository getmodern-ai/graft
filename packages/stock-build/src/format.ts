import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The repository's Biome over a staged tool directory (GRA-246): the model's code and the JSON the
 * build writes come out as `pnpm run lint` wants them, so a maintainer's pull request is not red on
 * formatting it did not write. `check --write` applies the formatter and the safe fixes alone;
 * what it cannot fix is answered as a sentence for the maintainer, and the build goes on, since
 * the harness, not the linter, is what proves a stock tool. The proofs run after this, on the
 * files as they will be committed.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIOME = fileURLToPath(new URL("../../../node_modules/.bin/biome", import.meta.url));

export type FormatTool = (dir: string) => Promise<string | null>;

export const formatWithBiome: FormatTool = (dir) => {
  if (!existsSync(BIOME)) {
    return Promise.resolve(
      "Biome is not installed here, so the files are as the model wrote them.",
    );
  }
  return new Promise((resolve) => {
    const child = spawn(BIOME, ["check", "--write", "--colors=off", `--config-path=${ROOT}`, dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => resolve(`Biome did not run: ${error.message}`));
    child.on("close", (code) =>
      resolve(
        code === 0
          ? null
          : `Biome left problems it cannot fix; \`pnpm run lint\` names them:\n${output.trim().slice(-2000)}`,
      ),
    );
  });
};
