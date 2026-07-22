FROM node:20-alpine

# Install Chromium and dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tzdata

# Tell Puppeteer to skip downloading Chromium and use system-installed package.
# Set DISABLE_CRASHPAD=1 to prevent crashpad helper process initialization errors under container seccomp profiles.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    DISABLE_CRASHPAD=1

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src/ ./src/

# Create data directory
RUN mkdir -p /app/data /app/screenshots && \
    chown -R node:node /app/data /app/screenshots

# Run as non-root user
USER node

# Command
CMD ["node", "src/index.js"]
