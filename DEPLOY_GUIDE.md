# AI Marketing Command Center - Deployment Guide for Afrihost

## Important: Afrihost Hosting Requirements

This app is a **Node.js full-stack application** (React frontend + Node.js backend + MySQL database). 

**Afrihost Shared Hosting (cPanel) does NOT support Node.js.**

You have **two options**:

| Option | Plan Needed | Difficulty | Cost |
|--------|------------|------------|------|
| **A - VPS (Recommended)** | Afrihost Cloud VPS | Medium | ~R99-R299/month |
| **B - Dedicated Server** | Afrihost Dedicated | Advanced | ~R999+/month |

---

## Option A: Afrihost Cloud VPS (Recommended)

### Step 1: Buy an Afrihost VPS

1. Go to https://www.afrihost.com/cloud/ or https://clientzone.afrihost.com
2. Order a **Cloud VPS** with these minimum specs:
   - **OS**: Ubuntu 22.04 LTS (recommended)
   - **RAM**: 2GB minimum (4GB recommended)
   - **Storage**: 40GB SSD minimum
   - **Bandwidth**: 1TB+
3. You'll receive an email with:
   - VPS IP address
   - Root username (usually `root`)
   - Root password (or SSH key)

### Step 2: Prepare Your Project for Upload

**On your local machine**, run these commands in the project folder:

```bash
# 1. Navigate to your project
cd /path/to/your/ai-marketing-app

# 2. Install dependencies
npm install

# 3. Build the project for production
npm run build

# 4. The build creates:
#    - dist/boot.js          (Node.js backend server)
#    - dist/public/          (React frontend static files)
```

### Step 3: Create a Production Environment File

Create a file named `.env.production` in your project root:

```env
# ── App Secret (for JWT signing) ────────────────────────────────
# Generate a random string:  openssl rand -base64 32
APP_SECRET=your_random_secret_here_change_this

# ── Database ────────────────────────────────────────────────────
# You will get this after creating your MySQL database in Step 5
DATABASE_URL=mysql://your_db_user:your_db_password@localhost:3306/aimarketing

# ── Google OAuth (optional - only if you want Google login) ────
VITE_GOOGLE_CLIENT_ID=
```

> **IMPORTANT**: Replace `your_random_secret_here_change_this` with a real random string. Run `openssl rand -base64 32` to generate one.

### Step 4: Upload Files to Your VPS

**Method 1: Using SCP (from your local terminal)**

```bash
# Create a deploy package locally
cd /path/to/your/project

# Copy the built files and necessary folders
mkdir -p deploy
cp -r dist deploy/
cp -r api deploy/
cp -r db deploy/
cp -r contracts deploy/
cp package.json deploy/
cp .env.production deploy/.env
cp drizzle.config.ts deploy/
cp postcss.config.js deploy/
cp tailwind.config.js deploy/
cp vite.config.ts deploy/
cp tsconfig*.json deploy/

# Create a tar.gz archive
tar -czvf deploy.tar.gz deploy/

# Upload to your VPS (replace YOUR_VPS_IP with your actual IP)
scp deploy.tar.gz root@YOUR_VPS_IP:/root/
```

**Method 2: Using SFTP (FileZilla or similar)**

1. Open FileZilla
2. Connect with: Host = your VPS IP, Username = root, Password = your root password, Port = 22
3. Upload the entire project folder to `/var/www/aimarketing/`

**Method 3: Using Git**

```bash
# On your VPS
ssh root@YOUR_VPS_IP
cd /var
mkdir -p www
cd www
git clone https://github.com/YOUR_USERNAME/ai-marketing-app.git aimarketing
```

### Step 5: Set Up MySQL Database on Your VPS

SSH into your VPS and set up MySQL:

```bash
# SSH into your VPS
ssh root@YOUR_VPS_IP

# Update packages
apt update && apt upgrade -y

# Install MySQL Server
apt install mysql-server -y

# Secure MySQL installation
mysql_secure_installation
# Answer the prompts: Set root password, remove anonymous users, 
# disallow remote root login, remove test database, reload privileges

# Create database and user
mysql -u root -p
```

Inside the MySQL prompt:

```sql
-- Create the database
CREATE DATABASE aimarketing CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create a database user
CREATE USER 'aimarketing_user'@'localhost' IDENTIFIED BY 'YourStrongPassword123!';

-- Grant privileges
GRANT ALL PRIVILEGES ON aimarketing.* TO 'aimarketing_user'@'localhost';

-- Apply changes
FLUSH PRIVILEGES;

-- Exit
EXIT;
```

Now update your `.env` file on the VPS:

```bash
cd /var/www/aimarketing
nano .env
```

Set the DATABASE_URL:
```env
DATABASE_URL=mysql://aimarketing_user:YourStrongPassword123!@localhost:3306/aimarketing
```

Press `Ctrl+X`, then `Y`, then `Enter` to save.

### Step 6: Install Node.js 20+ on Your VPS

```bash
# Install Node.js 20 (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify installation
node --version   # Should show v20.x.x
npm --version    # Should show 10.x.x

# Install PM2 (process manager to keep app running)
npm install -g pm2
```

### Step 7: Install Dependencies and Build on VPS

```bash
cd /var/www/aimarketing

# Install production dependencies
npm install

# Build the project
npm run build

# Push database schema
npm run db:push
```

If `db:push` gives errors, use this alternative:

```bash
# Use the fix script to create tables
cd /var/www/aimarketing
npx tsx db/fix.ts
```

### Step 8: Start the App with PM2

```bash
cd /var/www/aimarketing

# Start the app with PM2
pm2 start dist/boot.js --name "ai-marketing"

# Save the PM2 config so it restarts on boot
pm2 save
pm2 startup systemd

# Check status
pm2 status
pm2 logs ai-marketing
```

The app should now be running on port 3000.

### Step 9: Set Up Nginx as Reverse Proxy

Install and configure Nginx to route traffic to your app:

```bash
# Install Nginx
apt install nginx -y

# Create Nginx config for your app
nano /etc/nginx/sites-available/aimarketing
```

Paste this configuration (replace `your-domain.com` with your actual domain):

```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    # Frontend static files
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
    }

    # API routes
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Activate the site:

```bash
# Enable the site
ln -s /etc/nginx/sites-available/aimarketing /etc/nginx/sites-enabled/

# Test Nginx config
nginx -t

# Restart Nginx
systemctl restart nginx

# Allow Nginx through firewall
ufw allow 'Nginx Full'
ufw allow OpenSSH
ufw enable
```

### Step 10: Set Up SSL (HTTPS) with Let's Encrypt

```bash
# Install Certbot
apt install certbot python3-certbot-nginx -y

# Get SSL certificate (replace with your domain)
certbot --nginx -d your-domain.com -d www.your-domain.com

# Follow the prompts - choose redirect to HTTPS

# Test auto-renewal
certbot renew --dry-run
```

### Step 11: Point Your Domain to the VPS

1. Log in to your domain registrar (where you bought your domain)
2. Find the DNS management section
3. Create an **A Record**:
   - Name: `@` (root) or `www`
   - Value: Your VPS IP address
   - TTL: 3600 (or default)
4. Wait 5-60 minutes for DNS to propagate

### Step 12: Verify Deployment

Open your browser and visit:
- `http://your-domain.com` (should redirect to HTTPS)
- `https://your-domain.com` (main app)

---

## Option B: Afrihost Shared Hosting (Workaround)

**WARNING**: Afrihost shared hosting is designed for PHP, not Node.js. This is a workaround and not recommended for production.

### Alternative: Use Afrihost for Domain + External Node.js Hosting

1. **Buy a domain** from Afrihost (or keep your existing one)
2. **Host the app elsewhere** that supports Node.js:
   - **Render.com** (Free tier available)
   - **Railway.app** (Free tier available)
   - **DigitalOcean** ($6/month)
   - **Vercel** (Frontend only) + **Render** (Backend)
3. **Point your Afrihost domain** to the external host using DNS records

### How to Point Afrihost Domain to External Host

1. Log into Afrihost Client Zone: https://clientzone.afrihost.com
2. Go to **Hosting** → **Your Domain** → **DNS Management**
3. Add/Edit these DNS records:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | @ | YOUR_EXTERNAL_SERVER_IP | 3600 |
| CNAME | www | your-domain.com | 3600 |

4. Save and wait for DNS propagation (5-60 minutes)

---

## Quick Reference: Common VPS Commands

```bash
# SSH into VPS
ssh root@YOUR_VPS_IP

# View app logs
pm2 logs ai-marketing

# Restart app
pm2 restart ai-marketing

# Stop app
pm2 stop ai-marketing

# Check app status
pm2 status

# Monitor resources
pm2 monit

# View Nginx error logs
tail -f /var/log/nginx/error.log

# View Nginx access logs
tail -f /var/log/nginx/access.log

# Restart Nginx
systemctl restart nginx

# Check MySQL status
systemctl status mysql

# MySQL login
mysql -u aimarketing_user -p

# Update app (after code changes)
cd /var/www/aimarketing
git pull          # If using git
npm install
npm run build
pm2 restart ai-marketing
```

---

## Troubleshooting

### App won't start
```bash
# Check if port 3000 is in use
lsof -ti:3000 | xargs kill -9

# Try running manually to see errors
node dist/boot.js
```

### Database connection errors
```bash
# Test MySQL connection
mysql -u aimarketing_user -p -e "USE aimarketing; SHOW TABLES;"

# Check .env DATABASE_URL is correct
cat .env | grep DATABASE_URL
```

### Nginx 502 Bad Gateway
```bash
# Check if app is running
pm2 status

# Restart everything
pm2 restart ai-marketing
systemctl restart nginx
```

### Permission denied errors
```bash
# Fix permissions
chown -R www-data:www-data /var/www/aimarketing
chmod -R 755 /var/www/aimarketing
```

---

## File Checklist for Upload

These are the files/folders you MUST upload to your VPS:

```
aimarketing/
  dist/
    boot.js           <- Backend server (required)
    public/           <- Frontend files (required)
      index.html
      assets/
  api/                <- Backend source (not needed if dist/boot.js exists)
  db/
    schema.ts         <- Database schema (required for db:push)
    fix.ts            <- Table creation fallback (recommended)
  contracts/          <- Shared types (required)
  package.json        <- Dependencies (required)
  .env                <- Environment variables (required)
  drizzle.config.ts   <- DB config (required)
  tsconfig.server.json <- TS config (required for db:push)
```

---

## Cost Summary (Afrihost VPS)

| Item | Estimated Cost (ZAR) |
|------|---------------------|
| Afrihost Cloud VPS (2GB RAM) | ~R99 - R199/month |
| Domain (.co.za) | ~R89/year |
| SSL Certificate | Free (Let's Encrypt) |
| **Total Monthly** | **~R99 - R199/month** |

---

## Need Help?

- **Afrihost Support**: https://www.afrihost.com/help/ or WhatsApp +27 11 507 5555
- **VPS Issues**: Check Afrihost Client Zone for server status
- **App Issues**: Run `pm2 logs` and check error messages
