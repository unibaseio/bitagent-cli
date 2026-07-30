#!/usr/bin/env node

// bin/bitagent.ts
import "dotenv/config";
import { Command } from "commander";
import { createRequire } from "node:module";

// src/commands/agent.ts
import { spawn } from "node:child_process";

// src/lib/errors.ts
var CliError = class extends Error {
  constructor(message, hint2, exitCode = 1) {
    super(message);
    this.hint = hint2;
    this.exitCode = exitCode;
    this.name = "CliError";
  }
};
var ApiError = class extends CliError {
  constructor(status, detail, url, hint2) {
    super(`HTTP ${status} from ${url}: ${detail}`, hint2);
    this.status = status;
    this.detail = detail;
    this.url = url;
    this.name = "ApiError";
  }
};
var isCliError = (e) => e instanceof CliError;

// src/lib/http.ts
function buildUrl(base2, path2, query) {
  const url = new URL(base2.replace(/\/+$/, "") + (path2.startsWith("/") ? path2 : `/${path2}`));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === void 0 || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function request(base2, path2, options = {}) {
  const url = buildUrl(base2, path2, options.query);
  const method = options.method ?? "GET";
  const headers = {
    Accept: "application/json",
    ...authHeaders(options.token),
    ...options.headers
  };
  if (options.body !== void 0) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === void 0 ? void 0 : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 6e4)
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new CliError(
      `Cannot reach ${url}: ${reason}`,
      "Check your connection, or override the endpoint with --aip-endpoint / --bitagent-api."
    );
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    if (options.allowStatus?.includes(response.status)) return void 0;
    throw new ApiError(response.status, extractDetail(text) || response.statusText, url);
  }
  if (!text) return void 0;
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`Unexpected non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}
async function* streamSse(base2, path2, options = {}) {
  const url = buildUrl(base2, path2, options.query);
  const response = await fetch(url, {
    method: options.method ?? "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...authHeaders(options.token),
      ...options.headers
    },
    body: options.body === void 0 ? void 0 : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 6e5)
  }).catch((e) => {
    throw new CliError(`Cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new ApiError(response.status, extractDetail(text) || response.statusText, url);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        yield JSON.parse(raw);
      } catch {
        yield { raw };
      }
    }
  }
}
function extractDetail(text) {
  if (!text) return "";
  try {
    const body = JSON.parse(text);
    if (typeof body === "string") return body;
    if (body && typeof body === "object") {
      const record = body;
      const detail = record.detail ?? record.message ?? record.error;
      if (typeof detail === "string") return detail;
      if (Array.isArray(detail)) {
        return detail.map((item) => {
          const entry = item;
          const field = (entry.loc ?? []).slice(1).join(".") || "body";
          return entry.msg ? `${field}: ${entry.msg}` : JSON.stringify(item);
        }).join("; ");
      }
      if (detail) return JSON.stringify(detail);
    }
  } catch {
  }
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

// src/lib/api/aip.ts
var AipClient = class _AipClient {
  constructor(base2, chainId) {
    this.base = base2;
    this.chainId = chainId;
  }
  static from(ctx) {
    return new _AipClient(ctx.aip, ctx.net.chainId);
  }
  get(path2, query, token) {
    return request(this.base, path2, { query: { chain_id: this.chainId, ...query }, token });
  }
  post(path2, body, query, token) {
    return request(this.base, path2, {
      method: "POST",
      body: body ?? {},
      query: { chain_id: this.chainId, ...query },
      token
    });
  }
  // ------------------------------------------------------------ discovery
  listAgents(query = {}) {
    return this.get("/agents", { page: 1, pageSize: 50, ...query });
  }
  getAgent(agentId) {
    return this.get(`/agents/${encodeURIComponent(agentId)}`);
  }
  getAgentByHandle(handle) {
    return this.get(`/agents/handle/${encodeURIComponent(handle)}`);
  }
  listServices(query = {}) {
    return this.get("/services", { page: 1, pageSize: 50, ...query });
  }
  getService(serviceId) {
    return this.get(`/services/${encodeURIComponent(serviceId)}`);
  }
  listTasks(query = {}) {
    return this.get("/tasks", { limit: 20, offset: 0, ...query });
  }
  getTask(taskId) {
    return this.get(`/tasks/${encodeURIComponent(taskId)}`);
  }
  /** Rankings are platform-wide: the endpoint ignores `chain_id`. */
  rankings(query = {}) {
    return request(this.base, "/rankings", {
      query: { metric: "revenue", limit: 10, ...query }
    });
  }
  stats() {
    return this.get("/stats/summary");
  }
  // ------------------------------------------------------------ my account
  myAgents(token) {
    return this.get("/my-agents", {}, token);
  }
  myJobs(token, role = "any") {
    return this.get("/my-jobs", { role }, token);
  }
  // ------------------------------------------------------------ registration
  /** POST /agents/register — accepts a bearer token or an EIP-191 signature. */
  registerAgent(payload, token) {
    return request(this.base, "/agents/register", {
      method: "POST",
      body: payload,
      token
    });
  }
  // ------------------------------------------------------------ butler
  async butlerStatus(token, wallet) {
    return await request(this.base, "/butler", {
      query: { chain_id: this.chainId, wallet_address: wallet },
      token,
      allowStatus: [404]
    });
  }
  activateButler(body, token) {
    return request(this.base, "/butler/activate", { method: "POST", body, token });
  }
  butlerStats(token) {
    return this.get("/butler/stats", {}, token);
  }
  // ------------------------------------------------------------ invoke
  invoke(agentId, body, token) {
    const path2 = agentId ? `/invoke/${encodeURIComponent(agentId)}` : "/invoke";
    return request(this.base, path2, {
      method: "POST",
      body,
      token,
      timeoutMs: 6e5
    });
  }
  invokeStream(agentId, body, token) {
    const path2 = agentId ? `/invoke/${encodeURIComponent(agentId)}/stream` : "/invoke/stream";
    return streamSse(this.base, path2, { method: "POST", body, token });
  }
  conversations(token) {
    return this.get("/conversations", {}, token);
  }
  conversationHistory(conversationId, token) {
    return this.get(`/conversations/${encodeURIComponent(conversationId)}/history`, {}, token);
  }
  // ------------------------------------------------------------ jobs (8183)
  createJob(clientId, body, token) {
    return request(this.base, "/v1/jobs", {
      method: "POST",
      body: { expires_in: 86400, metadata: {}, ...body },
      query: { client_id: clientId, chain_id: this.chainId },
      token
    });
  }
  getJob(jobId2, token) {
    return this.get(`/v1/jobs/${encodeURIComponent(jobId2)}`, {}, token);
  }
  acceptJob(jobId2, providerId, token) {
    return this.post(
      `/v1/jobs/${encodeURIComponent(jobId2)}/accept`,
      void 0,
      { provider_id: providerId },
      token
    );
  }
  submitJob(jobId2, body, token) {
    return this.post(`/v1/jobs/${encodeURIComponent(jobId2)}/submit`, body, {}, token);
  }
  completeJob(jobId2, body, token) {
    return this.post(`/v1/jobs/${encodeURIComponent(jobId2)}/complete`, body, {}, token);
  }
  rejectJob(jobId2, rejectorId, reason, token) {
    return this.post(
      `/v1/jobs/${encodeURIComponent(jobId2)}/reject`,
      { reason },
      { rejector_id: rejectorId },
      token
    );
  }
};

// src/lib/api/gateway.ts
var GatewayClient = class _GatewayClient {
  constructor(base2) {
    this.base = base2;
  }
  static from(ctx) {
    return new _GatewayClient(ctx.gateway);
  }
  health() {
    return request(this.base, "/gateway/health", { timeoutMs: 15e3 });
  }
  /**
   * Long-poll for one assignment. Resolves to undefined when the queue is
   * empty for the poll window.
   */
  async pollJob(agent, timeoutSeconds = 5) {
    const job = await request(this.base, "/gateway/jobs/poll", {
      query: { agent, timeout: timeoutSeconds.toFixed(1) },
      timeoutMs: (timeoutSeconds + 25) * 1e3,
      allowStatus: [204, 404, 408, 502, 503, 504]
    });
    if (!job || !job.job_id && !job.task_id) return void 0;
    return job;
  }
  completeJob(body) {
    return request(this.base, "/gateway/jobs/complete", { method: "POST", body });
  }
};

// src/lib/config.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function configDir() {
  const override = process.env.BITAGENT_CONFIG_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".config", "bitagent");
}
function configFile() {
  return path.join(configDir(), "config.json");
}
function sdkConfigFile() {
  return path.join(os.homedir(), ".config", "unibase-aip-sdk", "config.json");
}
function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function loadConfig() {
  return readJson(configFile());
}
function saveConfig(config) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 384 });
  fs.chmodSync(file, 384);
}
function updateConfig(mutate) {
  const config = loadConfig();
  mutate(config);
  saveConfig(config);
  return config;
}
function sdkCredential(key) {
  const value = readJson(sdkConfigFile())[key];
  return typeof value === "string" ? value : "";
}
function getSession(chainId) {
  const session = loadConfig().sessions?.[String(chainId)];
  if (!session?.token) return void 0;
  if (session.expiresAt && session.expiresAt < Date.now() + 6e4) return void 0;
  return session;
}
function setSession(chainId, session) {
  updateConfig((config) => {
    config.sessions ??= {};
    config.sessions[String(chainId)] = session;
  });
}
function clearSessions() {
  updateConfig((config) => {
    delete config.sessions;
  });
}
function setButler(chainId, agentId) {
  updateConfig((config) => {
    config.butler ??= {};
    config.butler[String(chainId)] = agentId;
  });
}
function getConversation(chainId) {
  return loadConfig().conversation?.[String(chainId)];
}
function setConversation(chainId, conversationId) {
  updateConfig((config) => {
    config.conversation ??= {};
    config.conversation[String(chainId)] = conversationId;
  });
}

// src/lib/chains.ts
import { defineChain } from "viem";
import { base, baseSepolia, bsc, bscTestnet } from "viem/chains";
var xLayerTestnet = defineChain({
  id: 1952,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech"] } },
  blockExplorers: {
    default: { name: "OKLink", url: "https://www.oklink.com/xlayer-test" }
  },
  testnet: true
});
var AIP_MAINNET = "https://api.aip.unibase.com";
var AIP_TESTNET = "https://api.aip.unibase.com";
var GATEWAY = "https://gateway.aip.unibase.com";
var NETWORKS = {
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
      ub: "0x40b8129B786D766267A7a118cF8C07E31CDB6Fde"
    },
    reserves: {
      UB: {
        symbol: "UB",
        address: "0x40b8129B786D766267A7a118cF8C07E31CDB6Fde",
        decimals: 18,
        initialPrice: 8e-6,
        stepCount: 100
      },
      USD1: {
        symbol: "USD1",
        address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
        decimals: 18,
        initialPrice: 8e-7,
        stepCount: 100
      },
      WBNB: {
        symbol: "WBNB",
        address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        decimals: 18,
        initialPrice: 8e-10,
        stepCount: 99
      }
    }
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
      ub: "0x7e624D1b87ecb3985E94dbE3Db184594e4E5DB37"
    },
    reserves: {
      UB: {
        symbol: "UB",
        address: "0x7e624D1b87ecb3985E94dbE3Db184594e4E5DB37",
        decimals: 18,
        initialPrice: 8e-6,
        stepCount: 100
      },
      USD1: {
        symbol: "USD1",
        address: "0xB9951cd2921f72AE7f2d7C9ec2036bAD80076085",
        decimals: 18,
        initialPrice: 8e-7,
        stepCount: 100
      },
      WBNB: {
        symbol: "WBNB",
        address: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
        decimals: 18,
        initialPrice: 8e-10,
        stepCount: 99
      }
    }
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
      ub: "0x51d9eef6d49e2782f99d43f659d4f0cb493c28cc"
    },
    reserves: {}
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
      ub: "0x27C8b63E5aCD5298035B984AC3ea3f39d522A700"
    },
    reserves: {}
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
      usdc: "0xcb8bf24c6ce16ad21d707c9505421a17f2bec79d"
    },
    reserves: {}
  }
};
var BY_CHAIN_ID = new Map(
  Object.values(NETWORKS).map((n) => [n.chainId, n])
);
var networkNames = () => Object.keys(NETWORKS);
function resolveNetwork(value) {
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
    `Supported: ${networkNames().join(", ")}, or any of their chain ids.`
  );
}
var txUrl = (net, hash) => `${net.explorer}/tx/${hash}`;
var addressUrl = (net, address) => `${net.explorer}/address/${address}`;

// src/lib/output.ts
import pc from "picocolors";
var jsonMode = false;
var setJsonMode = (enabled) => {
  jsonMode = enabled;
};
var isJsonMode = () => jsonMode;
var stderr = (line) => {
  process.stderr.write(line + "\n");
};
var info = (message) => stderr(message);
var step = (message) => stderr(pc.dim("\u203A ") + message);
var success = (message) => stderr(pc.green("\u2714 ") + message);
var warn = (message) => stderr(pc.yellow("! ") + message);
var fail = (message) => stderr(pc.red("\u2716 ") + message);
var hint = (message) => stderr(pc.dim("  " + message));
function result(data, render) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, jsonReplacer, 2) + "\n");
    return;
  }
  render();
}
function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
var heading = (text) => {
  process.stdout.write("\n" + pc.bold(text) + "\n");
};
function kv(pairs, indent = "  ") {
  const shown = pairs.filter(([, v]) => v !== void 0 && v !== null && v !== "");
  const width = shown.reduce((max, [k]) => Math.max(max, k.length), 0);
  for (const [key, value] of shown) {
    process.stdout.write(`${indent}${pc.dim((key + ":").padEnd(width + 1))} ${format(value)}
`);
  }
}
function table(rows, columns) {
  if (rows.length === 0) {
    process.stdout.write(pc.dim("  (no results)\n"));
    return;
  }
  const cells = rows.map(
    (row) => columns.map((col) => truncate(col.value(row) ?? "", col.max ?? 0))
  );
  const widths = columns.map(
    (col, i) => Math.max(col.header.length, ...cells.map((row) => row[i]?.length ?? 0))
  );
  const line = (values, dim) => {
    const text = values.map((value, i) => {
      const width = widths[i] ?? value.length;
      return columns[i]?.align === "right" ? value.padStart(width) : value.padEnd(width);
    }).join("  ").trimEnd();
    process.stdout.write((dim ? pc.dim(text) : text) + "\n");
  };
  line(
    columns.map((c) => c.header.toUpperCase()),
    true
  );
  for (const row of cells) line(row, false);
}
function truncate(value, max) {
  const flat = value.replace(/\s+/g, " ").trim();
  if (max <= 0 || flat.length <= max) return flat;
  return flat.slice(0, Math.max(1, max - 1)) + "\u2026";
}
function format(value) {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(6);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
var link = (url) => pc.cyan(pc.underline(url));

// src/lib/context.ts
var DEFAULT_NETWORK = "bscTestnet";
function resolveNetworkOption(explicit) {
  const value = explicit || process.env.BITAGENT_NETWORK || loadConfig().network || DEFAULT_NETWORK;
  return resolveNetwork(value);
}
function resolveContext(command) {
  const options = command.optsWithGlobals();
  const net = resolveNetworkOption(options.network);
  setJsonMode(Boolean(options.json));
  return {
    net,
    json: Boolean(options.json),
    aip: options.aipEndpoint || process.env.AIP_ENDPOINT || net.aipEndpoint,
    gateway: options.gatewayUrl || process.env.GATEWAY_URL || net.gatewayUrl,
    bitagent: options.bitagentApi || process.env.BITAGENT_API || net.bitagentApi,
    pay: process.env.UNIBASE_PAY_URL || "https://api.pay.unibase.com",
    rpcUrl: options.rpcUrl || process.env.BITAGENT_RPC_URL
  };
}
var networkChoicesHelp = () => Object.values(NETWORKS).map((n) => `${n.name} (${n.chainId})`).join(", ");

// src/lib/agentCard.ts
var AGENT_CARD_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
var defaultSupportedTrust = () => [
  "reputation",
  "crypto-economic",
  "tee-attestation"
];
var defaultTrustModels = () => [
  "feedback",
  "inference-validation",
  "tee-attestation"
];
var handleOrName = (config) => config.handle || config.name.toLowerCase().replaceAll(" ", "_");
var price = (config) => config.costModel?.baseCallFee || 1e-3;
function skillToMap(skill) {
  const field = (item) => ({
    name: item.name,
    field_type: item.fieldType,
    description: item.description
  });
  return {
    name: skill.name,
    description: skill.description,
    inputs: (skill.inputs ?? []).map(field),
    outputs: (skill.outputs ?? []).map(field)
  };
}
function costModelToMap(model) {
  const map = {};
  if (model.baseCallFee !== void 0) map.base_call_fee = model.baseCallFee;
  if (model.perAgentCallFee !== void 0) map.per_agent_call_fee = model.perAgentCallFee;
  if (model.perUseFee !== void 0) map.per_use_fee = model.perUseFee;
  if (model.perWriteFee !== void 0) map.per_write_fee = model.perWriteFee;
  if (model.perTokenFee !== void 0) map.per_token_fee = model.perTokenFee;
  map.custom_fees = model.customFees ?? {};
  return map;
}
function toAgentCard(config) {
  const handle = handleOrName(config);
  const url = config.endpointUrl || `http://localhost:8000/agents/${handle}/`;
  const a2aEndpoint = url.replace(/\/+$/, "");
  const skills = config.skills ?? [];
  return {
    type: AGENT_CARD_TYPE,
    name: config.name,
    description: config.description ?? "",
    url,
    x402support: true,
    active: true,
    version: "1.0.0",
    services: [
      { name: "A2A", endpoint: a2aEndpoint, a2aSkills: skills.map((s) => s.name) },
      { name: "web", endpoint: url }
    ],
    registrations: null,
    supportedTrust: defaultSupportedTrust(),
    metadata: config.metadata,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    authentication: { schemes: ["Bearer"] },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json"],
    skills: skills.map((skill) => ({
      id: `${handle}_${skill.name}`,
      name: skill.name,
      description: skill.description,
      ...config.capabilities?.length ? { tags: config.capabilities } : {},
      inputModes: ["text/plain"],
      outputModes: ["application/json"]
    })),
    jobOfferings: config.jobOfferings ?? null,
    jobResources: config.jobResources ?? null,
    trustModels: defaultTrustModels(),
    provider: { organization: "BitAgent", url: "https://bitagent.io" }
  };
}
function toRegistrationMap(config) {
  const skills = config.skills ?? [];
  const payload = {
    handle: handleOrName(config),
    card: toAgentCard(config),
    skills: skills.map(skillToMap),
    tasks: skills.map((skill) => ({ name: skill.name, description: skill.description })),
    cost_model: costModelToMap(config.costModel ?? {}),
    price: { amount: price(config), currency: config.currency ?? "USD" },
    jobOfferings: config.jobOfferings ?? [],
    jobResources: config.jobResources ?? [],
    metadata: config.metadata ?? {},
    endpoint_url: config.endpointUrl ?? "",
    chain_id: config.chainId ?? 97
  };
  if (config.signature) {
    payload.signature = config.signature;
    if (config.message) payload.message = config.message;
  }
  return payload;
}
var REGISTER_MESSAGE = "Create an AIP agent";

// src/lib/credentials.ts
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";
var normalizeKey = (value) => {
  const hex = value.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CliError(
      "Invalid wallet private key: expected 64 hex characters.",
      "Run `bitagent configure` to store a valid key."
    );
  }
  return `0x${hex}`;
};
function walletFromToken(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return "";
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const sub = decoded.sub;
    return typeof sub === "string" ? sub : "";
  } catch {
    return "";
  }
}
function isTokenExpired(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp = decoded.exp;
    if (typeof exp !== "number") return false;
    return exp * 1e3 < Date.now() + 6e4;
  } catch {
    return true;
  }
}
function resolveCredentials() {
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
function jwtCredentials(token, source) {
  return { mode: "jwt", token, privateKey: "", wallet: walletFromToken(token), source };
}
function keyCredentials(key, source) {
  const privateKey = normalizeKey(key);
  return {
    mode: "key",
    token: "",
    privateKey,
    wallet: privateKeyToAccount(privateKey).address,
    source
  };
}
function requireCredentials() {
  const credentials = resolveCredentials();
  if (credentials.mode === "none") {
    throw new CliError(
      "No credential found.",
      "Run `bitagent configure`, or set UNIBASE_PROXY_AUTH / UNIBASE_WALLET_PRIVATE_KEY."
    );
  }
  if (credentials.mode === "jwt" && isTokenExpired(credentials.token)) {
    throw new CliError(
      "Your Unibase Pay authorization token has expired.",
      "Run `bitagent configure` to authorize again."
    );
  }
  return credentials;
}
function requireAccount() {
  const credentials = requireCredentials();
  if (credentials.mode !== "key") {
    throw new CliError(
      "This command signs on-chain transactions and needs a wallet private key.",
      "Run `bitagent configure` and choose the private-key method, or set UNIBASE_WALLET_PRIVATE_KEY."
    );
  }
  return privateKeyToAccount(credentials.privateKey);
}
function publicClientFor(net, rpcUrl) {
  return createPublicClient({ chain: net.chain, transport: http(rpcUrl) });
}
function walletClientFor(net, rpcUrl) {
  return createWalletClient({
    account: requireAccount(),
    chain: net.chain,
    transport: http(rpcUrl)
  });
}
async function signMessage(message) {
  return await requireAccount().signMessage({ message });
}
async function aipAuth(message) {
  const credentials = requireCredentials();
  if (credentials.mode === "jwt") return { token: credentials.token };
  return {
    userId: credentials.wallet,
    signature: await signMessage(message),
    message
  };
}
async function bitagentToken(net, apiBase) {
  const account = requireAccount();
  const cached = getSession(net.chainId);
  if (cached && cached.wallet.toLowerCase() === account.address.toLowerCase()) {
    return cached.token;
  }
  step(`Signing in to ${apiBase} as ${account.address} \u2026`);
  const nonceResponse = await request(apiBase, "/nonce", {
    query: { account: account.address }
  });
  const nonceData = nonceResponse.data ?? nonceResponse;
  const nonce = nonceData.nonce;
  if (!nonce) throw new CliError(`No nonce in the response from ${apiBase}/nonce`);
  const expirationTime = new Date(Date.now() + 24 * 60 * 60 * 1e3);
  const siwe = new SiweMessage({
    domain: nonceData.domain ?? "bitagent.io",
    address: account.address,
    statement: nonceData.message ?? "Login to Bitagent",
    uri: nonceData.uri ?? "https://bitagent.io",
    version: "1",
    chainId: net.chainId,
    nonce,
    expirationTime: expirationTime.toISOString()
  });
  const prepared = siwe.prepareMessage();
  const signature = await account.signMessage({ message: prepared });
  const auth = await request(apiBase, "/auth", {
    method: "POST",
    body: {
      chain_id: net.chainId,
      account: account.address,
      message: prepared,
      // The BitAgent API expects the signature without the 0x prefix.
      signature: signature.replace(/^0x/, "")
    }
  });
  const token = auth.token ?? auth.data?.token;
  if (!token) throw new CliError(`No token in the response from ${apiBase}/auth`);
  setSession(net.chainId, {
    token,
    wallet: account.address,
    expiresAt: expirationTime.getTime()
  });
  return token;
}

// src/commands/agent.ts
var POLL_BACKOFF_MS = 2e3;
function registerAgentCommands(program2) {
  const agent = program2.command("agent").description("Discover, register and run AIP agents");
  agent.command("list").description("List agents registered on the marketplace").option("--limit <n>", "Maximum rows", "30").option("--handle <text>", "Only agents whose handle contains this text").option("--no-health", "Skip the gateway health lookup (faster)").action(async function() {
    const ctx = resolveContext(this);
    const options = this.opts();
    const page = await AipClient.from(ctx).listAgents({
      pageSize: Math.max(Number(options.limit), 100),
      include_health: options.health
    });
    let agents = page.data ?? [];
    if (options.handle) {
      const needle = options.handle.toLowerCase();
      agents = agents.filter((a) => (a.handle ?? "").toLowerCase().includes(needle));
    }
    agents = agents.slice(0, Number(options.limit));
    result({ ...page, data: agents }, () => {
      heading(`Agents on ${ctx.net.label} (${agents.length} of ${page.total ?? agents.length})`);
      table(agents, [
        { header: "handle", value: (a) => a.handle ?? "\u2014", max: 30 },
        { header: "name", value: (a) => a.display_name ?? a.card?.name ?? "\u2014", max: 30 },
        {
          header: "price",
          value: (a) => a.price?.amount ? `${a.price.amount} ${a.price.symbol ?? ""}`.trim() : "free",
          align: "right"
        },
        { header: "health", value: (a) => a.health_status ?? "\u2014" },
        { header: "agent id", value: (a) => a.agent_id, max: 46 }
      ]);
    });
  });
  agent.command("show <idOrHandle>").description("Show one agent in full").action(async function(idOrHandle) {
    const ctx = resolveContext(this);
    const found = await fetchAgent(ctx, idOrHandle);
    result(found, () => renderAgent(found));
  });
  agent.command("mine").description("List the agents owned by the authenticated wallet").action(async function() {
    const ctx = resolveContext(this);
    const credentials = requireCredentials();
    if (credentials.mode !== "jwt") {
      throw new CliError(
        "`agent mine` needs a Unibase Pay JWT.",
        "Run `bitagent configure` and choose browser authorization."
      );
    }
    const agents = await AipClient.from(ctx).myAgents(credentials.token);
    result(agents, () => {
      heading(`Your agents (${agents.length})`);
      table(agents, [
        { header: "handle", value: (a) => a.handle ?? "\u2014", max: 30 },
        { header: "name", value: (a) => a.display_name ?? "\u2014", max: 30 },
        { header: "chain", value: (a) => String(a.chain_id ?? ctx.net.chainId), align: "right" },
        { header: "agent id", value: (a) => a.agent_id, max: 46 }
      ]);
    });
  });
  agent.command("register").description("Register an agent on AIP (ERC-8004) so it is discoverable and hireable").requiredOption("--name <name>", "Display name").option("--handle <handle>", "Unique marketplace handle (defaults to a slug of the name)").option("--description <text>", "What the agent does", "").option("--url <url>", "Public A2A endpoint. Omit for gateway-polling (private) agents").option("--price <amount>", "Base call fee, in USD", "0.001").option("--currency <code>", "Price currency", "USD").option(
    "--skill <name:description...>",
    "Repeatable. A capability listed on the agent card",
    collect,
    []
  ).option("--tag <tag...>", "Repeatable. Capability tags used for discovery", collect, []).option(
    "--offering <name:price[:description]...>",
    "Repeatable. A hireable job offering",
    collect,
    []
  ).option("--metadata <json>", "Extra metadata object, as JSON").option("--dry-run", "Print the registration payload without sending it").action(async function() {
    const ctx = resolveContext(this);
    const options = this.opts();
    const config = buildAgentConfig(ctx, options);
    const auth = await aipAuth(REGISTER_MESSAGE);
    if (auth.signature) {
      config.signature = auth.signature;
      config.message = auth.message;
    }
    const payload = toRegistrationMap(config);
    if (auth.userId && !auth.token) payload.user_id = auth.userId;
    if (options.dryRun) {
      result(payload, () => {
        heading("Registration payload (dry run)");
        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      });
      return;
    }
    step(`Registering ${config.handle ?? config.name} on ${ctx.net.label} \u2026`);
    const response = await AipClient.from(ctx).registerAgent(payload, auth.token);
    const agentId = String(response.agent_id ?? "");
    if (agentId) {
      updateConfig((saved) => {
        saved.agentId = agentId;
        saved.agentWallet = requireCredentials().wallet;
      });
    }
    result(response, () => {
      success(`Registered ${config.handle ?? config.name}`);
      kv([
        ["agent id", agentId || "(not returned)"],
        ["handle", config.handle],
        ["endpoint", config.endpointUrl || "gateway polling"],
        ["price", `${config.costModel?.baseCallFee} ${config.currency}`],
        ["offerings", (config.jobOfferings ?? []).length]
      ]);
      hint('Start taking work with `bitagent agent serve --exec "<your command>"`.');
    });
  });
  agent.command("serve").description("Take jobs from the AIP gateway queue and run a local command for each").requiredOption(
    "--exec <command>",
    "Shell command to run per job. Job input arrives on stdin; stdout is the deliverable"
  ).option("--agent-id <id>", "Poll as this agent id (defaults to the last registered one)").option("--handle <handle>", "Poll as this handle when no agent id is known").option("--timeout <seconds>", "Per-job command timeout", "300").option("--poll-timeout <seconds>", "Long-poll window", "5").option("--once", "Handle a single job and exit").action(async function() {
    const ctx = resolveContext(this);
    const options = this.opts();
    const pollAs = options.agentId ?? loadAgentId() ?? options.handle;
    if (!pollAs) {
      throw new CliError(
        "No agent id to poll as.",
        "Run `bitagent agent register \u2026` first, or pass --agent-id / --handle."
      );
    }
    const gateway = GatewayClient.from(ctx);
    const health = await gateway.health().catch(() => void 0);
    info("");
    success(`Serving as ${pollAs}`);
    kv([
      ["gateway", ctx.gateway],
      ["command", options.exec],
      ["job timeout", `${options.timeout}s`],
      ["gateway status", health?.status ?? "unknown"]
    ]);
    info("");
    hint("Press Ctrl-C to stop.");
    const stop = { value: false };
    const onSignal = () => {
      stop.value = true;
      info("");
      step("Stopping after the current job \u2026");
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    let handled = 0;
    while (!stop.value) {
      const job = await gateway.pollJob(pollAs, Number(options.pollTimeout)).catch((e) => {
        warn(`Poll failed: ${e instanceof Error ? e.message : String(e)}`);
        return void 0;
      });
      if (!job) {
        await sleep(POLL_BACKOFF_MS);
        continue;
      }
      handled += 1;
      await handleJob(gateway, job, options.exec, Number(options.timeout) * 1e3);
      if (options.once) break;
    }
    info("");
    success(`Stopped after ${handled} job${handled === 1 ? "" : "s"}.`);
  });
}
function collect(value, previous) {
  return [...previous, value];
}
function loadAgentId() {
  return loadConfig().agentId;
}
function buildAgentConfig(ctx, options) {
  const skills = options.skill.map((entry) => {
    const [name, ...rest] = entry.split(":");
    if (!name) throw new CliError(`Invalid --skill "${entry}". Use name:description.`);
    return { name: name.trim(), description: rest.join(":").trim() || name.trim() };
  });
  const jobOfferings = options.offering.map((entry, index) => {
    const parts = entry.split(":");
    const name = parts[0]?.trim();
    const price3 = Number(parts[1]);
    if (!name || !Number.isFinite(price3)) {
      throw new CliError(
        `Invalid --offering "${entry}".`,
        'Use name:price[:description], e.g. --offering "audit:10:Solidity audit".'
      );
    }
    return {
      id: index + 1,
      name,
      description: parts.slice(2).join(":").trim() || name,
      price: price3,
      priceV2: ctx.net.contracts.usdc ? { amount: price3, currency: ctx.net.contracts.usdc, symbol: "USDC" } : void 0,
      active: true,
      requiredFunds: true
    };
  });
  let metadata;
  if (options.metadata) {
    try {
      metadata = JSON.parse(options.metadata);
    } catch {
      throw new CliError("--metadata must be valid JSON.");
    }
  }
  const price2 = Number(options.price);
  if (!Number.isFinite(price2) || price2 < 0) {
    throw new CliError(`Invalid --price "${options.price}".`);
  }
  return {
    name: options.name,
    handle: options.handle,
    description: options.description,
    endpointUrl: options.url,
    skills: skills.length > 0 ? skills : [{ name: "default", description: options.description || options.name }],
    capabilities: options.tag,
    costModel: { baseCallFee: price2 },
    currency: options.currency,
    metadata,
    jobOfferings,
    chainId: ctx.net.chainId
  };
}
async function handleJob(gateway, job, command, timeoutMs) {
  const jobId2 = String(job.job_id ?? job.task_id ?? "");
  const input = job.job_input ?? JSON.stringify(job.payload ?? {});
  info("");
  step(`Job ${jobId2} received (${input.length} bytes of input)`);
  const started = Date.now();
  try {
    const stdout = await runCommand(command, input, timeoutMs);
    await gateway.completeJob({
      job_id: jobId2,
      agent_id: job.agent_id,
      status: "completed",
      result: { response: stdout }
    });
    success(`Job ${jobId2} completed in ${((Date.now() - started) / 1e3).toFixed(1)}s`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await gateway.completeJob({ job_id: jobId2, agent_id: job.agent_id, status: "failed", error: message }).catch(() => void 0);
    fail(`Job ${jobId2} failed: ${message}`);
  }
}
function runCommand(command, input, timeoutMs) {
  return new Promise((resolve3, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BITAGENT_JOB_INPUT: input }
    });
    let stdout = "";
    let stderr2 = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`command timed out after ${timeoutMs / 1e3}s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr2 += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve3(stdout.trim());
        return;
      }
      reject(new Error(`command exited with code ${code}: ${stderr2.trim().slice(0, 500)}`));
    });
    child.stdin.end(input);
  });
}
async function fetchAgent(ctx, idOrHandle) {
  const aip = AipClient.from(ctx);
  if (idOrHandle.includes(":")) return await aip.getAgent(idOrHandle);
  const byHandle = await aip.getAgentByHandle(idOrHandle).catch(() => void 0);
  if (byHandle?.agent_id) return byHandle;
  const byId = await aip.getAgent(idOrHandle).catch(() => void 0);
  if (byId?.agent_id) return byId;
  throw new CliError(
    `No agent found for "${idOrHandle}" on ${ctx.net.label}.`,
    "Search with `bitagent browse <query>`."
  );
}
function renderAgent(agent) {
  heading(agent.display_name ?? agent.card?.name ?? agent.handle ?? agent.agent_id);
  kv([
    ["agent id", agent.agent_id],
    ["handle", agent.handle],
    ["chain", agent.chain_id],
    ["owner", agent.owner_id],
    ["wallet", agent.wallet_address],
    ["health", agent.health_status],
    ["endpoint", agent.card?.url],
    [
      "price",
      agent.price?.amount ? `${agent.price.amount} ${agent.price.symbol ?? agent.price.currency ?? ""}`.trim() : "free"
    ],
    ["created", agent.created_at]
  ]);
  if (agent.card?.description) {
    heading("Description");
    process.stdout.write("  " + agent.card.description.replace(/\n/g, "\n  ") + "\n");
  }
  const stats = agent.stats;
  if (stats) {
    heading("Performance");
    kv([
      ["jobs", stats.total_jobs],
      ["completed", stats.completed_jobs],
      ["revenue", stats.total_revenue],
      ["success rate", stats.success_rate !== void 0 ? `${stats.success_rate}%` : void 0]
    ]);
  }
  const skills = agent.card?.skills ?? [];
  if (skills.length > 0) {
    heading(`Skills (${skills.length})`);
    table(skills, [
      { header: "name", value: (s) => s.name ?? "\u2014", max: 28 },
      { header: "description", value: (s) => s.description ?? "\u2014", max: 60 }
    ]);
  }
  const offerings = agent.metadata?.job_offerings ?? [];
  if (Array.isArray(offerings) && offerings.length > 0) {
    heading(`Job offerings (${offerings.length})`);
    table(offerings, [
      { header: "id", value: (o) => String(o.id ?? "\u2014"), max: 10 },
      { header: "name", value: (o) => String(o.name ?? "\u2014"), max: 32 },
      { header: "price", value: (o) => String(o.price ?? "\u2014"), align: "right" },
      { header: "active", value: (o) => o.active === false ? "no" : "yes" }
    ]);
  }
}
var sleep = (ms) => new Promise((resolve3) => setTimeout(resolve3, ms));

// src/commands/auth.ts
import { erc20Abi, formatEther, formatUnits } from "viem";
function registerAuthCommands(program2) {
  program2.command("whoami").description("Show the active wallet, credential, network and balances").option("--no-balances", "Skip on-chain balance lookups").action(async function() {
    const ctx = resolveContext(this);
    const { balances: withBalances } = this.opts();
    const credentials = resolveCredentials();
    if (credentials.mode === "none") {
      throw new CliError(
        "Not configured yet.",
        "Run `bitagent configure` to authorize this machine."
      );
    }
    const balances = withBalances ? await readBalances(ctx, credentials.wallet) : [];
    const butler = await lookupButler(ctx, credentials.token, credentials.wallet);
    result(
      {
        wallet: credentials.wallet,
        credential: { mode: credentials.mode, source: credentials.source },
        network: { name: ctx.net.name, label: ctx.net.label, chainId: ctx.net.chainId },
        endpoints: { aip: ctx.aip, gateway: ctx.gateway, bitagent: ctx.bitagent },
        balances,
        terminalAgent: butler
      },
      () => {
        heading("Identity");
        kv([
          ["wallet", credentials.wallet || "unknown"],
          ["credential", `${credentials.mode} (${credentials.source})`],
          ["network", `${ctx.net.label} (${ctx.net.chainId})`],
          ["can sign tx", credentials.mode === "key"]
        ]);
        if (balances.length > 0) {
          heading("Balances");
          kv(balances.map((b) => [b.symbol, b.amount]));
        }
        heading("Terminal agent");
        if (butler) {
          kv([
            ["agent id", butler.agent_id],
            ["handle", butler.handle],
            ["wallet", butler.wallet_address]
          ]);
        } else {
          kv([["status", "not activated"]]);
          hint("Run `bitagent terminal activate` to create it.");
        }
      }
    );
  });
  program2.command("logout").description("Remove stored credentials and cached API sessions").option("--keep-network", "Keep the saved default network").action(function() {
    const { keepNetwork } = this.opts();
    const config2 = loadConfig();
    const network = config2.network;
    saveConfig(keepNetwork && network ? { network } : {});
    clearSessions();
    success(`Cleared credentials in ${configFile()}`);
    hint("Environment variables (UNIBASE_PROXY_AUTH, \u2026) are not affected.");
  });
  const config = program2.command("config").description("Inspect and edit the saved CLI config");
  config.command("path").description("Print the config file path").action(() => {
    result({ path: configFile() }, () => process.stdout.write(configFile() + "\n"));
  });
  config.command("list").description("Print the saved config, with secrets masked").action(() => {
    const saved = loadConfig();
    const masked = {
      ...saved,
      UNIBASE_PROXY_AUTH: mask(saved.UNIBASE_PROXY_AUTH),
      UNIBASE_WALLET_PRIVATE_KEY: mask(saved.UNIBASE_WALLET_PRIVATE_KEY),
      sessions: saved.sessions ? Object.fromEntries(
        Object.entries(saved.sessions).map(([chain, session]) => [
          chain,
          { ...session, token: mask(session.token) }
        ])
      ) : void 0
    };
    result(masked, () => {
      heading(`Config (${configFile()})`);
      kv(Object.entries(masked));
    });
  });
  config.command("set <key> <value>").description("Set a config key (network, UNIBASE_PROXY_AUTH, UNIBASE_WALLET_PRIVATE_KEY)").action((key, value) => {
    const allowed = ["network", "UNIBASE_PROXY_AUTH", "UNIBASE_WALLET_PRIVATE_KEY"];
    if (!allowed.includes(key)) {
      throw new CliError(`Cannot set "${key}".`, `Settable keys: ${allowed.join(", ")}`);
    }
    updateConfig((saved) => {
      saved[key] = value;
    });
    success(`Set ${key}.`);
  });
  config.command("unset <key>").description("Remove a config key").action((key) => {
    updateConfig((saved) => {
      delete saved[key];
    });
    success(`Removed ${key}.`);
  });
  program2.command("networks").description("List supported networks and their contract addresses").action(function() {
    const ctx = resolveContext(this);
    const rows = Object.values(NETWORKS);
    result(rows, () => {
      heading("Networks");
      table(rows, [
        { header: "name", value: (n) => n.name === ctx.net.name ? `${n.name} *` : n.name },
        { header: "chain id", value: (n) => String(n.chainId), align: "right" },
        { header: "type", value: (n) => n.testnet ? "testnet" : "mainnet" },
        { header: "launchpad", value: (n) => Object.keys(n.reserves).length ? "yes" : "no" },
        { header: "registry (8004)", value: (n) => n.contracts.registry ?? "\u2014" },
        { header: "commerce (8183)", value: (n) => n.contracts.commerce ?? "\u2014" }
      ]);
      hint("* current default \u2014 change it with `bitagent configure`.");
    });
  });
}
var mask = (value) => value ? `${value.slice(0, 6)}\u2026${value.slice(-4)} (${value.length} chars)` : void 0;
async function readBalances(ctx, wallet) {
  if (!wallet) return [];
  const client = publicClientFor(ctx.net, ctx.rpcUrl);
  const balances = [];
  const native = await client.getBalance({ address: wallet }).catch(() => void 0);
  if (native !== void 0) {
    balances.push({
      symbol: ctx.net.chain.nativeCurrency.symbol,
      address: "native",
      amount: formatEther(native)
    });
  }
  const tokens = [
    ["UB", ctx.net.contracts.ub],
    ["USDC", ctx.net.contracts.usdc]
  ];
  for (const [symbol, address] of tokens) {
    if (!address) continue;
    const result2 = await Promise.all([
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet]
      }),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" })
    ]).catch(() => void 0);
    if (!result2) continue;
    const [amount, decimals] = result2;
    balances.push({ symbol, address, amount: formatUnits(amount, decimals) });
  }
  return balances;
}
async function lookupButler(ctx, token, wallet) {
  if (!token) return void 0;
  const aip = AipClient.from(ctx);
  const butler = await aip.butlerStatus(token, wallet).catch(() => void 0);
  if (!butler?.agent_id) return void 0;
  return {
    agent_id: butler.agent_id,
    handle: butler.handle,
    wallet_address: butler.wallet_address
  };
}

// src/commands/configure.ts
import { privateKeyToAccount as privateKeyToAccount2 } from "viem/accounts";

// src/lib/api/pay.ts
async function initAuth(payBase) {
  const response = await request(payBase, "/v1/init", {
    method: "POST",
    // The service expects a bare JSON `true` body, matching the AIP SDKs.
    body: true,
    timeoutMs: 3e4
  });
  const authUrl = response.auth_url ?? response.authUrl;
  if (!authUrl) {
    throw new CliError(`No authorization URL in the response from ${payBase}/v1/init`);
  }
  return { code: response.code ?? "", authUrl };
}

// src/lib/prompt.ts
import * as readline from "node:readline/promises";
var requireTty = (what) => {
  if (!process.stdin.isTTY) {
    throw new CliError(
      `${what} requires an interactive terminal.`,
      "Pass the value as a flag, or set the matching environment variable."
    );
  }
};
async function ask(question, fallback = "") {
  requireTty("This prompt");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}
async function confirm(question, fallback = false) {
  const answer = await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`);
  if (!answer) return fallback;
  return /^y(es)?$/i.test(answer.trim());
}
async function askSecret(question) {
  requireTty("This prompt");
  process.stderr.write(question + " ");
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise((resolve3, reject) => {
    let value = "";
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new CliError("Aborted."));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          process.stderr.write("\n");
          resolve3(value.trim());
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}
async function select(title, options, defaultIndex = 0) {
  requireTty("This prompt");
  process.stderr.write(title + "\n");
  options.forEach((option, i) => {
    process.stderr.write(`  ${i + 1}) ${option.label}
`);
  });
  for (; ; ) {
    const answer = await ask("Choice", String(defaultIndex + 1));
    const index = Number(answer) - 1;
    const chosen = options[index];
    if (chosen) return chosen.value;
    process.stderr.write("  Please enter a number from the list.\n");
  }
}

// src/commands/configure.ts
function registerConfigureCommand(program2) {
  program2.command("configure").description("Set up your default network and credential (interactive)").option("--token <jwt>", "Store this Unibase Pay JWT instead of prompting").option("--private-key <hex>", "Store this wallet private key instead of prompting").option("--set-network <name>", "Store this network as the default instead of prompting").action(async function() {
    const options = this.opts();
    const ctx = resolveContext(this);
    if (options.token || options.privateKey || options.setNetwork) {
      const network2 = options.setNetwork ? resolveNetworkOption(options.setNetwork) : void 0;
      updateConfig((config) => {
        if (network2) config.network = network2.name;
        if (options.token) {
          config.UNIBASE_PROXY_AUTH = options.token.trim();
          delete config.UNIBASE_WALLET_PRIVATE_KEY;
        }
        if (options.privateKey) {
          config.UNIBASE_WALLET_PRIVATE_KEY = options.privateKey.trim();
          delete config.UNIBASE_PROXY_AUTH;
        }
      });
      success(`Saved to ${configFile()}`);
      await report(options.setNetwork ? resolveContext(this) : ctx);
      return;
    }
    info("");
    info("BitAgent CLI setup");
    info("");
    const network = await select(
      "Which network should commands default to?",
      Object.values(NETWORKS).map((net) => ({
        label: `${net.label} (${net.chainId})${net.testnet ? "" : "  \u2014 real funds"}`,
        value: net.name
      })),
      Object.keys(NETWORKS).indexOf(ctx.net.name)
    );
    const existing = resolveCredentials();
    const methods = [
      { label: "Browser authorization \u2014 approve a URL, paste the JWT token", value: "jwt" },
      { label: "Wallet private key \u2014 required for on-chain transactions", value: "key" }
    ];
    if (existing.mode !== "none") {
      methods.push({
        label: `Keep the current credential (${existing.mode}, ${existing.wallet || "unknown wallet"})`,
        value: "keep"
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
      if (!key) throw new CliError("No private key provided \u2014 nothing was saved.");
      const address = privateKeyToAccount2(normalize(key)).address;
      info(`  wallet: ${address}`);
      updateConfig((config) => {
        config.network = network;
        config.UNIBASE_WALLET_PRIVATE_KEY = key;
      });
    } else {
      updateConfig((config) => {
        config.network = network;
      });
    }
    success(`Saved to ${configFile()} (0600)`);
    await report(resolveContext(this));
  });
}
function normalize(key) {
  const hex = key.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CliError("Invalid wallet private key: expected 64 hex characters.");
  }
  return `0x${hex}`;
}
async function browserAuthorize(payBase) {
  step("Requesting an authorization URL \u2026");
  const session = await initAuth(payBase);
  info("");
  info("Open this URL, approve the request, and copy the token it gives you:");
  info("");
  info(`  ${link(session.authUrl)}`);
  info("");
  const token = (await ask("Paste the token:")).trim();
  if (!token) throw new CliError("No token provided \u2014 nothing was saved.");
  if (isTokenExpired(token)) {
    warn("That token looks already expired \u2014 saving it anyway.");
  }
  const wallet = walletFromToken(token);
  if (wallet) info(`  wallet: ${wallet}`);
  return token;
}
async function report(ctx) {
  const credentials = resolveCredentials();
  heading("Configuration");
  kv([
    ["network", `${ctx.net.label} (${ctx.net.chainId})`],
    ["wallet", credentials.wallet || "unknown"],
    ["credential", credentials.mode === "none" ? "none" : `${credentials.mode} \u2014 ${credentials.source}`],
    ["aip endpoint", ctx.aip],
    ["bitagent api", ctx.bitagent],
    ["config file", configFile()]
  ]);
  const aip = AipClient.from(ctx);
  const stats = await aip.stats().catch(() => void 0);
  if (stats) {
    info("");
    success(
      `Connected \u2014 ${stats.total_agents ?? 0} agents and ${stats.total_services ?? 0} services on the marketplace.`
    );
  } else {
    warn(`Could not reach ${ctx.aip} \u2014 check your connection.`);
  }
  if (credentials.mode !== "none") {
    info("");
    info("Next: `bitagent terminal activate` then `bitagent terminal chat`");
  }
}

// src/commands/job.ts
import { readFileSync as readFileSync2 } from "node:fs";
var userId = (wallet) => wallet.startsWith("user:") ? wallet : `user:${wallet}`;
function registerJobCommands(program2) {
  const job = program2.command("job").description("Create, fund and settle ERC-8183 jobs");
  job.command("create").description("Create a job with an escrowed reward").requiredOption("--description <text>", "What the provider must deliver").requiredOption("--reward <amount>", "Reward amount").option("--token <symbolOrAddress>", "Reward token: USDC, UB, or a contract address", "USDC").option("--evaluator <id>", "Evaluator id (defaults to the network's evaluator contract)").option("--client <id>", "Client id (defaults to user:<your wallet>)").option("--expires-in <seconds>", "Job expiry", "86400").option("--metadata <json>", "Extra metadata object, as JSON").action(async function() {
    const ctx = resolveContext(this);
    const options = this.opts();
    const credentials = requireCredentials();
    const reward = Number(options.reward);
    if (!Number.isFinite(reward) || reward <= 0) {
      throw new CliError(`Invalid --reward "${options.reward}".`);
    }
    const created = await AipClient.from(ctx).createJob(
      options.client ?? userId(credentials.wallet),
      {
        description: options.description,
        reward_amount: reward,
        reward_token: resolveRewardToken(ctx, options.token),
        evaluator_id: options.evaluator ?? ctx.net.contracts.evaluator,
        expires_in: Number(options.expiresIn),
        metadata: parseMetadata(options.metadata)
      },
      credentials.token || void 0
    );
    result(created, () => {
      success(`Job ${jobId(created)} created`);
      renderJob(created);
      hint("Bind a provider with `bitagent job accept <id> --provider <agent-id>`.");
    });
  });
  job.command("list").description("List your jobs").option("--role <role>", "client | provider | evaluator | any", "any").option("--limit <n>", "Maximum rows", "30").action(async function() {
    const ctx = resolveContext(this);
    const options = this.opts();
    const credentials = requireCredentials();
    if (!credentials.token) {
      throw new CliError(
        "`job list` needs a Unibase Pay JWT.",
        "Run `bitagent configure` and choose browser authorization."
      );
    }
    const jobs = (await AipClient.from(ctx).myJobs(credentials.token, options.role)).slice(
      0,
      Number(options.limit)
    );
    result(jobs, () => {
      heading(`Your jobs \u2014 role ${options.role} (${jobs.length})`);
      table(jobs, [
        { header: "job id", value: (j) => jobId(j), max: 14 },
        { header: "status", value: (j) => String(j.status ?? "\u2014") },
        { header: "description", value: (j) => String(j.description ?? "\u2014"), max: 44 },
        {
          header: "reward",
          value: (j) => `${j.reward_amount ?? 0} ${symbolOf(ctx, j.reward_token)}`.trim(),
          align: "right"
        },
        { header: "provider", value: (j) => shorten(j.provider_id), max: 26 }
      ]);
    });
  });
  job.command("show <jobId>").description("Show one job in full").action(async function(id) {
    const ctx = resolveContext(this);
    const credentials = requireCredentials();
    const record = await AipClient.from(ctx).getJob(id, credentials.token || void 0);
    result(record, () => renderJob(record, true));
  });
  job.command("accept <jobId>").description("Accept a job as the provider").requiredOption("--provider <id>", "Provider agent id").action(async function(id) {
    const ctx = resolveContext(this);
    const { provider } = this.opts();
    const credentials = requireCredentials();
    const record = await AipClient.from(ctx).acceptJob(
      id,
      provider,
      credentials.token || void 0
    );
    result(record, () => {
      success(`Job ${id} accepted by ${provider}`);
      renderJob(record);
    });
  });
  job.command("submit <jobId>").description("Submit the deliverable as the provider").requiredOption("--provider <id>", "Provider agent id").option("--data <text>", "Deliverable payload; JSON is parsed, anything else sent as text").option("--file <path>", "Read the deliverable from a file instead of --data").option("--description <text>", "Note attached to the submission", "").action(async function(id) {
    const ctx = resolveContext(this);
    const options = this.opts();
    const credentials = requireCredentials();
    const raw = options.file ? readFileSync2(options.file, "utf8") : options.data;
    if (raw === void 0) {
      throw new CliError("Provide the deliverable with --data or --file.");
    }
    const record = await AipClient.from(ctx).submitJob(
      id,
      {
        provider_id: options.provider,
        deliverable_data: parseLoose(raw),
        description: options.description
      },
      credentials.token || void 0
    );
    result(record, () => {
      success(`Deliverable submitted for job ${id}`);
      renderJob(record);
      hint("The evaluator releases escrow with `bitagent job complete <id>`.");
    });
  });
  job.command("complete <jobId>").description("Approve the deliverable as the evaluator and release escrow").option("--evaluator <id>", "Evaluator id (defaults to the network's evaluator contract)").option("--reason <text>", "Why it was approved", "Deliverable accepted").action(async function(id) {
    const ctx = resolveContext(this);
    const options = this.opts();
    const credentials = requireCredentials();
    const evaluator = options.evaluator ?? ctx.net.contracts.evaluator;
    if (!evaluator) {
      throw new CliError(`No evaluator configured for ${ctx.net.label}. Pass --evaluator.`);
    }
    const record = await AipClient.from(ctx).completeJob(
      id,
      { evaluator_id: evaluator, reason: options.reason },
      credentials.token || void 0
    );
    result(record, () => {
      success(`Job ${id} completed \u2014 escrow released`);
      renderJob(record);
    });
  });
  job.command("reject <jobId>").description("Reject the deliverable").requiredOption("--reason <text>", "Why it was rejected").option("--rejector <id>", "Rejector id (defaults to user:<your wallet>)").action(async function(id) {
    const ctx = resolveContext(this);
    const options = this.opts();
    const credentials = requireCredentials();
    const record = await AipClient.from(ctx).rejectJob(
      id,
      options.rejector ?? userId(credentials.wallet),
      options.reason,
      credentials.token || void 0
    );
    result(record, () => {
      success(`Job ${id} rejected`);
      renderJob(record);
    });
  });
}
var jobId = (record) => String(record.job_id ?? record.id ?? "\u2014");
var shorten = (value) => {
  if (!value) return "\u2014";
  return value.length > 26 ? `${value.slice(0, 12)}\u2026${value.slice(-8)}` : value;
};
function resolveRewardToken(ctx, token) {
  if (token.startsWith("0x")) return token;
  const upper = token.toUpperCase();
  if (upper === "USDC" && ctx.net.contracts.usdc) return ctx.net.contracts.usdc;
  if (upper === "UB" && ctx.net.contracts.ub) return ctx.net.contracts.ub;
  return token;
}
function symbolOf(ctx, token) {
  if (!token) return "";
  const lower = token.toLowerCase();
  if (lower === ctx.net.contracts.usdc?.toLowerCase()) return "USDC";
  if (lower === ctx.net.contracts.ub?.toLowerCase()) return "UB";
  return token.startsWith("0x") ? `${token.slice(0, 6)}\u2026` : token;
}
function parseMetadata(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new CliError("--metadata must be valid JSON.");
  }
}
function parseLoose(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
function renderJob(record, verbose = false) {
  kv([
    ["job id", jobId(record)],
    ["status", record.status],
    ["description", record.description],
    ["reward", record.reward_amount !== void 0 ? `${record.reward_amount}` : void 0],
    ["reward token", record.reward_token],
    ["client", record.client_id],
    ["provider", record.provider_id],
    ["evaluator", record.evaluator_id],
    ["deliverable", record.deliverable_uri],
    ["created", record.created_at]
  ]);
  if (!verbose) return;
  const known = /* @__PURE__ */ new Set([
    "job_id",
    "id",
    "status",
    "description",
    "reward_amount",
    "reward_token",
    "client_id",
    "provider_id",
    "evaluator_id",
    "deliverable_uri",
    "created_at"
  ]);
  const extra = Object.entries(record).filter(([key]) => !known.has(key));
  if (extra.length > 0) {
    heading("Additional fields");
    kv(extra);
  }
}

// src/commands/market.ts
var agentName = (agent) => agent.display_name || agent.card?.name || agent.handle || agent.agent_id;
var agentPrice = (agent) => {
  const price2 = agent.price;
  if (!price2?.amount) return "free";
  return `${trim(price2.amount)} ${price2.symbol ?? price2.currency ?? ""}`.trim();
};
var trim = (value) => Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
var servicePrice = (service) => {
  if (service.price_v2?.amount !== void 0) {
    return `${trim(service.price_v2.amount)} ${service.price_v2.symbol ?? ""}`.trim();
  }
  const raw = Number(service.price);
  return Number.isFinite(raw) ? trim(raw) : service.price ?? "\u2014";
};
var matches = (query, ...fields) => {
  if (!query) return true;
  const needle = query.toLowerCase();
  return fields.some((field) => {
    if (!field) return false;
    const text = Array.isArray(field) ? field.join(" ") : field;
    return text.toLowerCase().includes(needle);
  });
};
function registerMarketCommands(program2) {
  program2.command("browse").argument("[query]", "Filter agents and services by name, handle, description or tag").description("Search the marketplace for agents and the services they sell").option("--agents-only", "Only list agents").option("--services-only", "Only list services").option("--limit <n>", "Maximum rows per section", "20").option("--page-size <n>", "Rows to fetch per API page", "100").action(async function(query) {
    const ctx = resolveContext(this);
    const options = this.opts();
    const limit = Number(options.limit);
    const pageSize = Number(options.pageSize);
    const needle = query ?? "";
    const aip = AipClient.from(ctx);
    const wantAgents = !options.servicesOnly;
    const wantServices = !options.agentsOnly;
    const [agentPage, servicePage] = await Promise.all([
      wantAgents ? aip.listAgents({ pageSize, include_health: true }) : void 0,
      wantServices ? aip.listServices({ pageSize }) : void 0
    ]);
    const agents = (agentPage?.data ?? []).filter(
      (agent) => matches(
        needle,
        agent.handle,
        agent.display_name,
        agent.card?.name,
        agent.card?.description,
        agent.card?.skills?.map((s) => s.name ?? "").join(" ")
      )
    ).slice(0, limit);
    const services = (servicePage?.data ?? []).filter(
      (service) => matches(needle, service.name, service.description, service.agent_handle, service.tags)
    ).slice(0, limit);
    result({ query: needle || null, agents, services }, () => {
      if (wantAgents) {
        heading(`Agents (${agents.length}${agentPage?.total ? ` of ${agentPage.total}` : ""})`);
        table(agents, [
          { header: "handle", value: (a) => a.handle ?? "\u2014", max: 28 },
          { header: "name", value: agentName, max: 30 },
          { header: "price", value: agentPrice, align: "right" },
          { header: "health", value: (a) => a.health_status ?? "\u2014" },
          { header: "jobs", value: (a) => String(a.stats?.total_jobs ?? 0), align: "right" },
          { header: "agent id", value: (a) => a.agent_id, max: 44 }
        ]);
      }
      if (wantServices) {
        heading(
          `Services (${services.length}${servicePage?.total ? ` of ${servicePage.total}` : ""})`
        );
        table(services, [
          { header: "id", value: (s) => s.id, max: 12 },
          { header: "service", value: (s) => s.name ?? "\u2014", max: 34 },
          { header: "agent", value: (s) => s.agent_handle ?? s.provider ?? "\u2014", max: 22 },
          { header: "price", value: servicePrice, align: "right" },
          { header: "sla", value: (s) => s.sla_minutes ? `${s.sla_minutes}m` : "\u2014" }
        ]);
        hint('Hire one with `bitagent terminal hire <agent-handle> --task "\u2026"`.');
      }
    });
  });
  program2.command("services").argument("[serviceId]", "Show one service by its id").description("List job offerings sold on the marketplace").option("--limit <n>", "Maximum rows", "30").action(async function(serviceId) {
    const ctx = resolveContext(this);
    const { limit } = this.opts();
    const aip = AipClient.from(ctx);
    if (serviceId) {
      const service = await aip.getService(serviceId);
      result(service, () => {
        heading(service.name ?? service.id);
        kv([
          ["id", service.id],
          ["description", service.description],
          ["tags", service.tags?.join(", ")],
          ["price", servicePrice(service)],
          ["sla", service.sla_minutes ? `${service.sla_minutes} min` : void 0],
          ["agent", service.agent_handle],
          ["agent id", service.agent_id],
          ["offering id", service.offering_id],
          ["active", service.active]
        ]);
      });
      return;
    }
    const page = await aip.listServices({ pageSize: Number(limit) });
    const services = page.data ?? [];
    result(page, () => {
      heading(`Services (${services.length} of ${page.total ?? services.length})`);
      table(services, [
        { header: "id", value: (s) => s.id, max: 12 },
        { header: "service", value: (s) => s.name ?? "\u2014", max: 36 },
        { header: "agent", value: (s) => s.agent_handle ?? "\u2014", max: 22 },
        { header: "price", value: servicePrice, align: "right" },
        { header: "active", value: (s) => s.active === false ? "no" : "yes" }
      ]);
    });
  });
  program2.command("tasks").argument("[taskId]", "Show one market task by its id").description("List open tasks on the task market").option("--status <status>", "open | closed | fulfilled").option("--query <text>", "Keyword search in title and description").option("--limit <n>", "Maximum rows", "20").action(async function(taskId) {
    const ctx = resolveContext(this);
    const options = this.opts();
    const aip = AipClient.from(ctx);
    if (taskId) {
      const task = await aip.getTask(taskId);
      result(task, () => renderTask(task));
      return;
    }
    const limit = Number(options.limit);
    const page = await aip.listTasks({
      status: options.status,
      query: options.query,
      limit
    });
    const tasks = (page.data ?? []).slice(0, limit);
    result({ ...page, data: tasks }, () => {
      heading(`Tasks (${tasks.length} of ${page.total ?? tasks.length})`);
      table(tasks, [
        { header: "task id", value: (t) => t.task_id, max: 16 },
        { header: "title", value: (t) => t.title ?? "\u2014", max: 44 },
        {
          header: "reward",
          value: (t) => `${t.reward_amount ?? 0} ${t.reward_token ?? ""}`.trim(),
          align: "right"
        },
        {
          header: "slots",
          value: (t) => `${t.claimed_slots ?? 0}/${t.total_slots ?? 0}`,
          align: "right"
        },
        { header: "status", value: (t) => t.status ?? "\u2014" }
      ]);
    });
  });
  program2.command("rankings").description("Leaderboard of the top-performing agents").option("--metric <metric>", "revenue | tasks", "revenue").option("--limit <n>", "Number of agents", "10").action(async function() {
    const ctx = resolveContext(this);
    const options = this.opts();
    const rankings = await AipClient.from(ctx).rankings({
      metric: options.metric,
      limit: Number(options.limit)
    });
    result(rankings, () => {
      heading(`Top agents by ${options.metric} (all networks)`);
      table(rankings, [
        { header: "#", value: (r) => String(r.rank ?? ""), align: "right" },
        { header: "handle", value: (r) => r.handle ?? "\u2014", max: 26 },
        { header: "name", value: (r) => r.name ?? "\u2014", max: 30 },
        {
          header: options.metric,
          value: (r) => r.score !== void 0 ? trim(r.score) : "\u2014",
          align: "right"
        },
        { header: "agent id", value: (r) => r.agent_id ?? "\u2014", max: 46 }
      ]);
      if (rankings.length === 0) {
        hint(`No agents ranked by ${options.metric} yet \u2014 try --metric tasks.`);
      }
    });
  });
  program2.command("stats").description("Platform-wide metrics").action(async function() {
    const ctx = resolveContext(this);
    const stats = await AipClient.from(ctx).stats();
    result(stats, () => {
      heading(`BitAgent \u2014 ${ctx.net.label}`);
      kv([
        ["agents", stats.total_agents],
        ["services", stats.total_services],
        ["tasks", stats.total_tasks],
        ["revenue", stats.total_revenue !== void 0 ? trim(stats.total_revenue) : void 0],
        ["agents 30d", pct(stats.agents_growth_30d)],
        ["services 30d", pct(stats.services_growth_30d)],
        ["tasks 30d", pct(stats.tasks_growth_30d)],
        ["revenue 30d", pct(stats.revenue_growth_30d)]
      ]);
    });
  });
}
var pct = (value) => value === void 0 ? void 0 : `${value > 0 ? "+" : ""}${trim(value)}%`;
function renderTask(task) {
  heading(task.title ?? task.task_id);
  kv([
    ["task id", task.task_id],
    ["status", task.status],
    ["reward", `${task.reward_amount ?? 0} ${task.reward_token ?? ""}`.trim()],
    ["budget", task.total_budget],
    ["slots", `${task.claimed_slots ?? 0}/${task.total_slots ?? 0}`],
    ["creator", task.creator_name],
    ["due", task.due_date],
    ["created", task.created_at]
  ]);
  if (task.description) {
    heading("Description");
    process.stdout.write("  " + task.description.replace(/\n/g, "\n  ") + "\n");
  }
  const completions = task.completions ?? [];
  if (completions.length > 0) {
    heading(`Completions (${completions.length})`);
    table(completions, [
      { header: "job", value: (c) => String(c.job_id ?? "\u2014"), max: 16 },
      { header: "provider", value: (c) => String(c.provider_id ?? "\u2014"), max: 34 },
      { header: "status", value: (c) => String(c.status ?? "\u2014") },
      { header: "reward", value: (c) => String(c.reward_amount ?? "\u2014"), align: "right" }
    ]);
  }
}

// src/commands/skill.ts
import { existsSync, readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
function skillPath() {
  const here = dirname2(fileURLToPath(import.meta.url));
  const candidates = [
    resolve2(here, "../../SKILL.md"),
    // src/commands/ → repo root
    resolve2(here, "../../../SKILL.md"),
    // dist/bin/ → package root
    resolve2(process.cwd(), "SKILL.md")
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new CliError(
      "SKILL.md was not found next to the installed CLI.",
      `Looked in: ${candidates.join(", ")}`
    );
  }
  return found;
}
function installedVersion(program2) {
  return program2.version() ?? "0.0.0";
}
function registerSkillCommands(program2) {
  const skill = program2.command("skill").description("Print the bundled agent skill document (SKILL.md)");
  skill.command("path").description("Print the absolute path to the bundled SKILL.md").action(function() {
    const path2 = skillPath();
    result({ path: path2 }, () => process.stdout.write(path2 + "\n"));
  });
  skill.command("print").description("Print the bundled SKILL.md").action(function() {
    const path2 = skillPath();
    const content = readFileSync3(path2, "utf8");
    result({ path: path2, content }, () => process.stdout.write(content));
  });
  skill.command("check").description("Compare a loaded skill copy against the installed CLI version").requiredOption("--against <version>", "The bitagentCliVersion your loaded copy declares").action(function() {
    const { against } = this.opts();
    const installed = installedVersion(program2);
    const upToDate = against.trim() === installed;
    result(
      {
        installed,
        against: against.trim(),
        upToDate,
        action: upToDate ? "none" : "reload",
        path: skillPath()
      },
      () => {
        kv([
          ["installed cli", installed],
          ["loaded skill", against.trim()],
          ["up to date", upToDate]
        ]);
        if (!upToDate) {
          warn("Your loaded skill copy is out of step with the installed CLI.");
          hint("Re-read it with `bitagent skill print`.");
        }
      }
    );
  });
}

// src/commands/terminal.ts
import { randomUUID } from "node:crypto";
import * as readline2 from "node:readline/promises";
var ACTIVATE_MESSAGE = "Activate my personal Butler Agent";
function registerTerminalCommands(program2) {
  const terminal = program2.command("terminal").description("Talk to your Terminal agent: describe a task, hire, and settle");
  terminal.command("status").description("Show whether your Terminal agent is active").action(async function() {
    const ctx = resolveContext(this);
    const credentials = requireJwt(ctx);
    const butler = await AipClient.from(ctx).butlerStatus(credentials.token, credentials.wallet);
    result(butler ?? { active: false }, () => {
      if (!butler) {
        warn(`No Terminal agent on ${ctx.net.label}.`);
        hint("Create it with `bitagent terminal activate`.");
        return;
      }
      heading("Terminal agent");
      kv([
        ["agent id", butler.agent_id],
        ["handle", butler.handle],
        ["display name", butler.display_name],
        ["wallet", butler.wallet_address],
        ["chain", butler.chain_id],
        ["jobs", butler.stats?.total_jobs],
        ["revenue", butler.stats?.total_revenue]
      ]);
    });
  });
  terminal.command("activate").description("Activate your Terminal agent on this network").action(async function() {
    const ctx = resolveContext(this);
    const credentials = requireJwt(ctx);
    const aip = AipClient.from(ctx);
    const existing = await aip.butlerStatus(credentials.token, credentials.wallet);
    if (existing?.agent_id) {
      setButler(ctx.net.chainId, existing.agent_id);
      result(existing, () => {
        success(`Already active: ${existing.agent_id}`);
      });
      return;
    }
    const body = {
      chain_id: ctx.net.chainId,
      wallet_address: credentials.wallet || void 0
    };
    if (credentials.mode === "key") {
      step("Signing the activation message \u2026");
      body.signature = await signMessage(ACTIVATE_MESSAGE);
      body.message = ACTIVATE_MESSAGE;
    }
    step(`Activating your Terminal agent on ${ctx.net.label} \u2026`);
    const activated = await aip.activateButler(body, credentials.token);
    if (activated.agent_id) setButler(ctx.net.chainId, activated.agent_id);
    result(activated, () => {
      success(`Terminal agent ${activated.status ?? "activated"}`);
      kv([
        ["agent id", activated.agent_id],
        ["wallet", activated.wallet_address]
      ]);
      hint('Now try `bitagent terminal chat "find me an agent that can audit Solidity"`.');
    });
  });
  terminal.command("chat").argument("[message...]", "Message to send. Omit for an interactive session").description("Send a task to your Terminal agent (streams the reply)").option("--conversation <id>", "Continue a conversation (defaults to the last one used)").option("--new", "Start a fresh conversation").option("--agent <id>", "Talk to a specific agent instead of your Terminal agent").option("--no-stream", "Wait for the full reply instead of streaming tokens").action(async function(words) {
    const ctx = resolveContext(this);
    const options = this.opts();
    const credentials = requireJwt(ctx);
    const aip = AipClient.from(ctx);
    const target = options.agent ?? await resolveButlerId(ctx, credentials);
    const conversationId = options.conversation ?? (options.new ? `cli-${randomUUID()}` : getConversation(ctx.net.chainId)) ?? `cli-${randomUUID()}`;
    setConversation(ctx.net.chainId, conversationId);
    const message = words.join(" ").trim();
    if (message) {
      const reply = await send(ctx, credentials, target, conversationId, message, options.stream);
      result(
        { conversation_id: conversationId, agent_id: target, reply },
        () => void 0
        // `send` already streamed the reply to stdout
      );
      return;
    }
    if (!process.stdin.isTTY) {
      throw new CliError(
        "No message given and stdin is not a terminal.",
        'Pass the message inline: bitagent terminal chat "\u2026"'
      );
    }
    info("");
    success(`Connected to ${target}`);
    kv([
      ["network", `${ctx.net.label} (${ctx.net.chainId})`],
      ["conversation", conversationId]
    ]);
    hint("Type your task. Ctrl-C or `exit` to quit.");
    info("");
    const rl = readline2.createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (; ; ) {
        const line = (await rl.question(pc.bold("you \u203A "))).trim();
        if (!line) continue;
        if (line === "exit" || line === "quit") break;
        await send(ctx, credentials, target, conversationId, line, options.stream);
        process.stdout.write("\n");
      }
    } finally {
      rl.close();
    }
  });
  terminal.command("hire <agentOrHandle>").description("Ask your Terminal agent to hire an agent for a task").requiredOption("--task <text>", "What you want done").option("--reward <amount>", "Reward you are willing to escrow").option("--token <symbol>", "Reward token", "USDC").option("--service <name>", "A specific job offering of that agent").option("--conversation <id>", "Continue a conversation").option("--no-stream", "Wait for the full reply instead of streaming tokens").action(async function(agentOrHandle) {
    const ctx = resolveContext(this);
    const options = this.opts();
    const credentials = requireJwt(ctx);
    const target = await resolveButlerId(ctx, credentials);
    const conversationId = options.conversation ?? getConversation(ctx.net.chainId) ?? `cli-${randomUUID()}`;
    setConversation(ctx.net.chainId, conversationId);
    const parts = [`I want to hire ${agentOrHandle}`];
    if (options.service) parts.push(`for the "${options.service}" service`);
    parts.push(`to do this task: ${options.task}`);
    if (options.reward) parts.push(`Reward: ${options.reward} ${options.token}.`);
    parts.push("Please create the job, lock the budget, and hire the agent.");
    const message = parts.join(" ");
    step(`Asking your Terminal agent to hire ${agentOrHandle} \u2026`);
    const reply = await send(ctx, credentials, target, conversationId, message, options.stream);
    result(
      { conversation_id: conversationId, agent_id: target, intent: message, reply },
      () => void 0
    );
  });
  terminal.command("conversations").description("List your Terminal conversations").action(async function() {
    const ctx = resolveContext(this);
    const credentials = requireJwt(ctx);
    const response = await AipClient.from(ctx).conversations(credentials.token);
    const conversations = response.conversations ?? [];
    result(response, () => {
      heading(`Conversations (${conversations.length})`);
      table(conversations, [
        { header: "conversation id", value: (c) => c.conversation_id, max: 36 },
        { header: "messages", value: (c) => String(c.message_count ?? 0), align: "right" },
        { header: "updated", value: (c) => c.updated_at ?? "\u2014", max: 24 },
        { header: "last message", value: (c) => c.last_message ?? "\u2014", max: 48 }
      ]);
    });
  });
  terminal.command("history <conversationId>").description("Print the transcript of a conversation").action(async function(conversationId) {
    const ctx = resolveContext(this);
    const credentials = requireJwt(ctx);
    const response = await AipClient.from(ctx).conversationHistory(
      conversationId,
      credentials.token
    );
    const messages = response.messages ?? [];
    result(response, () => {
      heading(`${conversationId} (${messages.length} messages)`);
      for (const message of messages) renderMessage(message);
    });
  });
}
function requireJwt(ctx) {
  const credentials = requireCredentials();
  if (!credentials.token) {
    throw new CliError(
      "The Terminal agent needs a Unibase Pay JWT \u2014 a private key alone is not enough.",
      "Run `bitagent configure` and choose browser authorization."
    );
  }
  void ctx;
  return credentials;
}
async function resolveButlerId(ctx, credentials) {
  const butler = await AipClient.from(ctx).butlerStatus(credentials.token, credentials.wallet);
  if (butler?.agent_id) {
    setButler(ctx.net.chainId, butler.agent_id);
    return butler.agent_id;
  }
  throw new CliError(
    `No Terminal agent on ${ctx.net.label}.`,
    "Create it with `bitagent terminal activate`."
  );
}
async function send(ctx, credentials, agentId, conversationId, message, stream) {
  const aip = AipClient.from(ctx);
  const body = {
    message,
    chain_id: ctx.net.chainId,
    context: {
      conversation_id: conversationId,
      metadata: { chain_id: ctx.net.chainId, source: "bitagent-cli" }
    }
  };
  if (!stream) {
    const response = await aip.invoke(agentId, body, credentials.token);
    const content = String(response.content ?? "");
    if (!isJsonMode()) {
      process.stdout.write(pc.bold("agent \u203A ") + content + "\n");
      if (response.cost) hint(`cost: ${response.cost}`);
    }
    return content;
  }
  let text = "";
  let wroteHeader = false;
  const write = (chunk) => {
    if (isJsonMode()) return;
    if (!wroteHeader) {
      process.stdout.write(pc.bold("agent \u203A "));
      wroteHeader = true;
    }
    process.stdout.write(chunk);
  };
  for await (const event of aip.invokeStream(agentId, body, credentials.token)) {
    const kind = String(event.event ?? event.type ?? "");
    const data = event.data;
    if (kind === "token") {
      const piece = typeof data === "string" ? data : String(data?.text ?? "");
      text += piece;
      write(piece);
      continue;
    }
    if (kind === "status") {
      const status = typeof data === "string" ? data : JSON.stringify(data);
      if (status && !isJsonMode()) step(status);
      continue;
    }
    if (kind === "result") {
      const record = data ?? {};
      const content = typeof record.content === "string" ? record.content : "";
      if (content && !text) {
        text = content;
        write(content);
      }
      if (record.cost && !isJsonMode()) hint(`cost: ${String(record.cost)}`);
      continue;
    }
    if (typeof event.raw === "string") {
      text += event.raw;
      write(event.raw);
    }
  }
  if (wroteHeader) process.stdout.write("\n");
  return text;
}
function renderMessage(message) {
  const label = message.role === "user" ? pc.bold("you \u203A ") : pc.bold("agent \u203A ");
  const body = String(message.content ?? "").replace(/\n/g, "\n  ");
  process.stdout.write(`${label}${body}
`);
}

// src/commands/token.ts
import { erc20Abi as erc20Abi2, formatEther as formatEther3, formatUnits as formatUnits3, parseEther as parseEther2, parseUnits as parseUnits2 } from "viem";

// src/lib/api/bitagent.ts
var BitagentClient = class _BitagentClient {
  constructor(base2) {
    this.base = base2;
  }
  static from(ctx) {
    return new _BitagentClient(ctx.bitagent);
  }
  /** Register the agent record that the on-chain `create` call references. */
  async deployAgent(payload, token) {
    const response = await request(
      this.base,
      "/agent/deploy",
      { method: "POST", body: payload, token }
    );
    const id = response.data?.id ?? response.id;
    if (!id) {
      throw new CliError(
        `The launchpad did not return an agent id: ${JSON.stringify(response).slice(0, 300)}`
      );
    }
    return id;
  }
  /** Look up a launchpad agent by its token address. */
  async agentByToken(tokenAddress) {
    const single = await request(this.base, "/agent", {
      query: { token: tokenAddress },
      allowStatus: [404, 400]
    });
    const direct = single?.data ?? single;
    if (direct?.creator) return direct;
    const list = await request(
      this.base,
      "/agents",
      { query: { token: tokenAddress }, allowStatus: [404, 400] }
    );
    const agents = list?.data?.agents ?? list?.agents ?? [];
    const match = agents.find(
      (agent) => (agent.token ?? "").toLowerCase() === tokenAddress.toLowerCase()
    );
    return match ?? agents[0];
  }
  /**
   * The creator address a bonding-curve token was deployed under — required
   * by the SDK to derive the token's bond parameters.
   */
  async creatorOf(tokenAddress, fallback) {
    const agent = await this.agentByToken(tokenAddress).catch(() => void 0);
    if (agent?.creator) return agent.creator;
    if (fallback) return fallback;
    throw new CliError(
      `Could not find the creator for token ${tokenAddress} on this network.`,
      "Check that --network matches the chain the token was launched on."
    );
  }
};

// src/lib/bonding.ts
import { formatEther as formatEther2, formatUnits as formatUnits2, parseEther, parseUnits } from "viem";
import { bitagent, binaryReverseMint } from "@bitagent/sdk";
var BOND_VERSION = "3.1.0";
var MAX_SUPPLY_AT_CURVE = 85e8;
var DEFAULT_SLIPPAGE = 50;
function requireLaunchpad(net) {
  if (Object.keys(net.reserves).length === 0) {
    throw new CliError(
      `The bonding-curve launchpad is not available on ${net.label}.`,
      "Use --network bsc or --network bscTestnet for token commands."
    );
  }
}
function openBonding(ctx, options = {}) {
  requireLaunchpad(ctx.net);
  const publicClient = publicClientFor(ctx.net, ctx.rpcUrl);
  if (options.readOnly) {
    const sdk2 = bitagent.withPublicClient(publicClient).network(ctx.net.chainId, BOND_VERSION);
    return { net: ctx.net, wallet: "", canSign: false, sdk: sdk2 };
  }
  const account = requireAccount();
  const walletClient = walletClientFor(ctx.net, ctx.rpcUrl);
  const sdk = bitagent.withWalletClient(walletClient).withPublicClient(publicClient).network(ctx.net.chainId, BOND_VERSION);
  return { net: ctx.net, wallet: account.address, canSign: true, sdk };
}
function resolveReserve(net, symbol) {
  const reserve = net.reserves[symbol.toUpperCase()];
  if (!reserve) {
    throw new CliError(
      `Unsupported reserve token "${symbol}" on ${net.label}.`,
      `Supported: ${Object.keys(net.reserves).join(", ")}`
    );
  }
  return reserve;
}
function predictTokenAddress(session, symbol) {
  if (!session.wallet) throw new CliError("A signing wallet is required to derive the address.");
  return session.sdk.token(symbol.toUpperCase(), session.wallet).getTokenAddress();
}
async function launchToken(session, params) {
  if (!session.canSign || !session.wallet) {
    throw new CliError("Launching a token requires a signing wallet.");
  }
  const token = session.sdk.token(params.symbol.toUpperCase(), session.wallet);
  const tokenAddress = token.getTokenAddress();
  const receipt = await token.create({
    name: params.name,
    agentHash: params.agentHash,
    reserveToken: { address: params.reserve.address, decimals: params.reserve.decimals },
    curveData: {
      curveType: "EXPONENTIAL",
      stepCount: params.reserve.stepCount,
      maxSupply: MAX_SUPPLY_AT_CURVE,
      initialMintingPrice: params.reserve.initialPrice,
      finalMintingPrice: params.reserve.initialPrice * 10,
      creatorAllocation: params.creatorAllocation
    },
    buyRoyalty: params.buyRoyalty,
    sellRoyalty: params.sellRoyalty,
    onError: (e) => {
      throw asCliError(e, "The on-chain token creation failed.");
    }
  });
  if (!receipt || receipt.status !== "success") {
    throw new CliError("The on-chain token creation did not succeed.");
  }
  return { tokenAddress, receipt };
}
function tokenHandle(session, tokenAddress, creator) {
  return session.sdk.token(tokenAddress, creator);
}
async function curveDetail(token) {
  const detail = await token.getDetail();
  const info2 = detail.info;
  const progress = info2.maxSupply > 0n ? Number(info2.currentSupply * 10000n / info2.maxSupply) / 1e4 : 0;
  return {
    name: info2.name,
    symbol: info2.symbol,
    decimals: info2.decimals,
    creator: info2.creator,
    currentSupply: info2.currentSupply,
    maxSupply: info2.maxSupply,
    priceForNextMint: info2.priceForNextMint,
    reserveSymbol: info2.reserveSymbol,
    reserveDecimals: info2.reserveDecimals,
    reserveBalance: info2.reserveBalance,
    mintRoyalty: detail.mintRoyalty,
    burnRoyalty: detail.burnRoyalty,
    // The contract stores rates as amount * rate / 10000.
    mintRoyaltyPercent: detail.mintRoyalty / 100,
    burnRoyaltyPercent: detail.burnRoyalty / 100,
    progress
  };
}
async function quoteBuy(token, reserveSpend) {
  const detail = await token.getDetail();
  const tokenAmount = binaryReverseMint({
    reserveAmount: reserveSpend,
    bondSteps: detail.steps,
    currentSupply: detail.info.currentSupply,
    maxSupply: detail.info.maxSupply,
    multiFactor: parseEther("1"),
    mintRoyalty: detail.mintRoyalty,
    slippage: 0
  });
  if (tokenAmount <= 0n) {
    throw new CliError(
      "That reserve amount is too small to buy any tokens at the current price."
    );
  }
  const [reserveAmount, royalty] = await token.getBuyEstimation(tokenAmount);
  return {
    tokenAmount,
    reserveAmount,
    royalty,
    reserveSymbol: detail.info.reserveSymbol,
    reserveDecimals: detail.info.reserveDecimals
  };
}
async function quoteSell(token, tokenAmount) {
  const detail = await token.getDetail();
  const [reserveAmount, royalty] = await token.getSellEstimation(tokenAmount);
  return {
    tokenAmount,
    reserveAmount,
    royalty,
    reserveSymbol: detail.info.reserveSymbol,
    reserveDecimals: detail.info.reserveDecimals
  };
}
async function executeTrade(token, side, amount, slippage) {
  const params = {
    amount,
    slippage,
    onError: (e) => {
      throw asCliError(e, `The ${side} transaction failed.`);
    },
    onSignatureRequest: () => step("Waiting for the transaction signature \u2026"),
    onSuccess: () => void 0
  };
  const receipt = side === "buy" ? await token.buy(params) : await token.sell(params);
  if (!receipt || receipt.status !== "success") {
    throw new CliError(`The ${side} transaction did not succeed.`);
  }
  return receipt;
}
function asCliError(e, prefix) {
  const record = e;
  const detail = record?.shortMessage ?? record?.details ?? record?.message ?? String(e);
  return new CliError(`${prefix} ${detail}`);
}

// src/commands/token.ts
function registerTokenCommands(program2) {
  const token = program2.command("token").description("Launch and trade agent tokens on the bonding curve");
  token.command("launch").description("Deploy a new agent token on a bonding curve").requiredOption("--name <name>", "Project name").requiredOption("--symbol <symbol>", "Ticker, e.g. MYAGENT").option("--reserve <symbol>", "Reserve token: UB, USD1 or WBNB", "UB").option("--description <text>", "Short description shown on the project page").option("--image <url>", "Logo URL", "https://bitagent.io/logo.png").option("--buy-royalty <percent>", "Buy royalty, in percent", "1").option("--sell-royalty <percent>", "Sell royalty, in percent", "1").option("--creator-allocation <amount>", "Tokens minted to you at launch", "0").option("-y, --yes", "Skip the confirmation prompt").action(async function() {
    const ctx = resolveContext(this);
    const options = this.opts();
    const session = openBonding(ctx);
    const reserve = resolveReserve(ctx.net, options.reserve);
    const symbol = options.symbol.toUpperCase();
    const description = options.description ?? `${options.name} token`;
    const tokenAddress = predictTokenAddress(session, symbol);
    heading("Launch");
    kv([
      ["network", `${ctx.net.label} (${ctx.net.chainId})`],
      ["name", options.name],
      ["symbol", symbol],
      ["reserve", `${reserve.symbol} (${reserve.address})`],
      ["curve", `exponential, ${reserve.stepCount} steps`],
      ["initial price", `${reserve.initialPrice} ${reserve.symbol}`],
      ["curve supply", MAX_SUPPLY_AT_CURVE.toLocaleString("en-US")],
      ["royalties", `${options.buyRoyalty}% buy / ${options.sellRoyalty}% sell`],
      ["creator", session.wallet],
      ["token address", tokenAddress]
    ]);
    await showNativeBalance(ctx, session.wallet);
    if (!options.yes && !await confirm(`
Launch ${symbol} on ${ctx.net.label}?`, false)) {
      throw new CliError("Cancelled.");
    }
    const apiToken = await bitagentToken(ctx.net, ctx.bitagent);
    step("Registering the project with the launchpad \u2026");
    const agentHash = await BitagentClient.from(ctx).deployAgent(
      {
        name: options.name,
        ticker: symbol,
        description,
        image: options.image,
        token: tokenAddress,
        chain_id: ctx.net.chainId,
        version: BOND_VERSION,
        market_type: "bonding_curve"
      },
      apiToken
    );
    success(`Registered \u2014 agent hash ${agentHash}`);
    step("Submitting the on-chain transaction \u2026");
    const launched = await launchToken(session, {
      name: options.name,
      symbol,
      reserve,
      agentHash,
      buyRoyalty: Number(options.buyRoyalty),
      sellRoyalty: Number(options.sellRoyalty),
      creatorAllocation: Number(options.creatorAllocation)
    });
    const projectUrl = `${ctx.net.webBase}/agents/${launched.tokenAddress}`;
    result(
      {
        token: launched.tokenAddress,
        agentHash,
        transactionHash: launched.receipt.transactionHash,
        url: projectUrl,
        network: ctx.net.name,
        chainId: ctx.net.chainId
      },
      () => {
        info("");
        success(`${symbol} launched`);
        kv([
          ["token", launched.tokenAddress],
          ["tx", txUrl(ctx.net, launched.receipt.transactionHash)],
          ["project", projectUrl]
        ]);
        hint(`Buy the first tokens: bitagent token buy ${launched.tokenAddress} --amount 0.1`);
      }
    );
  });
  token.command("buy <tokenAddress>").description("Buy tokens on the curve, spending reserve tokens").requiredOption("--amount <amount>", "Reserve token amount to spend").option("--slippage <bps>", "Slippage tolerance in SDK units (50 = 0.5%)", String(DEFAULT_SLIPPAGE)).option("-y, --yes", "Skip the confirmation prompt").action(async function(tokenAddress) {
    await trade(this, "buy", tokenAddress);
  });
  token.command("sell <tokenAddress>").description("Sell tokens back into the curve").requiredOption("--amount <amount>", "Token amount to sell").option("--slippage <bps>", "Slippage tolerance in SDK units (50 = 0.5%)", String(DEFAULT_SLIPPAGE)).option("-y, --yes", "Skip the confirmation prompt").action(async function(tokenAddress) {
    await trade(this, "sell", tokenAddress);
  });
  token.command("quote <tokenAddress>").description("Price a trade without sending a transaction").requiredOption("--side <side>", "buy | sell").requiredOption("--amount <amount>", "Reserve amount for buy, token amount for sell").action(async function(tokenAddress) {
    const ctx = resolveContext(this);
    const options = this.opts();
    const side = options.side.toLowerCase();
    if (side !== "buy" && side !== "sell") {
      throw new CliError(`--side must be "buy" or "sell".`);
    }
    const { handle, detail } = await openToken(ctx, tokenAddress, { readOnly: true });
    const quote = side === "buy" ? await quoteBuy(handle, parseUnits2(options.amount, detail.reserveDecimals)) : await quoteSell(handle, parseEther2(options.amount));
    const tokens = formatEther3(quote.tokenAmount);
    const reserve = formatUnits3(quote.reserveAmount, quote.reserveDecimals);
    const royalty = formatUnits3(quote.royalty, quote.reserveDecimals);
    const unitPrice = Number(tokens) > 0 ? String(Number(reserve) / Number(tokens)) : "0";
    result(
      {
        side,
        token: tokenAddress,
        tokenAmount: tokens,
        reserveAmount: reserve,
        reserveSymbol: quote.reserveSymbol,
        royalty,
        unitPrice
      },
      () => {
        heading(`${side === "buy" ? "Buy" : "Sell"} quote \u2014 ${detail.symbol}`);
        kv([
          [side === "buy" ? "you spend" : "you receive", `${reserve} ${quote.reserveSymbol}`],
          [side === "buy" ? "you receive" : "you sell", `${tokens} ${detail.symbol}`],
          ["royalty", `${royalty} ${quote.reserveSymbol}`],
          ["price per token", `${unitPrice} ${quote.reserveSymbol}`]
        ]);
      }
    );
  });
  token.command("info <tokenAddress>").description("Show the curve state of a token").action(async function(tokenAddress) {
    const ctx = resolveContext(this);
    const { detail, creator } = await openToken(ctx, tokenAddress, { readOnly: true });
    const supply = formatEther3(detail.currentSupply);
    const maxSupply = formatEther3(detail.maxSupply);
    const price2 = formatUnits3(detail.priceForNextMint, detail.reserveDecimals);
    const reserveBalance = formatUnits3(detail.reserveBalance, detail.reserveDecimals);
    result(
      {
        token: tokenAddress,
        name: detail.name,
        symbol: detail.symbol,
        creator,
        currentSupply: supply,
        maxSupply,
        progress: detail.progress,
        priceForNextMint: price2,
        reserveSymbol: detail.reserveSymbol,
        reserveBalance,
        buyRoyaltyPercent: detail.mintRoyaltyPercent,
        sellRoyaltyPercent: detail.burnRoyaltyPercent,
        url: `${ctx.net.webBase}/agents/${tokenAddress}`
      },
      () => {
        heading(`${detail.name} ($${detail.symbol})`);
        kv([
          ["token", tokenAddress],
          ["creator", creator],
          ["price", `${price2} ${detail.reserveSymbol}`],
          ["supply", `${supply} / ${maxSupply}`],
          ["curve progress", `${(detail.progress * 100).toFixed(2)}%`],
          ["reserve locked", `${reserveBalance} ${detail.reserveSymbol}`],
          [
            "royalties",
            `${detail.mintRoyaltyPercent}% buy / ${detail.burnRoyaltyPercent}% sell`
          ],
          ["explorer", addressUrl(ctx.net, tokenAddress)],
          ["project", `${ctx.net.webBase}/agents/${tokenAddress}`]
        ]);
      }
    );
  });
  token.command("balance <tokenAddress>").description("Your balance of a curve token").option("--wallet <address>", "Check another address").action(async function(tokenAddress) {
    const ctx = resolveContext(this);
    const { wallet: override } = this.opts();
    const own = resolveCredentials().wallet;
    if (!override && !own) {
      throw new CliError("No wallet to check.", "Pass --wallet, or run `bitagent configure`.");
    }
    const wallet = override ?? own;
    const client = publicClientFor(ctx.net, ctx.rpcUrl);
    const [balance, decimals, symbol] = await Promise.all([
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi2,
        functionName: "balanceOf",
        args: [wallet]
      }),
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi2,
        functionName: "decimals"
      }),
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi2,
        functionName: "symbol"
      })
    ]);
    const amount = formatUnits3(balance, decimals);
    result({ wallet, token: tokenAddress, symbol, balance: amount }, () => {
      kv([
        ["wallet", wallet],
        ["token", `${symbol} (${tokenAddress})`],
        ["balance", amount]
      ]);
    });
  });
}
async function openToken(ctx, tokenAddress, options = {}) {
  requireLaunchpad(ctx.net);
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    throw new CliError(`"${tokenAddress}" is not a token address.`);
  }
  const session = openBonding(ctx, options);
  const creator = await BitagentClient.from(ctx).creatorOf(
    tokenAddress,
    session.wallet || void 0
  );
  const handle = tokenHandle(session, tokenAddress, creator);
  if (!await handle.exists()) {
    throw new CliError(
      `No bonding-curve token at ${tokenAddress} on ${ctx.net.label}.`,
      "Check --network."
    );
  }
  return { session, handle, detail: await curveDetail(handle), creator };
}
async function trade(command, side, tokenAddress) {
  const ctx = resolveContext(command);
  const options = command.opts();
  const slippage = Number(options.slippage);
  if (!Number.isFinite(slippage) || slippage < 0) {
    throw new CliError(`Invalid --slippage "${options.slippage}".`);
  }
  const { handle, detail } = await openToken(ctx, tokenAddress);
  const quote = side === "buy" ? await quoteBuy(handle, parseUnits2(options.amount, detail.reserveDecimals)) : await quoteSell(handle, parseEther2(options.amount));
  const tokens = formatEther3(quote.tokenAmount);
  const reserve = formatUnits3(quote.reserveAmount, quote.reserveDecimals);
  heading(`${side === "buy" ? "Buy" : "Sell"} ${detail.symbol}`);
  kv([
    ["network", `${ctx.net.label} (${ctx.net.chainId})`],
    ["token", tokenAddress],
    [side === "buy" ? "you spend" : "you receive", `${reserve} ${quote.reserveSymbol}`],
    [side === "buy" ? "you receive" : "you sell", `${tokens} ${detail.symbol}`],
    ["slippage", `${slippage / 100}%`]
  ]);
  if (!options.yes) {
    const label = side === "buy" ? `Spend ${reserve} ${quote.reserveSymbol}` : `Sell ${tokens} ${detail.symbol}`;
    if (!await confirm(`
${label} on ${ctx.net.label}?`, false)) {
      throw new CliError("Cancelled.");
    }
  }
  const receipt = await executeTrade(handle, side, quote.tokenAmount, slippage);
  result(
    {
      side,
      token: tokenAddress,
      symbol: detail.symbol,
      tokenAmount: tokens,
      reserveAmount: reserve,
      reserveSymbol: quote.reserveSymbol,
      transactionHash: receipt.transactionHash,
      url: txUrl(ctx.net, receipt.transactionHash)
    },
    () => {
      info("");
      success(`${side === "buy" ? "Bought" : "Sold"} ${tokens} ${detail.symbol}`);
      kv([["tx", txUrl(ctx.net, receipt.transactionHash)]]);
    }
  );
}
async function showNativeBalance(ctx, wallet) {
  const balance = await publicClientFor(ctx.net, ctx.rpcUrl).getBalance({ address: wallet }).catch(() => void 0);
  if (balance === void 0) return;
  kv([["gas balance", `${formatEther3(balance)} ${ctx.net.chain.nativeCurrency.symbol}`]]);
}

// bin/bitagent.ts
var require2 = createRequire(import.meta.url);
function version() {
  for (const path2 of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require2(path2);
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
    }
  }
  return "0.0.0";
}
var program = new Command();
program.name("bitagent").version(version()).description("BitAgent CLI \u2014 hire agents, run agents, and trade agent tokens").option("-n, --network <name>", `Network or chain id. ${networkChoicesHelp()}`).option("--json", "Print the result as JSON on stdout (logs go to stderr)").option("--aip-endpoint <url>", "Override the AIP platform API base URL").option("--gateway-url <url>", "Override the AIP gateway base URL").option("--bitagent-api <url>", "Override the BitAgent product API base URL").option("--rpc-url <url>", "Override the JSON-RPC endpoint for on-chain calls").hook("preAction", (root) => {
  setJsonMode(Boolean(root.opts().json));
}).addHelpText(
  "after",
  `
Get started:
  bitagent configure                 authorize this machine and pick a network
  bitagent browse "solidity audit"   find an agent that can do the work
  bitagent terminal activate         create your personal Terminal agent
  bitagent terminal chat             describe a task in plain language

Run an agent:
  bitagent agent register --name "My Agent" --handle my-agent --offering "echo:0.01:Echo text"
  bitagent agent serve --exec "python handler.py"

Settle work directly (ERC-8183):
  bitagent job create --description "Audit my contract" --reward 10
  bitagent job accept <id> --provider <agent-id>
  bitagent job submit <id> --provider <agent-id> --file report.json
  bitagent job complete <id>

Launchpad (BSC only):
  bitagent token launch --name "My Agent" --symbol MYAG --reserve UB
  bitagent token buy <token> --amount 0.1
`
);
registerConfigureCommand(program);
registerAuthCommands(program);
registerMarketCommands(program);
registerAgentCommands(program);
registerJobCommands(program);
registerTerminalCommands(program);
registerTokenCommands(program);
registerSkillCommands(program);
function report2(error) {
  if (isCliError(error)) {
    fail(error.message);
    if (error.hint) hint(error.hint);
    process.exit(error.exitCode);
  }
  fail(error instanceof Error ? error.message : String(error));
  if (process.env.BITAGENT_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(error.stack + "\n");
  } else {
    hint("Set BITAGENT_DEBUG=1 for a stack trace.");
  }
  process.exit(1);
}
process.on("unhandledRejection", report2);
try {
  await program.parseAsync();
} catch (error) {
  report2(error);
}
