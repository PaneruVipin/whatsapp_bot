# Use the official Playwright base image for version 1.56.0
FROM mcr.microsoft.com/playwright:v1.56.0-noble AS base

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy the rest of your application
COPY . .

# Expose Railway’s default port
EXPOSE 3000

# Define environment variables (Railway sets PORT automatically)
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Start your Node.js app
CMD ["node", "index.js"]
