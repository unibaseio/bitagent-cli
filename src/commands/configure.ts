/** `bitagent configure` — interactive first-run setup. */

import type { Command } from "commander";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS } from "../lib/chains.js";
import { configFile, updateConfig } from "../lib/config.js";
import { resolveContext, resolveNetworkOption } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { initAuth } from "../lib/api/pay.js";
import { AipClient } from "../lib/api/aip.js";
import { isTokenExpired, resolveCredentials, walletFromToken } from "../lib/credentials.js";
import { ask, askSecret, select } from "../lib/prompt.js";
import * as out from "../lib/output.js";

export function registerConfigureCommand(program: Command): void {
  program
    .command("configure")
    .description("Set up your default network and credential (interactive)")
    .option("--token <jwt>", "Store this Unibase Pay JWT instead of prompting")
    .option("--private-key <hex>", "Store this wallet private key instead of prompting")
    .option("--set-network <name>", "Store this network as the default instead of prompting")
    .action(async function (this: Command) {
      const options = this.opts<{
        token?: string;
        privateKey?: string;
        setNetwork?: string;
      }>();
      const ctx = resolveContext(this);

      // Non-interactive path: every value came in as a flag.
      if (options.token || options.privateKey || options.setNetwork) {
        const network = options.setNetwork ? resolveNetworkOption(options.setNetwork) : undefined;
        updateConfig((config) => {
          if (network) config.network = network.name;
          if (options.token) {
            config.UNIBASE_PROXY_AUTH = options.token.trim();
            delete config.UNIBASE_WALLET_PRIVATE_KEY;
          }
          if (options.privateKey) {
            config.UNIBASE_WALLET_PRIVATE_KEY = options.privateKey.trim();
            delete config.UNIBASE_PROXY_AUTH;
          }
        });
        out.success(`Saved to ${configFile()}`);
        await report(options.setNetwork ? resolveContext(this) : ctx);
        return;
      }

      out.info("");
      out.info("BitAgent CLI setup");
      out.info("");

      const network = await select(
        "Which network should commands default to?",
        Object.values(NETWORKS).map((net) => ({
          label: `${net.label} (${net.chainId})${net.testnet ? "" : "  — real funds"}`,
          value: net.name,
        })),
        Object.keys(NETWORKS).indexOf(ctx.net.name),
      );

      const existing = resolveCredentials();
      const methods: Array<{ label: string; value: "jwt" | "key" | "keep" }> = [
        { label: "Browser authorization — approve a URL, paste the JWT token", value: "jwt" },
        { label: "Wallet private key — required for on-chain transactions", value: "key" },
      ];
      if (existing.mode !== "none") {
        methods.push({
          label: `Keep the current credential (${existing.mode}, ${existing.wallet || "unknown wallet"})`,
          value: "keep",
        });
      }

      const method = await select("\nHow do you want to authorize?", methods);

      if (method === "jwt") {
        const token = await browserAuthorize(ctx.pay);
        updateConfig((config) => {
          config.network = network;
          config.UNIBASE_PROXY_AUTH = token;
        });
      } else if (method === "key") {
        const key = await askSecret("Paste your wallet private key (hidden):");
        if (!key) throw new CliError("No private key provided — nothing was saved.");
        const address = privateKeyToAccount(normalize(key)).address;
        out.info(`  wallet: ${address}`);
        updateConfig((config) => {
          config.network = network;
          config.UNIBASE_WALLET_PRIVATE_KEY = key;
        });
      } else {
        updateConfig((config) => {
          config.network = network;
        });
      }

      out.success(`Saved to ${configFile()} (0600)`);
      await report(resolveContext(this));
    });
}

function normalize(key: string): `0x${string}` {
  const hex = key.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CliError("Invalid wallet private key: expected 64 hex characters.");
  }
  return `0x${hex}`;
}

async function browserAuthorize(payBase: string): Promise<string> {
  out.step("Requesting an authorization URL …");
  const session = await initAuth(payBase);

  out.info("");
  out.info("Open this URL, approve the request, and copy the token it gives you:");
  out.info("");
  out.info(`  ${out.link(session.authUrl)}`);
  out.info("");

  const token = (await ask("Paste the token:")).trim();
  if (!token) throw new CliError("No token provided — nothing was saved.");
  if (isTokenExpired(token)) {
    out.warn("That token looks already expired — saving it anyway.");
  }
  const wallet = walletFromToken(token);
  if (wallet) out.info(`  wallet: ${wallet}`);
  return token;
}

/** Verify the saved configuration against the live platform. */
async function report(ctx: ReturnType<typeof resolveContext>): Promise<void> {
  const credentials = resolveCredentials();
  out.heading("Configuration");
  out.kv([
    ["network", `${ctx.net.label} (${ctx.net.chainId})`],
    ["wallet", credentials.wallet || "unknown"],
    ["credential", credentials.mode === "none" ? "none" : `${credentials.mode} — ${credentials.source}`],
    ["aip endpoint", ctx.aip],
    ["bitagent api", ctx.bitagent],
    ["config file", configFile()],
  ]);

  const aip = AipClient.from(ctx);
  const stats = await aip.stats().catch(() => undefined);
  if (stats) {
    out.info("");
    out.success(
      `Connected — ${stats.total_agents ?? 0} agents and ${stats.total_services ?? 0} services on the marketplace.`,
    );
  } else {
    out.warn(`Could not reach ${ctx.aip} — check your connection.`);
  }

  if (credentials.mode !== "none") {
    out.info("");
    out.info("Next: `bitagent terminal activate` then `bitagent terminal chat`");
  }
}
