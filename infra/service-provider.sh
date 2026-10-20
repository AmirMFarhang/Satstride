#!/usr/bin/env bash
# The laptop as the service provider (docs/SERVICE-PROVIDER.md): one command
# brings up, on ONE Compose project with ports from the environment,
#   the regtest services (bitcoind, electrs, rgb-proxy, Nostr relay),
#   the platform,
#   the lender peer(s),
# and prints what the phone needs: relay URL, platform URL, lender and
#
#   infra/service-provider.sh up               start (idempotent); prints provider.json
#   infra/service-provider.sh status [--json]  what runs, from the pid files and Compose
#   infra/service-provider.sh stop             stop everything it started; volumes and state kept
#   infra/service-provider.sh env              shell exports for the phone and tools
#   infra/service-provider.sh info             provider.json; on Mutinynet also the QR the phones scan
#
# Env (defaults = the passbook-provider-dev test project):
#   PASSBOOK_SP_PROJECT (passbook-provider-dev)
#   PASSBOOK_SP_{BITCOIND,ELECTRS,PROXY,RELAY,PLATFORM}_PORT (18663 50231 3330 7997 4351)
#   PASSBOOK_SP_CHECK_STATUS_PORT (4361)
#   PASSBOOK_SP_STATE (data/service-provider/<project>, git-ignored: wallets, keys, logs, pids, provider.json)
#   PASSBOOK_SP_PUBLIC_HOST (127.0.0.1: the host the phone uses, e.g. with adb reverse; or a LAN address). Host wallets'
#     RGB invoices name the proxy as rpc://<this host>:<proxy port>/json-rpc, so the phone can post consignments to it
#   PASSBOOK_SP_LENDERS (lender1; none = no peer), PASSBOOK_SP_PEER_ARGS (flags for src/cli/peer.ts), PASSBOOK_SP_CHECK_PRICE (0.5)
#   PASSBOOK_SP_SUBNET (10.231.63.0/24: the project network, explicit because Docker's default pools run out)
#   PASSBOOK_SP_PUBLIC_RELAYS (empty: local relay only; `default`: wss://nos.lol,wss://relay.primal.net,wss://nostr.mom;
#     or a comma list of wss:// URLs). Public relays are added ALONGSIDE the local relay for the lender peer(s), the
#     check node and the help agent; each labels its own events (network tag, NIP-31 alt "test USDT ... no value",
#     NIP-40 expiry on offers: src/agents/relay.ts). The platform stays local. docs/SERVICE-PROVIDER.md "Public relays and Mutinynet".
#   PASSBOOK_SP_ASSIST_AI (qvac-http), PASSBOOK_SP_ASSIST_QVAC_URL, PASSBOOK_SP_ASSIST_MODEL: the help agent (lane D2), if built
#   PASSBOOK_SP_NETWORK (regtest | mutinynet). mutinynet: the provider for two phones on Mutinynet (test coins only):
#     the platform (Esplora; over Nostr with P1's bridge, on the LAN as the fallback, API auth enforced), the check
#     node and the help agent, on the public relays only; no chain, no RGB Lightning node and no lender of ours (the
#     lender is a phone). Defaults: project passbook-provider-mutinynet, platform 4391, check status 4393, LAN host.
#
# stop never deletes volumes (no `down -v`), wallets or state.
set -euo pipefail
unset PASSBOOK_BORROWER_LIGHTNING_URL PASSBOOK_LENDER_LIGHTNING_URL PASSBOOK_SP_RLN_LENDER_URL PASSBOOK_SP_RLN_CHECK_URL PASSBOOK_CHECK_PROXY
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NETWORK=${PASSBOOK_SP_NETWORK:-regtest}
case "$NETWORK" in regtest|mutinynet) ;; *) echo "[service-provider] PASSBOOK_SP_NETWORK must be regtest or mutinynet (never mainnet)" >&2; exit 2 ;; esac
if [ "$NETWORK" = mutinynet ]; then PROJECT=${PASSBOOK_SP_PROJECT:-passbook-provider-mutinynet}; else PROJECT=${PASSBOOK_SP_PROJECT:-passbook-provider-dev}; fi
BITCOIND_PORT=${PASSBOOK_SP_BITCOIND_PORT:-18663}
ELECTRS_PORT=${PASSBOOK_SP_ELECTRS_PORT:-50231}
PROXY_PORT=${PASSBOOK_SP_PROXY_PORT:-3330}
RELAY_PORT=${PASSBOOK_SP_RELAY_PORT:-7997}
PLATFORM_PORT=${PASSBOOK_SP_PLATFORM_PORT:-$([ "$NETWORK" = mutinynet ] && echo 4391 || echo 4351)}
CHECK_STATUS_PORT=${PASSBOOK_SP_CHECK_STATUS_PORT:-$([ "$NETWORK" = mutinynet ] && echo 4393 || echo 4361)}
STATE=$(mkdir -p "${PASSBOOK_SP_STATE:-$ROOT/data/service-provider/$PROJECT}" && cd "${PASSBOOK_SP_STATE:-$ROOT/data/service-provider/$PROJECT}" && pwd)
# On Mutinynet the phones come over the Wi-Fi (the fallback to the Nostr bridge): the laptop's LAN address by default.
lan_ip() {
  if command -v ip >/dev/null 2>&1; then ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' || true
  elif command -v ipconfig >/dev/null 2>&1; then ipconfig getifaddr en0 2>/dev/null || true
  fi
}
if [ "$NETWORK" = mutinynet ]; then PUBLIC_HOST=${PASSBOOK_SP_PUBLIC_HOST:-$(lan_ip)}; PUBLIC_HOST=${PUBLIC_HOST:-127.0.0.1}; else PUBLIC_HOST=${PASSBOOK_SP_PUBLIC_HOST:-127.0.0.1}; fi
if [ "$NETWORK" = mutinynet ]; then
  LENDERS=${PASSBOOK_SP_LENDERS:-none}
  [ "$LENDERS" = none ] || { echo "[service-provider] no laptop lender on Mutinynet: the lender is a phone (PASSBOOK_SP_LENDERS=none)" >&2; exit 2; }
else LENDERS=${PASSBOOK_SP_LENDERS:-lender1}; fi
# The lender peer negotiates over Nostr, receives a signed check bill due at close,
# and underwrites only a verified QUALIFY. --auto-approve is a labelled rehearsal (regtest test coins only).
PEER_ARGS=${PASSBOOK_SP_PEER_ARGS:---lender-pays-check --auto-approve --timeout-ms 3600000}
CHECK_PRICE=${PASSBOOK_SP_CHECK_PRICE:-0.5}
# Public Nostr relays, alongside the local one (infra/public-relay-probe.ts chose the default list on 18 Oct 2026).
DEFAULT_PUBLIC_RELAYS=wss://nos.lol,wss://relay.primal.net,wss://nostr.mom
PUBLIC_RELAYS=${PASSBOOK_SP_PUBLIC_RELAYS:-}
[ "$PUBLIC_RELAYS" = default ] && PUBLIC_RELAYS=$DEFAULT_PUBLIC_RELAYS
# On Mutinynet the public relays are the only relays: the phones reach nothing else.
[ "$NETWORK" = mutinynet ] && [ -z "$PUBLIC_RELAYS" ] && PUBLIC_RELAYS=$DEFAULT_PUBLIC_RELAYS
for r in ${PUBLIC_RELAYS//,/ }; do case "$r" in wss://?*) ;; *) echo "[service-provider] PASSBOOK_SP_PUBLIC_RELAYS: $r is not a wss:// URL" >&2; exit 2 ;; esac; done
PIDS="$STATE/pids"
LOGS="$STATE/logs"
mkdir -p "$PIDS" "$LOGS"

export COMPOSE_PROJECT_NAME=$PROJECT
export PASSBOOK_BITCOIND_PORT=$BITCOIND_PORT PASSBOOK_ELECTRS_PORT=$ELECTRS_PORT PASSBOOK_PROXY_PORT=$PROXY_PORT PASSBOOK_RELAY_PORT=$RELAY_PORT
COMPOSE=(docker compose -f "$ROOT/infra/compose.yaml" -f "$ROOT/infra/service-provider.compose.yaml")
RPC=("${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password)
SERVICES=(bitcoind electrs rgb-proxy nostr-relay)

say() { echo "[service-provider] $*" >&2; }
alive() { [ -f "$PIDS/$1.pid" ] && kill -0 "$(cat "$PIDS/$1.pid")" 2>/dev/null; }
listening() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }
ours_container_port() { docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Ports}}' | grep -q "127.0.0.1:$1->"; }


app_env() {
  # Stale shell settings must not activate retired transports in a child agent.
  unset PASSBOOK_BORROWER_LIGHTNING_URL PASSBOOK_LENDER_LIGHTNING_URL PASSBOOK_SP_RLN_LENDER_URL PASSBOOK_SP_RLN_CHECK_URL PASSBOOK_CHECK_PROXY
  export BITCOIND_URL=http://127.0.0.1:$BITCOIND_PORT BITCOIND_USER=user BITCOIND_PASSWORD=password PASSBOOK_CHAIN=bitcoind
  export RGB_INDEXER_URL=tcp://127.0.0.1:$ELECTRS_PORT
  # Host wallets (the lender peer, the platform's watch wallet, the seed) name the proxy in their RGB invoices, and the
  # phone posts its consignments to that endpoint. The phone reaches the proxy only as PUBLIC_HOST:PROXY_PORT (127.0.0.1
  # over adb reverse, or a LAN address), never at the Docker bridge address, so host wallets use that endpoint.
  export RGB_TRANSPORT_URL=rpc://$PUBLIC_HOST:$PROXY_PORT/json-rpc
  export PASSBOOK_RELAYS=ws://127.0.0.1:$RELAY_PORT PASSBOOK_URL=http://127.0.0.1:$PLATFORM_PORT
  export PASSBOOK_WALLETS=$STATE/wallets PASSBOOK_STATE=$STATE/state.json PASSBOOK_DB=$STATE/platform.db
  export PASSBOOK_SP_STATE=$STATE
  export PASSBOOK_PUBLIC_RELAYS=$PUBLIC_RELAYS
}

# The relays of a service on the public relays too: the local relay plus the public ones, and PASSBOOK_PUBLIC_NETWORK, so
# its Relay (src/agents/relay.ts) labels every event it signs and sends nothing unlabelled off this machine. `guard` also
# preloads infra/public-ws-guard.mjs for a process that opens nostr-tools pools outside src/agents/relay.ts (the lender
# peer's negotiation pool in src/agents/lender.ts, the help agent's), so an unreachable public relay cannot crash it.
# Without public relays: the local relay only, exactly as before.
labelled_env() {
  LABELLED=(PASSBOOK_RELAYS="ws://127.0.0.1:$RELAY_PORT")
  [ -z "$PUBLIC_RELAYS" ] && return 0
  if [ "$NETWORK" = mutinynet ]; then LABELLED=(PASSBOOK_RELAYS="$PUBLIC_RELAYS" PASSBOOK_PUBLIC_NETWORK=mutinynet)
  else LABELLED=(PASSBOOK_RELAYS="ws://127.0.0.1:$RELAY_PORT,$PUBLIC_RELAYS" PASSBOOK_PUBLIC_NETWORK=regtest); fi
  [ "${1:-}" = guard ] && LABELLED+=(NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=$ROOT/infra/public-ws-guard.mjs")
  return 0
}

# A port is free, or already ours (our containers or our live processes); anything else refuses.
check_ports() {
  local p name
  for pair in "bitcoind:$BITCOIND_PORT" "electrs:$ELECTRS_PORT" "proxy:$PROXY_PORT" "relay:$RELAY_PORT"; do
    name=${pair%%:*}; p=${pair##*:}
    if listening "$p" && ! ours_container_port "$p"; then say "port $p ($name) is held by something outside project $PROJECT; refusing"; exit 3; fi
  done
  for pair in "platform:$PLATFORM_PORT" "check-node:$CHECK_STATUS_PORT"; do
    name=${pair%%:*}; p=${pair##*:}
    if listening "$p" && ! alive "$name"; then say "port $p ($name) is held by another process; refusing"; exit 3; fi
  done
}

start_bg() { # name logfile command...
  local name=$1; shift
  if alive "$name"; then say "$name already running (pid $(cat "$PIDS/$name.pid"))"; return; fi
  setsid nohup "$@" > "$LOGS/$name.log" 2>&1 < /dev/null &
  echo $! > "$PIDS/$name.pid"
  say "$name started (pid $!, log $LOGS/$name.log)"
}

wait_for() { # description seconds command...
  local what=$1 secs=$2; shift 2
  for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  say "$what did not come up in ${secs}s"; return 1
}

provider_json() {
  app_env
  STATE=$STATE PUBLIC_HOST=$PUBLIC_HOST RELAY_PORT=$RELAY_PORT PLATFORM_PORT=$PLATFORM_PORT PROJECT=$PROJECT LENDERS=$LENDERS PUBLIC_RELAYS="$(active_public_relays)" NETWORK=$NETWORK \
    npx tsx infra/service-provider-info.ts
}

# Bill at close (lane E2, docs/CHECK-MARKET.md): the check fee is added to the lender's platform fee when the loan closes.
# Wired only where this checkout's check node knows --bill-at-close; the platform accepts bills from this operator only.
bill_env() {
  BILL_PLATFORM=() BILL_NODE=() BILL_FLAG=()
  grep -q -- '--bill-at-close' "$ROOT/src/checknode/provider.ts" 2>/dev/null || return 0
  BILL_OPERATOR=$(npx tsx infra/service-provider-operator-pk.ts "$STATE/keys/operator.secret")
  BILL_PLATFORM=(PASSBOOK_CHECK_BILLS="$STATE/check-bills.jsonl" PASSBOOK_CHECK_BILL_OPERATORS="$BILL_OPERATOR")
  BILL_NODE=(PASSBOOK_CHECK_BILLS="$STATE/check-bills.jsonl" PASSBOOK_URL="http://127.0.0.1:$PLATFORM_PORT")
  BILL_FLAG=(--bill-at-close)
}

# The help agent (lane D2, src/assistant): answers and allowlisted navigation over Nostr (NIP-44), never money. The
# templates only, labelled. Started only where D2's `passbook assistant` is built in this checkout.
start_assistant() {
  if [ -d "$ROOT/src/assistant" ]; then
    labelled_env guard
    start_bg assistant env "${LABELLED[@]}" PASSBOOK_ASSIST_AI="${PASSBOOK_SP_ASSIST_AI:-qvac-http}" QVAC_BASE_URL="${PASSBOOK_SP_ASSIST_QVAC_URL:-http://127.0.0.1:11690/v1}" QVAC_MODEL="${PASSBOOK_SP_ASSIST_MODEL:-qvac-sdk:qwen3-1.7b}" \
      npx tsx src/cli/passbook.ts assistant serve --secret-file "$STATE/keys/assistant.secret" --info-out "$STATE/assistant.json" --log "$LOGS/assistant.jsonl"
    wait_for assistant 30 test -s "$STATE/assistant.json" || { tail -5 "$LOGS/assistant.log" >&2; exit 1; }
  else
    say "help agent not started: src/assistant (lane D2) is not in this checkout"
  fi
}

# The provider on Mutinynet (PASSBOOK_SP_NETWORK=mutinynet): no Compose project, no chain or RGB Lightning node of ours,
# no lender (the lender is a phone). The platform reads Mutinynet through KaleidoSwap's Esplora (its deployment config).
up_mutinynet() {
  # Repayment watches and platform-fee invoices need the platform's RGB services, which src/server/main.ts starts only on
  # bitcoind until it also starts them on a public network: refuse instead of running a platform that can't take repayments.
  awk '/cfg\.repayments = await repaymentWatchFromEnv/ { print prev } { prev = $0 }' "$ROOT/src/server/main.ts" | grep -q 'network\.public' || {
    say "the platform in this checkout starts no RGB repayment watch or fee wallet on a public network (src/server/main.ts); refusing"; exit 3; }
  for pair in "platform:$PLATFORM_PORT" "check-node:$CHECK_STATUS_PORT"; do
    name=${pair%%:*}; p=${pair##*:}
    if listening "$p" && ! alive "$name"; then say "port $p ($name) is held by another process; refusing"; exit 3; fi
  done
  printf '%s' "$PUBLIC_RELAYS" > "$ACTIVE_RELAYS_FILE"
  say "Mutinynet provider (test coins only) on $PUBLIC_RELAYS: platform, check node, help agent; no chain, Lightning node or lender of ours"
    npx tsx infra/service-provider-mutinynet.ts > "$LOGS/setup.log" 2>&1 || { tail -5 "$LOGS/setup.log" >&2; exit 1; }
  local config="$STATE/mutinynet.config.yaml" asset rgb_env
  asset=$(python3 -c "import json;print(json.load(open('$STATE/mutinynet.json'))['asset']['id'])")
  # The platform's own RGB wallets (the fee wallet, the repayment watch) on Mutinynet: lane E2's network selection.
  read -r -a rgb_env < <(python3 -c "import json;e=json.load(open('$STATE/mutinynet.json'))['endpoints'];print(f\"PASSBOOK_RGB_NETWORK={e['rgb_network']} RGB_INDEXER_URL={e['rgb_indexer']} RGB_TRANSPORT_URL={e['rgb_proxy']}\")")
  bill_env
  # The platform's API for the phones: over Nostr when P1's bridge (src/server/nostr-api.ts) is in this checkout, on the
  # public relays; on the LAN as the fallback (HOST, default 0.0.0.0; API auth stays enforced, the default).
  local bridge=()
  [ -f "$ROOT/src/server/nostr-api.ts" ] && bridge=(PASSBOOK_PLATFORM_RELAYS="$PUBLIC_RELAYS")
  labelled_env guard
  start_bg platform env "${LABELLED[@]}" "${bridge[@]}" "${BILL_PLATFORM[@]}" "${rgb_env[@]}" PASSBOOK_CONFIG="$config" PASSBOOK_WALLETS="$STATE/wallets" PASSBOOK_DB="$STATE/platform.db" \
    PASSBOOK_SP_STATE="$STATE" PASSBOOK_ASSIST_AI="${PASSBOOK_SP_ASSIST_AI:-qvac-http}" QVAC_BASE_URL="${PASSBOOK_SP_ASSIST_QVAC_URL:-http://127.0.0.1:11690/v1}" QVAC_MODEL="${PASSBOOK_SP_ASSIST_MODEL:-qvac-sdk:qwen3-1.7b}" \
    HOST="${PASSBOOK_SP_PLATFORM_HOST:-0.0.0.0}" PORT="$PLATFORM_PORT" npx tsx src/server/main.ts
  wait_for platform 90 curl -sf "http://127.0.0.1:$PLATFORM_PORT/state" || { tail -5 "$LOGS/platform.log" >&2; exit 1; }
  # The check node offers the bill-at-close rail (no Lightning on a phone) and runs its chain checks on Mutinynet: it
  # starts only where this checkout's check node does both (lane E2).
  if [ ${#BILL_FLAG[@]} -gt 0 ] && grep -q 'EsploraChain' "$ROOT/src/checknode/provider.ts"; then
    labelled_env guard
    # The chain checks trust the platform's history observer: the platform key that watched the test persona from zero
    # (infra/public-mutinynet-persona.ts); without it a persona's signed history is not trusted and the check escalates.
    local observer
    observer=${PASSBOOK_HISTORY_OBSERVER_PK:-$(python3 -c "import json;print(json.load(open('$STATE/mutinynet.json'))['platform_pk'])")}
    # Mutinynet mines a block about every 30 s, so the observer's history proof may be up to 240 blocks (~2 h) old;
    # every allocation is still re-checked unspent at check time through Esplora (src/scorer/chain-checks.ts, #81).
    start_bg check-node env "${LABELLED[@]}" "${BILL_NODE[@]}" PASSBOOK_CONFIG="$config" PASSBOOK_HISTORY_OBSERVER_PK="$observer" \
      PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS="${PASSBOOK_SP_HISTORY_PROOF_MAX_AGE_BLOCKS:-240}" \
      npx tsx src/cli/passbook.ts check-node provide --name provider --price "$CHECK_PRICE" --asset "$asset" --status-port "$CHECK_STATUS_PORT" \
      --operator-secret-file "$STATE/keys/operator.secret" --chain-check-secret-file "$STATE/keys/chain-check.secret" --payer-modes lender \
      --info-out "$STATE/check-node.json" "${BILL_FLAG[@]}"
    wait_for check-node 90 curl -sf "http://127.0.0.1:$CHECK_STATUS_PORT/status" || { tail -5 "$LOGS/check-node.log" >&2; exit 1; }
  else
    say "check node not started on Mutinynet: it needs lane E2's check node (bill at close without a Lightning node, chain checks through Esplora) in this checkout"
  fi
  start_assistant
  provider_json | tee "$STATE/provider.json"
}

# The public relays the running services started with: a rerun of `up` with another PASSBOOK_SP_PUBLIC_RELAYS refuses
# while any of them is alive (start_bg skips a live service, so it would keep its old relays under a new provider.json).
ACTIVE_RELAYS_FILE="$STATE/public-relays.active"
active_public_relays() { if [ -f "$ACTIVE_RELAYS_FILE" ]; then cat "$ACTIVE_RELAYS_FILE"; else printf '%s' "$PUBLIC_RELAYS"; fi; }

case "${1:-}" in
  up)
    if [ -f "$ACTIVE_RELAYS_FILE" ] && [ "$(cat "$ACTIVE_RELAYS_FILE")" != "$PUBLIC_RELAYS" ]; then
      for f in "$PIDS"/*.pid; do
        [ -e "$f" ] || continue
        if alive "$(basename "$f" .pid)"; then
          say "the running services use PASSBOOK_SP_PUBLIC_RELAYS='$(cat "$ACTIVE_RELAYS_FILE")', this up asks for '$PUBLIC_RELAYS'; run 'infra/service-provider.sh stop' first, then up again, so no service keeps stale relays"
          exit 3
        fi
      done
    fi
    grep -q -- '--bill-at-close' "$ROOT/src/checknode/provider.ts" || { say "requires PR #71's bill-at-close provider; refusing to start an unpaid or retired-transport fallback"; exit 3; }
    if [ "$NETWORK" = mutinynet ]; then up_mutinynet; exit 0; fi
    check_ports
    printf '%s' "$PUBLIC_RELAYS" > "$ACTIVE_RELAYS_FILE"
    say "project $PROJECT: regtest services; credit checks billed at close, not paid up front"
    "${COMPOSE[@]}" up -d "${SERVICES[@]}" >> "$LOGS/compose.log" 2>&1
    wait_for bitcoind 60 "${RPC[@]}" getblockchaininfo
    "${RPC[@]}" createwallet miner >/dev/null 2>&1 || "${RPC[@]}" loadwallet miner >/dev/null 2>&1 || true
    if [ "$("${RPC[@]}" getblockcount)" -lt 101 ]; then "${RPC[@]}" generatetoaddress 101 "$("${RPC[@]}" -rpcwallet=miner getnewaddress)" >/dev/null; fi
    app_env
    if [ ! -f "$STATE/state.json" ]; then say "seeding test wallets, test USDT and the personas (regtest)"; npx tsx infra/seed.ts --fresh --personas > "$LOGS/seed.log" 2>&1; fi
    npx tsx infra/service-provider-setup.ts > "$LOGS/setup.log" 2>&1 || { tail -5 "$LOGS/setup.log" >&2; exit 1; }
    ASSET=$(python3 -c "import json;print(json.load(open('$STATE/provider-setup.json'))['asset_id'])")
    bill_env
    start_bg platform env "${BILL_PLATFORM[@]}" PASSBOOK_CONFIG="$STATE/scorer.config.yaml" HOST=127.0.0.1 PORT="$PLATFORM_PORT" npx tsx src/server/main.ts
    wait_for platform 60 curl -sf "http://127.0.0.1:$PLATFORM_PORT/state"
    # The chain checks trust the platform's history observer (the platform key that observed the personas from zero).
    OBSERVER=${PASSBOOK_HISTORY_OBSERVER_PK:-$(python3 -c "import json;print(json.load(open('$STATE/state.json'))['platform_pk'])")}
    labelled_env
    start_bg check-node env "${LABELLED[@]}" "${BILL_NODE[@]}" PASSBOOK_CONFIG="$STATE/scorer.config.yaml" PASSBOOK_HISTORY_OBSERVER_PK="$OBSERVER" \
      npx tsx src/cli/passbook.ts check-node provide --name provider --price "$CHECK_PRICE" --asset "$ASSET" \
      --status-port "$CHECK_STATUS_PORT" --operator-secret-file "$STATE/keys/operator.secret" --chain-check-secret-file "$STATE/keys/chain-check.secret" \
      --payer-modes lender --info-out "$STATE/check-node.json" "${BILL_FLAG[@]}"
    wait_for check-node 90 curl -sf "http://127.0.0.1:$CHECK_STATUS_PORT/status" || { tail -5 "$LOGS/check-node.log" >&2; exit 1; }
    start_assistant
    [ "$LENDERS" = none ] && say "no lender peer started (PASSBOOK_SP_LENDERS=none: a test or another process is the lender)"
    for l in ${LENDERS//,/ }; do
      [ "$l" = none ] && continue
      # The lender peer (src/cli/peer.ts); PASSBOOK_SP_PEER_ARGS replaces its flags.
      # shellcheck disable=SC2086
      OPERATOR_PK=$(python3 -c "import json;print(json.load(open('$STATE/check-node.json'))['operator_pk'])")
      # With public relays, the peer's offer (NIP-40 expiry), negotiation and check messages go there too, labelled.
      labelled_env guard
      start_bg "peer-$l" env "${LABELLED[@]}" PASSBOOK_CONFIG="$STATE/scorer.config.yaml" PASSBOOK_CHECK_NODE_PKS="$OPERATOR_PK" \
        npx tsx src/cli/peer.ts --role lender --wallet "$l" --asset-id "$ASSET" $PEER_ARGS
    done
    provider_json | tee "$STATE/provider.json"
    ;;
  info)
    # provider.json for the phones, and on Mutinynet the QR they scan (terminal; provider-qr.svg next to provider.json)
    QR_TERMINAL=1 provider_json
    ;;
  status)
    app_env
    if [ "${2:-}" = --json ]; then provider_json; exit 0; fi
    [ "$NETWORK" = mutinynet ] && echo "network: mutinynet (test coins only); no Compose project" || "${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' 2>/dev/null | sed 's/^/compose: /'
    if [ "$NETWORK" = mutinynet ]; then echo "relays: $(active_public_relays) only (platform, check node, help agent; labelled mutinynet test data)"
    else echo "relays: ws://127.0.0.1:$RELAY_PORT${PUBLIC_RELAYS:+ + public $PUBLIC_RELAYS (lender peer, check node, help agent; labelled test data)}"; fi
    for f in "$PIDS"/*.pid; do [ -e "$f" ] || continue; n=$(basename "$f" .pid); alive "$n" && echo "$n: running (pid $(cat "$f"))" || echo "$n: stopped"; done
    ;;
  stop)
    for f in "$PIDS"/*.pid; do
      [ -e "$f" ] || continue
      n=$(basename "$f" .pid); pid=$(cat "$f")
      if kill -0 "$pid" 2>/dev/null; then
        kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
        kill -0 "$pid" 2>/dev/null && { kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
        say "$n stopped"
      fi
      rm -f "$f"
    done
    rm -f "$ACTIVE_RELAYS_FILE"
    if [ "$NETWORK" != mutinynet ]; then "${COMPOSE[@]}" stop "${SERVICES[@]}" >> "$LOGS/compose.log" 2>&1; say "project $PROJECT stopped (volumes kept)"; fi
    ;;
  env)
    printf '%s\n' 'unset PASSBOOK_BORROWER_LIGHTNING_URL PASSBOOK_LENDER_LIGHTNING_URL PASSBOOK_SP_RLN_LENDER_URL PASSBOOK_SP_RLN_CHECK_URL PASSBOOK_CHECK_PROXY'
    [ -f "$STATE/provider.json" ] || { say "not up yet: $STATE/provider.json missing"; exit 1; }
    if [ "$NETWORK" = mutinynet ]; then
      # What the phones and tools need on Mutinynet: public endpoints only, plus the platform (Nostr, or the LAN).
      python3 - "$STATE/provider.json" <<'PY'
import json, shlex, sys
p = json.load(open(sys.argv[1]))
e = p['endpoints']
for k, v in [('PASSBOOK_SP_NETWORK', 'mutinynet'), ('PASSBOOK_PLATFORM_URL', p['platform_url']), ('PASSBOOK_PLATFORM_PK', p['platform']['pubkey'] or ''),
             ('PASSBOOK_PLATFORM_RELAYS', ','.join(p['platform']['relays'])), ('PASSBOOK_PUBLIC_RELAYS', ','.join(p['public_relays'])),
             ('PASSBOOK_ESPLORA_URL', e['esplora']), ('PASSBOOK_RGB_INDEXER_URL', e['rgb_indexer']), ('PASSBOOK_RGB_PROXY_URL', e['rgb_proxy']),
             ('PASSBOOK_ASSET_ID', (p.get('asset') or {}).get('asset_id', '')), ('PASSBOOK_CHECK_NODE_PKS', ','.join(c['operator_pk'] for c in p['check_nodes'])),
             ('PASSBOOK_SP_PROVIDER_JSON', sys.argv[1])]:
    print(f'export {k}={shlex.quote(v)}')
if (p.get('assistant') or {}).get('pubkey'): print(f"export PASSBOOK_ASSISTANT_PK={p['assistant']['pubkey']}")
PY
      exit 0
    fi
    # What the laptop clients read (Relay: PASSBOOK_RELAYS, PlatformClient: PASSBOOK_URL, the chain, RGB and wallet
    # paths), then the phone-facing names of the frozen contract.
    app_env
    for v in BITCOIND_URL BITCOIND_USER BITCOIND_PASSWORD PASSBOOK_CHAIN RGB_INDEXER_URL RGB_TRANSPORT_URL \
      PASSBOOK_RELAYS PASSBOOK_URL PASSBOOK_WALLETS PASSBOOK_STATE PASSBOOK_SP_STATE \
      PASSBOOK_BITCOIND_PORT PASSBOOK_ELECTRS_PORT PASSBOOK_PROXY_PORT PASSBOOK_RELAY_PORT COMPOSE_PROJECT_NAME; do
      printf 'export %s=%q\n' "$v" "${!v}"
    done
    python3 - "$STATE/provider.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print(f"export PASSBOOK_RELAY_URL={p['relay_url']} PASSBOOK_PLATFORM_URL={p['platform_url']}")
print(f"export PASSBOOK_LENDER_PKS={','.join(l['pubkey'] for l in p['lenders'])} PASSBOOK_CHECK_NODE_PKS={','.join(c['operator_pk'] for c in p['check_nodes'])}")
print(f"export PASSBOOK_SP_PROVIDER_JSON={sys.argv[1]}")
print(f"export PASSBOOK_PUBLIC_RELAYS={','.join(p.get('public_relays') or [])}")
if (p.get('assistant') or {}).get('pubkey'): print(f"export PASSBOOK_ASSISTANT_PK={p['assistant']['pubkey']}")
PY
    ;;
  *) sed -n '2,42p' "$0"; exit 2 ;;
esac
