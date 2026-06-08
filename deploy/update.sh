#!/bin/bash
# Run this on EC2 to pull latest code and redeploy
# Usage: bash update.sh

set -e
cd /home/ubuntu/familyguard

echo "=== Pull latest code ==="
git pull

echo "=== Update backend ==="
cd server && npm install --production
pm2 restart familyguard-api

echo "=== Rebuild frontend ==="
cd ../client
npm install
VITE_API_URL="" npm run build
sudo cp -r dist/* /var/www/familyguard/

echo "Done — app updated."
