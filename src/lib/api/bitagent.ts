/**
 * BitAgent product API client — `https://api.bitagent.io` /
 * `https://testnet-api.bitagent.io`.
 *
 * This is a different service from the AIP platform API with its own auth
 * (SIWE, see `credentials.bitagentToken`). It backs the launchpad: registering
 * an agent record before the on-chain bonding-curve deploy, and looking up the
 * creator of an existing token.
 */

import { request } from "../http.js";
import { CliError } from "../errors.js";
import type { Ctx } from "../context.js";

export interface LaunchpadAgent {
  id?: string;
  name?: string;
  ticker?: string;
  token?: string;
  creator?: string;
  description?: string;
  image?: string;
  chain_id?: number;
  version?: string;
  market_type?: string;
  [key: string]: unknown;
}

interface Envelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

export interface DeployAgentPayload {
  name: string;
  ticker: string;
  description: string;
  image: string;
  token: string;
  chain_id: number;
  version: string;
  market_type: string;
}

export class BitagentClient {
  constructor(private readonly base: string) {}

  static from(ctx: Ctx): BitagentClient {
    return new BitagentClient(ctx.bitagent);
  }

  /** Register the agent record that the on-chain `create` call references. */
  async deployAgent(payload: DeployAgentPayload, token: string): Promise<string> {
    const response = await request<Envelope<LaunchpadAgent> & LaunchpadAgent>(
      this.base,
      "/agent/deploy",
      { method: "POST", body: payload, token },
    );
    const id = response.data?.id ?? response.id;
    if (!id) {
      throw new CliError(
        `The launchpad did not return an agent id: ${JSON.stringify(response).slice(0, 300)}`,
      );
    }
    return id;
  }

  /** Look up a launchpad agent by its token address. */
  async agentByToken(tokenAddress: string): Promise<LaunchpadAgent | undefined> {
    const single = await request<Envelope<LaunchpadAgent> & LaunchpadAgent>(this.base, "/agent", {
      query: { token: tokenAddress },
      allowStatus: [404, 400],
    });
    const direct = single?.data ?? single;
    if (direct?.creator) return direct;

    const list = await request<Envelope<{ agents?: LaunchpadAgent[] }> & { agents?: LaunchpadAgent[] }>(
      this.base,
      "/agents",
      { query: { token: tokenAddress }, allowStatus: [404, 400] },
    );
    const agents = list?.data?.agents ?? list?.agents ?? [];
    const match = agents.find(
      (agent) => (agent.token ?? "").toLowerCase() === tokenAddress.toLowerCase(),
    );
    return match ?? agents[0];
  }

  /**
   * The creator address a bonding-curve token was deployed under — required
   * by the SDK to derive the token's bond parameters.
   */
  async creatorOf(tokenAddress: string, fallback?: string): Promise<`0x${string}`> {
    const agent = await this.agentByToken(tokenAddress).catch(() => undefined);
    if (agent?.creator) return agent.creator as `0x${string}`;
    if (fallback) return fallback as `0x${string}`;
    throw new CliError(
      `Could not find the creator for token ${tokenAddress} on this network.`,
      "Check that --network matches the chain the token was launched on.",
    );
  }
}
