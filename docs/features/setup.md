# Setup

## Environment Variables

**`backend/.env`:**
```
DATABASE_URL=postgresql://...
JWT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:5173/auth/callback
FRONTEND_URL=http://localhost:5173
PORT=8080
AI_PROVIDER=groq          # or openai, gemini
GROQ_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=   # Slack app's signing secret — verifies /api/slack/events webhook requests
ASANA_PAT=
ASANA_PROJECT_ID=
```

**`frontend/.env`:**
```
VITE_API_URL=http://localhost:8080/api
VITE_GOOGLE_CLIENT_ID=
VITE_ENVIRONMENT=production   # hides dev login in prod builds
```

## Database Notes

- PostgreSQL via pgx/pgxpool. Pool: max 10, min 2, 1h lifetime.
- `DATABASE_URL` unset → in-memory maps (no persistence).
- `go.mod` toolchain must be a released version (`go 1.24.0`, not `go 1.25.x`).
