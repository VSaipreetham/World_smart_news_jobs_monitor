# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

# Copy source and build
COPY . .
RUN npm run build

# Serve stage
FROM nginx:alpine

# Copy built assets to nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# Replace default nginx config with our custom one handles /api proxying
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
