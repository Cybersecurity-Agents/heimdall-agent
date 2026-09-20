#!/usr/bin/env node
import { runAgent } from "./runner.js";

async function main(): Promise<number> {
  try {
    return await runAgent();
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") return 130;
    console.error("agent crashed:", e);
    return 1;
  }
}

const code = await main();
process.exit(code);
