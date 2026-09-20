#!/usr/bin/env node
import { validateWorkspace, writeValidateErr } from "./validate.js";

const ws = process.argv[2] || process.env.HEIMDALL_WORKSPACE || "/workspace";
const result = validateWorkspace(ws);
process.stdout.write(result.asText());
try {
  writeValidateErr(ws, result);
} catch {
  /* ignore */
}
process.exit(result.ok ? 0 : 2);
