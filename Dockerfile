FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production && \
    npm cache clean --force

COPY . .

RUN mkdir -p /app/data

EXPOSE 8045

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider --timeout=2 http://localhost:8045/v1/models 2>&1 | grep -q "401\|200" && exit 0 || exit 1

CMD ["node", "src/server/index.js"]

