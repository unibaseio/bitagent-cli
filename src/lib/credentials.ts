/**
 * Credential resolution and signing.
 *
 * Two interchangeable credentials, exactly as the AIP SDKs define them:
 *
 * - **JWT** (`UNIBASE_PROXY_AUTH`) from Unibase Pay — sent as a bearer token;
 *   the platform resolves the wallet from the `sub` claim.
 * - **Private key** (`UNIBASE_WALLET_PRIVATE_KEY`) — the address is derived
 *   locally and messages are signed locally (EIP-191 / SIWE). The key is
 *   never transmitted.
 *
 * The JWT wins when both are present, matching the SDKs. Only the private-key
 * mode can sign on-chain transactions, so the launchpad commands require it.
 */

import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { SiweMessage } from "siwe";
import { CliError } from "./errors.js";
import { request } from "./http.js";
import { getSession, loadConfig, sdkCredential, setSession } from "./config.js";
import type { Network } from "./chains.js";
import * as out from "./output.js";

export type CredentialMode = "jwt" | "key" | "none";

export interface Credentials {
  mode: CredentialMode;
  /** Unibase Pay JWT, empty in key mode. */
  token: string;
  /** Wallet private key (0x-prefixed), empty in JWT mode. */
  privateKey: `0x${string}` | "";
  /** Wallet address — from the JWT `sub` claim or derived from the key. */
  wallet: string;
  /** Where the credential came from, for `whoami`. */
  source: string;
}

const normalizeKey = (value: string): `0x${string}` => {
  const hex = value.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CliError(
      "Invalid wallet private key: expected 64 hex characters.",
      "Run `bitagent configure` to store a valid key.",
    );
  }
  return `0x${hex}`;
};

/** Decode a JWT payload and return its `sub` claim. */
export function walletFromToken(token: string): string {
  try {
    const payload = token.split(".")[1];
    if (!payload) return "";
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const sub = (decoded as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : "";
  } catch {
    return "";
  }
}

/** True when the JWT is expired or expires within a minute. */
export function isTokenExpired(token: string): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp = (decoded as { exp?: unknown }).exp;
    if (typeof exp !== "number") return false;
    return exp * 1000 < Date.now() + 60_000;
  } catch {
    return true;
  }
}

/**
 * Resolve credentials: environment first, then the CLI config, then the AIP
 * SDK config. Never prompts — commands that need a credential call
 * `requireCredentials()`.
 */
export function resolveCredentials(): Credentials {
  const envToken = process.env.UNIBASE_PROXY_AUTH?.trim();
  if (envToken) return jwtCredentials(envToken, "env UNIBASE_PROXY_AUTH");

  const config = loadConfig();
  if (config.UNIBASE_PROXY_AUTH) {
    return jwtCredentials(config.UNIBASE_PROXY_AUTH, "config UNIBASE_PROXY_AUTH");
  }

  const sdkToken = sdkCredential("UNIBASE_PROXY_AUTH");
  if (sdkToken) return jwtCredentials(sdkToken, "aip-sdk config UNIBASE_PROXY_AUTH");

  const envKey = process.env.UNIBASE_WALLET_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();
  if (envKey) return keyCredentials(envKey, "env UNIBASE_WALLET_PRIVATE_KEY");

  if (config.UNIBASE_WALLET_PRIVATE_KEY) {
    return keyCredentials(config.UNIBASE_WALLET_PRIVATE_KEY, "config UNIBASE_WALLET_PRIVATE_KEY");
  }

  const sdkKey = sdkCredential("UNIBASE_WALLET_PRIVATE_KEY");
  if (sdkKey) return keyCredentials(sdkKey, "aip-sdk config UNIBASE_WALLET_PRIVATE_KEY");

  return { mode: "none", token: "", privateKey: "", wallet: "", source: "" };
}

function jwtCredentials(token: string, source: string): Credentials {
  return { mode: "jwt", token, privateKey: "", wallet: walletFromToken(token), source };
}

function keyCredentials(key: string, source: string): Credentials {
  const privateKey = normalizeKey(key);
  return {
    mode: "key",
    token: "",
    privateKey,
    wallet: privateKeyToAccount(privateKey).address,
    source,
  };
}

export function requireCredentials(): Credentials {
  const credentials = resolveCredentials();
  if (credentials.mode === "none") {
    throw new CliError(
      "No credential found.",
      "Run `bitagent configure`, or set UNIBASE_PROXY_AUTH / UNIBASE_WALLET_PRIVATE_KEY.",
    );
  }
  if (credentials.mode === "jwt" && isTokenExpired(credentials.token)) {
    throw new CliError(
      "Your Unibase Pay authorization token has expired.",
      "Run `bitagent configure` to authorize again.",
    );
  }
  return credentials;
}

/** For on-chain work: only the private-key mode can sign transactions. */
export function requireAccount(): PrivateKeyAccount {
  const credentials = requireCredentials();
  if (credentials.mode !== "key") {
    throw new CliError(
      "This command signs on-chain transactions and needs a wallet private key.",
      "Run `bitagent configure` and choose the private-key method, or set UNIBASE_WALLET_PRIVATE_KEY.",
    );
  }
  return privateKeyToAccount(credentials.privateKey as `0x${string}`);
}

export function publicClientFor(net: Network, rpcUrl?: string): PublicClient {
  return createPublicClient({ chain: net.chain, transport: http(rpcUrl) }) as PublicClient;
}

export function walletClientFor(net: Network, rpcUrl?: string): WalletClient {
  return createWalletClient({
    account: requireAccount(),
    chain: net.chain,
    transport: http(rpcUrl),
  });
}

/** EIP-191 personal_sign with the configured key. */
export async function signMessage(message: string): Promise<string> {
  return await requireAccount().signMessage({ message });
}

/**
 * Auth material for AIP endpoints that accept either a bearer token or a
 * wallet signature over a fixed message.
 */
export interface AipAuth {
  token?: string;
  userId?: string;
  signature?: string;
  message?: string;
}

export async function aipAuth(message: string): Promise<AipAuth> {
  const credentials = requireCredentials();
  if (credentials.mode === "jwt") return { token: credentials.token };
  return {
    userId: credentials.wallet,
    signature: await signMessage(message),
    message,
  };
}

interface NonceData {
  nonce?: string;
  uri?: string;
  domain?: string;
  message?: string;
}

/** The API wraps the payload in `data`, but tolerate a flat body too. */
interface NonceResponse extends NonceData {
  data?: NonceData;
}

interface AuthResponse {
  token?: string;
  data?: { token?: string };
}

/**
 * Bearer token for the BitAgent product API (`api.bitagent.io`), obtained by
 * signing a SIWE message. Cached per chain until it expires.
 */
export async function bitagentToken(net: Network, apiBase: string): Promise<string> {
  const account = requireAccount();

  const cached = getSession(net.chainId);
  if (cached && cached.wallet.toLowerCase() === account.address.toLowerCase()) {
    return cached.token;
  }

  out.step(`Signing in to ${apiBase} as ${account.address} …`);

  const nonceResponse = await request<NonceResponse>(apiBase, "/nonce", {
    query: { account: account.address },
  });
  const nonceData = nonceResponse.data ?? nonceResponse;
  const nonce = nonceData.nonce;
  if (!nonce) throw new CliError(`No nonce in the response from ${apiBase}/nonce`);

  const expirationTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const siwe = new SiweMessage({
    domain: nonceData.domain ?? "bitagent.io",
    address: account.address,
    statement: nonceData.message ?? "Login to Bitagent",
    uri: nonceData.uri ?? "https://bitagent.io",
    version: "1",
    chainId: net.chainId,
    nonce,
    expirationTime: expirationTime.toISOString(),
  });
  const prepared = siwe.prepareMessage();
  const signature = await account.signMessage({ message: prepared });

  const auth = await request<AuthResponse>(apiBase, "/auth", {
    method: "POST",
    body: {
      chain_id: net.chainId,
      account: account.address,
      message: prepared,
      // The BitAgent API expects the signature without the 0x prefix.
      signature: signature.replace(/^0x/, ""),
    },
  });

  const token = auth.token ?? auth.data?.token;
  if (!token) throw new CliError(`No token in the response from ${apiBase}/auth`);

  setSession(net.chainId, {
    token,
    wallet: account.address,
    expiresAt: expirationTime.getTime(),
  });
  return token;
}
