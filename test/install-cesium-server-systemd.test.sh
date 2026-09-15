#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="$(mktemp -d)"
trap 'rm -rf "$TEST_HOME"' EXIT

CESIUM_INSTALLER_SOURCE_ONLY=1
# shellcheck source=../scripts/install-cesium-server.sh
source "$ROOT_DIR/scripts/install-cesium-server.sh"

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nExpected:\n%s\nActual:\n%s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL: %s\nMissing: %s\nIn:\n%s\n' "$label" "$needle" "$haystack" >&2
    exit 1
  fi
}

# `systemd-analyze verify` insists that ExecStart= resolves to an executable,
# so every rendered install tree needs a manager script at the rendered path.
make_install_tree() {
  local cesium_home="$1"
  mkdir -p "$cesium_home/bin" "$cesium_home/source" "$cesium_home/logs"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$cesium_home/bin/cesium-server"
  chmod 700 "$cesium_home/bin/cesium-server"
}

render_for() {
  local cesium_home="$1"
  render_systemd_unit "$cesium_home/bin/cesium-server" "$cesium_home/source" \
    "$cesium_home/logs/supervisor.log"
}

PLAIN_HOME="$TEST_HOME/home/bennett/.cesium"
make_install_tree "$PLAIN_HOME"
plain_unit="$(render_for "$PLAIN_HOME")"
assert_equal "$(
  cat <<EOF
[Unit]
Description=Cesium local server and secure tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="$PLAIN_HOME/bin/cesium-server" supervise
WorkingDirectory=$PLAIN_HOME/source
Restart=always
RestartSec=5
KillMode=control-group
StandardOutput=append:$PLAIN_HOME/logs/supervisor.log
StandardError=append:$PLAIN_HOME/logs/supervisor.log

[Install]
WantedBy=default.target
EOF
)" "$plain_unit" "ExecStart= is the only quoted setting; path settings are written verbatim"

ODD_HOME="$TEST_HOME/odd %h dir/.cesium"
make_install_tree "$ODD_HOME"
odd_unit="$(render_for "$ODD_HOME")"
assert_contains "$odd_unit" \
  "ExecStart=\"$TEST_HOME/odd %%h dir/.cesium/bin/cesium-server\" supervise" \
  "ExecStart= keeps a path with spaces as one quoted word and doubles %"
assert_contains "$odd_unit" \
  "WorkingDirectory=$TEST_HOME/odd %%h dir/.cesium/source" \
  "WorkingDirectory= is unquoted and doubles %"
assert_contains "$odd_unit" \
  "StandardOutput=append:$TEST_HOME/odd %%h dir/.cesium/logs/supervisor.log" \
  "StandardOutput=append: doubles %"

if ! command -v systemd-analyze >/dev/null 2>&1; then
  printf 'PASS: Cesium installer systemd unit tests (systemd-analyze unavailable; verification skipped)\n'
  exit 0
fi

# The offline user manager still resolves a runtime directory; keep it out of
# any real login session so the run is hermetic.
export XDG_RUNTIME_DIR="$TEST_HOME/runtime"
mkdir -m 700 "$XDG_RUNTIME_DIR"

# Writes the unit under a per-case directory (the basename is the unit name)
# and returns systemd-analyze's exit status with its output on stdout.
verify_unit() {
  local label="$1"
  local unit_text="$2"
  local unit_dir="$TEST_HOME/units/$label"
  mkdir -p "$unit_dir"
  printf '%s\n' "$unit_text" >"$unit_dir/cesium-server.service"
  systemd-analyze --user verify "$unit_dir/cesium-server.service" 2>&1
}

if ! output="$(verify_unit plain "$plain_unit")"; then
  printf 'FAIL: systemd rejected the rendered unit for a plain install path\n%s\n' "$output" >&2
  exit 1
fi
if ! output="$(verify_unit odd "$odd_unit")"; then
  printf 'FAIL: systemd rejected the rendered unit for a path with a space and %%\n%s\n' "$output" >&2
  exit 1
fi

# Regression control: the installer used to shell-quote WorkingDirectory=,
# which systemd reads as a relative path starting with `"`.
legacy_unit="$(printf '%s\n' "$plain_unit" |
  sed 's|^WorkingDirectory=\(.*\)$|WorkingDirectory="\1"|')"
if output="$(verify_unit legacy "$legacy_unit")"; then
  printf 'FAIL: systemd accepted a quoted WorkingDirectory=; the control no longer detects the regression\n' >&2
  exit 1
fi
assert_contains "$output" "bad unit file setting" \
  "a quoted WorkingDirectory= is the fatal setting the installer used to write"

# Specifier control: an unescaped % is expanded (%h becomes the home
# directory), so the executable lookup lands on the wrong path.
unescaped_unit="$(printf '%s\n' "$odd_unit" | sed 's/%%/%/g')"
if output="$(verify_unit unescaped "$unescaped_unit")"; then
  printf 'FAIL: systemd accepted an unescaped %% in the unit paths\n' >&2
  exit 1
fi
assert_contains "$output" "not executable" \
  "an unescaped %h is expanded as a specifier and breaks the ExecStart= path"

printf 'PASS: Cesium installer systemd unit tests\n'
