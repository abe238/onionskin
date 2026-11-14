#!/usr/bin/env node
// Kept so old instructions still work: the checks live in src/doctor.js and run as `onionskin doctor`. Prints OK / MISSING / NOTE lines.
// Unlike `onionskin doctor` this always exits 0. Run: node ~/.onionskin/app/<version>/scripts/install-check.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { runDoctor, formatDoctor } = await import(path.join(root, "src", "doctor.js"));
process.stdout.write(formatDoctor(await runDoctor({ appRoot: root })));
