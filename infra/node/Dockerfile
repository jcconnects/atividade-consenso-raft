FROM golang:1.22-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod ./
RUN go mod download || true
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/raft-node .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates curl iptables
COPY --from=build /out/raft-node /usr/local/bin/raft-node
RUN mkdir -p /data
WORKDIR /data
EXPOSE 7000 8100 9000
ENTRYPOINT ["/usr/local/bin/raft-node"]
