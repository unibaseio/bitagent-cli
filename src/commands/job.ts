/**
 * Your ERC-8183 jobs, read-only.
 *
 * Jobs are created by hiring through your Terminal (`bitagent terminal hire`)
 * and settled by the platform's evaluator; the API has no endpoints for a
 * client to create, accept, submit or settle a job by hand.
 */

import type { Command } from "commander";
import { AipClient, type JobRecord } from "../lib/api/aip.js";
import { resolveContext, type Ctx } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { requireCredentials } from "../lib/credentials.js";
import * as out from "../lib/output.js";

export function registerJobCommands(program: Command): void {
  const job = program
    .command("job")
    .description("List and inspect your ERC-8183 jobs (hire with `terminal hire`)");

  job
    .command("list")
    .description("List your jobs")
    .option("--role <role>", "client | provider | evaluator | any", "any")
    .option("--limit <n>", "Maximum rows", "30")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const options = this.opts<{ role: string; limit: string }>();
      const token = requireToken("job list");

      const jobs = (await AipClient.from(ctx).myJobs(token, options.role)).slice(
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
    .description("Show one of your jobs in full")
    .action(async function (this: Command, id: string) {
      const ctx = resolveContext(this);
      const jobs = await AipClient.from(ctx).myJobs(requireToken("job show"), "any");
      const record = jobs.find((j) => jobId(j) === id);
      if (!record) {
        throw new CliError(`Job ${id} is not one of yours on ${ctx.net.label}.`, "List them with `bitagent job list`.");
      }
      out.result(record, () => renderJob(record, true));
    });
}

/** /my-jobs is keyed off the Unibase Pay JWT; a local key alone can't list jobs. */
function requireToken(command: string): string {
  const credentials = requireCredentials();
  if (!credentials.token) {
    throw new CliError(
      `\`${command}\` needs a Unibase Pay JWT.`,
      "Run `bitagent configure` and choose browser authorization.",
    );
  }
  return credentials.token;
}

const jobId = (record: JobRecord): string => String(record.job_id ?? record.id ?? "—");

const shorten = (value?: string): string => {
  if (!value) return "—";
  return value.length > 26 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
};

function symbolOf(ctx: Ctx, token?: string): string {
  if (!token) return "";
  const lower = token.toLowerCase();
  if (lower === ctx.net.contracts.usdc?.toLowerCase()) return "USDC";
  if (lower === ctx.net.contracts.ub?.toLowerCase()) return "UB";
  return token.startsWith("0x") ? `${token.slice(0, 6)}…` : token;
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
