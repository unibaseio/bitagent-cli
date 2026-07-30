/** Identity and local state: `whoami`, `logout`, `config`, `networks`. */

import type { Command } from "commander";
import { erc20Abi, formatEther, formatUnits } from "viem";
import { NETWORKS } from "../lib/chains.js";
import { clearSessions, configFile, loadConfig, saveConfig, updateConfig } from "../lib/config.js";
import { resolveContext, type Ctx } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { AipClient } from "../lib/api/aip.js";
import { publicClientFor, resolveCredentials } from "../lib/credentials.js";
import * as out from "../lib/output.js";

interface TokenBalance {
  symbol: string;
  address: string;
  amount: string;
}

export function registerAuthCommands(program: Command): void {
  program
    .command("whoami")
    .description("Show the active wallet, credential, network and balances")
    .option("--no-balances", "Skip on-chain balance lookups")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const { balances: withBalances } = this.opts<{ balances: boolean }>();
      const credentials = resolveCredentials();

      if (credentials.mode === "none") {
        throw new CliError(
          "Not configured yet.",
          "Run `bitagent configure` to authorize this machine.",
        );
      }

      const balances = withBalances ? await readBalances(ctx, credentials.wallet) : [];
      const butler = await lookupButler(ctx, credentials.token, credentials.wallet);

      out.result(
        {
          wallet: credentials.wallet,
          credential: { mode: credentials.mode, source: credentials.source },
          network: { name: ctx.net.name, label: ctx.net.label, chainId: ctx.net.chainId },
          endpoints: { aip: ctx.aip, gateway: ctx.gateway, bitagent: ctx.bitagent },
          balances,
          terminalAgent: butler,
        },
        () => {
          out.heading("Identity");
          out.kv([
            ["wallet", credentials.wallet || "unknown"],
            ["credential", `${credentials.mode} (${credentials.source})`],
            ["network", `${ctx.net.label} (${ctx.net.chainId})`],
            ["can sign tx", credentials.mode === "key"],
          ]);

          if (balances.length > 0) {
            out.heading("Balances");
            out.kv(balances.map((b) => [b.symbol, b.amount] as [string, unknown]));
          }

          out.heading("Terminal agent");
          if (butler) {
            out.kv([
              ["agent id", butler.agent_id],
              ["handle", butler.handle],
              ["wallet", butler.wallet_address],
            ]);
          } else {
            out.kv([["status", "not activated"]]);
            out.hint("Run `bitagent terminal activate` to create it.");
          }
        },
      );
    });

  program
    .command("logout")
    .description("Remove stored credentials and cached API sessions")
    .option("--keep-network", "Keep the saved default network")
    .action(function (this: Command) {
      const { keepNetwork } = this.opts<{ keepNetwork?: boolean }>();
      const config = loadConfig();
      const network = config.network;
      saveConfig(keepNetwork && network ? { network } : {});
      clearSessions();
      out.success(`Cleared credentials in ${configFile()}`);
      out.hint("Environment variables (UNIBASE_PROXY_AUTH, …) are not affected.");
    });

  const config = program.command("config").description("Inspect and edit the saved CLI config");

  config
    .command("path")
    .description("Print the config file path")
    .action(() => {
      out.result({ path: configFile() }, () => process.stdout.write(configFile() + "\n"));
    });

  config
    .command("list")
    .description("Print the saved config, with secrets masked")
    .action(() => {
      const saved = loadConfig();
      const masked = {
        ...saved,
        UNIBASE_PROXY_AUTH: mask(saved.UNIBASE_PROXY_AUTH),
        UNIBASE_WALLET_PRIVATE_KEY: mask(saved.UNIBASE_WALLET_PRIVATE_KEY),
        sessions: saved.sessions
          ? Object.fromEntries(
              Object.entries(saved.sessions).map(([chain, session]) => [
                chain,
                { ...session, token: mask(session.token) },
              ]),
            )
          : undefined,
      };
      out.result(masked, () => {
        out.heading(`Config (${configFile()})`);
        out.kv(Object.entries(masked) as Array<[string, unknown]>);
      });
    });

  config
    .command("set <key> <value>")
    .description("Set a config key (network, UNIBASE_PROXY_AUTH, UNIBASE_WALLET_PRIVATE_KEY)")
    .action((key: string, value: string) => {
      const allowed = ["network", "UNIBASE_PROXY_AUTH", "UNIBASE_WALLET_PRIVATE_KEY"];
      if (!allowed.includes(key)) {
        throw new CliError(`Cannot set "${key}".`, `Settable keys: ${allowed.join(", ")}`);
      }
      updateConfig((saved) => {
        (saved as Record<string, unknown>)[key] = value;
      });
      out.success(`Set ${key}.`);
    });

  config
    .command("unset <key>")
    .description("Remove a config key")
    .action((key: string) => {
      updateConfig((saved) => {
        delete (saved as Record<string, unknown>)[key];
      });
      out.success(`Removed ${key}.`);
    });

  program
    .command("networks")
    .description("List supported networks and their contract addresses")
    .action(function (this: Command) {
      const ctx = resolveContext(this);
      const rows = Object.values(NETWORKS);
      out.result(rows, () => {
        out.heading("Networks");
        out.table(rows, [
          { header: "name", value: (n) => (n.name === ctx.net.name ? `${n.name} *` : n.name) },
          { header: "chain id", value: (n) => String(n.chainId), align: "right" },
          { header: "type", value: (n) => (n.testnet ? "testnet" : "mainnet") },
          { header: "launchpad", value: (n) => (Object.keys(n.reserves).length ? "yes" : "no") },
          { header: "registry (8004)", value: (n) => n.contracts.registry ?? "—" },
          { header: "commerce (8183)", value: (n) => n.contracts.commerce ?? "—" },
        ]);
        out.hint("* current default — change it with `bitagent configure`.");
      });
    });
}

const mask = (value?: string): string | undefined =>
  value ? `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)` : undefined;

async function readBalances(ctx: Ctx, wallet: string): Promise<TokenBalance[]> {
  if (!wallet) return [];
  const client = publicClientFor(ctx.net, ctx.rpcUrl);
  const balances: TokenBalance[] = [];

  const native = await client
    .getBalance({ address: wallet as `0x${string}` })
    .catch(() => undefined);
  if (native !== undefined) {
    balances.push({
      symbol: ctx.net.chain.nativeCurrency.symbol,
      address: "native",
      amount: formatEther(native),
    });
  }

  const tokens = [
    ["UB", ctx.net.contracts.ub],
    ["USDC", ctx.net.contracts.usdc],
  ] as const;

  for (const [symbol, address] of tokens) {
    if (!address) continue;
    const result = await Promise.all([
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet as `0x${string}`],
      }),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]).catch(() => undefined);
    if (!result) continue;
    const [amount, decimals] = result;
    balances.push({ symbol, address, amount: formatUnits(amount, decimals) });
  }

  return balances;
}

async function lookupButler(
  ctx: Ctx,
  token: string,
  wallet: string,
): Promise<{ agent_id: string; handle?: string; wallet_address?: string } | undefined> {
  if (!token) return undefined;
  const aip = AipClient.from(ctx);
  const butler = await aip.butlerStatus(token, wallet).catch(() => undefined);
  if (!butler?.agent_id) return undefined;
  return {
    agent_id: butler.agent_id,
    handle: butler.handle,
    wallet_address: butler.wallet_address,
  };
}
