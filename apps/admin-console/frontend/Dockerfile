# The build stage runs on the builder's own platform. Vite produces the same
# bundle for every target, so emulating a foreign architecture to run npm would
# only make the arm64 leg slow.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
RUN npm install -g serve@14.2.4
COPY --from=build /app/dist /app/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# /app/www is where the entrypoint assembles the served root at start: the
# built assets plus a config.js rendered from the environment. It is a
# directory here so a container run without the emptyDir mount still has
# somewhere to write, and owned by the runtime user so it can.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/www \
    && chown -R 65532:65532 /app/www
USER 65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# -c names the cache policy shipped in public/serve.json. cleanUrls is off
# there because serve-handler otherwise redirects any path ending in .html to
# its extensionless form, and with single-page rewriting on that form is
# answered by index.html, so every real .html file but one becomes
# unreachable over HTTP while sitting perfectly well on disk.
CMD ["serve", "-s", "/app/www", "-l", "8080", "-c", "/app/www/serve.json"]
