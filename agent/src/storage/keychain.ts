import { spawn } from "node:child_process";

import { APP_ID } from "../constants.js";

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export async function keychainGet(account: string): Promise<string | null> {
  const res = await run("security", ["find-generic-password", "-s", APP_ID, "-a", account, "-w"]);
  if (res.code === 0) return res.stdout.trim();
  // "could not be found" is the common case for missing entries.
  return null;
}

export async function keychainSet(account: string, secret: string): Promise<void> {
  const res = await run("security", [
    "add-generic-password",
    "-s",
    APP_ID,
    "-a",
    account,
    "-w",
    secret,
    "-U",
  ]);
  if (res.code !== 0) {
    throw new Error(`keychainSet failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
}

export async function keychainDelete(account: string): Promise<void> {
  const res = await run("security", ["delete-generic-password", "-s", APP_ID, "-a", account]);
  if (res.code !== 0) {
    // Missing is fine.
    return;
  }
}

