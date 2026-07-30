/**
 * Persistent CLI state: `~/.config/bitagent/config.json` (0600).
 *
 * Credentials are also read from `~/.config/unibase-aip-sdk/config.json` — the
 * file the Python / Go / TypeScript AIP SDKs write — so a machine that already
 * authorized an SDK is authorized here too. Writes always go to the CLI's own
 * file; the SDK file is never modified.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SiweSession {
  /** BitAgent API bearer token obtained via SIWE. */
  token: string;
  /** Epoch milliseconds after which the token is considered stale. */
  expiresAt: number;
  wallet: string;
}

export interface Config {
  /** Default network name, e.g. `bscTestnet`. */
  network?: string;
  UNIBASE_PROXY_AUTH?: string;
  UNIBASE_WALLET_PRIVATE_KEY?: string;
  /** Agent id from the last successful `agent register`. */
  agentId?: string;
  agentWallet?: string;
  /** Terminal (butler) agent id, keyed by chain id. */
  butler?: Record<string, string>;
  /** BitAgent API SIWE sessions, keyed by chain id. */
  sessions?: Record<string, SiweSession>;
  /** Last terminal conversation id, keyed by chain id. */
  conversation?: Record<string, string>;
}

export function configDir(): string {
  const override = process.env.BITAGENT_CONFIG_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".config", "bitagent");
}

export function configFile(): string {
  return path.join(configDir(), "config.json");
}

/** The credential file shared by the AIP SDKs (read-only from here). */
export function sdkConfigFile(): string {
  return path.join(os.homedir(), ".config", "unibase-aip-sdk", "config.json");
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  return readJson(configFile()) as Config;
}

export function saveConfig(config: Config): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Read-modify-write a single pass over the config file. */
export function updateConfig(mutate: (config: Config) => void): Config {
  const config = loadConfig();
  mutate(config);
  saveConfig(config);
  return config;
}

/** A credential from the SDK config file, if present. */
export function sdkCredential(key: "UNIBASE_PROXY_AUTH" | "UNIBASE_WALLET_PRIVATE_KEY"): string {
  const value = readJson(sdkConfigFile())[key];
  return typeof value === "string" ? value : "";
}

export function getSession(chainId: number): SiweSession | undefined {
  const session = loadConfig().sessions?.[String(chainId)];
  if (!session?.token) return undefined;
  if (session.expiresAt && session.expiresAt < Date.now() + 60_000) return undefined;
  return session;
}

export function setSession(chainId: number, session: SiweSession): void {
  updateConfig((config) => {
    config.sessions ??= {};
    config.sessions[String(chainId)] = session;
  });
}

export function clearSessions(): void {
  updateConfig((config) => {
    delete config.sessions;
  });
}

export function getButler(chainId: number): string | undefined {
  return loadConfig().butler?.[String(chainId)];
}

export function setButler(chainId: number, agentId: string): void {
  updateConfig((config) => {
    config.butler ??= {};
    config.butler[String(chainId)] = agentId;
  });
}

export function getConversation(chainId: number): string | undefined {
  return loadConfig().conversation?.[String(chainId)];
}

export function setConversation(chainId: number, conversationId: string): void {
  updateConfig((config) => {
    config.conversation ??= {};
    config.conversation[String(chainId)] = conversationId;
  });
}
