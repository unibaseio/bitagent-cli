/** Resolves the global options into everything a command needs. */

import type { Command } from "commander";
import { loadConfig } from "./config.js";
import { NETWORKS, resolveNetwork, type Network } from "./chains.js";
import * as out from "./output.js";

export interface GlobalOptions {
  network?: string;
  json?: boolean;
  aipEndpoint?: string;
  gatewayUrl?: string;
  bitagentApi?: string;
  rpcUrl?: string;
}

export interface Ctx {
  net: Network;
  json: boolean;
  /** AIP platform API base (agents, jobs, butler, invoke). */
  aip: string;
  /** AIP gateway base (registration, job polling). */
  gateway: string;
  /** BitAgent product API base (launchpad, SIWE auth). */
  bitagent: string;
  /** Unibase Pay base (browser authorization flow). */
  pay: string;
  /** Optional RPC override for on-chain calls. */
  rpcUrl?: string;
}

const DEFAULT_NETWORK = "bscTestnet";

/**
 * Network precedence: `--network` flag › `BITAGENT_NETWORK` env ›
 * saved config › bscTestnet.
 */
export function resolveNetworkOption(explicit?: string): Network {
  const value = explicit || process.env.BITAGENT_NETWORK || loadConfig().network || DEFAULT_NETWORK;
  return resolveNetwork(value);
}

export function resolveContext(command: Command): Ctx {
  const options = command.optsWithGlobals<GlobalOptions>();
  const net = resolveNetworkOption(options.network);

  out.setJsonMode(Boolean(options.json));

  return {
    net,
    json: Boolean(options.json),
    aip: options.aipEndpoint || process.env.AIP_ENDPOINT || net.aipEndpoint,
    gateway: options.gatewayUrl || process.env.GATEWAY_URL || net.gatewayUrl,
    bitagent: options.bitagentApi || process.env.BITAGENT_API || net.bitagentApi,
    pay: process.env.UNIBASE_PAY_URL || "https://api.pay.unibase.com",
    rpcUrl: options.rpcUrl || process.env.BITAGENT_RPC_URL,
  };
}

/** `--network` help text listing every supported name and chain id. */
export const networkChoicesHelp = (): string =>
  Object.values(NETWORKS)
    .map((n) => `${n.name} (${n.chainId})`)
    .join(", ");
