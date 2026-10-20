# The base image by digest: this is the program that decides whether a
# sign-in is genuine, and a rebuild must not change what it runs on.
FROM docker.io/library/node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5

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
