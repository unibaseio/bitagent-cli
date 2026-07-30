/**
 * Bonding-curve launchpad: launch a project token, trade it, inspect the curve.
 *
 * `--amount` means the reserve token for `buy` (what you spend) and the
 * project token for `sell` (what you sell) — the same convention as the web app.
 */

import type { Command } from "commander";
import { erc20Abi, formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { BitagentClient } from "../lib/api/bitagent.js";
import {
  BOND_VERSION,
  DEFAULT_SLIPPAGE,
  MAX_SUPPLY_AT_CURVE,
  curveDetail,
  executeTrade,
  launchToken,
  openBonding,
  predictTokenAddress,
  quoteBuy,
  quoteSell,
  requireLaunchpad,
  resolveReserve,
  tokenHandle,
  type BondingSession,
} from "../lib/bonding.js";
import { addressUrl, txUrl } from "../lib/chains.js";
import { resolveContext, type Ctx } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { bitagentToken, publicClientFor, resolveCredentials } from "../lib/credentials.js";
import { confirm } from "../lib/prompt.js";
import * as out from "../lib/output.js";

export function registerTokenCommands(program: Command): void {
  const token = program
    .command("token")
    .description("Launch and trade agent tokens on the bonding curve");

  token
    .command("launch")
    .description("Deploy a new agent token on a bonding curve")
    .requiredOption("--name <name>", "Project name")
    .requiredOption("--symbol <symbol>", "Ticker, e.g. MYAGENT")
    .option("--reserve <symbol>", "Reserve token: UB, USD1 or WBNB", "UB")
    .option("--description <text>", "Short description shown on the project page")
    .option("--image <url>", "Logo URL", "https://bitagent.io/logo.png")
    .option("--buy-royalty <percent>", "Buy royalty, in percent", "1")
    .option("--sell-royalty <percent>", "Sell royalty, in percent", "1")
    .option("--creator-allocation <amount>", "Tokens minted to you at launch", "0")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const options = this.opts<{
        name: string;
        symbol: string;
        reserve: string;
        description?: string;
        image: string;
        buyRoyalty: string;
        sellRoyalty: string;
        creatorAllocation: string;
        yes?: boolean;
      }>();

      const session = openBonding(ctx);
      const reserve = resolveReserve(ctx.net, options.reserve);
      const symbol = options.symbol.toUpperCase();
      const description = options.description ?? `${options.name} token`;
      const tokenAddress = predictTokenAddress(session, symbol);

      out.heading("Launch");
      out.kv([
        ["network", `${ctx.net.label} (${ctx.net.chainId})`],
        ["name", options.name],
        ["symbol", symbol],
        ["reserve", `${reserve.symbol} (${reserve.address})`],
        ["curve", `exponential, ${reserve.stepCount} steps`],
        ["initial price", `${reserve.initialPrice} ${reserve.symbol}`],
        ["curve supply", MAX_SUPPLY_AT_CURVE.toLocaleString("en-US")],
        ["royalties", `${options.buyRoyalty}% buy / ${options.sellRoyalty}% sell`],
        ["creator", session.wallet],
        ["token address", tokenAddress],
      ]);

      await showNativeBalance(ctx, session.wallet);

      if (!options.yes && !(await confirm(`\nLaunch ${symbol} on ${ctx.net.label}?`, false))) {
        throw new CliError("Cancelled.");
      }

      // Phase 1 — the off-chain record whose id the curve commits to.
      const apiToken = await bitagentToken(ctx.net, ctx.bitagent);
      out.step("Registering the project with the launchpad …");
      const agentHash = await BitagentClient.from(ctx).deployAgent(
        {
          name: options.name,
          ticker: symbol,
          description,
          image: options.image,
          token: tokenAddress,
          chain_id: ctx.net.chainId,
          version: BOND_VERSION,
          market_type: "bonding_curve",
        },
        apiToken,
      );
      out.success(`Registered — agent hash ${agentHash}`);

      // Phase 2 — deploy the curve on-chain.
      out.step("Submitting the on-chain transaction …");
      const launched = await launchToken(session, {
        name: options.name,
        symbol,
        reserve,
        agentHash,
        buyRoyalty: Number(options.buyRoyalty),
        sellRoyalty: Number(options.sellRoyalty),
        creatorAllocation: Number(options.creatorAllocation),
      });

      const projectUrl = `${ctx.net.webBase}/agents/${launched.tokenAddress}`;
      out.result(
        {
          token: launched.tokenAddress,
          agentHash,
          transactionHash: launched.receipt.transactionHash,
          url: projectUrl,
          network: ctx.net.name,
          chainId: ctx.net.chainId,
        },
        () => {
          out.info("");
          out.success(`${symbol} launched`);
          out.kv([
            ["token", launched.tokenAddress],
            ["tx", txUrl(ctx.net, launched.receipt.transactionHash)],
            ["project", projectUrl],
          ]);
          out.hint(`Buy the first tokens: bitagent token buy ${launched.tokenAddress} --amount 0.1`);
        },
      );
    });

  token
    .command("buy <tokenAddress>")
    .description("Buy tokens on the curve, spending reserve tokens")
    .requiredOption("--amount <amount>", "Reserve token amount to spend")
    .option("--slippage <bps>", "Slippage tolerance in SDK units (50 = 0.5%)", String(DEFAULT_SLIPPAGE))
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async function (this: Command, tokenAddress: string) {
      await trade(this, "buy", tokenAddress);
    });

  token
    .command("sell <tokenAddress>")
    .description("Sell tokens back into the curve")
    .requiredOption("--amount <amount>", "Token amount to sell")
    .option("--slippage <bps>", "Slippage tolerance in SDK units (50 = 0.5%)", String(DEFAULT_SLIPPAGE))
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async function (this: Command, tokenAddress: string) {
      await trade(this, "sell", tokenAddress);
    });

  token
    .command("quote <tokenAddress>")
    .description("Price a trade without sending a transaction")
    .requiredOption("--side <side>", "buy | sell")
    .requiredOption("--amount <amount>", "Reserve amount for buy, token amount for sell")
    .action(async function (this: Command, tokenAddress: string) {
      const ctx = resolveContext(this);
      const options = this.opts<{ side: string; amount: string }>();
      const side = options.side.toLowerCase();
      if (side !== "buy" && side !== "sell") {
        throw new CliError(`--side must be "buy" or "sell".`);
      }

      const { handle, detail } = await openToken(ctx, tokenAddress, { readOnly: true });
      const quote =
        side === "buy"
          ? await quoteBuy(handle, parseUnits(options.amount, detail.reserveDecimals))
          : await quoteSell(handle, parseEther(options.amount));

      const tokens = formatEther(quote.tokenAmount);
      const reserve = formatUnits(quote.reserveAmount, quote.reserveDecimals);
      const royalty = formatUnits(quote.royalty, quote.reserveDecimals);
      const unitPrice =
        Number(tokens) > 0 ? String(Number(reserve) / Number(tokens)) : "0";

      out.result(
        {
          side,
          token: tokenAddress,
          tokenAmount: tokens,
          reserveAmount: reserve,
          reserveSymbol: quote.reserveSymbol,
          royalty,
          unitPrice,
        },
        () => {
          out.heading(`${side === "buy" ? "Buy" : "Sell"} quote — ${detail.symbol}`);
          out.kv([
            [side === "buy" ? "you spend" : "you receive", `${reserve} ${quote.reserveSymbol}`],
            [side === "buy" ? "you receive" : "you sell", `${tokens} ${detail.symbol}`],
            ["royalty", `${royalty} ${quote.reserveSymbol}`],
            ["price per token", `${unitPrice} ${quote.reserveSymbol}`],
          ]);
        },
      );
    });

  token
    .command("info <tokenAddress>")
    .description("Show the curve state of a token")
    .action(async function (this: Command, tokenAddress: string) {
      const ctx = resolveContext(this);
      const { detail, creator } = await openToken(ctx, tokenAddress, { readOnly: true });

      const supply = formatEther(detail.currentSupply);
      const maxSupply = formatEther(detail.maxSupply);
      const price = formatUnits(detail.priceForNextMint, detail.reserveDecimals);
      const reserveBalance = formatUnits(detail.reserveBalance, detail.reserveDecimals);

      out.result(
        {
          token: tokenAddress,
          name: detail.name,
          symbol: detail.symbol,
          creator,
          currentSupply: supply,
          maxSupply,
          progress: detail.progress,
          priceForNextMint: price,
          reserveSymbol: detail.reserveSymbol,
          reserveBalance,
          buyRoyaltyPercent: detail.mintRoyaltyPercent,
          sellRoyaltyPercent: detail.burnRoyaltyPercent,
          url: `${ctx.net.webBase}/agents/${tokenAddress}`,
        },
        () => {
          out.heading(`${detail.name} ($${detail.symbol})`);
          out.kv([
            ["token", tokenAddress],
            ["creator", creator],
            ["price", `${price} ${detail.reserveSymbol}`],
            ["supply", `${supply} / ${maxSupply}`],
            ["curve progress", `${(detail.progress * 100).toFixed(2)}%`],
            ["reserve locked", `${reserveBalance} ${detail.reserveSymbol}`],
            [
              "royalties",
              `${detail.mintRoyaltyPercent}% buy / ${detail.burnRoyaltyPercent}% sell`,
            ],
            ["explorer", addressUrl(ctx.net, tokenAddress)],
            ["project", `${ctx.net.webBase}/agents/${tokenAddress}`],
          ]);
        },
      );
    });

  token
    .command("balance <tokenAddress>")
    .description("Your balance of a curve token")
    .option("--wallet <address>", "Check another address")
    .action(async function (this: Command, tokenAddress: string) {
      const ctx = resolveContext(this);
      const { wallet: override } = this.opts<{ wallet?: string }>();
      const own = resolveCredentials().wallet;
      if (!override && !own) {
        throw new CliError("No wallet to check.", "Pass --wallet, or run `bitagent configure`.");
      }
      const wallet = (override ?? own) as `0x${string}`;
      const client = publicClientFor(ctx.net, ctx.rpcUrl);

      const [balance, decimals, symbol] = await Promise.all([
        client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet],
        }),
        client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "decimals",
        }),
        client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "symbol",
        }),
      ]);

      const amount = formatUnits(balance, decimals);
      out.result({ wallet, token: tokenAddress, symbol, balance: amount }, () => {
        out.kv([
          ["wallet", wallet],
          ["token", `${symbol} (${tokenAddress})`],
          ["balance", amount],
        ]);
      });
    });
}

interface OpenToken {
  session: BondingSession;
  handle: ReturnType<typeof tokenHandle>;
  detail: Awaited<ReturnType<typeof curveDetail>>;
  creator: string;
}

/**
 * Resolve the creator (required by the SDK) and read the curve state.
 * `readOnly` sessions need no private key, so `info` and `quote` work for
 * anyone.
 */
async function openToken(
  ctx: Ctx,
  tokenAddress: string,
  options: { readOnly?: boolean } = {},
): Promise<OpenToken> {
  requireLaunchpad(ctx.net);
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    throw new CliError(`"${tokenAddress}" is not a token address.`);
  }

  const session = openBonding(ctx, options);
  const creator = await BitagentClient.from(ctx).creatorOf(
    tokenAddress,
    session.wallet || undefined,
  );
  const handle = tokenHandle(session, tokenAddress, creator);

  if (!(await handle.exists())) {
    throw new CliError(
      `No bonding-curve token at ${tokenAddress} on ${ctx.net.label}.`,
      "Check --network.",
    );
  }

  return { session, handle, detail: await curveDetail(handle), creator };
}

async function trade(command: Command, side: "buy" | "sell", tokenAddress: string): Promise<void> {
  const ctx = resolveContext(command);
  const options = command.opts<{ amount: string; slippage: string; yes?: boolean }>();
  const slippage = Number(options.slippage);
  if (!Number.isFinite(slippage) || slippage < 0) {
    throw new CliError(`Invalid --slippage "${options.slippage}".`);
  }

  const { handle, detail } = await openToken(ctx, tokenAddress);

  const quote =
    side === "buy"
      ? await quoteBuy(handle, parseUnits(options.amount, detail.reserveDecimals))
      : await quoteSell(handle, parseEther(options.amount));

  const tokens = formatEther(quote.tokenAmount);
  const reserve = formatUnits(quote.reserveAmount, quote.reserveDecimals);

  out.heading(`${side === "buy" ? "Buy" : "Sell"} ${detail.symbol}`);
  out.kv([
    ["network", `${ctx.net.label} (${ctx.net.chainId})`],
    ["token", tokenAddress],
    [side === "buy" ? "you spend" : "you receive", `${reserve} ${quote.reserveSymbol}`],
    [side === "buy" ? "you receive" : "you sell", `${tokens} ${detail.symbol}`],
    ["slippage", `${slippage / 100}%`],
  ]);

  if (!options.yes) {
    const label = side === "buy" ? `Spend ${reserve} ${quote.reserveSymbol}` : `Sell ${tokens} ${detail.symbol}`;
    if (!(await confirm(`\n${label} on ${ctx.net.label}?`, false))) {
      throw new CliError("Cancelled.");
    }
  }

  // The contract takes the token amount on both sides of the trade.
  const receipt = await executeTrade(handle, side, quote.tokenAmount, slippage);

  out.result(
    {
      side,
      token: tokenAddress,
      symbol: detail.symbol,
      tokenAmount: tokens,
      reserveAmount: reserve,
      reserveSymbol: quote.reserveSymbol,
      transactionHash: receipt.transactionHash,
      url: txUrl(ctx.net, receipt.transactionHash),
    },
    () => {
      out.info("");
      out.success(`${side === "buy" ? "Bought" : "Sold"} ${tokens} ${detail.symbol}`);
      out.kv([["tx", txUrl(ctx.net, receipt.transactionHash)]]);
    },
  );
}

async function showNativeBalance(ctx: Ctx, wallet: string): Promise<void> {
  const balance = await publicClientFor(ctx.net, ctx.rpcUrl)
    .getBalance({ address: wallet as `0x${string}` })
    .catch(() => undefined);
  if (balance === undefined) return;
  out.kv([["gas balance", `${formatEther(balance)} ${ctx.net.chain.nativeCurrency.symbol}`]]);
}
