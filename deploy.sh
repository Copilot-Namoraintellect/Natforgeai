#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  AI Marketing Command Center - Deployment Script for Afrihost VPS
# ═══════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

APP_NAME="ai-marketing"
APP_DIR="/var/www/aimarketing"
NODE_VERSION="20"
DB_NAME="aimarketing"
DB_USER="aimarketing_user"

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  AI Marketing Command Center - Deployment Script${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ─── Check if running as root ─────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root (use: sudo bash deploy.sh)${NC}"
  exit 1
fi

# ─── Install Node.js ──────────────────────────────────────────────
echo -e "${YELLOW}[1/9] Installing Node.js ${NODE_VERSION}...${NC}"
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" != "$NODE_VERSION" ]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt install -y nodejs
fi
echo -e "${GREEN}Node.js $(node --version) installed${NC}"

# ─── Install PM2 ──────────────────────────────────────────────────
echo -e "${YELLOW}[2/9] Installing PM2...${NC}"
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2
fi
echo -e "${GREEN}PM2 installed${NC}"

# ─── Install MySQL ────────────────────────────────────────────────
echo -e "${YELLOW}[3/9] Installing MySQL Server...${NC}"
if ! command -v mysql &> /dev/null; then
  apt install mysql-server -y
  systemctl start mysql
  systemctl enable mysql
fi
echo -e "${GREEN}MySQL installed${NC}"

# ─── Install Nginx ────────────────────────────────────────────────
echo -e "${YELLOW}[4/9] Installing Nginx...${NC}"
if ! command -v nginx &> /dev/null; then
  apt install nginx -y
fi
echo -e "${GREEN}Nginx installed${NC}"

# ─── Create app directory ─────────────────────────────────────────
echo -e "${YELLOW}[5/9] Setting up application directory...${NC}"
mkdir -p $APP_DIR
echo -e "${GREEN}Directory ready at ${APP_DIR}${NC}"

# ─── Prompt for database password ─────────────────────────────────
echo ""
read -sp "Enter a strong MySQL password for database user '${DB_USER}': " DB_PASS
echo ""

# ─── Set up MySQL database ────────────────────────────────────────
echo -e "${YELLOW}[6/9] Creating database and user...${NC}"
mysql -u root <<EOF
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
EOF
echo -e "${GREEN}Database '${DB_NAME}' and user '${DB_USER}' created${NC}"

# ─── Generate app secret ──────────────────────────────────────────
echo -e "${YELLOW}[7/9] Generating app secrets...${NC}"
APP_SECRET=$(openssl rand -base64 32)

# ─── Create .env file ─────────────────────────────────────────────
echo -e "${YELLOW}Creating .env file...${NC}"
cat > $APP_DIR/.env <<EOF
APP_SECRET=${APP_SECRET}
DATABASE_URL=mysql://${DB_USER}:${DB_PASS}@localhost:3306/${DB_NAME}
EOF
echo -e "${GREEN}.env file created${NC}"

# ─── Instructions for file upload ─────────────────────────────────
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}VPS setup complete!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo "1. Upload your project files to: ${APP_DIR}"
echo "   Use one of these methods:"
echo "   a) SCP:  scp -r ./deploy/* root@$(curl -s ifconfig.me):${APP_DIR}/"
echo "   b) SFTP: Use FileZilla to connect to $(curl -s ifconfig.me)"
echo ""
echo "2. After uploading, SSH into your VPS and run:"
echo -e "   ${GREEN}cd ${APP_DIR}${NC}"
echo -e "   ${GREEN}npm install${NC}"
echo -e "   ${GREEN}npm run build${NC}"
echo -e "   ${GREEN}npx tsx db/fix.ts${NC}"
echo -e "   ${GREEN}pm2 start dist/boot.js --name ${APP_NAME}${NC}"
echo ""
echo "3. Set up Nginx config:"
echo -e "   ${GREEN}nano /etc/nginx/sites-available/aimarketing${NC}"
echo "   (Paste the Nginx config from DEPLOY_GUIDE.md)"
echo -e "   ${GREEN}ln -s /etc/nginx/sites-available/aimarketing /etc/nginx/sites-enabled/${NC}"
echo -e "   ${GREEN}nginx -t && systemctl restart nginx${NC}"
echo ""
echo "4. Set up SSL:"
echo -e "   ${GREEN}apt install certbot python3-certbot-nginx -y${NC}"
echo -e "   ${GREEN}certbot --nginx -d your-domain.com${NC}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
