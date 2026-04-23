FROM oven/bun:1 AS base
WORKDIR /app

# Install all deps (including devDeps) — we need @types/bun for typecheck
# and @tailwindcss/cli for the CSS build below.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Build CSS so the runtime doesn't need devDeps and the UI ships with
# styles already baked in.
RUN bun run build:css

# Type check (redundant with CI, but catches image-specific regressions).
RUN bun run check

# Expose default port
EXPOSE 3000

# Run — src/main.ts directly (dist.css already built above; no chained build needed at runtime).
CMD ["bun", "run", "src/main.ts"]
