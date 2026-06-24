import "dotenv/config";
import { startServer } from "./server.js";

// Defense-in-depth: never let a stray async error (e.g. a flaky IMAP connection
// for one account) take down the whole agent. Log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[otp-agent] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[otp-agent] uncaughtException:", err);
});

async function main() {
  const cmd = process.argv.slice(2)[0];
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    // eslint-disable-next-line no-console
    console.log("otp-agent: run without args to start the local server.");
    process.exit(0);
  }

  await startServer();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[otp-agent] fatal:", err);
  process.exit(1);
});

