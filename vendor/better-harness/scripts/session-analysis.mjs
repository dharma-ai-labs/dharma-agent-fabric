#!/usr/bin/env node

// Thin compatibility shim (docs/adrs/directory-structure.md): the capability
// owner is scripts/session-analysis/. New exports land in the directory, not here.
//
// Minimal AI-facing usage:
//   const analyzer = await createAnalyzer("qoder");
//   const result = await analyzer.analyze({ workspace: "/path/to/repo", command: "facets" });
//   // result => { scope, sources, sessions, facets, warnings }
// CLI workflow for AI agents:
//   node scripts/session-analysis.mjs sources --platform qoder --workspace /path/to/repo
//   node scripts/session-analysis.mjs facets --platform qoder --workspace /path/to/repo --limit 5
//   node scripts/session-analysis.mjs insights --platform qoder --workspace /path/to/repo --limit 5
//   node scripts/session-analysis.mjs facts --platform qoder --workspace /path/to/repo --limit 3
//   node scripts/session-analysis.mjs facts --platform qoder --workspace /path/to/repo --limit 3 --debug
//   node scripts/session-analysis.mjs claude-facets --platform qoder --workspace /path/to/repo --limit 5
//   node scripts/session-analysis.mjs file-reads --platform qoder --workspace /path/to/repo --limit 5
//   node scripts/session-analysis.mjs show --platform qoder --workspace /path/to/repo --session-id <id> --include-events
// This module returns evidence and compact insight packs; the caller synthesizes
// any final narrative/report.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./session-analysis/analyzer.mjs";

export {
  createAnalyzer,
  main,
  SessionAnalyzer,
  SESSION_ANALYSIS_HELP,
  SUPPORTED_SESSION_PLATFORMS,
} from "./session-analysis/analyzer.mjs";

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`session-analysis failed: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
