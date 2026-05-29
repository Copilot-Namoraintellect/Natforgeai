#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  NatForge AI - Local Packaging Script
#  Run this ON YOUR LOCAL MACHINE before uploading to VPS
# ═══════════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  NatForge AI - Packaging for Production Deploy${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ─── Check .env.production is configured ──────────────────────────
if [ ! -f ".env.production" ]; then
  echo -e "${RED}ERROR: .env.production not found!${NC}"
  echo "Copy .env.example to .env.production and fill in all values."
  exit 1
fi

if grep -q "GENERATE_A_STRONG_SECRET_HERE\|your_db_user\|YOUR_CLOUD_SQL_IP\|your_firebase_api_key\|your_project_id" .env.production; then
  echo -e "${RED}ERROR: .env.production still contains placeholder values!${NC}"
  echo "Please edit .env.production and replace ALL placeholder values with real credentials."
  exit 1
fi

# ─── Build the project ────────────────────────────────────────────
echo -e "${YELLOW}[1/3] Building project for production...${NC}"
npm run build
echo -e "${GREEN}Build complete${NC}"

# ─── Create deploy package ────────────────────────────────────────
echo -e "${YELLOW}[2/3] Creating deploy package...${NC}"
rm -rf deploy
mkdir -p deploy

# Copy built files
cp -r dist deploy/

# Copy backend source (needed for runtime)
cp -r api deploy/

# Copy database files
cp -r db deploy/

# Copy contracts (shared types)
cp -r contracts deploy/

# Copy config files
cp package.json deploy/
cp package-lock.json deploy/ 2>/dev/null || true
cp .env.production deploy/.env
cp drizzle.config.ts deploy/
cp postcss.config.js deploy/ 2>/dev/null || true
cp tailwind.config.js deploy/ 2>/dev/null || true
cp tailwind.config.ts deploy/ 2>/dev/null || true
cp vite.config.ts deploy/
cp tsconfig.json deploy/
cp tsconfig.app.json deploy/ 2>/dev/null || true
cp tsconfig.node.json deploy/ 2>/dev/null || true
cp tsconfig.server.json deploy/ 2>/dev/null || true

# Copy deployment scripts
cp deploy-vps.sh deploy/

# Copy Firebase service account if referenced in .env
FIREBASE_FILE=$(grep "^FIREBASE_SERVICE_ACCOUNT=" .env.production | cut -d'=' -f2 | tr -d '"')
if [ -n "$FIREBASE_FILE" ] && [ -f "$FIREBASE_FILE" ]; then
  cp "$FIREBASE_FILE" deploy/
  echo -e "${GREEN}Copied Firebase service account: $(basename "$FIREBASE_FILE")${NC}"
fi

# ─── Create the archive ───────────────────────────────────────────
echo -e "${YELLOW}[3/3] Creating archive...${NC}"
tar -czvf natforgeai-deploy.tar.gz deploy/

# ─── Done ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}✅ Package created: natforgeai-deploy.tar.gz${NC}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}Upload to your VPS:${NC}"
echo ""
echo "1. Upload the archive:"
echo -e "   ${GREEN}scp natforgeai-deploy.tar.gz root@YOUR_VPS_IP:/root/${NC}"
echo ""
echo "2. SSH into your VPS:"
echo -e "   ${GREEN}ssh root@YOUR_VPS_IP${NC}"
echo ""
echo "3. Extract and set up:"
echo -e "   ${GREEN}mkdir -p /var/www/natforgeai${NC}"
echo -e "   ${GREEN}tar -xzvf /root/natforgeai-deploy.tar.gz${NC}"
echo -e "   ${GREEN}cp -r deploy/* /var/www/natforgeai/${NC}"
echo -e "   ${GREEN}cd /var/www/natforgeai${NC}"
echo -e "   ${GREEN}bash deploy-vps.sh${NC}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
