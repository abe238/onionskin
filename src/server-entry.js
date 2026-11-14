import { startServer } from "./server.js";

try {
  await startServer();
  process.stdout.write("ready\n"); // the CLI waits for this line instead of polling
} catch (err) {
  if (err?.code === "EALREADY") process.exit(0);
  console.error(err?.message || err);
  process.exit(1);
}
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.stdout.on("error", () => {});
