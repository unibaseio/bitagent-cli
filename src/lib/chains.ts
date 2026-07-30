/**
 * Network registry — the single source of truth for chain IDs, endpoints,
 * contract addresses and bonding-curve reserve tokens.
 *
 * Mirrors the "Networks & Contracts" reference page of the BitAgent docs.
 */

import { defineChain, type Chain } from "viem";
import { base, baseSepolia, bsc, bscTestnet } from "viem/chains";
import { CliError } from "./errors.js";

/** X Layer Testnet as used by BitAgent (chain id 1952, not viem's 195). */
export const xLayerTestnet: Chain = defineChain({
  id: 1952,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech"] } },
  blockExplorers: {
    default: { name: "OKLink", url: "https://www.oklink.com/xlayer-test" },
  },
  testnet: true,
});

export interface ReserveToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** Bonding-curve initial minting price, in reserve token units. */
  initialPrice: number;
  /** Number of steps in the exponential curve. */
  stepCount: number;
}

export interface Contracts {
  /** ERC-8004 agent identity registry. */
  registry?: `0x${string}`;
  /** ERC-8183 agentic commerce / escrow. */
  commerce?: `0x${string}`;
  /** Evaluator (AIP/UMA) — plays the arbitrator role in settlement. */
  evaluator?: `0x${string}`;
  usdc?: `0x${string}`;
  ub?: `0x${string}`;
}

export interface Network {
  /** Canonical CLI name, e.g. `bscTestnet`. */
  name: string;
  /** Human label for output. */
  label: string;
  chainId: number;
  chain: Chain;
  testnet: boolean;
  /** AIP platform API (agents, jobs, butler, invoke). */
  aipEndpoint: string;
  /** AIP gateway (registration + job polling for private agents). */
  gatewayUrl: string;
  /** BitAgent product API (bonding curve, agent deploy, SIWE auth). */
  bitagentApi: string;
  /** BitAgent web app, used to build shareable links. */
  webBase: string;
  explorer: string;
  contracts: Contracts;
  /** Bonding-curve reserve tokens. Empty when the launchpad is unavailable. */
  reserves: Record<string, ReserveToken>;
}

const AIP_MAINNET = "https://api.aip.unibase.com";
const AIP_TESTNET = "https://api.aip.unibase.com";
const GATEWAY = "https://gateway.aip.unibase.com";

export const NETWORKS: Record<string, Network> = {
  bsc: {
    name: "bsc",
    label: "BSC Mainnet",
    chainId: 56,
    chain: bsc,
    testnet: false,
    aipEndpoint: AIP_MAINNET,
    gatewayUrl: GATEWAY,
    bitagentApi: "https://api.bitagent.io",
    webBase: "https://app.bitagent.io",
    explorer: "https://bscscan.com",
    contracts: {
      registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      commerce: "0x5b02dF1580ef4580755c68F3E43838F727541a69",
      evaluator: "0x26cAb683D3c04AB521894edA13f24E3726944472",
      usdc: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      ub: "0x40b8129B786D766267A7a118cF8C07E31CDB6Fde",
    },
    reserves: {
      UB: {
        symbol: "UB",
        address: "0x40b8129B786D766267A7a118cF8C07E31CDB6Fde",
        decimals: 18,
        initialPrice: 8e-6,
        stepCount: 100,
      },
      USD1: {
        symbol: "USD1",
        address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
        decimals: 18,
        initialPrice: 8e-7,
        stepCount: 100,
      },
      WBNB: {
        symbol: "WBNB",
        address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        decimals: 18,
        initialPrice: 8e-10,
        stepCount: 99,
      },
    },
  },

  bscTestnet: {
    name: "bscTestnet",
    label: "BSC Testnet",
    chainId: 97,
    chain: bscTestnet,
    testnet: true,
    aipEndpoint: AIP_TESTNET,
    gatewayUrl: GATEWAY,
    bitagentApi: "https://testnet-api.bitagent.io",
    webBase: "https://testnet.app.bitagent.io",
    explorer: "https://testnet.bscscan.com",
    contracts: {
      registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      commerce: "0x770a741AB71d1A75a124133098f2da11F893488C",
      evaluator: "0xd4bfA87D71f0D696F164a5511c45A50670507cF7",
      usdc: "0x64544969ed7ebf5f083679233325356ebe738930",
      ub: "0x7e624D1b87ecb3985E94dbE3Db184594e4E5DB37",
    },
    reserves: {
      UB: {
        symbol: "UB",
        address: "0x7e624D1b87ecb3985E94dbE3Db184594e4E5DB37",
        decimals: 18,
        initialPrice: 8e-6,
        stepCount: 100,
      },
      USD1: {
        symbol: "USD1",
        address: "0xB9951cd2921f72AE7f2d7C9ec2036bAD80076085",
        decimals: 18,
        initialPrice: 8e-7,
        stepCount: 100,
      },
      WBNB: {
        symbol: "WBNB",
        address: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
        decimals: 18,
        initialPrice: 8e-10,
        stepCount: 99,
      },
    },
  },

  base: {
    name: "base",
    label: "Base Mainnet",
    chainId: 8453,
    chain: base,
    testnet: false,
    aipEndpoint: AIP_MAINNET,
    gatewayUrl: GATEWAY,
    bitagentApi: "https://api.bitagent.io",
    webBase: "https://app.bitagent.io",
    explorer: "https://basescan.org",
    contracts: {
      registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      commerce: "0x5009ABB3A309115a4a682C66BAf3BC9E0329BaB7",
      evaluator: "0x4302e523D982f3b89Cfc43cE4530C012b495Ec11",
      usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ub: "0x51d9eef6d49e2782f99d43f659d4f0cb493c28cc",
    },
    reserves: {},
  },

  baseSepolia: {
    name: "baseSepolia",
    label: "Base Sepolia",
    chainId: 84532,
    chain: baseSepolia,
    testnet: true,
    aipEndpoint: AIP_TESTNET,
    gatewayUrl: GATEWAY,
    bitagentApi: "https://testnet-api.bitagent.io",
    webBase: "https://testnet.app.bitagent.io",
    explorer: "https://sepolia.basescan.org",
    contracts: {
      registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      commerce: "0xdcE48013B8D9b6812C1eb101621E588967F1F9e3",
      evaluator: "0x071a9F7c68292cEbc4dc88cf35a0de93b6831d11",
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      ub: "0x27C8b63E5aCD5298035B984AC3ea3f39d522A700",
    },
    reserves: {},
  },

  xLayerTestnet: {
    name: "xLayerTestnet",
    label: "X Layer Testnet",
    chainId: 1952,
    chain: xLayerTestnet,
    testnet: true,
    aipEndpoint: AIP_TESTNET,
    gatewayUrl: GATEWAY,
    bitagentApi: "https://testnet-api.bitagent.io",
    webBase: "https://testnet.app.bitagent.io",
    explorer: "https://www.oklink.com/xlayer-test",
    contracts: {
      registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      // X Layer settles through OKX OptimisticEscrow instead of ERC-8183.
      commerce: "0x00e5c0051cd65f261720e0bdcf459e136552dbf5",
      evaluator: "0xFc140Ff8108448c56c0f9FACd0c3434E83aE1568",
      usdc: "0xcb8bf24c6ce16ad21d707c9505421a17f2bec79d",
    },
    reserves: {},
  },
};

const BY_CHAIN_ID = new Map<number, Network>(
  Object.values(NETWORKS).map((n) => [n.chainId, n]),
);

export const networkNames = (): string[] => Object.keys(NETWORKS);

/** Resolve a network from a CLI name (`bscTestnet`) or a chain id (`97`). */
export function resolveNetwork(value: string): Network {
  const trimmed = value.trim();
  const direct = NETWORKS[trimmed];
  if (direct) return direct;

  const lower = trimmed.toLowerCase();
  const byName = Object.values(NETWORKS).find((n) => n.name.toLowerCase() === lower);
  if (byName) return byName;

  if (/^\d+$/.test(trimmed)) {
    const byId = BY_CHAIN_ID.get(Number(trimmed));
    if (byId) return byId;
  }

  throw new CliError(
    `Unknown network "${value}".`,
    `Supported: ${networkNames().join(", ")}, or any of their chain ids.`,
  );
}

/** Explorer link for a transaction hash. */
export const txUrl = (net: Network, hash: string): string =>
  `${net.explorer}/tx/${hash}`;

/** Explorer link for an address. */
export const addressUrl = (net: Network, address: string): string =>
  `${net.explorer}/address/${address}`;
