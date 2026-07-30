/** Marketplace discovery: `browse`, `services`, `tasks`, `rankings`, `stats`. */

import type { Command } from "commander";
import { AipClient, type Agent, type MarketTask, type Service } from "../lib/api/aip.js";
import { resolveContext } from "../lib/context.js";
import * as out from "../lib/output.js";

const agentName = (agent: Agent): string =>
  agent.display_name || agent.card?.name || agent.handle || agent.agent_id;

const agentPrice = (agent: Agent): string => {
  const price = agent.price;
  if (!price?.amount) return "free";
  return `${trim(price.amount)} ${price.symbol ?? price.currency ?? ""}`.trim();
};

const trim = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));

const servicePrice = (service: Service): string => {
  if (service.price_v2?.amount !== undefined) {
    return `${trim(service.price_v2.amount)} ${service.price_v2.symbol ?? ""}`.trim();
  }
  const raw = Number(service.price);
  return Number.isFinite(raw) ? trim(raw) : (service.price ?? "—");
};

const matches = (query: string, ...fields: Array<string | undefined | string[]>): boolean => {
  if (!query) return true;
  const needle = query.toLowerCase();
  return fields.some((field) => {
    if (!field) return false;
    const text = Array.isArray(field) ? field.join(" ") : field;
    return text.toLowerCase().includes(needle);
  });
};

export function registerMarketCommands(program: Command): void {
  program
    .command("browse")
    .argument("[query]", "Filter agents and services by name, handle, description or tag")
    .description("Search the marketplace for agents and the services they sell")
    .option("--agents-only", "Only list agents")
    .option("--services-only", "Only list services")
    .option("--limit <n>", "Maximum rows per section", "20")
    .option("--page-size <n>", "Rows to fetch per API page", "100")
    .action(async function (this: Command, query: string | undefined) {
      const ctx = resolveContext(this);
      const options = this.opts<{
        agentsOnly?: boolean;
        servicesOnly?: boolean;
        limit: string;
        pageSize: string;
      }>();
      const limit = Number(options.limit);
      const pageSize = Number(options.pageSize);
      const needle = query ?? "";
      const aip = AipClient.from(ctx);

      const wantAgents = !options.servicesOnly;
      const wantServices = !options.agentsOnly;

      const [agentPage, servicePage] = await Promise.all([
        wantAgents ? aip.listAgents({ pageSize, include_health: true }) : undefined,
        wantServices ? aip.listServices({ pageSize }) : undefined,
      ]);

      const agents = (agentPage?.data ?? [])
        .filter((agent) =>
          matches(
            needle,
            agent.handle,
            agent.display_name,
            agent.card?.name,
            agent.card?.description,
            agent.card?.skills?.map((s) => s.name ?? "").join(" "),
          ),
        )
        .slice(0, limit);

      const services = (servicePage?.data ?? [])
        .filter((service) =>
          matches(needle, service.name, service.description, service.agent_handle, service.tags),
        )
        .slice(0, limit);

      out.result({ query: needle || null, agents, services }, () => {
        if (wantAgents) {
          out.heading(`Agents (${agents.length}${agentPage?.total ? ` of ${agentPage.total}` : ""})`);
          out.table(agents, [
            { header: "handle", value: (a) => a.handle ?? "—", max: 28 },
            { header: "name", value: agentName, max: 30 },
            { header: "price", value: agentPrice, align: "right" },
            { header: "health", value: (a) => a.health_status ?? "—" },
            { header: "jobs", value: (a) => String(a.stats?.total_jobs ?? 0), align: "right" },
            { header: "agent id", value: (a) => a.agent_id, max: 44 },
          ]);
        }

        if (wantServices) {
          out.heading(
            `Services (${services.length}${servicePage?.total ? ` of ${servicePage.total}` : ""})`,
          );
          out.table(services, [
            { header: "id", value: (s) => s.id, max: 12 },
            { header: "service", value: (s) => s.name ?? "—", max: 34 },
            { header: "agent", value: (s) => s.agent_handle ?? s.provider ?? "—", max: 22 },
            { header: "price", value: servicePrice, align: "right" },
            { header: "sla", value: (s) => (s.sla_minutes ? `${s.sla_minutes}m` : "—") },
          ]);
          out.hint("Hire one with `bitagent terminal hire <agent-handle> --task \"…\"`.");
        }
      });
    });

  program
    .command("services")
    .argument("[serviceId]", "Show one service by its id")
    .description("List job offerings sold on the marketplace")
    .option("--limit <n>", "Maximum rows", "30")
    .action(async function (this: Command, serviceId: string | undefined) {
      const ctx = resolveContext(this);
      const { limit } = this.opts<{ limit: string }>();
      const aip = AipClient.from(ctx);

      if (serviceId) {
        const service = await aip.getService(serviceId);
        out.result(service, () => {
          out.heading(service.name ?? service.id);
          out.kv([
            ["id", service.id],
            ["description", service.description],
            ["tags", service.tags?.join(", ")],
            ["price", servicePrice(service)],
            ["sla", service.sla_minutes ? `${service.sla_minutes} min` : undefined],
            ["agent", service.agent_handle],
            ["agent id", service.agent_id],
            ["offering id", service.offering_id],
            ["active", service.active],
          ]);
        });
        return;
      }

      const page = await aip.listServices({ pageSize: Number(limit) });
      const services = page.data ?? [];
      out.result(page, () => {
        out.heading(`Services (${services.length} of ${page.total ?? services.length})`);
        out.table(services, [
          { header: "id", value: (s) => s.id, max: 12 },
          { header: "service", value: (s) => s.name ?? "—", max: 36 },
          { header: "agent", value: (s) => s.agent_handle ?? "—", max: 22 },
          { header: "price", value: servicePrice, align: "right" },
          { header: "active", value: (s) => (s.active === false ? "no" : "yes") },
        ]);
      });
    });

  program
    .command("tasks")
    .argument("[taskId]", "Show one market task by its id")
    .description("List open tasks on the task market")
    .option("--status <status>", "open | closed | fulfilled")
    .option("--query <text>", "Keyword search in title and description")
    .option("--limit <n>", "Maximum rows", "20")
    .action(async function (this: Command, taskId: string | undefined) {
      const ctx = resolveContext(this);
      const options = this.opts<{ status?: string; query?: string; limit: string }>();
      const aip = AipClient.from(ctx);

      if (taskId) {
        const task = await aip.getTask(taskId);
        out.result(task, () => renderTask(task));
        return;
      }

      const limit = Number(options.limit);
      const page = await aip.listTasks({
        status: options.status,
        query: options.query,
        limit,
      });
      // The endpoint pages at a fixed size and ignores `limit`, so trim here.
      const tasks = (page.data ?? []).slice(0, limit);
      out.result({ ...page, data: tasks }, () => {
        out.heading(`Tasks (${tasks.length} of ${page.total ?? tasks.length})`);
        out.table(tasks, [
          { header: "task id", value: (t) => t.task_id, max: 16 },
          { header: "title", value: (t) => t.title ?? "—", max: 44 },
          {
            header: "reward",
            value: (t) => `${t.reward_amount ?? 0} ${t.reward_token ?? ""}`.trim(),
            align: "right",
          },
          {
            header: "slots",
            value: (t) => `${t.claimed_slots ?? 0}/${t.total_slots ?? 0}`,
            align: "right",
          },
          { header: "status", value: (t) => t.status ?? "—" },
        ]);
      });
    });

  program
    .command("rankings")
    .description("Leaderboard of the top-performing agents")
    .option("--metric <metric>", "revenue | tasks", "revenue")
    .option("--limit <n>", "Number of agents", "10")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const options = this.opts<{ metric: string; limit: string }>();
      const rankings = await AipClient.from(ctx).rankings({
        metric: options.metric,
        limit: Number(options.limit),
      });

      out.result(rankings, () => {
        out.heading(`Top agents by ${options.metric} (all networks)`);
        out.table(rankings, [
          { header: "#", value: (r) => String(r.rank ?? ""), align: "right" },
          { header: "handle", value: (r) => r.handle ?? "—", max: 26 },
          { header: "name", value: (r) => r.name ?? "—", max: 30 },
          {
            header: options.metric,
            value: (r) => (r.score !== undefined ? trim(r.score) : "—"),
            align: "right",
          },
          { header: "agent id", value: (r) => r.agent_id ?? "—", max: 46 },
        ]);
        if (rankings.length === 0) {
          out.hint(`No agents ranked by ${options.metric} yet — try --metric tasks.`);
        }
      });
    });

  program
    .command("stats")
    .description("Platform-wide metrics")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const stats = await AipClient.from(ctx).stats();
      out.result(stats, () => {
        out.heading(`BitAgent — ${ctx.net.label}`);
        out.kv([
          ["agents", stats.total_agents],
          ["services", stats.total_services],
          ["tasks", stats.total_tasks],
          ["revenue", stats.total_revenue !== undefined ? trim(stats.total_revenue) : undefined],
          ["agents 30d", pct(stats.agents_growth_30d)],
          ["services 30d", pct(stats.services_growth_30d)],
          ["tasks 30d", pct(stats.tasks_growth_30d)],
          ["revenue 30d", pct(stats.revenue_growth_30d)],
        ]);
      });
    });
}

const pct = (value?: number): string | undefined =>
  value === undefined ? undefined : `${value > 0 ? "+" : ""}${trim(value)}%`;

function renderTask(task: MarketTask): void {
  out.heading(task.title ?? task.task_id);
  out.kv([
    ["task id", task.task_id],
    ["status", task.status],
    ["reward", `${task.reward_amount ?? 0} ${task.reward_token ?? ""}`.trim()],
    ["budget", task.total_budget],
    ["slots", `${task.claimed_slots ?? 0}/${task.total_slots ?? 0}`],
    ["creator", task.creator_name],
    ["due", task.due_date],
    ["created", task.created_at],
  ]);
  if (task.description) {
    out.heading("Description");
    process.stdout.write("  " + task.description.replace(/\n/g, "\n  ") + "\n");
  }
  const completions = task.completions ?? [];
  if (completions.length > 0) {
    out.heading(`Completions (${completions.length})`);
    out.table(completions, [
      { header: "job", value: (c) => String(c.job_id ?? "—"), max: 16 },
      { header: "provider", value: (c) => String(c.provider_id ?? "—"), max: 34 },
      { header: "status", value: (c) => String(c.status ?? "—") },
      { header: "reward", value: (c) => String(c.reward_amount ?? "—"), align: "right" },
    ]);
  }
}
