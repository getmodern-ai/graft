import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * The ask card as one HTML file (GRA-84; ADR 0006 as amended 2026-09-18). A host renders an MCP
 * App inside a sandboxed iframe under a content-security policy that blocks every external script
 * and stylesheet by default, so the page has to arrive whole: `vite-plugin-singlefile` inlines the
 * bundle and the stylesheet into `dist/ask.html`, which `@graft/mcp` serves as the body of
 * `resources/read` for `ui://graft/ask`. The source page is `ask.html` at this directory's root,
 * and Vite keeps the name, so the output is `dist/ask.html` and nothing renames it.
 *
 * No React: the card is a few hundred lines of plain DOM over `@modelcontextprotocol/ext-apps`'s
 * `app-with-deps` entry, which carries its own copies of the SDK and zod so neither leaks into the
 * bundle as a bare import a host could not resolve.
 */
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: "ask.html" },
    // The hosts' iframes are current browsers; nothing here needs a transform for an old one.
    target: "es2022",
    // The first releases with `oklch()`: below them lightningcss rewrites every token to hex with a
    // `lab()` fallback, and the block stops being the copy `src/bundle.test.ts` holds it to.
    cssTarget: ["chrome111", "safari160", "firefox113"],
    // The one chunk is the ext-apps bridge with its SDK and zod inlined; its size is measured and
    // recorded on the pull request, and Vite's default warning would fire on every build.
    chunkSizeWarningLimit: 600,
  },
});
