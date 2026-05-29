#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  NatForge AI - VPS Deployment Script
#  Run this ON THE VPS (not locally)
#  This script sets up Node.js, PM2, Nginx, and SSL for natforgeai.com
#  NOTE: MySQL is NOT installed - we use your existing Google Cloud SQL DB
# ═══════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

DOMAIN="natforgeai.com"
APP_DIR="/var/www/natforgeai"
NODE_VERSION="20"
APP_NAME="natforgeai"

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  NatForge AI - Production VPS Setup${NC}"
echo -e "${BLUE}  Domain: ${DOMAIN}${NC}"
echo -e "${BLUE}  Uses Google Cloud SQL (no local MySQL)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ─── Check if running as root ─────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root (use: sudo bash deploy-vps.sh)${NC}"
  exit 1
fi

# ─── Update system ────────────────────────────────────────────────
echo -e "${YELLOW}[1/8] Updating system packages...${NC}"
apt update && apt upgrade -y
echo -e "${GREEN}System updated${NC}"

# ─── Install Node.js ──────────────────────────────────────────────
echo -e "${YELLOW}[2/8] Installing Node.js ${NODE_VERSION}...${NC}"
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" != "$NODE_VERSION" ]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt install -y nodejs
fi
echo -e "${GREEN}Node.js $(node --version) installed${NC}"

# ─── Install PM2 ──────────────────────────────────────────────────
echo -e "${YELLOW}[3/8] Installing PM2...${NC}"
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2
fi
echo -e "${GREEN}PM2 installed${NC}"

# ─── Install Nginx ────────────────────────────────────────────────
echo -e "${YELLOW}[4/8] Installing Nginx...${NC}"
if ! command -v nginx &> /dev/null; then
  apt install nginx -y
fi
echo -e "${GREEN}Nginx installed${NC}"

# ─── Create app directory ─────────────────────────────────────────
echo -e "${YELLOW}[5/8] Setting up application directory...${NC}"
mkdir -p $APP_DIR
echo -e "${GREEN}Directory ready at ${APP_DIR}${NC}"

# ─── Install Certbot ──────────────────────────────────────────────
echo -e "${YELLOW}[6/8] Installing Certbot for SSL...${NC}"
apt install certbot python3-certbot-nginx -y
echo -e "${GREEN}Certbot installed${NC}"

# ─── Configure Firewall ───────────────────────────────────────────
echo -e "${YELLOW}[7/8] Configuring firewall...${NC}"
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 'Nginx Full'
ufw --force enable
echo -e "${GREEN}Firewall configured${NC}"

# ─── Create Nginx config ──────────────────────────────────────────
echo -e "${YELLOW}[8/8] Creating Nginx configuration for ${DOMAIN}...${NC}"

cat > /etc/nginx/sites-available/$APP_NAME <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name natforgeai.com www.natforgeai.com;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Proxy all requests to the Node.js app
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    # API routes (explicit but covered by location / above)
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # tRPC routes
    location /api/trpc/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Increase max body size for file uploads
    client_max_body_size 50M;
}
NGINX

# Enable the site
ln -sf /etc/nginx/sites-available/$APP_NAME /etc/nginx/sites-enabled/

# Remove default site if it exists
rm -f /etc/nginx/sites-enabled/default

# Test Nginx config
nginx -t

# Restart Nginx
systemctl restart nginx
systemctl enable nginx

echo -e "${GREEN}Nginx configured for ${DOMAIN}${NC}"

# ─── Done ─────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}VPS base setup complete!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}NEXT STEPS:${NC}"
echo ""
echo "1. Upload your app files to: ${APP_DIR}"
echo "   Use FileZilla or SCP to upload your built project."
echo ""
echo "2. Make sure your .env file is configured at: ${APP_DIR}/.env"
echo "   (Use the .env.production template as reference)"
echo ""
echo "3. IMPORTANT: Add this VPS IP to Google Cloud SQL authorized networks:"
VPS_IP=$(curl -s ifconfig.me)
echo -e "   ${GREEN}VPS Public IP: ${VPS_IP}${NC}"
echo "   Go to GCP Console → SQL → your instance → Connections → Authorized networks"
echo "   Add: ${VPS_IP}/32"
echo ""
echo "4. After uploading files, SSH into your VPS and run:"
echo -e "   ${GREEN}cd ${APP_DIR}${NC}"
echo -e "   ${GREEN}npm install${NC}"
echo -e "   ${GREEN}npm run build${NC}"
echo -e "   ${GREEN}npm run db:push${NC}  ${YELLOW}(or npx tsx db/fix.ts if push fails)${NC}"
echo -e "   ${GREEN}pm2 start dist/boot.js --name ${APP_NAME}${NC}"
echo -e "   ${GREEN}pm2 save${NC}"
echo -e "   ${GREEN}pm2 startup systemd${NC}"
echo ""
echo "5. Set up SSL (run AFTER pointing your domain to this VPS IP):"
echo -e "   ${GREEN}certbot --nginx -d natforgeai.com -d www.natforgeai.com${NC}"
echo ""
echo "6. Point your AfriHost domain to this VPS IP:"
echo -e "   ${GREEN}A Record: natforgeai.com → ${VPS_IP}${NC}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
