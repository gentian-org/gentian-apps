FROM alpine:3.18

RUN apk add --no-cache git openssh-client

WORKDIR /usr/src/app

COPY sync.sh /usr/src/app/sync.sh
RUN chmod +x /usr/src/app/sync.sh

CMD ["/usr/src/app/sync.sh"]
