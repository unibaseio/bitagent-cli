/**
 * AIP platform API client — `https://api.aip.unibase.com`.
 *
 * Covers the surface documented in unibase-aip's API.md: agent discovery,
 * services, market tasks, the ERC-8183 job lifecycle, the Terminal (butler)
 * agent, conversations and platform statistics.
 */

import { request, streamSse, type Query } from "../http.js";
import type { Ctx } from "../context.js";

export interface Paged<T> {
  data: T[];
  total?: number;
  page?: number;
  pageSize?: number;
}

export interface AgentPrice {
  amount?: number;
  currency?: string;
  symbol?: string;
}

export interface JobOffering {
  id?: string | number;
  name?: string;
  description?: string;
  price?: number;
  priceV2?: AgentPrice;
  active?: boolean;
  slaMinutes?: number;
}

export interface AgentCardSummary {
  name?: string;
  description?: string;
  url?: string;
  skills?: Array<{ name?: string; description?: string; tags?: string[] }>;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AgentStats {
  total_jobs?: number;
  completed_jobs?: number;
  total_revenue?: number;
  success_rate?: number;
}

export interface Agent {
  agent_id: string;
  handle?: string;
  display_name?: string;
  card?: AgentCardSummary;
  price?: AgentPrice;
  owner_id?: string;
  wallet_address?: string;
  chain_id?: number;
  health_status?: string;
  created_at?: string;
  stats?: AgentStats;
  services?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface Service {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  price?: string;
  price_v2?: AgentPrice;
  time?: number | string;
  provider?: string;
  agent_id?: string;
  agent_handle?: string;
  offering_id?: string;
  sla_minutes?: number;
  active?: boolean;
}

export interface MarketTask {
  task_id: string;
  title?: string;
  description?: string;
  reward_amount?: number;
  reward_token?: string;
  total_budget?: number;
  total_slots?: number;
  claimed_slots?: number;
  remaining_slots?: number;
  status?: string;
  creator_name?: string;
  due_date?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  completions?: Array<Record<string, unknown>>;
}

export interface JobRecord {
  job_id?: string | number;
  id?: string | number;
  description?: string;
  status?: string;
  client_id?: string;
  provider_id?: string;
  evaluator_id?: string;
  reward_amount?: number;
  reward_token?: string;
  deliverable_uri?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface Ranking {
  rank?: number;
  agent_id?: string;
  handle?: string;
  name?: string;
  avatar?: string | null;
  /** The value of the ranked metric — revenue or task count. */
  score?: number;
  metric?: string;
  [key: string]: unknown;
}

export interface PlatformStats {
  total_agents?: number;
  total_revenue?: number;
  total_services?: number;
  total_tasks?: number;
  revenue_growth_30d?: number;
  agents_growth_30d?: number;
  services_growth_30d?: number;
  tasks_growth_30d?: number;
}

export interface ButlerStatus {
  agent_id: string;
  handle?: string;
  display_name?: string;
  wallet_address?: string;
  chain_id?: number;
  card?: AgentCardSummary;
  stats?: AgentStats;
  [key: string]: unknown;
}

export interface InvokeResult {
  content?: string;
  role?: string;
  conversation_id?: string;
  cost?: number;
  [key: string]: unknown;
}

export interface Conversation {
  conversation_id: string;
  last_message?: string;
  message_count?: number;
  updated_at?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export class AipClient {
  constructor(
    private readonly base: string,
    private readonly chainId: number,
  ) {}

  static from(ctx: Ctx): AipClient {
    return new AipClient(ctx.aip, ctx.net.chainId);
  }

  private get<T>(path: string, query?: Query, token?: string): Promise<T> {
    return request<T>(this.base, path, { query: { chain_id: this.chainId, ...query }, token });
  }

  private post<T>(path: string, body?: unknown, query?: Query, token?: string): Promise<T> {
    return request<T>(this.base, path, {
      method: "POST",
      body: body ?? {},
      query: { chain_id: this.chainId, ...query },
      token,
    });
  }

  // ------------------------------------------------------------ discovery

  listAgents(query: Query = {}): Promise<Paged<Agent>> {
    return this.get<Paged<Agent>>("/agents", { page: 1, pageSize: 50, ...query });
  }

  getAgent(agentId: string): Promise<Agent> {
    return this.get<Agent>(`/agents/${encodeURIComponent(agentId)}`);
  }

  getAgentByHandle(handle: string): Promise<Agent> {
    return this.get<Agent>(`/agents/handle/${encodeURIComponent(handle)}`);
  }

  listServices(query: Query = {}): Promise<Paged<Service>> {
    return this.get<Paged<Service>>("/services", { page: 1, pageSize: 50, ...query });
  }

  getService(serviceId: string): Promise<Service> {
    return this.get<Service>(`/services/${encodeURIComponent(serviceId)}`);
  }

  listTasks(query: Query = {}): Promise<Paged<MarketTask>> {
    return this.get<Paged<MarketTask>>("/tasks", { limit: 20, offset: 0, ...query });
  }

  getTask(taskId: string): Promise<MarketTask> {
    return this.get<MarketTask>(`/tasks/${encodeURIComponent(taskId)}`);
  }

  /** Rankings are platform-wide: the endpoint ignores `chain_id`. */
  rankings(query: Query = {}): Promise<Ranking[]> {
    return request<Ranking[]>(this.base, "/rankings", {
      query: { metric: "revenue", limit: 10, ...query },
    });
  }

  stats(): Promise<PlatformStats> {
    return this.get<PlatformStats>("/stats/summary");
  }

  // ------------------------------------------------------------ my account

  myAgents(token: string): Promise<Agent[]> {
    return this.get<Agent[]>("/my-agents", {}, token);
  }

  myJobs(token: string, role = "any"): Promise<JobRecord[]> {
    return this.get<JobRecord[]>("/my-jobs", { role }, token);
  }

  // ------------------------------------------------------------ registration

  /** POST /agents/register — accepts a bearer token or an EIP-191 signature. */
  registerAgent(payload: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>(this.base, "/agents/register", {
      method: "POST",
      body: payload,
      token,
    });
  }

  // ------------------------------------------------------------ butler

  async butlerStatus(token: string, wallet?: string): Promise<ButlerStatus | undefined> {
    return await request<ButlerStatus | undefined>(this.base, "/butler", {
      query: { chain_id: this.chainId, wallet_address: wallet },
      token,
      allowStatus: [404],
    });
  }

  activateButler(
    body: { signature?: string; message?: string; chain_id: number; wallet_address?: string },
    token?: string,
  ): Promise<{ status?: string; agent_id?: string; wallet_address?: string }> {
    return request(this.base, "/butler/activate", { method: "POST", body, token });
  }

  butlerStats(token: string): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>("/butler/stats", {}, token);
  }

  // ------------------------------------------------------------ invoke

  invoke(
    agentId: string | undefined,
    body: Record<string, unknown>,
    token?: string,
  ): Promise<InvokeResult> {
    const path = agentId ? `/invoke/${encodeURIComponent(agentId)}` : "/invoke";
    return request<InvokeResult>(this.base, path, {
      method: "POST",
      body,
      token,
      timeoutMs: 600_000,
    });
  }

  invokeStream(
    agentId: string | undefined,
    body: Record<string, unknown>,
    token?: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const path = agentId ? `/invoke/${encodeURIComponent(agentId)}/stream` : "/invoke/stream";
    return streamSse(this.base, path, { method: "POST", body, token });
  }

  conversations(token: string): Promise<{ conversations?: Conversation[] }> {
    return this.get<{ conversations?: Conversation[] }>("/conversations", {}, token);
  }

  conversationHistory(
    conversationId: string,
    token: string,
  ): Promise<{ conversation_id?: string; messages?: ChatMessage[] }> {
    return this.get(`/conversations/${encodeURIComponent(conversationId)}/history`, {}, token);
  }

  // ------------------------------------------------------------ jobs (8183)

  createJob(
    clientId: string,
    body: {
      description: string;
      reward_amount: number;
      reward_token: string;
      evaluator_id?: string;
      expires_in?: number;
      metadata?: Record<string, unknown>;
    },
    token?: string,
  ): Promise<JobRecord> {
    return request<JobRecord>(this.base, "/v1/jobs", {
      method: "POST",
      body: { expires_in: 86_400, metadata: {}, ...body },
      query: { client_id: clientId, chain_id: this.chainId },
      token,
    });
  }

  getJob(jobId: string, token?: string): Promise<JobRecord> {
    return this.get<JobRecord>(`/v1/jobs/${encodeURIComponent(jobId)}`, {}, token);
  }

  acceptJob(jobId: string, providerId: string, token?: string): Promise<JobRecord> {
    return this.post<JobRecord>(
      `/v1/jobs/${encodeURIComponent(jobId)}/accept`,
      undefined,
      { provider_id: providerId },
      token,
    );
  }

  submitJob(
    jobId: string,
    body: { provider_id: string; deliverable_data: unknown; description?: string },
    token?: string,
  ): Promise<JobRecord> {
    return this.post<JobRecord>(`/v1/jobs/${encodeURIComponent(jobId)}/submit`, body, {}, token);
  }

  completeJob(
    jobId: string,
    body: { evaluator_id: string; reason?: string },
    token?: string,
  ): Promise<JobRecord> {
    return this.post<JobRecord>(`/v1/jobs/${encodeURIComponent(jobId)}/complete`, body, {}, token);
  }

  rejectJob(
    jobId: string,
    rejectorId: string,
    reason: string,
    token?: string,
  ): Promise<JobRecord> {
    return this.post<JobRecord>(
      `/v1/jobs/${encodeURIComponent(jobId)}/reject`,
      { reason },
      { rejector_id: rejectorId },
      token,
    );
  }
}
