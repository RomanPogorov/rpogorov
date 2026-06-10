#!/usr/bin/env bash
# Auto-rebuild rpogorov-dev Astro site when the vault (content source) changes.
# Triggered by cron every few minutes. Zero idle RAM (no daemon); RAM is used
# only during the actual `astro build`. Guards: single-instance lock + skip when
# free RAM is low (retries on the next tick instead of risking OOM).
set -uo pipefail
export PATH=/usr/bin:/usr/local/bin:$PATH

SITE=/root/rpogorov-dev/site
VAULT=/root/vault
STATE=/root/rpogorov-dev/.autobuild-state
LOCK=/tmp/rpogorov-autobuild.lock
LOG=/root/rpogorov-dev/autobuild.log
MIN_AVAIL_MB=700

ts() { date '+%F %T'; }

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(ts) skip: another build is running" >>"$LOG"
  exit 0
fi

# Signal = git tree hash of vault/portfolio/ only. Changes when case content
# changes, but NOT on unrelated vault auto-backup commits (sessions, etc.).
SIG=$(git -C "$VAULT" rev-parse HEAD:portfolio 2>/dev/null || echo none)
LAST=$(cat "$STATE" 2>/dev/null || echo none)
[ "$SIG" = "$LAST" ] && exit 0   # portfolio content unchanged since last build

AVAIL=$(free -m | awk '/Mem:/{print $7}')
if [ "${AVAIL:-0}" -lt "$MIN_AVAIL_MB" ]; then
  echo "$(ts) skip: low RAM ${AVAIL}MB (<${MIN_AVAIL_MB}MB) — will retry next tick" >>"$LOG"
  exit 0
fi

echo "$(ts) build start (portfolio $SIG, avail ${AVAIL}MB)" >>"$LOG"
cd "$SITE" || { echo "$(ts) ERROR: no $SITE" >>"$LOG"; exit 1; }
if NODE_OPTIONS=--max-old-space-size=1024 npm run build >>"$LOG" 2>&1; then
  echo "$SIG" > "$STATE"
  echo "$(ts) build OK -> /root/rpogorov-dev/app" >>"$LOG"
else
  echo "$(ts) build FAILED (app/ left as previous build)" >>"$LOG"
  exit 1
fi
