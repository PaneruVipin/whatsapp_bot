FROM mcr.microsoft.com/playwright:v1.56.0-focal

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "index.js"]
