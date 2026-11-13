FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

RUN apk add --no-cache git openssh-client

WORKDIR /usr/src/app

COPY sync.sh /usr/src/app/sync.sh
RUN chmod +x /usr/src/app/sync.sh

CMD ["/usr/src/app/sync.sh"]
