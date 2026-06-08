#!/bin/bash
# Run this once on a fresh Ubuntu 22.04 EC2 instance
# Usage: bash setup.sh

set -e

echo "=== 1. System update ==="
sudo apt update && sudo apt upgrade -y

echo "=== 2. Install Node.js 18 ==="
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

echo "=== 3. Install PM2 & Nginx ==="
sudo npm install -g pm2
sudo apt install -y nginx postgresql postgresql-contrib

echo "=== 4. Set up PostgreSQL ==="
sudo systemctl start postgresql
sudo systemctl enable postgresql
sudo -u postgres psql -c "CREATE USER familyguard WITH PASSWORD 'change_this_password';"
sudo -u postgres psql -c "CREATE DATABASE familyguard OWNER familyguard;"

echo "=== 5. Clone repository ==="
# Replace with your actual GitHub repo URL
read -p "Enter your GitHub repo URL (e.g. https://github.com/you/familyguard.git): " REPO_URL
git clone "$REPO_URL" /home/ubuntu/familyguard
cd /home/ubuntu/familyguard

echo "=== 6. Install backend dependencies ==="
cd server && npm install --production

echo "=== 7. Create .env file ==="
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
cat > .env <<EOF
NODE_ENV=production
PORT=5000
DATABASE_URL=postgresql://familyguard:change_this_password@localhost:5432/familyguard
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRES_IN=7d
CLIENT_URL=http://$PUBLIC_IP
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=FamilyGuard <noreply@familyguard.com>
EOF
echo ".env created — edit /home/ubuntu/familyguard/server/.env to fill in SMTP settings"

echo "=== 8. Build React frontend ==="
cd ../client
npm install
VITE_API_URL="" npm run build

echo "=== 9. Copy frontend build to Nginx ==="
sudo mkdir -p /var/www/familyguard
sudo cp -r dist/* /var/www/familyguard/
sudo chown -R www-data:www-data /var/www/familyguard

echo "=== 10. Configure Nginx ==="
sudo cp ../deploy/nginx.conf /etc/nginx/sites-available/familyguard
sudo ln -sf /etc/nginx/sites-available/familyguard /etc/nginx/sites-enabled/familyguard
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl enable nginx

echo "=== 11. Start backend with PM2 ==="
cd ../server
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup | tail -1 | sudo bash

echo ""
echo "=============================="
echo "Deploy complete!"
echo "App URL: http://$PUBLIC_IP"
echo "=============================="
