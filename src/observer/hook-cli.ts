#!/usr/bin/env node
import { bashBlockReason, toolBlockReason } from "./steer.js";

const kind = process.argv[2] || "";
const workspace = process.env.HEIMDALL_WORKSPACE || "/workspace";
let why: string | null = null;
if (kind === "bash") {
  why = bashBlockReason(workspace, process.argv.slice(3));
} else if (kind === "tool") {
  why = toolBlockReason(workspace, process.argv[3] || process.env.HEIMDALL_SHOTGUN_TOOL || "");
} else {
  process.stderr.write("usage: hook-cli bash|-- tool <name>\n");
  process.exit(2);
}
if (why) {
  process.stderr.write("heimdall: " + why + "\n");
  process.exit(75);
}
process.exit(0);
