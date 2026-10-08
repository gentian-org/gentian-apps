# The base image by digest: this is the program that decides whether a
# sign-in is genuine, and a rebuild must not change what it runs on.
FROM docker.io/library/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /usr/src/app

# Exactly the versions in package-lock.json. The SAML library, the XML parser
# and the signature check are pinned there, with the database clients and the
# token library a handler may use; nothing is fetched when the container
# starts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY bridge.js ./
COPY lib ./lib

ENV NODE_ENV=production \
    PORT=8081

# The image's unprivileged user. The sidecar writes nothing to disk.
USER 1000:1000
EXPOSE 8081

CMD ["node", "bridge.js"]
