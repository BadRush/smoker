FROM golang:alpine AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download && rm -rf /go/pkg/mod/cache/download

COPY cmd/ ./cmd/
COPY internal/ ./internal/

RUN CGO_ENABLED=0 GOOS=linux \
    go build -p 2 -trimpath -ldflags="-s -w" -o /out/central ./cmd/central \
    && rm -rf /root/.cache/go-build /tmp/go-build*

FROM alpine:latest AS runtime
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 65532 nonroot

WORKDIR /app
COPY --from=builder /out/central /app/central

USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/app/central"]
