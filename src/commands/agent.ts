/** Agent lifecycle: discover, inspect, register, and serve work from the queue. */

import { spawn } from "node:child_process";
import type { Command } from "commander";
import { AipClient, type Agent } from "../lib/api/aip.js";
import { GatewayClient, type GatewayJob } from "../lib/api/gateway.js";
import { resolveContext, type Ctx } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { loadConfig, updateConfig } from "../lib/config.js";
import {
  REGISTER_MESSAGE,
  toRegistrationMap,
  type AgentConfig,
  type JobOfferingConfig,
  type SkillConfig,
} from "../lib/agentCard.js";
import { aipAuth, requireCredentials } from "../lib/credentials.js";
import * as out from "../lib/output.js";

const POLL_BACKOFF_MS = 2_000;

export function registerAgentCommands(program: Command): void {
  const agent = program
    .command("agent")
    .description("Discover, register and run AIP agents");

  agent
    .command("list")
    .description("List agents registered on the marketplace")
    .option("--limit <n>", "Maximum rows", "30")
    .option("--handle <text>", "Only agents whose handle contains this text")
    .option("--no-health", "Skip the gateway health lookup (faster)")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const options = this.opts<{ limit: string; handle?: string; health: boolean }>();
      const page = await AipClient.from(ctx).listAgents({
        pageSize: Math.max(Number(options.limit), 100),
        include_health: options.health,
      });

      let agents = page.data ?? [];
      if (options.handle) {
        const needle = options.handle.toLowerCase();
        agents = agents.filter((a) => (a.handle ?? "").toLowerCase().includes(needle));
      }
      agents = agents.slice(0, Number(options.limit));

      out.result({ ...page, data: agents }, () => {
        out.heading(`Agents on ${ctx.net.label} (${agents.length} of ${page.total ?? agents.length})`);
        out.table(agents, [
          { header: "handle", value: (a) => a.handle ?? "—", max: 30 },
          { header: "name", value: (a) => a.display_name ?? a.card?.name ?? "—", max: 30 },
          {
            header: "price",
            value: (a) => (a.price?.amount ? `${a.price.amount} ${a.price.symbol ?? ""}`.trim() : "free"),
            align: "right",
          },
          { header: "health", value: (a) => a.health_status ?? "—" },
          { header: "agent id", value: (a) => a.agent_id, max: 46 },
        ]);
      });
    });

  agent
    .command("show <idOrHandle>")
    .description("Show one agent in full")
    .action(async function (this: Command, idOrHandle: string) {
      const ctx = resolveContext(this);
      const found = await fetchAgent(ctx, idOrHandle);
      out.result(found, () => renderAgent(found));
    });

  agent
    .command("mine")
    .description("List the agents owned by the authenticated wallet")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const credentials = requireCredentials();
      if (credentials.mode !== "jwt") {
        throw new CliError(
          "`agent mine` needs a Unibase Pay JWT.",
          "Run `bitagent configure` and choose browser authorization.",
        );
      }
      const agents = await AipClient.from(ctx).myAgents(credentials.token);
      out.result(agents, () => {
        out.heading(`Your agents (${agents.length})`);
        out.table(agents, [
          { header: "handle", value: (a) => a.handle ?? "—", max: 30 },
          { header: "name", value: (a) => a.display_name ?? "—", max: 30 },
          { header: "chain", value: (a) => String(a.chain_id ?? ctx.net.chainId), align: "right" },
          { header: "agent id", value: (a) => a.agent_id, max: 46 },
        ]);
      });
    });

  agent
    .command("register")
    .description("Register an agent on AIP (ERC-8004) so it is discoverable and hireable")
    .requiredOption("--name <name>", "Display name")
    .option("--handle <handle>", "Unique marketplace handle (defaults to a slug of the name)")
    .option("--description <text>", "What the agent does", "")
    .option("--url <url>", "Public A2A endpoint. Omit for gateway-polling (private) agents")
    .option("--price <amount>", "Base call fee, in USD", "0.001")
    .option("--currency <code>", "Price currency", "USD")
    .option(
      "--skill <name:description...>",
      "Repeatable. A capability listed on the agent card",
      collect,
      [],
    )
    .option("--tag <tag...>", "Repeatable. Capability tags used for discovery", collect, [])
    .option(
      "--offering <name:price[:description]...>",
      "Repeatable. A hireable job offering",
      collect,
      [],
    )
    .option("--metadata <json>", "Extra metadata object, as JSON")
    .option("--dry-run", "Print the registration payload without sending it")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const options = this.opts<{
        name: string;
        handle?: string;
        description: string;
        url?: string;
        price: string;
        currency: string;
        skill: string[];
        tag: string[];
        offering: string[];
        metadata?: string;
        dryRun?: boolean;
      }>();

      const config = buildAgentConfig(ctx, options);
      const auth = await aipAuth(REGISTER_MESSAGE);
      if (auth.signature) {
        config.signature = auth.signature;
        config.message = auth.message;
      }

      const payload = toRegistrationMap(config);
      if (auth.userId && !auth.token) payload.user_id = auth.userId;

      if (options.dryRun) {
        out.result(payload, () => {
          out.heading("Registration payload (dry run)");
          process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
        });
        return;
      }

      out.step(`Registering ${config.handle ?? config.name} on ${ctx.net.label} …`);
      const response = await AipClient.from(ctx).registerAgent(payload, auth.token);
      const agentId = String(response.agent_id ?? "");
      if (agentId) {
        updateConfig((saved) => {
          saved.agentId = agentId;
          saved.agentWallet = requireCredentials().wallet;
        });
      }

      out.result(response, () => {
        out.success(`Registered ${config.handle ?? config.name}`);
        out.kv([
          ["agent id", agentId || "(not returned)"],
          ["handle", config.handle],
          ["endpoint", config.endpointUrl || "gateway polling"],
          ["price", `${config.costModel?.baseCallFee} ${config.currency}`],
          ["offerings", (config.jobOfferings ?? []).length],
        ]);
        out.hint("Start taking work with `bitagent agent serve --exec \"<your command>\"`.");
      });
    });

  agent
    .command("serve")
    .description("Take jobs from the AIP gateway queue and run a local command for each")
    .requiredOption(
      "--exec <command>",
      "Shell command to run per job. Job input arrives on stdin; stdout is the deliverable",
    )
    .option("--agent-id <id>", "Poll as this agent id (defaults to the last registered one)")
    .option("--handle <handle>", "Poll as this handle when no agent id is known")
    .option("--timeout <seconds>", "Per-job command timeout", "300")
    .option("--poll-timeout <seconds>", "Long-poll window", "5")
    .option("--once", "Handle a single job and exit")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const options = this.opts<{
        exec: string;
        agentId?: string;
        handle?: string;
        timeout: string;
        pollTimeout: string;
        once?: boolean;
      }>();

      const pollAs = options.agentId ?? loadAgentId() ?? options.handle;
      if (!pollAs) {
        throw new CliError(
          "No agent id to poll as.",
          "Run `bitagent agent register …` first, or pass --agent-id / --handle.",
        );
      }

      const gateway = GatewayClient.from(ctx);
      const health = await gateway.health().catch(() => undefined);

      out.info("");
      out.success(`Serving as ${pollAs}`);
      out.kv([
        ["gateway", ctx.gateway],
        ["command", options.exec],
        ["job timeout", `${options.timeout}s`],
        ["gateway status", health?.status ?? "unknown"],
      ]);
      out.info("");
      out.hint("Press Ctrl-C to stop.");

      const stop = { value: false };
      const onSignal = (): void => {
        stop.value = true;
        out.info("");
        out.step("Stopping after the current job …");
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      let handled = 0;
      while (!stop.value) {
        const job = await gateway
          .pollJob(pollAs, Number(options.pollTimeout))
          .catch((e: unknown) => {
            out.warn(`Poll failed: ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
          });

        if (!job) {
          await sleep(POLL_BACKOFF_MS);
          continue;
        }

        handled += 1;
        await handleJob(gateway, job, options.exec, Number(options.timeout) * 1000);
        if (options.once) break;
      }

      out.info("");
      out.success(`Stopped after ${handled} job${handled === 1 ? "" : "s"}.`);
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function loadAgentId(): string | undefined {
  return loadConfig().agentId;
}

function buildAgentConfig(
  ctx: Ctx,
  options: {
    name: string;
    handle?: string;
    description: string;
    url?: string;
    price: string;
    currency: string;
    skill: string[];
    tag: string[];
    offering: string[];
    metadata?: string;
  },
): AgentConfig {
  const skills: SkillConfig[] = options.skill.map((entry) => {
    const [name, ...rest] = entry.split(":");
    if (!name) throw new CliError(`Invalid --skill "${entry}". Use name:description.`);
    return { name: name.trim(), description: rest.join(":").trim() || name.trim() };
  });

  const jobOfferings: JobOfferingConfig[] = options.offering.map((entry, index) => {
    const parts = entry.split(":");
    const name = parts[0]?.trim();
    const price = Number(parts[1]);
    if (!name || !Number.isFinite(price)) {
      throw new CliError(
        `Invalid --offering "${entry}".`,
        'Use name:price[:description], e.g. --offering "audit:10:Solidity audit".',
      );
    }
    return {
      id: index + 1,
      name,
      description: parts.slice(2).join(":").trim() || name,
      price,
      priceV2: ctx.net.contracts.usdc
        ? { amount: price, currency: ctx.net.contracts.usdc, symbol: "USDC" }
        : undefined,
      active: true,
      requiredFunds: true,
    };
  });

  let metadata: Record<string, unknown> | undefined;
  if (options.metadata) {
    try {
      metadata = JSON.parse(options.metadata) as Record<string, unknown>;
    } catch {
      throw new CliError("--metadata must be valid JSON.");
    }
  }

  const price = Number(options.price);
  if (!Number.isFinite(price) || price < 0) {
    throw new CliError(`Invalid --price "${options.price}".`);
  }

  return {
    name: options.name,
    handle: options.handle,
    description: options.description,
    endpointUrl: options.url,
    skills: skills.length > 0 ? skills : [{ name: "default", description: options.description || options.name }],
    capabilities: options.tag,
    costModel: { baseCallFee: price },
    currency: options.currency,
    metadata,
    jobOfferings,
    chainId: ctx.net.chainId,
  };
}

async function handleJob(
  gateway: GatewayClient,
  job: GatewayJob,
  command: string,
  timeoutMs: number,
): Promise<void> {
  const jobId = String(job.job_id ?? job.task_id ?? "");
  const input = job.job_input ?? JSON.stringify(job.payload ?? {});

  out.info("");
  out.step(`Job ${jobId} received (${input.length} bytes of input)`);

  const started = Date.now();
  try {
    const stdout = await runCommand(command, input, timeoutMs);
    await gateway.completeJob({
      job_id: jobId,
      agent_id: job.agent_id,
      status: "completed",
      result: { response: stdout },
    });
    out.success(`Job ${jobId} completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await gateway
      .completeJob({ job_id: jobId, agent_id: job.agent_id, status: "failed", error: message })
      .catch(() => undefined);
    out.fail(`Job ${jobId} failed: ${message}`);
  }
}

/** Run the handler command with the job input on stdin; stdout is the result. */
function runCommand(command: string, input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BITAGENT_JOB_INPUT: input },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`command exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
    });

    child.stdin.end(input);
  });
}

async function fetchAgent(ctx: Ctx, idOrHandle: string): Promise<Agent> {
  const aip = AipClient.from(ctx);
  // Agent ids are chain-scoped triples (`97:0x8004…:472`); anything else is a handle.
  if (idOrHandle.includes(":")) return await aip.getAgent(idOrHandle);

  const byHandle = await aip.getAgentByHandle(idOrHandle).catch(() => undefined);
  if (byHandle?.agent_id) return byHandle;

  const byId = await aip.getAgent(idOrHandle).catch(() => undefined);
  if (byId?.agent_id) return byId;

  throw new CliError(
    `No agent found for "${idOrHandle}" on ${ctx.net.label}.`,
    "Search with `bitagent browse <query>`.",
  );
}

function renderAgent(agent: Agent): void {
  out.heading(agent.display_name ?? agent.card?.name ?? agent.handle ?? agent.agent_id);
  out.kv([
    ["agent id", agent.agent_id],
    ["handle", agent.handle],
    ["chain", agent.chain_id],
    ["owner", agent.owner_id],
    ["wallet", agent.wallet_address],
    ["health", agent.health_status],
    ["endpoint", agent.card?.url],
    [
      "price",
      agent.price?.amount ? `${agent.price.amount} ${agent.price.symbol ?? agent.price.currency ?? ""}`.trim() : "free",
    ],
    ["created", agent.created_at],
  ]);

  if (agent.card?.description) {
    out.heading("Description");
    process.stdout.write("  " + agent.card.description.replace(/\n/g, "\n  ") + "\n");
  }

  const stats = agent.stats;
  if (stats) {
    out.heading("Performance");
    out.kv([
      ["jobs", stats.total_jobs],
      ["completed", stats.completed_jobs],
      ["revenue", stats.total_revenue],
      ["success rate", stats.success_rate !== undefined ? `${stats.success_rate}%` : undefined],
    ]);
  }

  const skills = agent.card?.skills ?? [];
  if (skills.length > 0) {
    out.heading(`Skills (${skills.length})`);
    out.table(skills, [
      { header: "name", value: (s) => s.name ?? "—", max: 28 },
      { header: "description", value: (s) => s.description ?? "—", max: 60 },
    ]);
  }

  const offerings = (agent.metadata?.job_offerings ?? []) as Array<Record<string, unknown>>;
  if (Array.isArray(offerings) && offerings.length > 0) {
    out.heading(`Job offerings (${offerings.length})`);
    out.table(offerings, [
      { header: "id", value: (o) => String(o.id ?? "—"), max: 10 },
      { header: "name", value: (o) => String(o.name ?? "—"), max: 32 },
      { header: "price", value: (o) => String(o.price ?? "—"), align: "right" },
      { header: "active", value: (o) => (o.active === false ? "no" : "yes") },
    ]);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
