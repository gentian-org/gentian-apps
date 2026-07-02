FROM node:22-alpine AS build
ARG VITE_AUTH_DISABLED=false
ENV VITE_AUTH_DISABLED=$VITE_AUTH_DISABLED
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
RUN npm install -g serve@14.2.4
COPY --from=build /app/dist /app/dist
USER 65532
EXPOSE 8080
CMD ["serve", "-s", "/app/dist", "-l", "8080"]
