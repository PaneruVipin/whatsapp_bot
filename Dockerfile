# Use official Node.js LTS image
FROM node:18-alpine AS base

# Set working directory
WORKDIR /app

# Copy only package files first (for better caching)
COPY package*.json ./

# Install dependencies (only production)
RUN npm ci --only=production

# Install Playwright and Chromium
RUN npm install playwright && \
    npx playwright install --with-deps chromium

# Copy the rest of the app
COPY . .

# Expose the app port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
