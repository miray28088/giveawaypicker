# Use Microsoft Playwright official image with all Linux Chromium dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

# Set working directory
WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install exact npm dependencies
RUN npm ci || npm install

# Guarantee exact Chromium browser binary is downloaded and installed
RUN npx playwright install chromium

# Copy application source code
COPY . .

# Expose port
EXPOSE 3000

# Set environment variables
ENV PORT=3000

# Start server
CMD ["node", "server.js"]
