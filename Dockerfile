FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Run pending migrations, then start the API.
CMD ["sh", "-c", "npm run migrate && node src/server.js"]
