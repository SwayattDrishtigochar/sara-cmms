FROM node:26-slim

WORKDIR /app

RUN npm install -g pnpm@12.11.2

COPY package.json ./

COPY server/package.json ./server/

RUN pnpm install --no-frozen-lockfile

COPY server/ ./server/

WORKDIR /app/server

EXPOSE 5080

CMD ["pnpm", "start"]
