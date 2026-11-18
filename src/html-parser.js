// The one module that imports the vendored HTML parser (vendor/parse5/parse5.mjs, pinned by vendor/parse5.lock.json) and installs it
// in src/html.js. Only modules that run in worker threads import this one (src/anchor-worker.js), so the server's own thread never
// parses a page: test/html-parser-thread.test.js fails if src/server.js or src/session.js reach it.
import * as P5 from "../vendor/parse5/parse5.mjs";
import { installParser } from "./html.js";

installParser(P5);
export { P5 };
