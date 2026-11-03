FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

RUN apk add --no-cache git openssh-client

WORKDIR /usr/src/app

COPY sync.sh /usr/src/app/sync.sh
RUN chmod +x /usr/src/app/sync.sh

CMD ["/usr/src/app/sync.sh"]
