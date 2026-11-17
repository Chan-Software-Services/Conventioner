# Which stack a seed writes to: told, never guessed. Sourced by seed_fixture.sh and
# seed_walk_market.sh, so the one guard that keeps a seed off a stack it was not told (Daniel's own,
# or another task's) has one copy, which a fix reaches for both.
#
# A seed takes its stack from, in this order:
#   1) COMPOSE_PROJECT_NAME and the three TH_*_PORT variables, as `th-compose.sh ports` exports them
#   2) the treehouse slot its checkout sits in
#   3) --primary, the default stack: the primary checkout's, or CI's one stack, never from a slot
# and otherwise refuses. A fallback to the primary stack's defaults once let a run outside a slot
# wipe the primary checkout's local database (2026-10-31).
#
# stack_identity <project dir> <primary: true|false>
#   Calls the caller's own `refuse <why>`, which must say why and exit, on a stack it cannot name.
#   Otherwise sets DOCKER_CMD (an array), SHOWN_CMD (how a person runs it), BACKEND_PORT and
#   FRONTEND_PORT, and prints which stack it took.
# shellcheck shell=bash

# The caller reads what it sets.
# shellcheck disable=SC2034
stack_identity() {
  local project_dir="$1" primary="$2"
  local stack_vars=(COMPOSE_PROJECT_NAME TH_MONGO_PORT TH_BACKEND_PORT TH_FRONTEND_PORT)
  local set_vars=() var slot
  for var in "${stack_vars[@]}"; do
    if [ -n "${!var:-}" ]; then set_vars+=("$var"); fi
  done
  slot="$(printf '%s' "$project_dir" | sed -nE 's#.*/\.treehouse/[^/]+/([0-9]+)/.*#\1#p')"

  if [ "$primary" = true ]; then
    if [ "${#set_vars[@]}" -gt 0 ]; then
      refuse "--primary, but ${set_vars[*]} names another stack"
    fi
    # In a slot, plain `docker compose` names the project after the directory, the primary's.
    if [[ "$slot" =~ ^[0-9]+$ ]]; then
      refuse "--primary, but $project_dir is in treehouse slot $slot, which names another stack"
    fi
    DOCKER_CMD=(docker compose)
    SHOWN_CMD="docker compose"
    BACKEND_PORT=5001
    FRONTEND_PORT=5173
    echo "Default stack, as --primary asks (ports: backend=$BACKEND_PORT, frontend=$FRONTEND_PORT)"
  elif [ "${#set_vars[@]}" -eq "${#stack_vars[@]}" ]; then
    DOCKER_CMD=("$project_dir/scripts/th-compose.sh")
    SHOWN_CMD="scripts/th-compose.sh"
    BACKEND_PORT="$TH_BACKEND_PORT"
    FRONTEND_PORT="$TH_FRONTEND_PORT"
    echo "Explicit stack identity: project=$COMPOSE_PROJECT_NAME (ports: backend=$BACKEND_PORT, frontend=$FRONTEND_PORT)"
  elif [ "${#set_vars[@]}" -gt 0 ]; then
    refuse "the environment names only part of a stack (${set_vars[*]} set, not all of ${stack_vars[*]})"
  elif [[ "$slot" =~ ^[0-9]+$ ]] && [ -x "$project_dir/scripts/th-compose.sh" ]; then
    DOCKER_CMD=("$project_dir/scripts/th-compose.sh")
    SHOWN_CMD="scripts/th-compose.sh"
    BACKEND_PORT=$((5001 + slot * 10))
    FRONTEND_PORT=$((5173 + slot * 10))
    echo "Worktree slot: $slot (ports: backend=$BACKEND_PORT, frontend=$FRONTEND_PORT)"
  else
    refuse "no stack given: no stack variables are set and $project_dir is not in a treehouse slot"
  fi
}
