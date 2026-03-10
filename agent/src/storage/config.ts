import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { CONFIG_PATH } from "../constants.js";

const OutlookModeSchema = z.enum(["oauth", "imap"]);

const ConfigSchema = z.object({
  pollIntervalMs: z.number().int().min(1000).max(60000).default(5000),
  qq: z
    .object({
      email: z.string().email().optional(),
    })
    .default({}),
  outlook: z
    .object({
      mode: OutlookModeSchema.default("oauth"),
      clientId: z.string().min(8).optional(), // OAuth mode
      imapEmail: z.string().email().optional(), // IMAP mode
    })
    .default({ mode: "oauth" }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return ConfigSchema.parse(JSON.parse(raw));
  } catch {
    return ConfigSchema.parse({});
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  const dir = path.dirname(CONFIG_PATH);
  await mkdir(dir, { recursive: true });
  const data = JSON.stringify(cfg, null, 2) + "\n";
  await writeFile(CONFIG_PATH, data, "utf8");
}
