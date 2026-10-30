# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────
# Stage 1: Build Go backend
# ─────────────────────────────────────────────────────────────
FROM golang:1.24-alpine AS go-builder

RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /app

# Keep the standard-library compiler cache in an exported layer; unlike a
# cache mount, this survives an ephemeral Docker-in-Docker builder via ECR.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build std

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/main.go ./
COPY backend/internal/ ./internal/
COPY backend/migrations/ ./migrations/

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s" \
    -o server \
    .


# ─────────────────────────────────────────────────────────────
# Stage 2: Build Vite frontend
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig*.json ./
COPY frontend/src/ ./src/
COPY frontend/public/ ./public/

# Build-time configuration must not invalidate the dependency install layer.
ARG VITE_API_URL=/api
ARG VITE_GOOGLE_CLIENT_ID=
ARG VITE_ENVIRONMENT=production

ENV VITE_API_URL=$VITE_API_URL \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID \
    VITE_ENVIRONMENT=$VITE_ENVIRONMENT

RUN npm run build


# ─────────────────────────────────────────────────────────────
# Stage 3: Runtime image
# ─────────────────────────────────────────────────────────────
FROM alpine:3.21

# poppler-utils: pdftotext, the knowledge base's primary PDF reader
# (backend/internal/services/kb/pdf_poppler.go); without it PDFs fall back
# to the pure-Go reader.
RUN for i in 1 2 3; do \
      apk add --no-cache ca-certificates tzdata curl poppler-utils && exit 0; \
      if [ "$i" -eq 3 ]; then exit 1; fi; \
      echo "apk retry $i..."; sleep 5; \
    done

WORKDIR /app

COPY --from=go-builder /app/server .
COPY --from=frontend-builder /app/frontend/dist ./public
COPY CHANGELOG.md .

ENV PORT=8080 \
    ENVIRONMENT=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -sf http://localhost:8080/api/health || exit 1

CMD ["/app/server"]
