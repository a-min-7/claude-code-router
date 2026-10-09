import { main as generateClaudeCodeConfigOptions } from "./../scripts/generate-claude-code-config-options.mjs";
import { buildBrowserRenderer, buildMain, buildRenderer, buildRequestLogBodyWorker, buildStyles, buildTrayRenderer, buildWebClientBridge, cleanDist, copyAppAssets, copyBrowserRendererHtml, copyBundledClaudeRuntimePlugins, copyModelCatalog, copyRendererHtml, copyTrayRendererHtml, syncUiRendererToRuntimeDists } from "./esbuild.config.mjs";

const mode = process.argv.includes("--dev") ? "development" : "production";

// Called explicitly rather than relied on as an import side effect: the generator now runs
// only when executed directly (so tests can import its parsers without a network fetch),
// and it throws rather than overwriting a populated catalog with an empty one.
await generateClaudeCodeConfigOptions();

cleanDist();
copyAppAssets();
copyBundledClaudeRuntimePlugins();
copyModelCatalog();
copyBrowserRendererHtml();
copyRendererHtml();
copyTrayRendererHtml();

await Promise.all([
  buildMain({ mode }),
  buildBrowserRenderer({ mode }),
  buildRenderer({ mode }),
  buildRequestLogBodyWorker({ mode }),
  buildTrayRenderer({ mode }),
  buildWebClientBridge({ mode }),
  buildStyles({ minify: mode === "production" })
]);

syncUiRendererToRuntimeDists();

console.log(`Built monorepo package assets in ${mode} mode.`);
