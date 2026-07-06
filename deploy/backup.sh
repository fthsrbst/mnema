#!/usr/bin/env bash
# Gece yedeği: SQLite online backup + sıkıştırma + 7 gün rotasyon.
# (Markdown export + git push Faz 3'te eklenecek.)
set -euo pipefail
cd "$(dirname "$0")/.."
DB="$(grep ^HUB_DB_PATH .env | cut -d= -f2)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/hub-backups}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
sqlite3 "$DB" ".backup '$BACKUP_DIR/hub-$STAMP.db'"
gzip "$BACKUP_DIR/hub-$STAMP.db"
find "$BACKUP_DIR" -name 'hub-*.db.gz' -mtime +7 -delete
echo "yedek: $BACKUP_DIR/hub-$STAMP.db.gz"
