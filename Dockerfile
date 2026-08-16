FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/index.ts"]
