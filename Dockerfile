FROM node:22-alpine
WORKDIR /app
ARG BUILD=dev
ENV NODE_ENV=production \
    BANTS_BUILD=$BUILD \
    PORT=42069 \
    DATA_DIR=/data
COPY package.json ./
COPY src ./src
RUN mkdir -p /data
VOLUME /data
EXPOSE 42069
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:42069/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
