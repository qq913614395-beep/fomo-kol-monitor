#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/fomo-kol-monitor}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/fomo-kol-monitor}"
CONFIG_FILE="${CONFIG_FILE:-/etc/fomo-kol-monitor/api.env}"
BASIC_AUTH_FILE="${BASIC_AUTH_FILE:-/etc/nginx/fomo-monitor.htpasswd}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DESTINATION="$BACKUP_ROOT/$STAMP"
DATABASE="$DATA_DIR/monitor.sqlite3"

if [[ ! -f "$DATABASE" ]]; then
  echo "Database not found: $DATABASE" >&2
  exit 1
fi
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Configuration not found: $CONFIG_FILE (backup would not be decryptable without MONITOR_MASTER_KEY)" >&2
  exit 1
fi
if [[ -e "$DESTINATION" ]]; then
  echo "Backup destination already exists: $DESTINATION" >&2
  exit 1
fi

install -d -m 0700 "$DESTINATION"
sqlite3 "$DATABASE" ".backup '$DESTINATION/monitor.sqlite3'"
cp -a "$DATA_DIR"/*.json "$DESTINATION/" 2>/dev/null || true
install -m 0600 "$CONFIG_FILE" "$DESTINATION/api.env"
if [[ -f "$BASIC_AUTH_FILE" ]]; then install -m 0600 "$BASIC_AUTH_FILE" "$DESTINATION/fomo-monitor.htpasswd"; fi
sha256sum "$DESTINATION"/* > "$DESTINATION/SHA256SUMS"
chmod 0600 "$DESTINATION"/*
echo "$DESTINATION"
