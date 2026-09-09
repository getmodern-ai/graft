import { describe, expect, it } from "vitest";

import { forbiddenDraftFiles, normaliseManifest, positionOf, readManifest } from "./manifest";

const manifest = (content: string) => [{ path: "package.json", content }];

describe("readManifest", () => {
  it("declares nothing without a package.json or without a dependencies table", () => {
    expect(readManifest([{ path: "index.ts", content: "" }])).toEqual({
      ok: true,
      dependencies: [],
    });
    expect(readManifest(manifest('{ "name": "x" }'))).toEqual({ ok: true, dependencies: [] });
  });

  it("reads each dependency with its spec and where it sits, sorted by name", () => {
    const text = [
      "{",
      '  "dependencies": {',
      '    "zod": "4.4.3",',
      '    "@slack/web-api": "^7.0.0"',
      "  }",
      "}",
    ].join("\n");
    expect(readManifest(manifest(text))).toEqual({
      ok: true,
      dependencies: [
        { name: "@slack/web-api", spec: "^7.0.0", line: 4, column: 5 },
        { name: "zod", spec: "4.4.3", line: 3, column: 5 },
      ],
    });
  });

  it("refuses a file that is not JSON, or not an object, at line one", () => {
    expect(readManifest(manifest("{ not json"))).toMatchObject({
      ok: false,
      refusals: [
        {
          rule: "manifest-invalid",
          file: "package.json",
          line: 1,
          column: 1,
          message: expect.stringContaining("not JSON"),
        },
      ],
    });
    expect(readManifest(manifest("[]"))).toMatchObject({
      ok: false,
      refusals: [{ rule: "manifest-invalid", message: "package.json is not a JSON object." }],
    });
  });

  it("refuses every dependency section but dependencies, at the section's line, and ignores an empty one", () => {
    for (const section of [
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "bundleDependencies",
      "overrides",
      "resolutions",
      "workspaces",
    ]) {
      const value =
        section === "workspaces" || section === "bundleDependencies" ? '["x"]' : '{ "x": "1.0.0" }';
      const text = ["{", '  "dependencies": {},', `  "${section}": ${value}`, "}"].join("\n");
      expect(readManifest(manifest(text)), section).toMatchObject({
        ok: false,
        refusals: [
          {
            rule: "manifest-invalid",
            line: 3,
            column: 3,
            message: expect.stringContaining(section),
            hint: expect.stringContaining("dependencies"),
          },
        ],
      });
    }
    expect(readManifest(manifest('{ "devDependencies": {}, "workspaces": [] }'))).toEqual({
      ok: true,
      dependencies: [],
    });
  });

  it('refuses "type" other than module, since the runner loads an ES module', () => {
    expect(readManifest(manifest('{\n  "type": "commonjs"\n}'))).toMatchObject({
      ok: false,
      refusals: [
        { rule: "manifest-invalid", line: 2, message: expect.stringContaining('"commonjs"') },
      ],
    });
    expect(readManifest(manifest('{ "type": "module" }'))).toEqual({ ok: true, dependencies: [] });
  });

  it("refuses a dependencies table that is not an object of strings", () => {
    expect(readManifest(manifest('{ "dependencies": ["left-pad"] }'))).toMatchObject({
      ok: false,
      refusals: [{ rule: "manifest-invalid", message: expect.stringContaining("not an object") }],
    });
    expect(
      readManifest(manifest('{\n  "dependencies": {\n    "left-pad": 1\n  }\n}')),
    ).toMatchObject({
      ok: false,
      refusals: [
        {
          rule: "manifest-invalid",
          line: 3,
          column: 5,
          message: expect.stringContaining("left-pad"),
        },
      ],
    });
  });
});

describe("normaliseManifest", () => {
  it("sets type: module first when the manifest lacks it, keeps the rest in order, and leaves other files alone", () => {
    const files = normaliseManifest([
      { path: "index.ts", content: "x" },
      { path: "package.json", content: '{"dependencies":{"left-pad":"1.3.0"},"name":"pad"}' },
    ]);
    expect(files[0]).toEqual({ path: "index.ts", content: "x" });
    expect(files[1]?.content).toBe(
      '{\n  "type": "module",\n  "dependencies": {\n    "left-pad": "1.3.0"\n  },\n  "name": "pad"\n}\n',
    );
  });

  it("leaves a manifest that already says module, and a draft with no manifest, untouched", () => {
    const withType = [{ path: "package.json", content: '{"type":"module"}' }];
    expect(normaliseManifest(withType)).toEqual(withType);
    const none = [{ path: "index.ts", content: "x" }];
    expect(normaliseManifest(none)).toEqual(none);
  });
});

describe("forbiddenDraftFiles", () => {
  it("names a lockfile, an npmrc and anything under node_modules, each once, and passes the rest", () => {
    const refusals = forbiddenDraftFiles([
      { path: "index.ts", content: "" },
      { path: "package.json", content: "{}" },
      { path: "package-lock.json", content: "{\n" },
      { path: ".npmrc", content: "registry=https://evil.example" },
      { path: "node_modules/left-pad/index.js", content: "" },
      { path: "node_modules/left-pad/package.json", content: "" },
      { path: "lib/yarn.lock.md", content: "" },
    ]);
    expect(refusals.map((r) => [r.rule, r.file])).toEqual([
      ["draft-contents", "package-lock.json"],
      ["draft-contents", ".npmrc"],
      ["draft-contents", "node_modules/left-pad/index.js"],
      ["draft-contents", "node_modules/left-pad/package.json"],
    ]);
    expect(refusals[1]?.text).toBe("registry=https://evil.example");
    expect(refusals[0]?.hint).toContain("Remove package-lock.json");
  });
});

describe("positionOf", () => {
  it("finds a key's line and column, and falls back to the start", () => {
    const text = '{\n  "a": { "b": 1 },\n  "b": 2\n}';
    expect(positionOf(text, "b")).toEqual({ line: 2, column: 10 });
    expect(positionOf(text, "a")).toEqual({ line: 2, column: 3 });
    expect(positionOf(text, "zzz")).toEqual({ line: 1, column: 1 });
  });
});
