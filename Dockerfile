FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS toolchain
WORKDIR /app
ENV CI=true
RUN npm install --global pnpm@12.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM toolchain AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

FROM toolchain AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY --from=production-dependencies /app/node_modules/ ./node_modules/
RUN ./node_modules/.bin/playwright install --with-deps chromium --only-shell \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY --from=build /app/dist/ ./dist/
COPY templates/ ./templates/
COPY drizzle/ ./drizzle/
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
