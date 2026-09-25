FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production

# Render sets $PORT itself; server.js already reads process.env.PORT
EXPOSE 10000

CMD ["node", "server.js"]
