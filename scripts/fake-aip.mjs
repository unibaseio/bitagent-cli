#!/usr/bin/env node
/**
 * A stand-in for the AIP platform, for testing `bitagent terminal chat` against
 * every SSE shape it has to survive — without spending money on a real hire.
 *
 *   node scripts/fake-aip.mjs [port] [mode]
 *
 * Modes:
 *   bus       (default) the platform's real event names: answer_chunk … run_completed
 *   envelope  the shape API.md documents: {"event":"token","data":…} … result
 *   error     run_error mid-stream, no answer
 *   empty     a 200 text/event-stream with no events — the bug that started this,
 *             which must make the CLI fall back to the non-streaming endpoint
 *   progress  orchestration events with summary_text, then an answer
 */

import http from "node:http";

const port = Number(process.argv[2]) || 8898;
const mode = process.argv[3] ?? "bus";
const ANSWER = "BTC is $100k";

const sse = (res, events) => {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Drain the body so the client is never left writing into a closed socket.
  let raw = "";
  for await (const chunk of req) raw += chunk;

  if (url.pathname.endsWith("/stream")) {
    const half = Math.ceil(ANSWER.length / 2);
    const [first, second] = [ANSWER.slice(0, half), ANSWER.slice(half)];

    if (mode === "empty") return sse(res, []);

    if (mode === "error") {
      return sse(res, [
        { type: "task_started", ts: "now", summary_text: "Selecting an agent" },
        { type: "run_error", run_id: "run-1", error: "no agent could take the task" },
      ]);
    }

    if (mode === "envelope") {
      return sse(res, [
        { event: "status", data: "routing" },
        { event: "token", data: first },
        { event: "token", data: { text: second } },
        { event: "result", data: { content: ANSWER, cost: 0.0001 } },
      ]);
    }

    if (mode === "progress") {
      return sse(res, [
        { type: "task_started", ts: "now", summary_text: "Selecting an agent" },
        { type: "agent_selected", ts: "now", summary_text: "Chose coingecko" },
        { type: "answer_chunk", content: ANSWER, ts: "now" },
        { type: "run_completed", run_id: "run-1", summary: "done", output: { content: ANSWER } },
      ]);
    }

    // mode === "bus": what the platform actually emits today.
    return sse(res, [
      { type: "answer_chunk", content: first, ts: "now" },
      { type: "answer_chunk", content: second, ts: "now" },
      { type: "run_completed", run_id: "run-1", summary: "done", output: { content: ANSWER } },
    ]);
  }

  if (url.pathname.startsWith("/invoke")) {
    // The non-streaming endpoint the CLI falls back to.
    return json(200, {
      run_id: "run-1",
      agent_id: "erc8004:butler.test",
      success: true,
      content: `${ANSWER} (non-streaming)`,
    });
  }

  if (url.pathname === "/butler") {
    return json(200, {
      agent_id: "erc8004:butler.test",
      handle: "butler.test",
      wallet_address: "0x0000000000000000000000000000000000000001",
      chain_id: 97,
    });
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  process.stderr.write(`fake aip (${mode}) listening on http://localhost:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
