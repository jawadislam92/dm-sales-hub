FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_BACKEND=pg PGDATA_DIR=/app/.pgdata
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/server.ts"]
