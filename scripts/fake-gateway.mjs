#!/usr/bin/env node
/**
 * A stand-in for the AIP gateway, for testing `bitagent agent serve` without
 * touching the platform.
 *
 *   node scripts/fake-gateway.mjs [port] [--fail]
 *
 * Serves exactly one job, then reports an empty queue. Prints the completion
 * body it receives to stderr prefixed with `COMPLETE_BODY:` so a test can
 * assert on the exact wire shape the CLI posts back.
 */

import http from "node:http";

const port = Number(process.argv[2]) || 8899;
const jobInput = process.env.FAKE_JOB_INPUT ?? JSON.stringify({ text: "hello" });

let served = false;
let completed = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/gateway/health") {
    return json(200, { status: "healthy", agents_registered: 1, agents_healthy: 1 });
  }

  if (url.pathname === "/gateway/jobs/poll") {
    if (served) {
      res.writeHead(204);
      return res.end();
    }
    served = true;
    return json(200, {
      job_id: "job-test-1",
      agent_id: url.searchParams.get("agent") ?? "test-agent",
      job_input: jobInput,
    });
  }

  if (url.pathname === "/gateway/jobs/complete") {
    let body = "";
    for await (const chunk of req) body += chunk;
    completed = body;
    process.stderr.write(`COMPLETE_BODY:${body}\n`);
    return json(200, {});
  }

  // Lets a test read back what was posted after the CLI exits.
  if (url.pathname === "/_completed") {
    return json(200, { completed });
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  process.stderr.write(`fake gateway listening on http://localhost:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
