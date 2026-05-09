FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 38080

ENV PORT=38080

CMD ["node", "server.js"]
