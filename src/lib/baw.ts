/**
 * The Binance Agentic Wallet CLI (`baw`), run as a child process.
 *
 * Agentic Wallets have no exportable key and sign EIP-712 typed data only —
 * never plain-text personal_sign — so anything that needs their signature
 * goes through `baw`, and sometimes through an approval in the Binance App.
 */

import { execFile } from "node:child_process";
import { CliError } from "./errors.js";

/** baw's chain id for BNB Smart Chain, where Agent IDs live. */
const BSC = "56";

interface BawEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: number | string; name?: string; message?: string };
}

/** Run `baw <args> --json` and return `data`, or throw baw's own error. */
export async function baw<T>(args: string[]): Promise<T> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("baw", [...args, "--json"], { maxBuffer: 8 << 20, timeout: 120_000 }, (error, out, err) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        reject(
          new CliError(
            "`baw` (the Binance Agentic Wallet CLI) is not installed or not on PATH.",
            "npm i -g @binance/agentic-wallet, then `baw auth signin`.",
          ),
        );
        return;
      }
      // baw exits non-zero on failure but still prints its JSON verdict.
      if (out.trim()) resolve(out);
      else reject(new CliError(`baw ${args.slice(0, 2).join(" ")} failed: ${(err || error?.message || "").trim()}`));
    });
  });

  let parsed: BawEnvelope<T>;
  try {
    parsed = JSON.parse(stdout) as BawEnvelope<T>;
  } catch {
    throw new CliError(`baw ${args.slice(0, 2).join(" ")} did not print JSON: ${stdout.slice(0, 200)}`);
  }
  if (!parsed.success) {
    const e = parsed.error ?? {};
    const code = e.code !== undefined ? ` (${e.code})` : "";
    throw new CliError(`baw ${args.slice(0, 2).join(" ")} failed: ${e.message ?? e.name ?? "unknown error"}${code}`);
  }
  return parsed.data as T;
}

/** The connected Agentic Wallet's BSC address. */
export async function bawAddress(): Promise<`0x${string}`> {
  const status = await baw<{ status?: string }>(["wallet", "status"]);
  if (status.status !== "CONNECTED") {
    throw new CliError("baw is not signed in.", "Run `baw auth signin` and confirm in the Binance App.");
  }
  const { addresses } = await baw<{ addresses: Array<{ binanceChainId: string; address: string }> }>([
    "wallet",
    "address",
  ]);
  const bsc = addresses.find((a) => a.binanceChainId === BSC);
  if (!bsc) throw new CliError("Your Agentic Wallet has no BNB Chain address.");
  return bsc.address as `0x${string}`;
}

/** Signing typed data needs Developer Mode, which only the Binance App can turn on. */
export async function requireDevMode(): Promise<void> {
  const { devMode } = await baw<{ devMode?: { enabled?: boolean; expiresAt?: number } }>(["wallet", "settings"]);
  // devMode.expiresAt is in seconds, unlike baw's other timestamps.
  const expiresMs = devMode?.expiresAt ? devMode.expiresAt * (devMode.expiresAt < 1e12 ? 1000 : 1) : Infinity;
  if (!devMode?.enabled || expiresMs < Date.now()) {
    throw new CliError(
      "Developer Mode is off or has expired on your Agentic Wallet.",
      "In the Binance App: Agentic Wallet → Settings → Developer Mode, accept the risk warning, then run this again. It stays on for 7 days.",
    );
  }
}

interface SignOrder {
  orderId: string;
  status: "COMPLETED" | "PENDING_CONFIRMATION" | "REJECTED" | "EXPIRED" | string;
  signature: string | null;
  signatureRecovery: string | null;
}

/**
 * Sign EIP-712 typed data with the Agentic Wallet: preview, execute, then — if
 * Binance wants the owner to approve it in the App — poll until they do.
 * Returns a 65-byte 0x signature.
 */
export async function bawSignTypedData(
  wallet: string,
  typedData: unknown,
  options: { onPending?: () => void; timeoutMs?: number; pollMs?: number } = {},
): Promise<`0x${string}`> {
  const message = JSON.stringify({ method: "eth_signTypedData_v4", params: [wallet, JSON.stringify(typedData)] });
  const preview = await baw<{ requestId?: string; risks?: unknown }>([
    "sign-message",
    "preview",
    "--binanceChainId",
    BSC,
    "--signType",
    "EIP712",
    "--message",
    message,
  ]);
  if (!preview.requestId) {
    throw new CliError("Binance's risk check stopped this signature request.", JSON.stringify(preview.risks ?? {}));
  }

  let order = await baw<SignOrder>(["sign-message", "execute", "--requestId", preview.requestId]);
  if (order.status === "PENDING_CONFIRMATION") {
    options.onPending?.();
    const deadline = Date.now() + (options.timeoutMs ?? 300_000);
    while (order.status === "PENDING_CONFIRMATION") {
      if (Date.now() > deadline) {
        throw new CliError(
          "Timed out waiting for the approval in the Binance App.",
          "Run the command again and approve within the time limit (--timeout).",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 3_000));
      order = await baw<SignOrder>(["sign-message", "result", "--order-id", order.orderId]);
    }
  }
  if (order.status !== "COMPLETED" || !order.signature) {
    throw new CliError(`The signature request was ${String(order.status).toLowerCase()} in the Binance App.`);
  }
  return toRsv(order.signature, order.signatureRecovery);
}

/** baw may return r||s and the recovery id separately; join them into r||s||v. */
export function toRsv(signature: string, recovery: string | null): `0x${string}` {
  const sig = signature.trim().replace(/^0x/, "");
  if (sig.length === 130) return `0x${sig}`;
  if (sig.length === 128 && recovery !== null) {
    const r = recovery.trim();
    const n = /^\d+$/.test(r) ? Number.parseInt(r, 10) : Number.parseInt(r, 16);
    const v = n < 27 ? n + 27 : n;
    return `0x${sig}${v.toString(16).padStart(2, "0")}`;
  }
  throw new CliError(`Unexpected signature from baw (${sig.length / 2} bytes).`);
}
