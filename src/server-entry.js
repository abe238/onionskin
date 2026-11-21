import { startServer } from "./server.js";

let srv;
try {
  srv = await startServer();
  process.stdout.write("ready\n"); // the CLI waits for this line instead of polling
} catch (err) {
  if (err?.code === "EALREADY") process.exit(0);
  console.error(err?.message || err);
  process.exit(1);
}
process.on("SIGTERM", () => srv.shutdown());
process.on("SIGINT", () => srv.shutdown());
process.stdout.on("error", () => {});
