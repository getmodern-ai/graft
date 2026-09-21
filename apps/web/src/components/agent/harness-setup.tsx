import { useId, useState } from "react";

import { CodeBlock } from "@/components/code-block";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  HARNESS_ITEMS,
  type Harness,
  harnessSetup,
  mcpEndpointUrl,
  readHarness,
} from "@/lib/mcp-snippet";

/**
 * Shared by creation and the saved-token instructions (ADR 0007). The harness is a `Select` with
 * `items` on the root, as every fixed choice in the console is (AGENTS.md), Hermes first (ADR 0016),
 * and the two blocks under it take the harness's own shape (GRA-152: Hermes wants YAML under
 * `mcp_servers` and the token in `~/.hermes/.env`, not the JSON block a person then rewrites by
 * hand). The URL is the same for every harness and stays above the choice.
 */
export function HarnessSetup({ token }: { token?: string }) {
  const origin = window.location.origin;
  const id = useId();
  const [harness, setHarness] = useState<Harness>("hermes");
  const blocks = harnessSetup(harness, origin, token);

  return (
    <>
      <CodeBlock label="MCP server URL" code={mcpEndpointUrl(origin)} copyLabel="Copy URL" />
      <Field>
        <FieldLabel htmlFor={id}>Harness</FieldLabel>
        <Select
          value={harness}
          items={HARNESS_ITEMS}
          onValueChange={(next) => {
            const read = readHarness(next);
            if (read) setHarness(read);
          }}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HARNESS_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          {harness === "hermes"
            ? "Hermes reads its configuration from ~/.hermes/config.yaml and its secrets from ~/.hermes/.env."
            : harness === "openclaw"
              ? "OpenClaw reads its own mcp.servers block in ~/.openclaw/openclaw.json and the token from ~/.openclaw/.env on the Gateway host."
              : "Any client that speaks MCP over HTTP with a bearer header: Claude Code, Cursor, a script."}
        </FieldDescription>
      </Field>
      <CodeBlock
        label={blocks.token.label}
        code={blocks.token.code}
        copyLabel={blocks.token.copyLabel}
        hint={blocks.token.hint}
      />
      <CodeBlock
        label={blocks.config.label}
        code={blocks.config.code}
        copyLabel={blocks.config.copyLabel}
        hint={blocks.config.hint}
      />
    </>
  );
}
