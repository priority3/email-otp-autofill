import { startServer } from "./server.js";

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

