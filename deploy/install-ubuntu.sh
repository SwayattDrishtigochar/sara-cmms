#!/usr/bin/env bash
# SARA on an Ubuntu VM (GCP: Ubuntu 22.04/24.04, e2-medium or larger). Installs Docker Engine + Compose,
# starts Docker on boot, adds a swap file when the VM has little RAM (the web app build needs ~2 GB),
# creates .env from .env.example and prints the remaining steps. Safe to run again.
#   git clone <repo-url> sara && cd sara && bash deploy/install-ubuntu.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker Engine from download.docker.com ..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" |
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

# Less than ~3.5 GB of RAM: a 2 GB swap file keeps the Vite build from being killed.
if [ ! -f /swapfile ] && [ "$(free -m | awk '/^Mem:/ {print $2}')" -lt 3500 ]; then
  echo "Adding a 2 GB swap file ..."
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example."; }

cat <<MSG

Docker $(docker --version | awk '{print $3}' | tr -d ,) is installed and starts on boot.
Log out and in again (or run: newgrp docker) so your user can use Docker without sudo.

Next:
  1. nano .env   MONGO_URI, INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG (the hosted databases),
                 JWT_SECRET, SUPERADMIN_PASSWORD, GEMINI_API_KEY (or AI_MOCK=true),
                 CLIENT_URL=https://<your domain>  and for HTTPS: DOMAIN=<your domain>, WEB_PORT=127.0.0.1:8080
  2. GCP firewall: allow tcp:80 and tcp:443 to this VM (network tag), and point the domain's A record at its external IP.
  3. HTTPS (needed for the voice assistant's microphone):   docker compose --profile tls up -d --build
     HTTP only (testing):                                    docker compose up -d --build
  4. First time only:  docker compose exec server node scripts/seed.js
  5. Logs:  docker compose logs -f server
MSG
