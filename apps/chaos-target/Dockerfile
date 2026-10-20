# Build context is the repo root (render.yaml: dockerContext "."), because the npm
# lockfile and workspace list live there.
FROM node:22-slim

WORKDIR /repo
ENV NODE_ENV=production

# npm ci checks the lockfile against every workspace, so all workspace manifests are
# copied, but only chaos-target's production dependencies are installed.
COPY package.json package-lock.json ./
COPY apps/app/package.json apps/app/
COPY apps/chaos-target/package.json apps/chaos-target/
COPY packages/core/package.json packages/core/
RUN npm ci --omit=dev --workspace @uptime/chaos-target --include-workspace-root=false \
  && npm cache clean --force

COPY apps/chaos-target/src apps/chaos-target/src

USER node
EXPOSE 3000
# Node 22 runs the TypeScript directly (type stripping), so there is no build step.
CMD ["node", "apps/chaos-target/src/server.ts"]
