#!/usr/bin/env bash
#
# Read-only smoke test for bitagent-cli.
#
#   npm run build && ./scripts/smoke.sh     # fastest: runs the built bundle
#   CLI="npx tsx bin/bitagent.ts" ./scripts/smoke.sh
#   NETWORK=bsc ./scripts/smoke.sh          # mainnet, still read-only
#
# Never sends a transaction and never creates a job. Tier 1 cases skip
# automatically when no credential resolves. Every case is time-bounded, so a
# hang fails that case instead of stalling the suite. Exits non-zero on failure.

set -uo pipefail
cd "$(dirname "$0")/.."

# Prefer the built bundle: one process per case, no npx/tsx wrapper to outlive a kill.
if [ -z "${CLI:-}" ]; then
  if [ -f dist/bin/bitagent.js ]; then
    CLI="node dist/bin/bitagent.js"
  else
    CLI="npx tsx bin/bitagent.ts"
    printf 'note: dist/ not built, falling back to tsx (slower). Run `npm run build` first.\n\n'
  fi
fi

NETWORK=${NETWORK:-bscTestnet}
CASE_TIMEOUT=${CASE_TIMEOUT:-60}
# A bonding-curve token that exists on BSC Testnet; override for other networks.
CURVE_TOKEN=${CURVE_TOKEN:-0xbb75077434848614489000671fcd29cecf2f78ae}
GATEWAY_PORT=${GATEWAY_PORT:-8899}

# Isolate CLI state so a run never clobbers a real config. Credentials still
# resolve from the environment and from ~/.config/unibase-aip-sdk/config.json.
WORKDIR=$(mktemp -d)
export BITAGENT_CONFIG_DIR="$WORKDIR/config"
cleanup() {
  [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

PASS=0
FAIL=0
SKIP=0
FAILED_CASES=()

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
dim()   { printf '\033[2m%s\033[0m' "$1"; }

pass() { PASS=$((PASS + 1)); printf '%s %s\n' "$(green ' ok ')" "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '%s %s %s\n' "$(dim 'skip')" "$1" "$(dim "($2)")"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILED_CASES+=("$1")
  printf '%s %s\n' "$(red 'FAIL')" "$1"
  [ -n "${2:-}" ] && printf '     %s\n' "$(dim "$2")"
  return 0
}

# Wait for a pid, killing it after N seconds. Returns the command's status, or
# 124 on timeout. macOS has no coreutils `timeout`, hence the hand-rolled loop.
wait_bounded() {
  local pid="$1" secs="$2" waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

# t <label> <js-assertion-on-d|-> <cli args...>
# Runs the command with --json, asserts exit 0, then evaluates the assertion
# against the parsed stdout document (`d`). Use `-` to assert only exit 0.
t() {
  local label="$1"; shift
  local assertion="$1"; shift
  local stdout="$WORKDIR/out.json" stderr="$WORKDIR/out.err" status

  $CLI -n "$NETWORK" "$@" --json >"$stdout" 2>"$stderr" &
  wait_bounded $! "$CASE_TIMEOUT"
  status=$?

  if [ "$status" -eq 124 ]; then
    fail "$label" "timed out after ${CASE_TIMEOUT}s"
    return
  fi
  if [ "$status" -ne 0 ]; then
    fail "$label" "exit $status — $(tr '\n' ' ' <"$stderr" | tail -c 200)"
    return
  fi
  if [ "$assertion" = "-" ]; then
    pass "$label"
    return
  fi

  if ASSERTION="$assertion" node -e '
    const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const fn = new Function("d", "return (" + process.env.ASSERTION + ")");
    if (!fn(d)) { console.error("assertion false: " + process.env.ASSERTION); process.exit(1); }
  ' "$stdout" 2>"$WORKDIR/assert.err"; then
    pass "$label"
  else
    fail "$label" "$(cat "$WORKDIR/assert.err")"
  fi
}

# terr <label> <cli args...> — expects a non-zero exit and a "✖" line on stderr.
terr() {
  local label="$1"; shift
  local stderr="$WORKDIR/out.err" status

  $CLI "$@" >/dev/null 2>"$stderr" &
  wait_bounded $! "$CASE_TIMEOUT"
  status=$?

  if [ "$status" -eq 124 ]; then
    fail "$label" "timed out after ${CASE_TIMEOUT}s"
  elif [ "$status" -eq 0 ]; then
    fail "$label" "expected a non-zero exit"
  elif grep -q '✖' "$stderr"; then
    pass "$label"
  else
    fail "$label" "no '✖' error line on stderr: $(head -c 160 "$stderr")"
  fi
}

json_field() { node -e '
  const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const fn = new Function("d", "return (" + process.argv[2] + ")");
  const v = fn(d);
  process.stdout.write(v === undefined || v === null ? "" : String(v));
' "$1" "$2" 2>/dev/null; }

printf '\nbitagent-cli smoke test\n'
printf '  cli:     %s\n' "$CLI"
printf '  network: %s\n' "$NETWORK"
printf '  timeout: %ss per case\n\n' "$CASE_TIMEOUT"

# ---------------------------------------------------------------- tier 0
printf '%s\n' "$(dim '── tier 0 — no credential, read-only ──')"

VERSION=$($CLI --version 2>/dev/null)
[ -n "$VERSION" ] && pass "--version → $VERSION" || fail "--version"

t "networks lists 5 chains"        'd.length === 5 && d.some(n => n.chainId === 97)'          networks
t "networks carry contracts"       'd.every(n => n.contracts && n.contracts.registry)'        networks
t "stats returns counters"         'typeof d.total_agents === "number" && d.total_agents > 0' stats
t "browse returns both sections"   'Array.isArray(d.agents) && Array.isArray(d.services)'     browse --limit 5
t "browse honours --limit"         'd.agents.length <= 3'                                     browse --limit 3
t "browse --agents-only"           'd.agents.length > 0 && d.services.length === 0'           browse --agents-only --limit 3
t "browse query filters"           'd.agents.every(a => JSON.stringify(a).toLowerCase().includes("weather"))' browse weather --agents-only --limit 5
t "agent list is paged"            'Array.isArray(d.data) && typeof d.total === "number"'     agent list --limit 5
t "agent show by handle"           'd.agent_id && d.handle === "coingecko"'                   agent show coingecko
t "agent show by chain-scoped id"  'd.agent_id && d.agent_id.includes(":")'                   agent show "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:477"
t "services list"                  'Array.isArray(d.data) && d.data.length > 0 && d.data[0].id' services --limit 5
t "tasks list"                     'Array.isArray(d.data) && typeof d.total === "number"'     tasks --limit 5
t "tasks honours --limit"          'd.data.length <= 3'                                       tasks --limit 3
t "rankings by tasks"              'Array.isArray(d) && d.length > 0 && d[0].rank === 1'      rankings --metric tasks --limit 5
t "config path"                    'typeof d.path === "string" && d.path.endsWith("config.json")' config path
t "skill check matches installed"  'd.upToDate === true'                                      skill check --against "$VERSION"
t "skill check detects drift"      'd.upToDate === false && d.action === "reload"'            skill check --against 0.0.0

# Service detail, using an id discovered above.
$CLI -n "$NETWORK" services --limit 5 --json >"$WORKDIR/services.json" 2>/dev/null
SERVICE_ID=$(json_field "$WORKDIR/services.json" 'd.data[0].id')
if [ -n "$SERVICE_ID" ]; then
  t "service detail by id"         'd.id !== undefined'                                       services "$SERVICE_ID"
else
  skip "service detail by id" "no service id available"
fi

terr "unknown network errors"      -n solana stats
terr "launchpad gated off BSC"     -n base token launch --name X --symbol X -y
terr "bad token address rejected"  -n "$NETWORK" token info not-an-address

case "$NETWORK" in
  bsc|bscTestnet)
    t "token info reads the curve"  'd.symbol && typeof d.progress === "number" && d.progress >= 0' token info "$CURVE_TOKEN"
    t "royalties render as percent" 'd.buyRoyaltyPercent <= 100 && d.sellRoyaltyPercent <= 100'     token info "$CURVE_TOKEN"
    t "buy quote prices tokens"     'Number(d.tokenAmount) > 0 && Number(d.reserveAmount) > 0'      token quote "$CURVE_TOKEN" --side buy --amount 0.001
    t "sell quote prices reserve"   'Number(d.reserveAmount) > 0'                                   token quote "$CURVE_TOKEN" --side sell --amount 1000
    terr "quote rejects bad --side" -n "$NETWORK" token quote "$CURVE_TOKEN" --side sideways --amount 1
    ;;
  *)
    skip "launchpad reads" "no bonding curve on $NETWORK"
    ;;
esac

# ------------------------------------------------- agent serve, fake gateway
printf '\n%s\n' "$(dim '── agent serve, against a local fake gateway ──')"

# serve_case <label> <exec-command> <expect-substring>
serve_case() {
  local label="$1" handler="$2" expect="$3"
  local log="$WORKDIR/gw-$RANDOM.log" status

  node scripts/fake-gateway.mjs "$GATEWAY_PORT" 2>"$log" &
  GW_PID=$!
  sleep 1
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    skip "$label" "fake gateway could not bind port $GATEWAY_PORT"
    return
  fi

  $CLI agent serve --gateway-url "http://localhost:$GATEWAY_PORT" \
    --agent-id test-agent --exec "$handler" --once \
    --poll-timeout 2 --timeout 20 >/dev/null 2>"$WORKDIR/serve.log" &
  wait_bounded $! 45
  status=$?

  kill "$GW_PID" 2>/dev/null
  wait "$GW_PID" 2>/dev/null
  GW_PID=""

  if [ "$status" -eq 124 ]; then
    fail "$label" "serve did not exit within 45s"
  elif grep -q "$expect" "$log"; then
    pass "$label"
  else
    fail "$label" "completion body was: $(grep COMPLETE_BODY "$log" | head -1 | head -c 200)"
  fi
}

serve_case "serve completes a job" \
  'python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(json.dumps({\"text\": \"Echo: \" + d[\"text\"]}))"' \
  'Echo: hello'

serve_case "serve reports a failure" \
  'echo boom >&2; exit 3' \
  'exited with code 3'

# ------------------------------------------- terminal chat, against a fake AIP
printf '\n%s\n' "$(dim '── terminal chat SSE shapes, against a local fake AIP ──')"

# A syntactically valid JWT with a far-future exp. Not a credential: the CLI only
# reads `exp` locally, and the fake server never checks the signature.
fake_jwt() {
  local header payload
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | base64 | tr -d '=\n' | tr '/+' '_-')
  payload=$(printf '{"sub":"0xtest","exp":4102444800}' | base64 | tr -d '=\n' | tr '/+' '_-')
  printf '%s.%s.x' "$header" "$payload"
}

# chat_case <label> <mode> <expected-substring>
chat_case() {
  local label="$1" mode="$2" expect="$3"
  local port=${AIP_PORT:-8898} log="$WORKDIR/aip-$mode.log" status

  node scripts/fake-aip.mjs "$port" "$mode" 2>"$log" &
  local pid=$!
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    skip "$label" "fake aip could not bind port $port"
    return
  fi

  UNIBASE_PROXY_AUTH="$(fake_jwt)" $CLI -n "$NETWORK" terminal chat "btc price" \
    --agent erc8004:butler.test --aip-endpoint "http://localhost:$port" --new --json \
    >"$WORKDIR/chat.json" 2>"$WORKDIR/chat.err" &
  wait_bounded $! 30
  status=$?

  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null

  if [ "$status" -eq 124 ]; then
    fail "$label" "timed out"
  elif [ "$mode" = "error" ]; then
    # The error mode must fail loudly, not fall back and pretend it worked.
    if [ "$status" -ne 0 ] && grep -q "$expect" "$WORKDIR/chat.err"; then
      pass "$label"
    else
      fail "$label" "exit $status, stderr: $(head -c 160 "$WORKDIR/chat.err")"
    fi
  elif [ "$status" -ne 0 ]; then
    fail "$label" "exit $status — $(tr '\n' ' ' <"$WORKDIR/chat.err" | tail -c 160)"
  # The fake server marks its non-streaming reply, so a streaming case that
  # silently fell back is a failure rather than a pass. Without this the suite
  # cannot tell "parsed the stream" from "dropped every event and retried" —
  # which is exactly how the event-name mismatch hid in production.
  elif ASSERTION="d.reply.includes('$expect')$([ "$mode" = empty ] || printf " && !d.reply.includes('non-streaming')")" node -e '
    const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!new Function("d", "return (" + process.env.ASSERTION + ")")(d)) {
      console.error("reply was: " + JSON.stringify(d.reply)); process.exit(1);
    }
  ' "$WORKDIR/chat.json" 2>"$WORKDIR/chat.assert"; then
    pass "$label"
  else
    fail "$label" "$(cat "$WORKDIR/chat.assert")"
  fi
}

chat_case "chat reads platform bus events"  bus      "BTC is \$100k"
chat_case "chat reads documented envelope"  envelope "BTC is \$100k"
chat_case "chat renders progress + answer"  progress "BTC is \$100k"
chat_case "empty stream falls back"         empty    "non-streaming"
chat_case "run_error fails loudly"          error    "no agent could take the task"

# ---------------------------------------------------------------- tier 1
printf '\n%s\n' "$(dim '── tier 1 — needs a credential, still read-only ──')"

if ! $CLI -n "$NETWORK" whoami --no-balances --json >"$WORKDIR/whoami.json" 2>/dev/null; then
  skip "tier 1" "no credential resolved — run \`bitagent configure\`"
else
  pass "whoami resolves an identity"
  MODE=$(json_field "$WORKDIR/whoami.json" 'd.credential.mode')
  printf '     %s\n' "$(dim "credential: $MODE  wallet: $(json_field "$WORKDIR/whoami.json" 'd.wallet')")"

  t "whoami reads balances"        'Array.isArray(d.balances) && d.balances.length > 0'       whoami
  t "register dry-run is ERC-8004" 'd.card.type.includes("eip-8004") && d.handle === "smoke-test-agent"' \
      agent register --name "Smoke Test Agent" --handle smoke-test-agent --offering "echo:0.01:Echo" --dry-run
  t "dry-run carries the offering" 'd.jobOfferings.length === 1 && d.jobOfferings[0].price === 0.01' \
      agent register --name "Smoke Test Agent" --handle smoke-test-agent --offering "echo:0.01:Echo" --dry-run
  terr "bad --offering rejected"   agent register --name X --offering "no-price" --dry-run

  if [ "$MODE" = "jwt" ]; then
    t "agent mine"                 'Array.isArray(d)'                                          agent mine
    t "job list"                   'Array.isArray(d)'                                          job list
    t "terminal status"            'd.agent_id !== undefined || d.active === false'             terminal status
    t "terminal conversations"     'Array.isArray(d.conversations)'                             terminal conversations

    $CLI -n "$NETWORK" terminal conversations --json >"$WORKDIR/convs.json" 2>/dev/null
    CONV_ID=$(json_field "$WORKDIR/convs.json" 'd.conversations[0] && d.conversations[0].conversation_id')
    if [ -n "$CONV_ID" ]; then
      t "terminal history"         'Array.isArray(d.messages)'                                  terminal history "$CONV_ID"
    else
      skip "terminal history" "no conversation on this account yet"
    fi
  else
    skip "agent mine / job list / terminal" "needs a JWT; current credential is $MODE"
  fi
fi

# ---------------------------------------------------------------- summary
printf '\n%s\n' "$(dim '────────────────────────────────')"
printf '%s passed, %s failed, %s skipped\n' \
  "$(green "$PASS")" "$([ "$FAIL" -gt 0 ] && red "$FAIL" || echo 0)" "$SKIP"

if [ "$FAIL" -gt 0 ]; then
  printf '\nfailed cases:\n'
  for case in "${FAILED_CASES[@]}"; do printf '  - %s\n' "$case"; done
  exit 1
fi
printf '\nAll good. Paid and state-changing flows are in TESTING.md tier 2.\n'
