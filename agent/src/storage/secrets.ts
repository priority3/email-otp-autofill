import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { SECRETS_PATH } from "../constants.js";
import { keychainDelete, keychainGet, keychainSet } from "./keychain.js";

const SecretsFileSchema = z.object({
  version: z.number().int().default(1),
  secrets: z.record(z.string(), z.string()).default({}),
});

type SecretsFile = z.infer<typeof SecretsFileSchema>;

async function readSecretsFile(): Promise<SecretsFile> {
  try {
    const raw = await readFile(SECRETS_PATH, "utf8");
    return SecretsFileSchema.parse(JSON.parse(raw));
  } catch {
    return SecretsFileSchema.parse({});
  }
}

async function writeSecretsFile(data: SecretsFile): Promise<void> {
  const dir = path.dirname(SECRETS_PATH);
  await mkdir(dir, { recursive: true });
  const tmp = `${SECRETS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, SECRETS_PATH);
  await chmod(SECRETS_PATH, 0o600).catch(() => {});
}

function shouldUseKeychain(): boolean {
  return os.platform() === "darwin";
}

export async function secretGet(key: string): Promise<string | null> {
  if (shouldUseKeychain()) {
    try {
      return await keychainGet(key);
    } catch {
      // Fall back to file store if keychain isn't available in this runtime.
    }
  }

  const file = await readSecretsFile();
  return file.secrets[key] ?? null;
}

export async function secretSet(key: string, value: string): Promise<void> {
  if (shouldUseKeychain()) {
    try {
      await keychainSet(key, value);
      return;
    } catch {
      // Fall back to file store if keychain isn't available in this runtime.
    }
  }

  const file = await readSecretsFile();
  file.secrets[key] = value;
  await writeSecretsFile(file);
}

export async function secretDelete(key: string): Promise<void> {
  if (shouldUseKeychain()) {
    try {
      await keychainDelete(key);
      return;
    } catch {
      // Fall back to file store if keychain isn't available in this runtime.
    }
  }

  const file = await readSecretsFile();
  if (!(key in file.secrets)) return;
  delete file.secrets[key];
  await writeSecretsFile(file);
}
