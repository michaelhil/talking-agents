FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Type check
RUN bun run check

# Expose default port
EXPOSE 3000

# Run
CMD ["bun", "run", "src/main.ts"]
