/** `bitagent mcp` — run the CLI as an MCP server over stdio. */

import type { Command } from "commander";
import type { GlobalOptions } from "../lib/context.js";
import * as out from "../lib/output.js";

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description(
      "Run an MCP (Model Context Protocol) server over stdio, exposing marketplace and Terminal tools to AI harnesses",
    )
    .addHelpText(
      "after",
      `
Mount it in an MCP-capable client (Claude Code, Cursor, ...):

  { "mcpServers": { "bitagent": { "command": "bitagent", "args": ["mcp"] } } }

Tools: browse_agents, get_agent, list_services, list_tasks, rankings,
platform_stats (read-only); terminal_status, list_conversations,
conversation_history, terminal_chat (need \`bitagent configure\` first).

terminal_chat can spend: the Terminal agent funds ERC-8183 escrow from
your proxy wallet when it hires a provider on your behalf.
`,
    )
    .action(async function (this: Command) {
      const options = this.optsWithGlobals<GlobalOptions>();
      // stdout belongs to the MCP protocol; force human logs to stderr.
      out.setJsonMode(true);
      const { startMcpServer } = await import("../lib/mcp.js");
      out.info(`bitagent MCP server on stdio (default network: ${options.network || process.env.BITAGENT_NETWORK || "configured/bscTestnet"})`);
      await startMcpServer(options);
    });
}
