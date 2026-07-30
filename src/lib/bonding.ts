/**
 * Bonding-curve launchpad, wrapping `@bitagent/sdk`.
 *
 * A BitAgent project token lives on an exponential bonding curve backed by a
 * reserve token (UB / USD1 / WBNB) and graduates to a DEX. Launching is a
 * two-phase operation: register the agent record off-chain to obtain the
 * `agentHash`, then deploy the curve on-chain referencing that hash.
 */

import { formatEther, formatUnits, parseEther, parseUnits, type TransactionReceipt } from "viem";
import { bitagent, binaryReverseMint, type SdkSupportedChainIds, type Version } from "@bitagent/sdk";
import type { Network, ReserveToken } from "./chains.js";
import type { Ctx } from "./context.js";
import { CliError } from "./errors.js";
import { publicClientFor, requireAccount, walletClientFor } from "./credentials.js";
import * as out from "./output.js";

/** Bond version the BitAgent deployment runs. */
export const BOND_VERSION = "3.1.0" as Version;

/** Token supply allocated to the curve before graduation. */
export const MAX_SUPPLY_AT_CURVE = 8_500_000_000;

/** Default slippage in basis-point-like SDK units (50 = 0.5%). */
export const DEFAULT_SLIPPAGE = 50;

type TokenHelper = ReturnType<ReturnType<typeof bitagent.network>["token"]>;

export interface BondingSession {
  net: Network;
  /** Signing wallet, or "" in read-only mode. */
  wallet: `0x${string}` | "";
  /** True when the session can send transactions. */
  canSign: boolean;
  /** SDK bound to a public client, and to a wallet client when signing. */
  sdk: ReturnType<typeof bitagent.network>;
}

/** Only the BSC deployment exposes the launchpad. */
export function requireLaunchpad(net: Network): void {
  if (Object.keys(net.reserves).length === 0) {
    throw new CliError(
      `The bonding-curve launchpad is not available on ${net.label}.`,
      "Use --network bsc or --network bscTestnet for token commands.",
    );
  }
}

/**
 * Open a launchpad session. Reads (`info`, `quote`) work without a key;
 * pass `readOnly: false` for anything that sends a transaction.
 */
export function openBonding(ctx: Ctx, options: { readOnly?: boolean } = {}): BondingSession {
  requireLaunchpad(ctx.net);
  const publicClient = publicClientFor(ctx.net, ctx.rpcUrl);

  if (options.readOnly) {
    const sdk = bitagent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem client generics differ across versions
      .withPublicClient(publicClient as any)
      .network(ctx.net.chainId as SdkSupportedChainIds, BOND_VERSION);
    return { net: ctx.net, wallet: "", canSign: false, sdk };
  }

  const account = requireAccount();
  const walletClient = walletClientFor(ctx.net, ctx.rpcUrl);
  const sdk = bitagent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .withWalletClient(walletClient as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .withPublicClient(publicClient as any)
    .network(ctx.net.chainId as SdkSupportedChainIds, BOND_VERSION);

  return { net: ctx.net, wallet: account.address, canSign: true, sdk };
}

export function resolveReserve(net: Network, symbol: string): ReserveToken {
  const reserve = net.reserves[symbol.toUpperCase()];
  if (!reserve) {
    throw new CliError(
      `Unsupported reserve token "${symbol}" on ${net.label}.`,
      `Supported: ${Object.keys(net.reserves).join(", ")}`,
    );
  }
  return reserve;
}

export interface LaunchParams {
  name: string;
  symbol: string;
  reserve: ReserveToken;
  /** Off-chain agent record id, used as the curve's agentHash. */
  agentHash: string;
  buyRoyalty: number;
  sellRoyalty: number;
  creatorAllocation: number;
}

export interface LaunchResult {
  tokenAddress: `0x${string}`;
  receipt: TransactionReceipt;
}

/** Deterministic token address for a symbol + creator, known before deploy. */
export function predictTokenAddress(session: BondingSession, symbol: string): `0x${string}` {
  if (!session.wallet) throw new CliError("A signing wallet is required to derive the address.");
  return session.sdk.token(symbol.toUpperCase(), session.wallet).getTokenAddress();
}

export async function launchToken(
  session: BondingSession,
  params: LaunchParams,
): Promise<LaunchResult> {
  if (!session.canSign || !session.wallet) {
    throw new CliError("Launching a token requires a signing wallet.");
  }
  const token = session.sdk.token(params.symbol.toUpperCase(), session.wallet);
  const tokenAddress = token.getTokenAddress();

  const receipt = await token.create({
    name: params.name,
    agentHash: params.agentHash as `0x${string}`,
    reserveToken: { address: params.reserve.address, decimals: params.reserve.decimals },
    curveData: {
      curveType: "EXPONENTIAL",
      stepCount: params.reserve.stepCount,
      maxSupply: MAX_SUPPLY_AT_CURVE,
      initialMintingPrice: params.reserve.initialPrice,
      finalMintingPrice: params.reserve.initialPrice * 10,
      creatorAllocation: params.creatorAllocation,
    },
    buyRoyalty: params.buyRoyalty,
    sellRoyalty: params.sellRoyalty,
    onError: (e: unknown) => {
      throw asCliError(e, "The on-chain token creation failed.");
    },
  });

  if (!receipt || receipt.status !== "success") {
    throw new CliError("The on-chain token creation did not succeed.");
  }
  return { tokenAddress, receipt };
}

/** Handle for an existing curve token. `creator` is required by the SDK. */
export function tokenHandle(
  session: BondingSession,
  tokenAddress: string,
  creator: `0x${string}`,
): TokenHelper {
  return session.sdk.token(tokenAddress, creator);
}

export interface CurveDetail {
  name: string;
  symbol: string;
  decimals: number;
  creator: `0x${string}`;
  currentSupply: bigint;
  maxSupply: bigint;
  priceForNextMint: bigint;
  reserveSymbol: string;
  reserveDecimals: number;
  reserveBalance: bigint;
  /** Raw on-chain rate, in hundredths of a percent (100 = 1%). */
  mintRoyalty: number;
  burnRoyalty: number;
  mintRoyaltyPercent: number;
  burnRoyaltyPercent: number;
  /** Fraction of the curve sold, 0–1. */
  progress: number;
}

export async function curveDetail(token: TokenHelper): Promise<CurveDetail> {
  const detail = await token.getDetail();
  const info = detail.info;
  const progress =
    info.maxSupply > 0n ? Number((info.currentSupply * 10_000n) / info.maxSupply) / 10_000 : 0;

  return {
    name: info.name,
    symbol: info.symbol,
    decimals: info.decimals,
    creator: info.creator,
    currentSupply: info.currentSupply,
    maxSupply: info.maxSupply,
    priceForNextMint: info.priceForNextMint,
    reserveSymbol: info.reserveSymbol,
    reserveDecimals: info.reserveDecimals,
    reserveBalance: info.reserveBalance,
    mintRoyalty: detail.mintRoyalty,
    burnRoyalty: detail.burnRoyalty,
    // The contract stores rates as amount * rate / 10000.
    mintRoyaltyPercent: detail.mintRoyalty / 100,
    burnRoyaltyPercent: detail.burnRoyalty / 100,
    progress,
  };
}

export interface Quote {
  /** Token amount, in wei of the curve token (18 decimals). */
  tokenAmount: bigint;
  /** Reserve amount moved, in reserve-token units. */
  reserveAmount: bigint;
  royalty: bigint;
  reserveSymbol: string;
  reserveDecimals: number;
}

/**
 * How many tokens a given amount of reserve buys. The curve is stepwise, so
 * the SDK binary-searches the token amount whose cost matches the reserve
 * spend, then confirms it with an exact estimation.
 */
export async function quoteBuy(token: TokenHelper, reserveSpend: bigint): Promise<Quote> {
  const detail = await token.getDetail();
  const tokenAmount = binaryReverseMint({
    reserveAmount: reserveSpend,
    bondSteps: detail.steps,
    currentSupply: detail.info.currentSupply,
    maxSupply: detail.info.maxSupply,
    multiFactor: parseEther("1"),
    mintRoyalty: detail.mintRoyalty,
    slippage: 0,
  });
  if (tokenAmount <= 0n) {
    throw new CliError(
      "That reserve amount is too small to buy any tokens at the current price.",
    );
  }
  const [reserveAmount, royalty] = await token.getBuyEstimation(tokenAmount);
  return {
    tokenAmount,
    reserveAmount,
    royalty,
    reserveSymbol: detail.info.reserveSymbol,
    reserveDecimals: detail.info.reserveDecimals,
  };
}

/** How much reserve a given token amount sells for. */
export async function quoteSell(token: TokenHelper, tokenAmount: bigint): Promise<Quote> {
  const detail = await token.getDetail();
  const [reserveAmount, royalty] = await token.getSellEstimation(tokenAmount);
  return {
    tokenAmount,
    reserveAmount,
    royalty,
    reserveSymbol: detail.info.reserveSymbol,
    reserveDecimals: detail.info.reserveDecimals,
  };
}

export async function executeTrade(
  token: TokenHelper,
  side: "buy" | "sell",
  amount: bigint,
  slippage: number,
): Promise<TransactionReceipt> {
  const params = {
    amount,
    slippage,
    onError: (e: unknown) => {
      throw asCliError(e, `The ${side} transaction failed.`);
    },
    onSignatureRequest: () => out.step("Waiting for the transaction signature …"),
    onSuccess: () => undefined,
  };

  const receipt = side === "buy" ? await token.buy(params) : await token.sell(params);
  if (!receipt || receipt.status !== "success") {
    throw new CliError(`The ${side} transaction did not succeed.`);
  }
  return receipt;
}

export const formatReserve = (amount: bigint, decimals: number): string =>
  formatUnits(amount, decimals);

export const formatToken = (amount: bigint): string => formatEther(amount);

export const parseReserve = (amount: string, decimals: number): bigint =>
  parseUnits(amount, decimals);

/** Turn a viem / SDK contract error into a single readable line. */
function asCliError(e: unknown, prefix: string): CliError {
  const record = e as { shortMessage?: string; details?: string; message?: string };
  const detail = record?.shortMessage ?? record?.details ?? record?.message ?? String(e);
  return new CliError(`${prefix} ${detail}`);
}
