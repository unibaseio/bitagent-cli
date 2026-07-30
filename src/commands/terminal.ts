/**
 * Terminal — the personal orchestrator agent (a.k.a. butler).
 *
 * It parses intent, finds providers on the AIP registry, and drives the
 * ERC-8183 escrow calls (`createJob`, `setBudget`, `fund`) through your proxy
 * wallet, so hiring works from plain language.
 */

import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import type { Command } from "commander";
import { AipClient, type ChatMessage } from "../lib/api/aip.js";
import { getConversation, setButler, setConversation } from "../lib/config.js";
import { resolveContext, type Ctx } from "../lib/context.js";
import { CliError } from "../lib/errors.js";
import { requireCredentials, signMessage, type Credentials } from "../lib/credentials.js";
import * as out from "../lib/output.js";

const ACTIVATE_MESSAGE = "Activate my personal Butler Agent";

export function registerTerminalCommands(program: Command): void {
  const terminal = program
    .command("terminal")
    .description("Talk to your Terminal agent: describe a task, hire, and settle");

  terminal
    .command("status")
    .description("Show whether your Terminal agent is active")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const credentials = requireJwt(ctx);
      const butler = await AipClient.from(ctx).butlerStatus(credentials.token, credentials.wallet);

      out.result(butler ?? { active: false }, () => {
        if (!butler) {
          out.warn(`No Terminal agent on ${ctx.net.label}.`);
          out.hint("Create it with `bitagent terminal activate`.");
          return;
        }
        out.heading("Terminal agent");
        out.kv([
          ["agent id", butler.agent_id],
          ["handle", butler.handle],
          ["display name", butler.display_name],
          ["wallet", butler.wallet_address],
          ["chain", butler.chain_id],
          ["jobs", butler.stats?.total_jobs],
          ["revenue", butler.stats?.total_revenue],
        ]);
      });
    });

  terminal
    .command("activate")
    .description("Activate your Terminal agent on this network")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const credentials = requireJwt(ctx);
      const aip = AipClient.from(ctx);

      const existing = await aip.butlerStatus(credentials.token, credentials.wallet);
      if (existing?.agent_id) {
        setButler(ctx.net.chainId, existing.agent_id);
        out.result(existing, () => {
          out.success(`Already active: ${existing.agent_id}`);
        });
        return;
      }

      // Terminal Agent V2 activates from the JWT alone; the signature is only
      // added when a local key is available, matching the web flow.
      const body: {
        chain_id: number;
        wallet_address?: string;
        signature?: string;
        message?: string;
      } = {
        chain_id: ctx.net.chainId,
        wallet_address: credentials.wallet || undefined,
      };
      if (credentials.mode === "key") {
        out.step("Signing the activation message …");
        body.signature = await signMessage(ACTIVATE_MESSAGE);
        body.message = ACTIVATE_MESSAGE;
      }

      out.step(`Activating your Terminal agent on ${ctx.net.label} …`);
      const activated = await aip.activateButler(body, credentials.token);
      if (activated.agent_id) setButler(ctx.net.chainId, activated.agent_id);

      out.result(activated, () => {
        out.success(`Terminal agent ${activated.status ?? "activated"}`);
        out.kv([
          ["agent id", activated.agent_id],
          ["wallet", activated.wallet_address],
        ]);
        out.hint("Now try `bitagent terminal chat \"find me an agent that can audit Solidity\"`.");
      });
    });

  terminal
    .command("chat")
    .argument("[message...]", "Message to send. Omit for an interactive session")
    .description("Send a task to your Terminal agent (streams the reply)")
    .option("--conversation <id>", "Continue a conversation (defaults to the last one used)")
    .option("--new", "Start a fresh conversation")
    .option("--agent <id>", "Talk to a specific agent instead of your Terminal agent")
    .option("--no-stream", "Wait for the full reply instead of streaming tokens")
    .action(async function (this: Command, words: string[]) {
      const ctx = resolveContext(this);
      const options = this.opts<{
        conversation?: string;
        new?: boolean;
        agent?: string;
        stream: boolean;
      }>();
      const credentials = requireJwt(ctx);
      const aip = AipClient.from(ctx);

      const target = options.agent ?? (await resolveButlerId(ctx, credentials));
      const conversationId =
        options.conversation ??
        (options.new ? `cli-${randomUUID()}` : getConversation(ctx.net.chainId)) ??
        `cli-${randomUUID()}`;
      setConversation(ctx.net.chainId, conversationId);

      const message = words.join(" ").trim();

      if (message) {
        const reply = await send(ctx, credentials, target, conversationId, message, options.stream);
        out.result(
          { conversation_id: conversationId, agent_id: target, reply },
          () => undefined, // `send` already streamed the reply to stdout
        );
        return;
      }

      // Interactive session.
      if (!process.stdin.isTTY) {
        throw new CliError(
          "No message given and stdin is not a terminal.",
          'Pass the message inline: bitagent terminal chat "…"',
        );
      }

      out.info("");
      out.success(`Connected to ${target}`);
      out.kv([
        ["network", `${ctx.net.label} (${ctx.net.chainId})`],
        ["conversation", conversationId],
      ]);
      out.hint("Type your task. Ctrl-C or `exit` to quit.");
      out.info("");

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const line = (await rl.question(out.pc.bold("you › "))).trim();
          if (!line) continue;
          if (line === "exit" || line === "quit") break;
          await send(ctx, credentials, target, conversationId, line, options.stream);
          process.stdout.write("\n");
        }
      } finally {
        rl.close();
      }
    });

  terminal
    .command("hire <agentOrHandle>")
    .description("Ask your Terminal agent to hire an agent for a task")
    .requiredOption("--task <text>", "What you want done")
    .option("--reward <amount>", "Reward you are willing to escrow")
    .option("--token <symbol>", "Reward token", "USDC")
    .option("--service <name>", "A specific job offering of that agent")
    .option("--conversation <id>", "Continue a conversation")
    .option("--no-stream", "Wait for the full reply instead of streaming tokens")
    .action(async function (this: Command, agentOrHandle: string) {
      const ctx = resolveContext(this);
      const options = this.opts<{
        task: string;
        reward?: string;
        token: string;
        service?: string;
        conversation?: string;
        stream: boolean;
      }>();
      const credentials = requireJwt(ctx);

      const target = await resolveButlerId(ctx, credentials);
      const conversationId =
        options.conversation ?? getConversation(ctx.net.chainId) ?? `cli-${randomUUID()}`;
      setConversation(ctx.net.chainId, conversationId);

      // Mirrors the intent string the web Terminal sends on "Hire".
      const parts = [`I want to hire ${agentOrHandle}`];
      if (options.service) parts.push(`for the "${options.service}" service`);
      parts.push(`to do this task: ${options.task}`);
      if (options.reward) parts.push(`Reward: ${options.reward} ${options.token}.`);
      parts.push("Please create the job, lock the budget, and hire the agent.");
      const message = parts.join(" ");

      out.step(`Asking your Terminal agent to hire ${agentOrHandle} …`);
      const reply = await send(ctx, credentials, target, conversationId, message, options.stream);

      out.result(
        { conversation_id: conversationId, agent_id: target, intent: message, reply },
        () => undefined,
      );
    });

  terminal
    .command("conversations")
    .description("List your Terminal conversations")
    .action(async function (this: Command) {
      const ctx = resolveContext(this);
      const credentials = requireJwt(ctx);
      const response = await AipClient.from(ctx).conversations(credentials.token);
      const conversations = response.conversations ?? [];

      out.result(response, () => {
        out.heading(`Conversations (${conversations.length})`);
        out.table(conversations, [
          { header: "conversation id", value: (c) => c.conversation_id, max: 36 },
          { header: "messages", value: (c) => String(c.message_count ?? 0), align: "right" },
          { header: "updated", value: (c) => c.updated_at ?? "—", max: 24 },
          { header: "last message", value: (c) => c.last_message ?? "—", max: 48 },
        ]);
      });
    });

  terminal
    .command("history <conversationId>")
    .description("Print the transcript of a conversation")
    .action(async function (this: Command, conversationId: string) {
      const ctx = resolveContext(this);
      const credentials = requireJwt(ctx);
      const response = await AipClient.from(ctx).conversationHistory(
        conversationId,
        credentials.token,
      );
      const messages = response.messages ?? [];

      out.result(response, () => {
        out.heading(`${conversationId} (${messages.length} messages)`);
        for (const message of messages) renderMessage(message);
      });
    });
}

function requireJwt(ctx: Ctx): Credentials {
  const credentials = requireCredentials();
  if (!credentials.token) {
    throw new CliError(
      "The Terminal agent needs a Unibase Pay JWT — a private key alone is not enough.",
      "Run `bitagent configure` and choose browser authorization.",
    );
  }
  void ctx;
  return credentials;
}

async function resolveButlerId(ctx: Ctx, credentials: Credentials): Promise<string> {
  const butler = await AipClient.from(ctx).butlerStatus(credentials.token, credentials.wallet);
  if (butler?.agent_id) {
    setButler(ctx.net.chainId, butler.agent_id);
    return butler.agent_id;
  }
  throw new CliError(
    `No Terminal agent on ${ctx.net.label}.`,
    "Create it with `bitagent terminal activate`.",
  );
}

/** Send one message and print the reply. Returns the reply text. */
async function send(
  ctx: Ctx,
  credentials: Credentials,
  agentId: string,
  conversationId: string,
  message: string,
  stream: boolean,
): Promise<string> {
  const aip = AipClient.from(ctx);
  const body = {
    message,
    chain_id: ctx.net.chainId,
    context: {
      conversation_id: conversationId,
      metadata: { chain_id: ctx.net.chainId, source: "bitagent-cli" },
    },
  };

  if (!stream) {
    const response = await aip.invoke(agentId, body, credentials.token);
    const content = String(response.content ?? "");
    if (!out.isJsonMode()) {
      process.stdout.write(out.pc.bold("agent › ") + content + "\n");
      if (response.cost) out.hint(`cost: ${response.cost}`);
    }
    return content;
  }

  let text = "";
  let wroteHeader = false;
  const write = (chunk: string): void => {
    if (out.isJsonMode()) return;
    if (!wroteHeader) {
      process.stdout.write(out.pc.bold("agent › "));
      wroteHeader = true;
    }
    process.stdout.write(chunk);
  };

  for await (const event of aip.invokeStream(agentId, body, credentials.token)) {
    const kind = String(event.event ?? event.type ?? "");
    const data = event.data;

    if (kind === "token") {
      const piece = typeof data === "string" ? data : String((data as { text?: string })?.text ?? "");
      text += piece;
      write(piece);
      continue;
    }

    if (kind === "status") {
      const status = typeof data === "string" ? data : JSON.stringify(data);
      if (status && !out.isJsonMode()) out.step(status);
      continue;
    }

    if (kind === "result") {
      const record = (data ?? {}) as { content?: unknown; cost?: unknown };
      const content = typeof record.content === "string" ? record.content : "";
      // Non-streaming servers send the whole answer in the result event.
      if (content && !text) {
        text = content;
        write(content);
      }
      if (record.cost && !out.isJsonMode()) out.hint(`cost: ${String(record.cost)}`);
      continue;
    }

    // Unrecognized event shape: surface the raw payload rather than dropping it.
    if (typeof event.raw === "string") {
      text += event.raw;
      write(event.raw);
    }
  }

  if (wroteHeader) process.stdout.write("\n");
  return text;
}

function renderMessage(message: ChatMessage): void {
  const label = message.role === "user" ? out.pc.bold("you › ") : out.pc.bold("agent › ");
  const body = String(message.content ?? "").replace(/\n/g, "\n  ");
  process.stdout.write(`${label}${body}\n`);
}
