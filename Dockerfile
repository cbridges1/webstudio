# selfhost: images for the builder and the deploy service, built from this checkout.
#
#   docker build --target builder -t webstudio-builder .
#   docker build --target deploy -t webstudio-deploy .
#
# Both start from one workspace stage (dependencies installed, workspace packages built), so
# they share its layers. CI publishes both to ghcr.io (.github/workflows/selfhost-images.yml).
# Settings come from the environment at run time; see apps/deploy/README.md and
# apps/builder/app/env/env.server.ts.

FROM node:22-bookworm-slim AS workspace
ENV CI=1 \
    PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
# The checkout's pinned pnpm (package.json packageManager). Site builds run it too.
RUN npm install --global --no-audit --no-fund pnpm@9.14.4 && npm cache clean --force
USER node
WORKDIR /app
COPY --chown=node:node . .
# One layer, so node_modules and the pnpm store it hardlinks from are stored once. The store
# stays in the image: the deploy service copies the site template out of it for each job.
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@webstudio-is/builder^..." build \
 && pnpm --filter "ssg-cloudflare-pages^..." build \
 && pnpm --filter webstudio pack:portable

# The builder: a production Remix server on PORT (default 3000). The same image runs the
# database migrations (compose's migrate service).
FROM workspace AS builder
ENV NODE_ENV=production \
    PORT=3000
RUN pnpm --filter @webstudio-is/builder build
WORKDIR /app/apps/builder
EXPOSE 3000
CMD ["node", "server.mjs", "build/server/index.js"]

# The deploy service: builds published projects with this checkout's CLI and site packages and
# uploads them. Job folders and logs live in DEPLOYER_DATA_DIR (a volume); the queue is in the database.
FROM workspace AS deploy
ENV HOST=0.0.0.0 \
    PORT=3001 \
    DEPLOYER_DATA_DIR=/data
USER root
RUN mkdir -p /data /sites && chown node:node /data /sites
USER node
WORKDIR /app/apps/deploy
EXPOSE 3001
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]
