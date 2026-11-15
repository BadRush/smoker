FROM golang:alpine AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/

RUN CGO_ENABLED=0 GOOS=linux \
    go build -trimpath -ldflags="-s -w" -o /out/probe ./cmd/probe

FROM alpine:latest AS runtime
RUN apk add --no-cache ca-certificates tzdata libcap \
    && adduser -D -u 65532 nonroot \
    && mkdir -p /data \
    && chown -R nonroot:nonroot /data

WORKDIR /app
COPY --from=builder /out/probe /app/probe
RUN setcap cap_net_raw+ep /app/probe

USER nonroot:nonroot
VOLUME ["/data"]
ENTRYPOINT ["/app/probe"]
