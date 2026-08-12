FROM node:18-alpine

WORKDIR /usr/src/app

COPY bridge.js ./

# Pre-install common database adapters and JWT libraries to avoid runtime installation.
# @node-saml/node-saml verifies the assertion signature, Destination, Audience and
# validity window. Pinned rather than floating: this is the component that decides
# whether a login is genuine, so it must not change under us on a rebuild.
RUN npm install pg mysql2 jsonwebtoken @node-saml/node-saml@5.1.0

ENV NODE_ENV=production
ENV PORT=8081

CMD ["node", "bridge.js"]
