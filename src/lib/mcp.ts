/**
 * MCP (Model Context Protocol) server over stdio.
 *
 * `bitagent mcp` turns this CLI into an MCP server any harness can mount
 * (Claude Code, Cursor, GPT desktop, ...):
 *
 *   { "mcpServers": { "bitagent": { "command": "bitagent", "args": ["mcp"] } } }
 *
 * Design notes:
 *
 * - stdout is the protocol channel. Every logger in output.ts already
 *   writes to stderr, so nothing in the existing lib can corrupt framing.
 * - Tools reuse the exact same lib layer as the commands; a tool call is
 *   the command's action minus the rendering.
 * - Read-only tools need no credentials. Terminal tools resolve the same
 *   credential chain as the CLI (env → ~/.config/bitagent/config.json)
 *   and fail with a "run `bitagent configure`" message when absent.
 * - `terminal_chat` can SPEND: the Terminal agent funds ERC-8183 escrow
 *   from the user's proxy wallet when it hires a provider. The tool
 *   description says so, so harnesses can require human approval for it.
 * - Every tool takes an optional `network`; per-call Ctx falls back to
 *   the server default (--network / BITAGENT_NETWORK / saved config).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AipClient, type Agent, type Service } from "./api/aip.js";
import { buildContext, type Ctx, type GlobalOptions } from "./context.js";
import { resolveCredentials, type Credentials } from "./credentials.js";
import { NETWORKS } from "./chains.js";

/** Substituted at build time; matches the CLI version reported by --version. */
declare const __BITAGENT_CLI_VERSION__: string | undefined;

const serverVersion = (): string =>
  typeof __BITAGENT_CLI_VERSION__ === "string" ? __BITAGENT_CLI_VERSION__ : "0.0.0";

const networkNames = Object.values(NETWORKS)
  .map((n) => n.name)
  .join(" | ");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const err = (error: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: error instanceof Error ? error.message : String(error),
    },
  ],
  isError: true,
});

/** Wraps a handler so thrown errors become MCP tool errors, not crashes. */
const guard =
  <A>(handler: (args: A) => Promise<ToolResult>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return err(error);
    }
  };

const jwtOrThrow = (): Credentials => {
  const credentials = resolveCredentials();
  if (!credentials.token) {
    throw new Error(
      "Not authorized: the Terminal tools need a Unibase Pay JWT. Run `bitagent configure` in a terminal and choose browser authorization.",
    );
  }
  return credentials;
};

const matches = (query: string, ...fields: Array<string | undefined>): boolean => {
  if (!query) return true;
  const needle = query.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(needle));
};

/** Trimmed agent row for list outputs — full cards are get_agent's job. */
const agentSummary = (agent: Agent) => ({
  agent_id: agent.agent_id,
  handle: agent.handle,
  name: agent.display_name || agent.card?.name,
  description: agent.card?.description,
  price: agent.price,
  health_status: agent.health_status,
  skills: agent.card?.skills?.map((s) => s.name),
});

const serviceSummary = (service: Service) => ({
  id: service.id,
  name: service.name,
  agent_id: service.agent_id,
  price: service.price_v2 ?? service.price,
  description: service.description,
});

const networkParam = {
  network: z
    .string()
    .optional()
    .describe(`Target network (${networkNames}) or a raw chain id. Defaults to the configured network.`),
};

export async function startMcpServer(defaults: GlobalOptions): Promise<void> {
  const ctxFor = (network?: string): Ctx =>
    buildContext({ ...defaults, network: network || defaults.network });

  const server = new McpServer({ name: "bitagent", version: serverVersion() });

  // ------------------------------------------------------------ read-only

  server.registerTool(
    "browse_agents",
    {
      title: "Browse agents",
      description:
        "Search the BitAgent marketplace for agents by name, handle, description or skill. Read-only.",
      inputSchema: {
        query: z.string().optional().describe("Keyword filter; empty lists everything"),
        limit: z.number().int().min(1).max(100).default(20),
        ...networkParam,
      },
    },
    guard(async ({ query = "", limit = 20, network }) => {
      const aip = AipClient.from(ctxFor(network));
      const page = await aip.listAgents({ pageSize: 100, include_health: true });
      const rows = (page.data ?? [])
        .filter((a) =>
          matches(
            query,
            a.handle,
            a.display_name,
            a.card?.name,
            a.card?.description,
            a.card?.skills?.map((s) => s.name ?? "").join(" "),
          ),
        )
        .slice(0, limit)
        .map(agentSummary);
      return ok({ total_matched: rows.length, agents: rows });
    }),
  );

  server.registerTool(
    "get_agent",
    {
      title: "Get agent",
      description:
        "Full agent card by agent id (chain:registry:index) or handle: skills, job offerings with prices, endpoint, socials. Read-only.",
      inputSchema: {
        agent: z.string().describe("Agent id (contains ':') or handle"),
        ...networkParam,
      },
    },
    guard(async ({ agent, network }) => {
      const aip = AipClient.from(ctxFor(network));
      const result = agent.includes(":")
        ? await aip.getAgent(agent)
        : await aip.getAgentByHandle(agent);
      return ok(result);
    }),
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "Purchasable job offerings on the marketplace, optionally filtered by keyword. Read-only.",
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        ...networkParam,
      },
    },
    guard(async ({ query = "", limit = 20, network }) => {
      const aip = AipClient.from(ctxFor(network));
      const page = await aip.listServices({ pageSize: 100 });
      const rows = (page.data ?? [])
        .filter((s) => matches(query, s.name, s.description))
        .slice(0, limit)
        .map(serviceSummary);
      return ok({ total_matched: rows.length, services: rows });
    }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "Open tasks posted on the marketplace. Read-only.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        ...networkParam,
      },
    },
    guard(async ({ limit = 20, network }) => {
      const aip = AipClient.from(ctxFor(network));
      const page = await aip.listTasks({ pageSize: limit });
      return ok(page.data ?? []);
    }),
  );

  server.registerTool(
    "rankings",
    {
      title: "Agent rankings",
      description: "Leaderboard of top-performing agents by revenue or tasks. Read-only.",
      inputSchema: {
        metric: z.enum(["revenue", "tasks"]).default("revenue"),
        limit: z.number().int().min(1).max(100).default(10),
        ...networkParam,
      },
    },
    guard(async ({ metric = "revenue", limit = 10, network }) => {
      const aip = AipClient.from(ctxFor(network));
      return ok(await aip.rankings({ metric, limit }));
    }),
  );

  server.registerTool(
    "platform_stats",
    {
      title: "Platform stats",
      description: "Aggregate platform statistics (agents, revenue, services, tasks). Read-only.",
      inputSchema: { ...networkParam },
    },
    guard(async ({ network }) => ok(await AipClient.from(ctxFor(network)).stats())),
  );

  // ------------------------------------------------- authenticated (JWT)

  server.registerTool(
    "terminal_status",
    {
      title: "Terminal status",
      description:
        "Status of the user's personal Terminal agent on the target network (agent id, proxy wallet). Requires `bitagent configure`.",
      inputSchema: { ...networkParam },
    },
    guard(async ({ network }) => {
      const credentials = jwtOrThrow();
      const aip = AipClient.from(ctxFor(network));
      const butler = await aip.butlerStatus(credentials.token, credentials.wallet);
      if (!butler?.agent_id) {
        return ok({
          activated: false,
          hint: "No Terminal agent on this network yet. Run `bitagent terminal activate` in a terminal (it signs an activation message).",
        });
      }
      return ok({ activated: true, ...butler });
    }),
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List Terminal conversations",
      description: "The user's Terminal conversations on the target network. Requires `bitagent configure`.",
      inputSchema: { ...networkParam },
    },
    guard(async ({ network }) => {
      const credentials = jwtOrThrow();
      const aip = AipClient.from(ctxFor(network));
      const result = await aip.conversations(credentials.token);
      return ok(result.conversations ?? []);
    }),
  );

  server.registerTool(
    "conversation_history",
    {
      title: "Conversation history",
      description: "Messages of one Terminal conversation. Requires `bitagent configure`.",
      inputSchema: {
        conversationId: z.string().describe("Conversation id from list_conversations"),
        ...networkParam,
      },
    },
    guard(async ({ conversationId, network }) => {
      const credentials = jwtOrThrow();
      const aip = AipClient.from(ctxFor(network));
      return ok(await aip.conversationHistory(conversationId, credentials.token));
    }),
  );

  server.registerTool(
    "terminal_chat",
    {
      title: "Chat with the Terminal agent",
      description:
        "Send a message to the user's Terminal agent. CAN SPEND FUNDS: when the message asks to hire an agent, the Terminal drives the full ERC-8183 escrow flow (createJob / setBudget / fund) from the user's proxy wallet. State a budget in the message (e.g. 'budget 0.01 USDC'). Requires `bitagent configure` and a previously activated Terminal.",
      inputSchema: {
        message: z.string().describe("Natural-language instruction, ideally with an explicit budget"),
        conversationId: z
          .string()
          .optional()
          .describe("Continue an existing conversation; omit to start a new one"),
        ...networkParam,
      },
    },
    guard(async ({ message, conversationId, network }) => {
      const credentials = jwtOrThrow();
      const ctx = ctxFor(network);
      const aip = AipClient.from(ctx);
      const butler = await aip.butlerStatus(credentials.token, credentials.wallet);
      if (!butler?.agent_id) {
        throw new Error(
          `No Terminal agent on ${ctx.net.label}. Run \`bitagent terminal activate\` in a terminal first.`,
        );
      }
      const convo =
        conversationId ||
        `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const reply = await aip.invoke(
        butler.agent_id,
        {
          message,
          chain_id: ctx.net.chainId,
          context: {
            conversation_id: convo,
            metadata: { chain_id: ctx.net.chainId, source: "bitagent-mcp" },
          },
        },
        credentials.token,
      );
      return ok({ conversation_id: convo, reply });
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until the client closes stdin.
  await new Promise<void>((resolvePromise) => {
    transport.onclose = () => resolvePromise();
  });
}
