# syntax=docker/dockerfile:1.6

FROM golang:1.24.10-alpine AS build
WORKDIR /src
RUN apk add --no-cache git build-base
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS
ARG TARGETARCH
RUN mkdir -p /out \
    && CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -ldflags="-s -w" -o /out/gateway-api .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/gateway-api /gateway-api
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/gateway-api"]
