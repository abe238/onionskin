#!/usr/bin/env node
// node scripts/real-run/prepare.mjs <scenario> <workdir>   prints the working file path (the agent opens this file)
import { prepare } from "./lib.mjs";
const [scenario, workdir] = process.argv.slice(2);
if (!scenario || !workdir) (console.error("usage: prepare.mjs <scenario> <workdir>"), process.exit(2));
const info = prepare(scenario, workdir);
console.log(info.file);
