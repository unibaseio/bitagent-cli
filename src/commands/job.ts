/**
 * ERC-8183 job lifecycle.
 *
 * created → accepted (provider bound) → submitted (deliverable) →
 * completed (evaluator releases escrow) | rejected.
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { AipClient, type JobRecord } from "../lib/api/aip.js";
import { resolveContext, type Ctx } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { requireCredentials } from "../lib/credentials.js";
import * as out from "../lib/output.js";

/** Platform ids for wallets are namespaced `user:0x…`. */
const userId = (wallet: string): string => (wallet.startsWith("user:") ? wallet : `user:${wallet}`);

export function registerJobCommands(program: Command): void {
  const job = program
    .command("job")
    .description("Create, fund and settle ERC-8183 jobs");

  job
    .command("create")
    .description("Create a job with an escrowed reward")
    .requiredOption("--description <text>", "What the provider must deliver")
    .requiredOption("--reward <amount>", "Reward amount")
    .option("--token <symbolOrAddress>", "Reward token: USDC, UB, or a contract address", "USDC")
    .option("--evaluator <id>", "Evaluator id (defaults to the network's evaluator contract)")
    .option("--client <id>", "Client id (defaults to user:<your wallet>)")
    .option("--expires-in <seconds>", "Job expiry", "86400")
    .option("--metadata <json>", "Extra metadata object, as JSON")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const options = this.opts<{
        description: string;
        reward: string;
        token: string;
        evaluator?: string;
        client?: string;
        expiresIn: string;
        metadata?: string;
      }>();

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
          metadata: parseMetadata(options.metadata),
        },
        credentials.token || undefined,
      );

      out.result(created, () => {
        out.success(`Job ${jobId(created)} created`);
        renderJob(created);
        out.hint("Bind a provider with `bitagent job accept <id> --provider <agent-id>`.");
      });
    });

  job
    .command("list")
    .description("List your jobs")
    .option("--role <role>", "client | provider | evaluator | any", "any")
    .option("--limit <n>", "Maximum rows", "30")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const options = this.opts<{ role: string; limit: string }>();
      const credentials = requireCredentials();
      if (!credentials.token) {
        throw new CliError(
          "`job list` needs a Unibase Pay JWT.",
          "Run `bitagent configure` and choose browser authorization.",
        );
      }

      const jobs = (await AipClient.from(ctx).myJobs(credentials.token, options.role)).slice(
        0,
        Number(options.limit),
      );

      out.result(jobs, () => {
        out.heading(`Your jobs — role ${options.role} (${jobs.length})`);
        out.table(jobs, [
          { header: "job id", value: (j) => jobId(j), max: 14 },
          { header: "status", value: (j) => String(j.status ?? "—") },
          { header: "description", value: (j) => String(j.description ?? "—"), max: 44 },
          {
            header: "reward",
            value: (j) => `${j.reward_amount ?? 0} ${symbolOf(ctx, j.reward_token)}`.trim(),
            align: "right",
          },
          { header: "provider", value: (j) => shorten(j.provider_id), max: 26 },
        ]);
      });
    });

  job
    .command("show <jobId>")
    .description("Show one job in full")
    .action(async function (this: Command, id: string) {
      const ctx = resolveContext(this);
      const credentials = requireCredentials();
      const record = await AipClient.from(ctx).getJob(id, credentials.token || undefined);
      out.result(record, () => renderJob(record, true));
    });

  job
    .command("accept <jobId>")
    .description("Accept a job as the provider")
    .requiredOption("--provider <id>", "Provider agent id")
    .action(async function (this: Command, id: string) {
      const ctx = resolveContext(this);
      const { provider } = this.opts<{ provider: string }>();
      const credentials = requireCredentials();
      const record = await AipClient.from(ctx).acceptJob(
        id,
        provider,
        credentials.token || undefined,
      );
      out.result(record, () => {
        out.success(`Job ${id} accepted by ${provider}`);
        renderJob(record);
      });
    });

  job
    .command("submit <jobId>")
    .description("Submit the deliverable as the provider")
    .requiredOption("--provider <id>", "Provider agent id")
    .option("--data <text>", "Deliverable payload; JSON is parsed, anything else sent as text")
    .option("--file <path>", "Read the deliverable from a file instead of --data")
    .option("--description <text>", "Note attached to the submission", "")
    .action(async function (this: Command, id: string) {
      const ctx = resolveContext(this);
      const options = this.opts<{
        provider: string;
        data?: string;
        file?: string;
        description: string;
      }>();
      const credentials = requireCredentials();

      const raw = options.file ? readFileSync(options.file, "utf8") : options.data;
      if (raw === undefined) {
        throw new CliError("Provide the deliverable with --data or --file.");
      }

      const record = await AipClient.from(ctx).submitJob(
        id,
        {
          provider_id: options.provider,
          deliverable_data: parseLoose(raw),
          description: options.description,
        },
        credentials.token || undefined,
      );

      out.result(record, () => {
        out.success(`Deliverable submitted for job ${id}`);
        renderJob(record);
        out.hint("The evaluator releases escrow with `bitagent job complete <id>`.");
      });
    });

  job
    .command("complete <jobId>")
    .description("Approve the deliverable as the evaluator and release escrow")
    .option("--evaluator <id>", "Evaluator id (defaults to the network's evaluator contract)")
    .option("--reason <text>", "Why it was approved", "Deliverable accepted")
    .action(async function (this: Command, id: string) {
      const ctx = resolveContext(this);
      const options = this.opts<{ evaluator?: string; reason: string }>();
      const credentials = requireCredentials();

      const evaluator = options.evaluator ?? ctx.net.contracts.evaluator;
      if (!evaluator) {
        throw new CliError(`No evaluator configured for ${ctx.net.label}. Pass --evaluator.`);
      }

      const record = await AipClient.from(ctx).completeJob(
        id,
        { evaluator_id: evaluator, reason: options.reason },
        credentials.token || undefined,
      );
      out.result(record, () => {
        out.success(`Job ${id} completed — escrow released`);
        renderJob(record);
      });
    });

  job
    .command("reject <jobId>")
    .description("Reject the deliverable")
    .requiredOption("--reason <text>", "Why it was rejected")
    .option("--rejector <id>", "Rejector id (defaults to user:<your wallet>)")
    .action(async function (this: Command, id: string) {
      const ctx = resolveContext(this);
      const options = this.opts<{ reason: string; rejector?: string }>();
      const credentials = requireCredentials();
      const record = await AipClient.from(ctx).rejectJob(
        id,
        options.rejector ?? userId(credentials.wallet),
        options.reason,
        credentials.token || undefined,
      );
      out.result(record, () => {
        out.success(`Job ${id} rejected`);
        renderJob(record);
      });
    });
}

const jobId = (record: JobRecord): string => String(record.job_id ?? record.id ?? "—");

const shorten = (value?: string): string => {
  if (!value) return "—";
  return value.length > 26 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
};

/** Accept `USDC` / `UB` / a raw address, and return what the API expects. */
function resolveRewardToken(ctx: Ctx, token: string): string {
  if (token.startsWith("0x")) return token;
  const upper = token.toUpperCase();
  if (upper === "USDC" && ctx.net.contracts.usdc) return ctx.net.contracts.usdc;
  if (upper === "UB" && ctx.net.contracts.ub) return ctx.net.contracts.ub;
  // Unknown symbol: pass it through and let the platform decide.
  return token;
}

function symbolOf(ctx: Ctx, token?: string): string {
  if (!token) return "";
  const lower = token.toLowerCase();
  if (lower === ctx.net.contracts.usdc?.toLowerCase()) return "USDC";
  if (lower === ctx.net.contracts.ub?.toLowerCase()) return "UB";
  return token.startsWith("0x") ? `${token.slice(0, 6)}…` : token;
}

function parseMetadata(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new CliError("--metadata must be valid JSON.");
  }
}

/** Deliverables are often JSON but plain text is legal too. */
function parseLoose(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function renderJob(record: JobRecord, verbose = false): void {
  out.kv([
    ["job id", jobId(record)],
    ["status", record.status],
    ["description", record.description],
    ["reward", record.reward_amount !== undefined ? `${record.reward_amount}` : undefined],
    ["reward token", record.reward_token],
    ["client", record.client_id],
    ["provider", record.provider_id],
    ["evaluator", record.evaluator_id],
    ["deliverable", record.deliverable_uri],
    ["created", record.created_at],
  ]);

  if (!verbose) return;
  const known = new Set([
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
    "created_at",
  ]);
  const extra = Object.entries(record).filter(([key]) => !known.has(key));
  if (extra.length > 0) {
    out.heading("Additional fields");
    out.kv(extra);
  }
}
