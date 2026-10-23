FROM node:24.19.0-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATABASE_PATH=/app/var/evidence.sqlite
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir /app/var && chown node:node /app/var
USER node
EXPOSE 8787
CMD ["node", "src/server.ts"]
