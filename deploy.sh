#!/bin/bash
set -e

echo "🚀 Starting Financier Deployment..."

echo "----------------------------------------"
echo "📦 1/5: Pulling latest backend code from GitHub..."
cd ~/financier
git pull origin master

echo "----------------------------------------"
echo "📦 2/5: Pulling latest frontend code from GitHub..."
cd ~/financier/financier-frontend
git pull origin master

echo "----------------------------------------"
echo "🛠️  3/5: Compiling Webpack production files (this may take a minute)..."
docker run --rm -v "$PWD":/app -w /app node:18 bash -c "yarn install && yarn build && yarn docs"

echo "----------------------------------------"
echo "🐳 4/5: Rebuilding Docker images and restarting containers..."
cd ~/financier
docker compose build node nginx init plaid_sync
docker compose up -d

echo "----------------------------------------"
echo "🌐 5/5: Restarting Nginx to pick up config changes..."
docker compose restart nginx

echo "----------------------------------------"
echo "✅ Deployment Complete! Your app is live."
