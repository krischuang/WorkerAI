#!/bin/bash
# provision-https.sh — install nginx + HTTPS for WorkerAI (workerai.ddns.net)
#
# Run as root:  sudo bash /home/ec2-user/WorkerAI/provision-https.sh
#
# What this script does:
#   1. Write Phase 1 nginx config (HTTP only, ACME challenge + proxy to :3000/:3099)
#   2. Create the Let's Encrypt webroot directory
#   3. Reload nginx (test first)
#   4. Run certbot --webroot to obtain the TLS certificate
#   5. Write Phase 2 nginx config (HTTPS + HTTP→HTTPS redirect)
#   6. Reload nginx
#   7. Restart Docker containers to pick up .env changes
#   8. Verify the health endpoint over HTTPS

set -euo pipefail

DOMAIN="workerai.ddns.net"
NGINX_CONF="/etc/nginx/conf.d/workerai.conf"
WEBROOT="/var/www/letsencrypt"
PROJECT_DIR="/home/ec2-user/WorkerAI/claude-task-monitor"
CERTBOT_EMAIL="kevinshuang1029@gmail.com"

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
step() { echo; echo "══════════════════════════════════════"; echo "  $*"; echo "══════════════════════════════════════"; }
fail() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; exit 1; }

[[ $EUID -ne 0 ]] && fail "Must run as root. Use: sudo bash $0"

# ── 1. Phase 1 nginx config (HTTP only) ──────────────────────────────────────
step "Writing Phase 1 nginx config (HTTP only)"

mkdir -p "${WEBROOT}/.well-known/acme-challenge"

cat > "${NGINX_CONF}" << 'PHASE1'
# workerai.conf — Phase 1 (pre-TLS, written by provision-https.sh)
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name workerai.ddns.net;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    # WebSocket SSH terminal
    location /ws {
        proxy_pass         http://127.0.0.1:3099;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Next.js app
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        $connection_upgrade;
        proxy_read_timeout 120s;
    }

    client_max_body_size 10m;
}
PHASE1

nginx -t || fail "nginx config test failed"
systemctl reload nginx
log "nginx reloaded with Phase 1 config"

# ── 2. Obtain TLS certificate via Let's Encrypt ───────────────────────────────
step "Obtaining TLS certificate for ${DOMAIN}"

certbot certonly \
    --webroot \
    --webroot-path "${WEBROOT}" \
    --domain "${DOMAIN}" \
    --email "${CERTBOT_EMAIL}" \
    --agree-tos \
    --non-interactive \
    --keep-until-expiring

log "Certificate obtained: /etc/letsencrypt/live/${DOMAIN}/"

# ── 3. Phase 2 nginx config (HTTPS) ──────────────────────────────────────────
step "Writing Phase 2 nginx config (HTTPS)"

# certbot writes options-ssl-nginx.conf and ssl-dhparams.pem here:
SSL_OPTS="/etc/letsencrypt/options-ssl-nginx.conf"
SSL_DH="/etc/letsencrypt/ssl-dhparams.pem"

# Generate dhparams if certbot didn't (older certbot versions skip this)
if [[ ! -f "${SSL_DH}" ]]; then
    log "Generating DH params (2048-bit) — this may take a minute…"
    openssl dhparam -out "${SSL_DH}" 2048
fi

# Write the options file if certbot didn't create it
if [[ ! -f "${SSL_OPTS}" ]]; then
    cat > "${SSL_OPTS}" << 'SSLOPTS'
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256";
SSLOPTS
fi

cat > "${NGINX_CONF}" << PHASE2
# workerai.conf — Phase 2 (HTTPS, written by provision-https.sh)
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ""      close;
}

# ── HTTP → HTTPS redirect ────────────────────────────────────────────────────
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # Keep ACME challenge available for auto-renewals
    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# ── HTTPS ────────────────────────────────────────────────────────────────────
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include             ${SSL_OPTS};
    ssl_dhparam         ${SSL_DH};

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    client_max_body_size 10m;

    # ── WebSocket SSH terminal (/ws → ws-server port 3099) ───────────────────
    location /ws {
        proxy_pass         http://127.0.0.1:3099;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       \$host;
        proxy_set_header   X-Real-IP  \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }

    # ── Next.js app (port 3000) ───────────────────────────────────────────────
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        \$connection_upgrade;
        proxy_read_timeout 120s;
    }
}
PHASE2

nginx -t || fail "nginx config test failed after Phase 2"
systemctl reload nginx
log "nginx reloaded with Phase 2 HTTPS config"

# ── 4. Auto-renew cron ────────────────────────────────────────────────────────
step "Ensuring certbot auto-renew timer is active"
systemctl enable --now certbot-renew.timer 2>/dev/null || \
    systemctl enable --now certbot.timer 2>/dev/null || \
    (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -
log "Auto-renew configured"

# ── 5. Restart Docker containers to pick up .env changes ─────────────────────
step "Restarting Docker containers (new ALLOWED_ORIGINS)"
cd "${PROJECT_DIR}"
docker compose down
docker compose up -d --build
log "Containers restarted"

# ── 6. Health check over HTTPS ────────────────────────────────────────────────
step "Verifying HTTPS health endpoint"
MAX_WAIT=60
ELAPSED=0
until curl -sf "https://${DOMAIN}/api/health" > /dev/null 2>&1; do
    log "Waiting for https://${DOMAIN}/api/health … (${ELAPSED}s)"
    sleep 5
    ELAPSED=$((ELAPSED + 5))
    [[ $ELAPSED -ge $MAX_WAIT ]] && fail "Health check timed out after ${MAX_WAIT}s"
done
log "Health check passed — https://${DOMAIN}/api/health is up"

echo
echo "════════════════════════════════════════════"
echo "  WorkerAI HTTPS setup complete!"
echo "  https://${DOMAIN}"
echo "  Certificate: /etc/letsencrypt/live/${DOMAIN}/"
echo "  Auto-renew: certbot renew (runs via cron/timer)"
echo "════════════════════════════════════════════"
