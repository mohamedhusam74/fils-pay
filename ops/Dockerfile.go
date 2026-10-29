# Multi-stage build of apps/settlement. Build context is the repo root
# (see docker-compose.yml); only apps/settlement is sent to the builder.
FROM golang:1.24-bookworm AS build

WORKDIR /src

COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download

COPY apps/settlement/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement

# Static binary on distroless. No OS tzdata needed: cmd/settlement imports
# time/tzdata, which embeds the zoneinfo database in the binary.
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=build /out/settlement ./settlement

CMD ["./settlement", "daemon"]
