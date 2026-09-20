#!/usr/bin/env node
import { observerEnabled, observerLoop } from "./loop.js";
import { finalizeObserver } from "./finalize.js";

if (!process.argv.includes("--finalize") && !observerEnabled()) {
  console.log("observer_pi skip (disabled)");
  process.exit(0);
}
const ws = process.env.HEIMDALL_WORKSPACE || "/workspace";
try {
  if (process.argv.includes("--finalize")) {
    process.exit(await finalizeObserver(ws, process.argv.includes("--retry")) ? 0 : 1);
  }
  await observerLoop(ws);
} catch (e) {
  if ((e as { name?: string }).name === "AbortError") process.exit(0);
  console.error(e);
  process.exit(1);
}
