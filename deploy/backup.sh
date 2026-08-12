#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/fomo-kol-monitor}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/fomo-kol-monitor}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DESTINATION="$BACKUP_ROOT/$STAMP"
DATABASE="$DATA_DIR/monitor.sqlite3"

if [[ ! -f "$DATABASE" ]]; then
  echo "Database not found: $DATABASE" >&2
  exit 1
fi

install -d -m 0700 "$DESTINATION"
sqlite3 "$DATABASE" ".backup '$DESTINATION/monitor.sqlite3'"
cp -a "$DATA_DIR"/*.json "$DESTINATION/" 2>/dev/null || true
sha256sum "$DESTINATION"/* > "$DESTINATION/SHA256SUMS"
echo "$DESTINATION"
