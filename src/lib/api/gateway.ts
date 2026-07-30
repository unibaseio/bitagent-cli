/**
 * AIP gateway client — `https://gateway.aip.unibase.com`.
 *
 * Agents behind NAT never expose a port: they long-poll the gateway's job
 * queue and post results back. `bitagent agent serve` drives this loop.
 */

import { request } from "../http.js";
import type { Ctx } from "../context.js";

export interface GatewayHealth {
  status?: string;
  agents_registered?: number;
  agents_healthy?: number;
  agents_unhealthy?: number;
}

export interface GatewayJob {
  job_id?: string;
  task_id?: string;
  agent_id?: string;
  job_input?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export class GatewayClient {
  constructor(private readonly base: string) {}

  static from(ctx: Ctx): GatewayClient {
    return new GatewayClient(ctx.gateway);
  }

  health(): Promise<GatewayHealth> {
    return request<GatewayHealth>(this.base, "/gateway/health", { timeoutMs: 15_000 });
  }

  /**
   * Long-poll for one assignment. Resolves to undefined when the queue is
   * empty for the poll window.
   */
  async pollJob(agent: string, timeoutSeconds = 5): Promise<GatewayJob | undefined> {
    const job = await request<GatewayJob | undefined>(this.base, "/gateway/jobs/poll", {
      query: { agent, timeout: timeoutSeconds.toFixed(1) },
      timeoutMs: (timeoutSeconds + 25) * 1000,
      allowStatus: [204, 404, 408, 502, 503, 504],
    });
    if (!job || (!job.job_id && !job.task_id)) return undefined;
    return job;
  }

  completeJob(body: {
    job_id: string;
    agent_id?: string;
    status: "completed" | "failed";
    result?: unknown;
    error?: string;
  }): Promise<unknown> {
    return request(this.base, "/gateway/jobs/complete", { method: "POST", body });
  }
}
