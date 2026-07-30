# Testing bitagent-cli

Four tiers, by what they can cost you.

| Tier | What it touches | Cost | How |
| --- | --- | --- | --- |
| **0** | Public read APIs, local logic, a fake gateway | none | automated |
| **1** | Authenticated read APIs | none | automated |
| **2** | Real state: agents, jobs, escrow, on-chain | testnet gas + testnet tokens | manual, below |
| **3** | Mainnet | **real money** | manual, read-only unless you mean it |

Tiers 0 and 1 are the automated suite. Tier 2 is a manual walkthrough because it
registers agents, creates jobs and signs transactions — things a test script should not
do behind your back.

## Automated suite (tiers 0 + 1)

```bash
npm install          # `prepare` builds dist/ automatically
npm run test:smoke
```

39 cases, ~40s. Exits non-zero if anything fails, and prints which cases.

```
 ok  networks lists 5 chains
 ok  stats returns counters
 ok  agent show by handle
 ...
39 passed, 0 failed, 0 skipped
```

What it covers: every read command's JSON shape, `--limit` handling, handle-vs-id
resolution, the five network definitions and their contract addresses, the four error
paths that should exit non-zero, bonding-curve reads against a live testnet curve,
`agent serve` end-to-end against a local fake gateway (both the success and the failure
completion body), and — when a credential resolves — `whoami`, `agent mine`, `job list`,
the Terminal read endpoints, and the `agent register --dry-run` payload.

Knobs:

```bash
CLI="npx tsx bin/bitagent.ts" npm run test:smoke   # run from source instead of dist/
NETWORK=bsc npm run test:smoke                     # mainnet, still read-only
CASE_TIMEOUT=120 npm run test:smoke                # slow network
GATEWAY_PORT=8901 npm run test:smoke               # 8899 already in use
CURVE_TOKEN=0x… npm run test:smoke                 # a different bonding-curve token
```

Run it against the **built bundle** (the default). Running through `npx tsx` spawns
wrapper processes that survive a kill, so a hung case can stall the suite instead of
failing cleanly.

Tier 1 skips itself with a `skip` line if no credential resolves — that is a pass, not a
failure. Credentials come from the environment, `~/.config/bitagent/config.json`, or
`~/.config/unibase-aip-sdk/config.json`; the suite uses a throwaway
`BITAGENT_CONFIG_DIR`, so it can read your credential but never writes to your real
config.

## Install verification — *free, do this after any release*

The suite tests the code, not the distribution. Since `dist/` is committed and the package
is installed from GitHub rather than npm, the install path has its own failure modes and is
worth checking by hand whenever `src/` changes.

```bash
# 1. The committed bundle matches the source.
npm run check:dist          # exits non-zero if dist/ is stale — rebuild and commit

# 2. Global install, into a throwaway prefix so your real global stays untouched.
rm -rf /tmp/bg && npm install -g --prefix /tmp/bg github:unibaseio/bitagent-cli
/tmp/bg/bin/bitagent --version
/tmp/bg/bin/bitagent stats --json | head -5

# 3. One-off execution.
npx -y github:unibaseio/bitagent-cli --version

# 4. As a project dependency (this path *does* install devDeps and rebuild).
mkdir -p /tmp/bgdep && cd /tmp/bgdep && npm init -y >/dev/null
npm install github:unibaseio/bitagent-cli
./node_modules/.bin/bitagent --version
```

**Expect:** all four print `0.1.0` and step 2 reaches the live API. Step 1 is the one that
catches the common mistake — editing `src/` and forgetting to rebuild, which ships a stale
binary to everyone installing from GitHub.

**Watch for:** if step 2 succeeds but installs no executable, `prepare` failed. Re-run
without hiding output: `npm install -g --prefix /tmp/bg --foreground-scripts
github:unibaseio/bitagent-cli`. A global git install has no devDependencies, so `prepare`
must fall back to the committed bundle rather than trying to build — see
[scripts/prepare.mjs](scripts/prepare.mjs).

---

## Tier 2 — manual, state-changing (BSC Testnet)

### Prerequisites

```bash
export BITAGENT_NETWORK=bscTestnet
bitagent whoami                     # confirm wallet + credential
```

- A **JWT** (`bitagent configure`, browser flow) for anything under `terminal`, `job` or
  `agent mine`.
- A **private key** for anything under `token`. `bitagent whoami` shows `can sign tx: yes`
  when you have one.
- Testnet **tBNB** for gas, plus **UB** or **tUSDC**, from
  [app.bitagent.io/testnet-faucet](https://app.bitagent.io/testnet-faucet). `bitagent whoami`
  prints all three balances.

Every case below is annotated with what it costs and what proves it worked.

---

### 2.1 Activate the Terminal agent — *free, one-time per network*

```bash
bitagent terminal status --json
bitagent terminal activate --json
bitagent terminal status --json
```

**Expect:** first call returns `{"active":false}` (or an existing agent). `activate`
returns `{status, agent_id, wallet_address}` with `agent_id` like
`erc8004:butler.41bc37d3`. The third call now returns that agent. Re-running `activate`
is idempotent — it reports "Already active".

**Watch for:** in JWT-only mode this uses the V2 path (no signature). If the API rejects
it asking for a signature, add a private key and re-run — the CLI will sign
`"Activate my personal Butler Agent"` automatically.

---

### 2.2 Talk to the Terminal agent — *free to ask, costs to execute*

```bash
bitagent terminal chat "what agents can check the weather?" --json
```

**Expect:** `{conversation_id, agent_id, reply}` where `reply` names candidate agents.
Without `--json` you see tokens stream in as `agent › …`.

Conversation state is sticky — the next `chat` continues the same thread:

```bash
bitagent terminal chat "how much would the first one cost?" --json
bitagent terminal conversations --json
bitagent terminal history <conversation_id> --json
```

**Expect:** `conversations` includes your thread with a rising `message_count`; `history`
returns the full `[{role, content}]` transcript. Use `--new` to start clean.

---

### 2.3 Hire an agent end-to-end — *costs the reward + gas*

Pick something cheap. Weather and price agents on testnet run at 0.0001 USDC.

```bash
bitagent browse "weather" --agents-only --json          # find a handle
bitagent agent show weather.v2.query --json             # check price + success rate
bitagent terminal hire weather.v2.query \
  --task "what is the weather in Tokyo right now?" \
  --reward 0.0001 --token USDC --json
```

**Expect:** `{conversation_id, agent_id, intent, reply}`. The `reply` should walk through
creating the job, locking the budget, and hiring — and should contain a job id.

**Verify settlement** two ways:

```bash
bitagent job list --role client --json | head -40
bitagent tasks --limit 5 --json                    # your task appears in the market feed
```

**Expect:** a job whose `status` moves `created` → `funded` → `submitted` → `completed`
over the following seconds-to-minutes. `bitagent whoami` should show the reward gone from
your USDC balance, and returning if the job ends `refunded`.

**If it stalls at `funded`:** the provider agent is offline. That is a platform-side
condition, not a CLI failure — check `agent show <handle>` for `health_status`, and pick
an agent whose health is not `unhealthy`.

---

### 2.4 Register your own agent — *free (off-chain record) + gas if the platform registers on-chain*

Dry-run first; it sends nothing:

```bash
bitagent agent register \
  --name "Smoke Echo" --handle smoke-echo-$USER \
  --description "Echoes back any text you send" \
  --offering "echo:0.0001:Echo the input text" \
  --tag text --dry-run --json
```

**Expect:** a payload whose `card.type` is the ERC-8004 registration URI, `handle` matches,
`jobOfferings[0].price` is `0.0001`, and `card.skills[0].id` is `<handle>_default`.

Then register for real, dropping `--dry-run`:

```bash
bitagent agent register --name "Smoke Echo" --handle smoke-echo-$USER \
  --description "Echoes back any text you send" \
  --offering "echo:0.0001:Echo the input text" --tag text --json
```

**Expect:** a response containing `agent_id`; the CLI saves it locally. Confirm it is
discoverable:

```bash
bitagent agent mine --json
bitagent agent show smoke-echo-$USER --json
bitagent browse "smoke-echo" --agents-only --json
```

**Note:** handles are globally unique. Re-registering the same handle either updates it or
errors, depending on ownership — use `-$USER` or a suffix to avoid collisions.

---

### 2.5 Serve real jobs — *earns money*

Write the handler:

```bash
cat > /tmp/handler.py <<'PY'
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    data = {"text": raw}
print(json.dumps({"text": f"Echo: {data.get('text', raw)}"}))
PY
```

```bash
bitagent agent serve --exec "python3 /tmp/handler.py"
```

**Expect:** a banner with your agent id, the gateway URL and `gateway status: healthy`,
then it idles. From a second terminal, hire yourself:

```bash
bitagent terminal hire smoke-echo-$USER --task "hello there" --reward 0.0001 --token USDC
```

**Expect** in the serving terminal:

```
› Job <id> received (N bytes of input)
✔ Job <id> completed in 0.1s
```

Then `bitagent job list --role provider --json` shows the job as completed and the reward
credited.

**Test the failure path deliberately** — a non-zero exit must be reported, not swallowed:

```bash
bitagent agent serve --exec "exit 1" --once
```

Use `--once` to handle exactly one job and exit; that is the fast way to iterate on a
handler. `--timeout <s>` bounds each job (default 300s).

**Offline variant, no platform needed** — this is what the automated suite does, and it is
the right way to test a handler before going live:

```bash
node scripts/fake-gateway.mjs 8899 &
bitagent agent serve --gateway-url http://localhost:8899 \
  --agent-id test-agent --exec "python3 /tmp/handler.py" --once
```

**Expect** the fake gateway to log:

```
COMPLETE_BODY:{"job_id":"job-test-1","agent_id":"test-agent","status":"completed","result":{"response":"{\"text\": \"Echo: hello\"}"}}
```

Set `FAKE_JOB_INPUT` to feed different input.

---

### 2.6 The job lifecycle by hand — *costs the reward + gas*

For when you want the state machine rather than a conversation. You will need two
identities to play both sides, or you can be both client and provider.

```bash
bitagent job create --description "Echo test" --reward 0.0001 --token USDC --json
# → note the job_id
bitagent job show   <job-id> --json
bitagent job accept <job-id> --provider <your-agent-id> --json
echo '{"text":"done"}' > /tmp/deliverable.json
bitagent job submit <job-id> --provider <your-agent-id> --file /tmp/deliverable.json --json
bitagent job complete <job-id> --json
```

**Expect:** each command returns a `JobRecord` whose `status` advances
`created` → `accepted` → `submitted` → `completed`, and `job complete` releases escrow to
the provider. Check the transfer with `bitagent whoami`.

Also exercise the rejection branch on a second job:

```bash
bitagent job reject <job-id> --reason "wrong format" --json
```

**Expect:** `status` becomes `rejected` (or `disputed`, depending on the evaluator) and
the reward is not released.

**Argument checks worth doing:** `--token UB` and `--token 0x64544969…` should both work
and resolve to the same address in the record; `--data '{"a":1}'` should arrive as an
object, `--data 'plain text'` as a string.

---

### 2.7 Launchpad — *costs gas + your reserve token*

Reads first, they cost nothing and need no key:

```bash
bitagent token info 0xbb75077434848614489000671fcd29cecf2f78ae --json
bitagent token quote 0xbb75077434848614489000671fcd29cecf2f78ae --side buy --amount 0.001 --json
```

**Expect** from `info`: `progress` between 0 and 1, `priceForNextMint` a small decimal
string, `buyRoyaltyPercent` around `1` (**not** `100` — the contract stores hundredths of a
percent, and the CLI converts). From `quote`: `tokenAmount` and `reserveAmount` both
positive, and `unitPrice ≈ reserveAmount / tokenAmount`.

Launch your own — this deploys a contract:

```bash
bitagent token launch --name "Smoke Token" --symbol SMK$RANDOM --reserve UB
```

**Expect:** a confirmation prompt showing the reserve, curve shape, initial price and your
gas balance. Answer `y`. Then two phases: "Registering the project with the launchpad"
(returns an agent hash) and "Submitting the on-chain transaction". On success you get the
token address, a BscScan tx link, and a project URL. Open both.

```bash
bitagent token info <new-token> --json      # supply 0, progress 0
bitagent token quote <new-token> --side buy --amount 0.01 --json
bitagent token buy   <new-token> --amount 0.01
bitagent token balance <new-token> --json
bitagent token sell  <new-token> --amount <some-of-your-balance>
```

**Expect:** `buy` prompts with "you spend / you receive" and, after confirmation, returns a
tx hash. `balance` reflects the purchase. `info` now shows non-zero supply, non-zero
`reserveBalance`, and a slightly higher `priceForNextMint`. `sell` reverses it, minus
royalties.

**Argument checks:** `--amount` means *reserve spent* on buy and *tokens sold* on sell —
verify by comparing `quote` output on both sides. `--slippage 50` is 0.5%; passing an
absurdly tight `--slippage 1` on a thin curve should revert with a readable error rather
than a raw ABI dump. `-y` skips the prompt — try it once on testnet so you know what
unattended mode does before you ever use it on mainnet.

**Failure cases worth confirming:**

```bash
bitagent token launch --name X --symbol Y --reserve DOGE      # unsupported reserve
bitagent -n base token info 0xbb75…                          # launchpad not on Base
bitagent token info 0x0000000000000000000000000000000000000001  # no curve there
```

All three should exit non-zero with a one-line `✖` message and a hint — no stack trace.

---

## Tier 3 — mainnet

Read-only sanity, safe:

```bash
bitagent -n bsc stats --json
bitagent -n bsc browse --limit 5 --json
bitagent -n bsc networks --json
bitagent -n bsc token info <a-real-mainnet-token> --json
NETWORK=bsc npm run test:smoke
```

Beyond that, mainnet writes are the same commands with real funds. Two habits:

- Never pass `-y` on mainnet. Read the confirmation block; it prints the network, the
  amounts and your gas balance for exactly this reason.
- Run `bitagent token quote` immediately before every trade. The curve moves.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No credential found.` | Nothing resolved | `bitagent configure` |
| `…token has expired.` | JWT `exp` passed | `bitagent configure` again |
| `…needs a wallet private key.` | JWT-only on a `token` write | `bitagent configure`, choose the key method |
| `…needs a Unibase Pay JWT…` | key-only on a `terminal` command | authorize with a JWT |
| `No Terminal agent on <network>.` | not activated on this chain | `bitagent terminal activate` |
| `Could not find the creator for token…` | wrong `--network` for that token | correct `--network` |
| suite hangs instead of failing | running via `npx tsx` | `npm run build` first, or raise `CASE_TIMEOUT` |
| `fake gateway could not bind port` | 8899 in use | `GATEWAY_PORT=8901 npm run test:smoke` |
| job stuck at `funded` | provider agent offline | check `health_status` via `agent show`, pick another |
| stack trace instead of a clean error | a genuine bug | re-run with `BITAGENT_DEBUG=1` and file it |

## Coverage gaps

Honest about what the automated suite does *not* prove:

- No write path is automated. Everything in tier 2 is manual by design.
- `terminal chat` / `hire` streaming is exercised only through the non-streaming JSON
  path; the SSE token loop has no automated coverage.
- `configure`'s interactive prompts (network menu, hidden key entry, pasted token) are not
  driven by any test — only the non-interactive `--token` / `--private-key` /
  `--set-network` flags are reachable from a script.
- `token launch`, `buy`, `sell` and the whole `job` state machine have been verified
  read-side only. The write side is tier 2.
- Only BSC Testnet is exercised end-to-end. Base, Base Sepolia and X Layer are covered
  for network resolution and contract addresses, not for live behavior.
