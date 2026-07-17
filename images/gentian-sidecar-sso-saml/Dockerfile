FROM node:18-alpine

WORKDIR /usr/src/app

COPY bridge.js ./

# Pre-install common database adapters and JWT libraries to avoid runtime installation
RUN npm install pg mysql2 jsonwebtoken

ENV NODE_ENV=production
ENV PORT=8081

CMD ["node", "bridge.js"]
