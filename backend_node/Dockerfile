FROM node:24-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Expose backend port
EXPOSE 8000

# Start the server
CMD ["node", "server.js"]

