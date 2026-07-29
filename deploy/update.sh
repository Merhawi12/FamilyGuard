#!/bin/bash
# Run this on EC2 to pull latest code and redeploy
# Usage: bash update.sh

set -e
cd /home/ubuntu/parentix

echo "=== Pull latest code ==="
git pull

echo "=== Update backend ==="
cd server && npm install --production
pm2 restart parentix-api

echo "=== Rebuild frontend ==="
cd ../client
npm install
VITE_API_URL="" npm run build
sudo cp -r dist/* /var/www/parentix/

echo "Done — app updated."
