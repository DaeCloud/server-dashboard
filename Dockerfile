FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    APP_MODE=dashboard

COPY package*.json ./
COPY server.js ./
COPY public ./public
COPY data ./data

EXPOSE 3000
CMD ["node", "server.js"]
