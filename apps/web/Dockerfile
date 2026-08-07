FROM node:24-alpine AS base
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY . .

RUN corepack enable pnpm
# OneAway: dropped the BuildKit `--mount=type=cache` (colima's docker has no BuildKit/buildx) so the
# legacy builder that `docker compose build` uses can build the fork image. Slower rebuilds, same result.
RUN pnpm i --frozen-lockfile

ARG NEXT_PUBLIC_DOCKER_BUILD=true
ENV NEXT_PUBLIC_WEB_URL=http://localhost:3000

RUN pnpm run build:web


# 3. Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

# OneAway: the chunked transcription path (lib/cloudflare-transcribe.ts) shells out to ffmpeg to probe
# duration and slice per-window audio. ffmpeg-static's binary is NOT traced into the Next standalone
# output, and the main audio extraction runs on the separate media-server service — so the web runner
# shipped with no ffmpeg at all, and every chunked transcription threw "FFmpeg binary not found". Install
# a real ffmpeg; getFfmpegPath() finds it at /usr/bin/ffmpeg. Without this, chunking always falls back to
# the slower single pass.
RUN apk add --no-cache ffmpeg

RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001


# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/packages/database/migrations ./apps/web/migrations


USER nextjs

EXPOSE 3000

CMD HOSTNAME="0.0.0.0" node apps/web/server.js
