FROM node:26-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@12.11.2

# Copy root workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy backend package configuration
COPY server/package.json ./server/package.json

# Install workspace dependencies
RUN pnpm install --no-frozen-lockfile

# Copy backend source
COPY server ./server

# Start backend
WORKDIR /app/server

EXPOSE 5080

CMD ["pnpm", "start"]
