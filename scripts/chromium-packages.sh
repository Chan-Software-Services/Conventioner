#!/usr/bin/env bash
#
# The Ubuntu packages Playwright's Chromium needs that a CI runner lacks, installed from .deb files
# that GitHub's cache keeps, so a shard whose cached files install reaches Ubuntu's apt mirrors for
# none of them.
# CI's e2e action (.github/actions/e2e-stack/action.yml) runs it in front-end/; never run it on a
# machine of your own: it calls sudo.
#
# Usage:
#   chromium-packages.sh missing
#       Writes packages=<the missing packages, sorted, space-separated> and hash=<a hash of the
#       operating system's release and of each package with the version the runner's package lists
#       would install>, the cache's key, to $GITHUB_OUTPUT. It asks Playwright
#       (`playwright install-deps --dry-run chromium`), which simulates the install with apt-get
#       against the runner's own package lists, offline, and simulates it again for the versions;
#       only when Playwright's simulation fails, as with no lists, does it refresh them from the
#       mirrors and ask again.
#   chromium-packages.sh install <directory> <package>...
#       Installs the packages from <directory>'s .deb files, offline, after downloading into it any
#       it lacks, then checks with Playwright that none is missing. Files that do not install, as
#       when they are not the versions the package lists name, are passed over for an install from
#       the mirrors. Writes cacheable=true to $GITHUB_OUTPUT when <directory>'s files installed and
#       are the versions the key names, else false.
#
# Each step that reaches the mirrors is tried 6 times, a minute apart, so an outage of a few minutes
# fails no shard; a cache hit whose files install makes none, so neither does an outage of hours.

set -euo pipefail

ATTEMPTS=6
PAUSE=60

# Runs "$@", again after a pause each time it fails, up to $ATTEMPTS times.
retry() {
  local attempt
  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    "$@" && return 0
    if ((attempt < ATTEMPTS)); then
      echo "chromium-packages: '$*' failed (attempt $attempt of $ATTEMPTS); trying again in $PAUSE seconds" >&2
      sleep "$PAUSE"
    fi
  done
  echo "chromium-packages: '$*' failed $ATTEMPTS times" >&2
  return 1
}

# Playwright's own check of Chromium's packages, in $DRY_RUN and $DRY_RUN_STATUS.
dry_run() {
  DRY_RUN_STATUS=0
  DRY_RUN="$(npx playwright install-deps --dry-run chromium 2>&1)" || DRY_RUN_STATUS=$?
}

# The packages Playwright finds missing, one a line, sorted, in $MISSING; fails on any other
# answer, such as a simulation that could not run.
missing_packages() {
  MISSING=""
  dry_run
  if ((DRY_RUN_STATUS == 0)) && grep -qx 'All system dependencies are installed.' <<<"$DRY_RUN"; then
    return 0
  fi
  local count
  count="$(sed -n 's/^Missing system dependencies (\([0-9][0-9]*\)):$/\1/p' <<<"$DRY_RUN")"
  if ((DRY_RUN_STATUS == 1)) && [[ -n "$count" ]]; then
    MISSING="$(sed -n '/^Missing system dependencies (/,$ s/^  \([^ ][^ ]*\)$/\1/p' <<<"$DRY_RUN" | LC_ALL=C sort)"
    if [[ -n "$MISSING" ]] && (($(wc -l <<<"$MISSING") == count)); then
      return 0
    fi
  fi
  return 1
}

output() {
  echo "$1" >>"${GITHUB_OUTPUT:?chromium-packages: GITHUB_OUTPUT is not set}"
}

# Each package with the version the runner's package lists would install, "<name> <version>" a line,
# sorted: a simulation, offline, as Playwright's is.
versions() {
  apt-get install -s --no-install-recommends "$@" |
    sed -n 's/^Inst \([^ ][^ ]*\) \(\[[^]]*\] \)\{0,1\}(\([^ ][^ ]*\) .*/\1 \3/p' | LC_ALL=C sort
}

# The hash of the release's line and each package's line.
hash_of() {
  {
    printf '%s\n' "$1"
    if [[ -n "$2" ]]; then printf '%s\n' "$2"; fi
  } | sha256sum | cut -d' ' -f1
}

missing() {
  local release lines=""
  if ! missing_packages; then
    echo "chromium-packages: Playwright could not say which packages are missing:" >&2
    printf '%s\n' "$DRY_RUN" >&2
    echo "chromium-packages: refreshing the package lists and asking again" >&2
    retry sudo apt-get update
    if ! missing_packages; then
      printf '%s\n' "$DRY_RUN" >&2
      echo "chromium-packages: Playwright still could not say which packages are missing" >&2
      exit 1
    fi
  fi
  # shellcheck disable=SC1091 # the runner's own
  release="$(. /etc/os-release && printf '%s %s' "$ID" "${VERSION_ID:-}")"
  output "packages=$(tr '\n' ' ' <<<"$MISSING" | sed 's/ $//')"
  if [[ -n "$MISSING" ]]; then
    local packages
    read -ra packages <<<"$(tr '\n' ' ' <<<"$MISSING")"
    lines="$(versions "${packages[@]}")"
  fi
  output "hash=$(hash_of "$release" "$lines")"
}

# Downloads the packages into the directory $1 at the versions the runner's package lists name,
# which the cache's key holds, or, when the mirrors no longer have those, at the versions of lists
# refreshed from them.
download() {
  local directory="$1"
  shift
  (cd "$directory" && apt-get download "$@") && return 0
  sudo apt-get update && (cd "$directory" && apt-get download "$@")
}

# "<name> <version>" of each .deb file in the directory $1, a line, sorted.
file_versions() {
  local deb
  for deb in "$1"/*.deb; do
    # shellcheck disable=SC2016 # dpkg-deb's own fields, not the shell's
    dpkg-deb --show --showformat='${Package} ${Version}\n' "$deb"
  done | LC_ALL=C sort
}

# Installs the packages from the .deb files in the directory $1, offline: put in apt's own archive
# directory, where `apt-get install --no-download` takes them, checked against the package lists,
# and fails before it changes anything if a package it needs is not there.
install_from() {
  local directory="$1" archives=""
  shift
  eval "$(apt-config shell archives Dir::Cache::Archives/d)"
  sudo cp "$directory"/*.deb "$archives" &&
    sudo apt-get install -y --no-install-recommends --no-download "$@"
}

from_mirrors() {
  sudo apt-get update && sudo apt-get install -y --no-install-recommends "$@"
}

install() {
  local directory="$1"
  shift
  local package lacking=() expected
  # Before any refresh of the lists, as the key was read.
  expected="$(versions "$@")"
  mkdir -p "$directory"
  for package in "$@"; do
    if ! compgen -G "$directory/${package}_*.deb" >/dev/null; then
      lacking+=("$package")
    fi
  done
  if ((${#lacking[@]})); then
    echo "chromium-packages: downloading ${lacking[*]}"
    retry download "$directory" "${lacking[@]}"
  fi
  if install_from "$directory" "$@"; then
    if [[ "$(file_versions "$directory")" == "$expected" ]]; then
      output "cacheable=true"
    else
      echo "chromium-packages: the .deb files are not the versions the cache's key names; not saving them" >&2
      output "cacheable=false"
    fi
  else
    echo "chromium-packages: the .deb files in $directory do not install; installing from the mirrors" >&2
    output "cacheable=false"
    retry from_mirrors "$@"
  fi
  dry_run
  if ((DRY_RUN_STATUS != 0)); then
    printf '%s\n' "$DRY_RUN" >&2
    echo "chromium-packages: Chromium's packages are still not all installed" >&2
    exit 1
  fi
  echo "chromium-packages: $DRY_RUN"
}

case "${1:-}" in
  missing) missing ;;
  install)
    if (($# < 3)); then
      echo "usage: chromium-packages.sh install <directory> <package>..." >&2
      exit 2
    fi
    shift
    install "$@"
    ;;
  *)
    echo "usage: chromium-packages.sh missing | install <directory> <package>..." >&2
    exit 2
    ;;
esac
