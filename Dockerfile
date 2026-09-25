FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
