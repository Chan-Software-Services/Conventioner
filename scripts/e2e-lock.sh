# shellcheck shell=bash
#
# The lock of nm-test.sh's end-to-end phase, sourced by it: the machine's heavy-run lock, the file
# the team's `team-heavy run` takes for each of its heavy commands. One run with Playwright at a
# time holds it, from just before its stack starts until its teardown is done, and never beside one
# of those commands: a stack starting or stopping changes the host's networks under another run's
# browser, which fails with net::ERR_NETWORK_CHANGED, and two heavy runs at once time each other out.
#
# It is an exclusive kernel lock (flock(2)) on one of the run's file descriptors, so the kernel
# releases it once the last process holding that descriptor is gone: the run, and the teardown
# guard it hands the descriptor to. Commands that may leave a process behind (Playwright's browser)
# run with the descriptor closed (`without_e2e_lock`), so nothing else keeps it after the run.
#
#     take_e2e_lock <seconds to wait> <who is taking it>
#     without_e2e_lock <command> [args...]   (an executable: a function or builtin would keep a copy)
#
# The holder's line in the file is "<who> since <time>", which `team-heavy status` prints after
# "held by". <who> must never read as "<label> (pid <pid>) since" or "<label> (pid <pid>, T<n>)
# since", team-heavy's own form: the team takes the pid of such a line for a team-heavy's.
#
# Under a team-heavy run (TEAM_HEAVY_HELD set, as it sets for its command) that run holds the lock
# for the whole command, so take_e2e_lock takes nothing: a second take would wait for the run it is
# part of. The lock then goes when that team-heavy ends, not when this run's teardown guard does.
#
# Uses flock(1) where it exists, else Python's fcntl ($PYTHON, else python3).

# Where team-heavy keeps it: under $HOME alone, whatever XDG_STATE_HOME says.
E2E_LOCK="$HOME/.local/state/agent-team/heavy.lock"

# Locks the descriptor $1, waiting up to $2 seconds (0: not at all).
e2e_flock() {
  if command -v flock >/dev/null; then
    if (( $2 == 0 )); then flock -n "$1"; else flock -w "$2" "$1"; fi
  else
    "${PYTHON:-python3}" -c '
import fcntl, sys, time
fd, deadline = int(sys.argv[1]), time.monotonic() + float(sys.argv[2])
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(1)
' "$1" "$2"
  fi
}

# "45 minutes" for 2700, "20 seconds" for 20, "1 minute" for 60, "1 second" for 1.
e2e_lock_span() {
  local count=$1 unit=second
  if (( $1 % 60 == 0 )); then count=$(( $1 / 60 )) unit=minute; fi
  if (( count != 1 )); then unit+=s; fi
  echo "$count $unit"
}

take_e2e_lock() {
  local wait=$1 who=$2 holder
  if [[ -n "${TEAM_HEAVY_HELD:-}" ]]; then
    echo "nm-test: under a heavy run, which holds the heavy-run lock for it"
    return 0
  fi
  mkdir -p "${E2E_LOCK%/*}"
  # Read-write, so opening it never truncates the holder's line a waiting run reads.
  exec {E2E_LOCK_FD}<>"$E2E_LOCK"
  if ! e2e_flock "$E2E_LOCK_FD" 0; then
    holder="$(<"$E2E_LOCK")"
    printf 'nm-test: waiting for the heavy-run lock since %(%F %T %z)T, held by %s\n' -1 \
      "${holder:-another run}"
    if ! e2e_flock "$E2E_LOCK_FD" "$wait"; then
      echo "nm-test: ERROR: no end-to-end slot within $(e2e_lock_span "$wait")" >&2
      return 1
    fi
  fi
  printf '%s since %(%F %T %z)T\n' "$who" -1 >"$E2E_LOCK"
  printf 'nm-test: has the heavy-run lock at %(%F %T %z)T\n' -1
}

without_e2e_lock() {
  # With no descriptor (under a team-heavy run) there is nothing to close.
  if [[ -n "${E2E_LOCK_FD:-}" ]]; then "$@" {E2E_LOCK_FD}>&-; else "$@"; fi
}
