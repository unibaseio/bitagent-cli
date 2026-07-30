/**
 * ERC-8004 agent card and the `/agents/register` request body.
 *
 * The wire format here is byte-compatible with the AIP SDKs
 * (`aip-ts-sdk/src/types.ts`, `aip-go-sdk/types`, `aip_sdk.types`) so an agent
 * registered from the CLI is indistinguishable from one registered by an SDK.
 * Keep the two in step when the SDK contract changes.
 */

export const AGENT_CARD_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

export interface SkillInput {
  name: string;
  fieldType: string;
  description: string;
}

export interface SkillConfig {
  name: string;
  description: string;
  inputs?: SkillInput[];
  outputs?: SkillInput[];
}

export interface CostModel {
  baseCallFee?: number;
  perAgentCallFee?: number;
  perUseFee?: number;
  perWriteFee?: number;
  perTokenFee?: number;
  customFees?: Record<string, number>;
}

export interface JobOfferingConfig {
  id: string | number;
  name: string;
  description?: string;
  price: number;
  priceV2?: Record<string, unknown>;
  slaMinutes?: number;
  requiredFunds?: boolean;
  active: boolean;
}

export interface AgentConfig {
  name: string;
  handle?: string;
  description?: string;
  endpointUrl?: string;
  skills?: SkillConfig[];
  capabilities?: string[];
  costModel?: CostModel;
  currency?: string;
  metadata?: Record<string, unknown>;
  jobOfferings?: JobOfferingConfig[];
  jobResources?: Array<Record<string, unknown>>;
  chainId?: number;
  /** Token-less auth: EIP-191 signature over `message`. */
  signature?: string;
  message?: string;
}

const defaultSupportedTrust = (): string[] => [
  "reputation",
  "crypto-economic",
  "tee-attestation",
];

const defaultTrustModels = (): string[] => [
  "feedback",
  "inference-validation",
  "tee-attestation",
];

export const handleOrName = (config: AgentConfig): string =>
  config.handle || config.name.toLowerCase().replaceAll(" ", "_");

export const price = (config: AgentConfig): number => config.costModel?.baseCallFee || 0.001;

function skillToMap(skill: SkillConfig): Record<string, unknown> {
  const field = (item: SkillInput): Record<string, unknown> => ({
    name: item.name,
    field_type: item.fieldType,
    description: item.description,
  });
  return {
    name: skill.name,
    description: skill.description,
    inputs: (skill.inputs ?? []).map(field),
    outputs: (skill.outputs ?? []).map(field),
  };
}

function costModelToMap(model: CostModel): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  if (model.baseCallFee !== undefined) map.base_call_fee = model.baseCallFee;
  if (model.perAgentCallFee !== undefined) map.per_agent_call_fee = model.perAgentCallFee;
  if (model.perUseFee !== undefined) map.per_use_fee = model.perUseFee;
  if (model.perWriteFee !== undefined) map.per_write_fee = model.perWriteFee;
  if (model.perTokenFee !== undefined) map.per_token_fee = model.perTokenFee;
  map.custom_fees = model.customFees ?? {};
  return map;
}

/** Synthesize the ERC-8004 agent card the platform stores and serves. */
export function toAgentCard(config: AgentConfig): Record<string, unknown> {
  const handle = handleOrName(config);
  const url = config.endpointUrl || `http://localhost:8000/agents/${handle}/`;
  // Consumers append /.well-known/agent-card.json themselves.
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
      { name: "web", endpoint: url },
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
      ...(config.capabilities?.length ? { tags: config.capabilities } : {}),
      inputModes: ["text/plain"],
      outputModes: ["application/json"],
    })),
    jobOfferings: config.jobOfferings ?? null,
    jobResources: config.jobResources ?? null,
    trustModels: defaultTrustModels(),
    provider: { organization: "BitAgent", url: "https://bitagent.io" },
  };
}

/** Build the POST /agents/register body. */
export function toRegistrationMap(config: AgentConfig): Record<string, unknown> {
  const skills = config.skills ?? [];
  const payload: Record<string, unknown> = {
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
    chain_id: config.chainId ?? 97,
  };
  if (config.signature) {
    payload.signature = config.signature;
    if (config.message) payload.message = config.message;
  }
  return payload;
}

/** The fixed message the platform recovers the wallet from in key mode. */
export const REGISTER_MESSAGE = "Create an AIP agent";
