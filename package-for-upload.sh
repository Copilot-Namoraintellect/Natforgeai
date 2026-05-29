#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Package the app for upload to Afrihost VPS
#  Run this on your LOCAL machine before uploading
# ═══════════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Packaging AI Marketing Command Center for Upload${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ─── Build the project ────────────────────────────────────────────
echo -e "${YELLOW}[1/3] Building project...${NC}"
npm run build
echo -e "${GREEN}Build complete${NC}"

# ─── Create deploy folder ─────────────────────────────────────────
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
cp package-lock.json deploy/
cp drizzle.config.ts deploy/
cp postcss.config.js deploy/
cp tailwind.config.js deploy/
cp vite.config.ts deploy/
cp tsconfig.json deploy/
cp tsconfig.app.json deploy/
cp tsconfig.node.json deploy/
cp tsconfig.server.json deploy/

# Copy environment example
cp .env.example deploy/.env.example

# Copy deployment scripts
cp deploy.sh deploy/
cp DEPLOY_GUIDE.md deploy/

# ─── Create the archive ───────────────────────────────────────────
echo -e "${YELLOW}[3/3] Creating archive...${NC}"
tar -czvf aimarketing-deploy.tar.gz deploy/

# ─── Done ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}Package created: aimarketing-deploy.tar.gz${NC}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}Upload to your VPS:${NC}"
echo ""
echo "1. Upload the archive:"
echo -e "   ${GREEN}scp aimarketing-deploy.tar.gz root@YOUR_VPS_IP:/root/${NC}"
echo ""
echo "2. SSH into your VPS:"
echo -e "   ${GREEN}ssh root@YOUR_VPS_IP${NC}"
echo ""
echo "3. Extract and install:"
echo -e "   ${GREEN}mkdir -p /var/www/aimarketing${NC}"
echo -e "   ${GREEN}tar -xzvf aimarketing-deploy.tar.gz${NC}"
echo -e "   ${GREEN}cp -r deploy/* /var/www/aimarketing/${NC}"
echo -e "   ${GREEN}cd /var/www/aimarketing${NC}"
echo -e "   ${GREEN}bash deploy.sh${NC}  ${YELLOW}# Run the VPS setup script${NC}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
