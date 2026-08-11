# ==========================================
# 1. مرحلة البناء (Builder Stage)
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# ==========================================
# 2. مرحلة التشغيل (Production Stage)
# ==========================================
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --production


COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./src/db/migrations

EXPOSE 8080

CMD ["npm", "run", "start"]