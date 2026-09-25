FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --include=dev && npm run build && npm prune --omit=dev

EXPOSE 3001
CMD ["npm", "start"]
