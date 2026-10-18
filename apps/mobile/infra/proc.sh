# Processes the provider script starts: each in its own process group, its pid in $D/<name>.pid.
# stop waits until the group has exited (it closes the platform's SQLite database and frees
# its port first), so nothing moves the database or starts a replacement while it still runs.
start() { local name=$1; shift; stop "$name" || return 1; setsid "$@" > "$D/$name.log" 2>&1 < /dev/null & echo $! > "$D/$name.pid"; }
stop() {
  local f="$D/$1.pid"; [ -f "$f" ] || return 0
  local p; p=$(cat "$f")
  kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true
  local i
  for i in $(seq "${STOP_WAIT_TENTHS:-150}"); do
    kill -0 -- "-$p" 2>/dev/null || kill -0 "$p" 2>/dev/null || { rm -f "$f"; return 0; }
    sleep 0.1
  done
  echo "$1 (pid $p) did not exit; not starting anything over it" >&2
  return 1
}
