# Use official Node.js LTS image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code

# Install Playwright and Chromium
RUN npm install playwright && \
    npx playwright install chromium
    
COPY . .

# Expose the app port (change if your app uses a different port)
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
