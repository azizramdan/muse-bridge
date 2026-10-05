#!/usr/bin/env bash
# Install or upgrade the muse-bridge systemd service for THIS machine.
#
# Derives the service user, repo paths, and the bun binary from the
# environment instead of hardcoding them — run it as any sudo-capable user
# and it configures the unit for whoever you are, wherever the repo lives.
#
# Usage:
#   sudo ./scripts/install-service.sh            install + (re)start
#   sudo ./scripts/install-service.sh --no-start install only
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "error: run with sudo (systemd units live in /etc/systemd/system)" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-$(id -un)}"

# Resolve bun as the service user, not root. Order matters:
#   1. login shell WITH -H (so HOME is the user's, not /root's)
#   2. known install locations — bun's installer often exports PATH only in
#      ~/.bashrc/~/.zshrc, which a non-interactive shell never reads
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
BUN_BIN="$(sudo -u "$SERVICE_USER" -H bash -lc 'command -v bun' 2>/dev/null || true)"
if [[ ! -x "${BUN_BIN:-}" ]]; then
  for c in "$SERVICE_HOME/.bun/bin/bun" /usr/local/bin/bun /usr/bin/bun; do
    if [[ -x "$c" ]]; then BUN_BIN="$c"; break; fi
  done
fi
if [[ ! -x "${BUN_BIN:-}" ]]; then
  echo "error: bun not found for user '$SERVICE_USER' (not on PATH, not in" >&2
  echo "  $SERVICE_HOME/.bun/bin, /usr/local/bin, or /usr/bin). Install it:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

TEMPLATE="$REPO_DIR/muse-bridge.service"
UNIT=/etc/systemd/system/muse-bridge.service

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: template not found: $TEMPLATE" >&2
  exit 1
fi

# Ports: override at install time if the defaults are already taken
#   sudo PORT=18765 ./scripts/install-service.sh
# Keep HUB_PORT at its default unless you also bake it into every worker's
# forced command — worker users run `consume` with no env, so they always
# get the built-in default.
PUBLIC_PORT="${PORT:-8765}"
HUB_PORT="${HUB_PORT:-8767}"
for v in "$PUBLIC_PORT" "$HUB_PORT"; do
  if ! [[ "$v" =~ ^[0-9]+$ ]]; then
    echo "error: PORT/HUB_PORT must be numeric (got '$v')" >&2
    exit 1
  fi
done

# Paths/usernames may contain sed metacharacters (&, \, |) — escape them.
esc() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

sed \
  -e "s|^User=.*|User=$(esc "$SERVICE_USER")|" \
  -e "s|/home/ubuntu/muse-bridge|$(esc "$REPO_DIR")|g" \
  -e "s|^ExecStart=.*|ExecStart=$(esc "$BUN_BIN") src/cli.ts serve|" \
  -e "s|^Environment=PORT=.*|Environment=PORT=$(esc "$PUBLIC_PORT")|" \
  -e "s|^Environment=HUB_PORT=.*|Environment=HUB_PORT=$(esc "$HUB_PORT")|" \
  "$TEMPLATE" > "$UNIT"
chmod 644 "$UNIT"

# The SQLite dir must exist before systemd applies ReadWritePaths=,
# and it holds prompts/answers — owner-only, never group/other readable.
mkdir -p "$REPO_DIR/data"
chown "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR/data"
chmod 700 "$REPO_DIR/data"

systemctl daemon-reload
systemctl enable muse-bridge >/dev/null
if [[ "${1:-}" != "--no-start" ]]; then
  systemctl restart muse-bridge
fi

echo "installed $UNIT"
echo "  User=$SERVICE_USER"
echo "  ExecStart=$BUN_BIN src/cli.ts serve"
echo "  WorkingDirectory/DB under $REPO_DIR"
echo "  API port=$PUBLIC_PORT  hub port=$HUB_PORT"
echo
echo "verify:"
echo "  systemctl status muse-bridge"
echo "  curl -s http://127.0.0.1:$PUBLIC_PORT/health"
