#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
SOURCE_DIR="${SOURCE_DIR:-$(pwd)}"
APP_DIR="/opt/fomo-kol-monitor"
DATA_DIR="/var/lib/fomo-kol-monitor"
CONFIG_DIR="/etc/fomo-kol-monitor"
APP_USER="fomo-monitor"

if [[ $EUID -ne 0 ]]; then echo "Run as root" >&2; exit 1; fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || [[ "$DOMAIN" != *.* ]]; then echo "Usage: sudo ./deploy/install-ubuntu.sh radar.example.com admin@example.com" >&2; exit 1; fi
if [[ ! "$EMAIL" =~ @ ]]; then echo "A valid Let's Encrypt email is required" >&2; exit 1; fi
if [[ ! -f "$SOURCE_DIR/package.json" ]]; then echo "Run from the project directory or set SOURCE_DIR" >&2; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg nginx apache2-utils certbot python3-certbot-nginx sqlite3 rsync

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 22 )); then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA_DIR"
install -d -o root -g root -m 0700 /var/backups/fomo-kol-monitor
install -d -o root -g "$APP_USER" -m 0750 "$CONFIG_DIR"
install -d -o root -g root -m 0755 "$APP_DIR"

rsync -a --delete \
  --exclude '.git' --exclude '.env' --exclude 'data' --exclude 'work' --exclude 'node_modules' --exclude 'dist' \
  "$SOURCE_DIR/" "$APP_DIR/"
cd "$APP_DIR"
npm ci
if [[ "${INSTALL_GMGN_CLI:-1}" == "1" ]]; then npm install --global gmgn-cli@1.5.6; fi

ENV_FILE="$CONFIG_DIR/api.env"
if [[ ! -f "$ENV_FILE" ]]; then
  MASTER_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  sed -e "s|https://radar.example.com|https://$DOMAIN|g" -e "s|radar.example.com|$DOMAIN|g" \
    "$APP_DIR/deploy/api.env.example" > "$ENV_FILE"
  sed -i "s|^MONITOR_MASTER_KEY=.*|MONITOR_MASTER_KEY=$MASTER_KEY|" "$ENV_FILE"
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

NEXT_PUBLIC_MONITOR_API="https://$DOMAIN" npm run build
chown -R root:root "$APP_DIR"
chmod 0755 "$APP_DIR/deploy/backup.sh"

install -m 0644 "$APP_DIR/deploy/fomo-monitor-api.service" /etc/systemd/system/fomo-monitor-api.service
install -m 0644 "$APP_DIR/deploy/fomo-monitor-web.service" /etc/systemd/system/fomo-monitor-web.service
install -m 0644 "$APP_DIR/deploy/fomo-monitor-backup.service" /etc/systemd/system/fomo-monitor-backup.service
install -m 0644 "$APP_DIR/deploy/fomo-monitor-backup.timer" /etc/systemd/system/fomo-monitor-backup.timer
sed "s/__DOMAIN__/$DOMAIN/g" "$APP_DIR/deploy/nginx-fomo-monitor.conf.template" > /etc/nginx/conf.d/fomo-monitor.conf

ADMIN_USER="${FOMO_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${FOMO_ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -d '\n')}"
htpasswd -b -c /etc/nginx/fomo-monitor.htpasswd "$ADMIN_USER" "$ADMIN_PASSWORD"
chmod 0640 /etc/nginx/fomo-monitor.htpasswd
chown root:www-data /etc/nginx/fomo-monitor.htpasswd

systemctl daemon-reload
systemctl enable --now fomo-monitor-api.service fomo-monitor-web.service fomo-monitor-backup.timer
nginx -t
systemctl reload nginx

certbot --nginx --non-interactive --agree-tos --redirect --email "$EMAIL" -d "$DOMAIN"
nginx -t
systemctl reload nginx

MONITOR_ENV_FILE="$ENV_FILE" node "$APP_DIR/scripts/server-doctor.mjs"

echo
echo "Installed: https://$DOMAIN"
echo "Dashboard user: $ADMIN_USER"
if [[ -z "${FOMO_ADMIN_PASSWORD:-}" ]]; then echo "Dashboard password (shown once): $ADMIN_PASSWORD"; fi
echo "Before production monitoring, edit $ENV_FILE and add dedicated RPC/GMGN credentials, then restart fomo-monitor-api."
