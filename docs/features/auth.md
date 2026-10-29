# Authentication & Access Control

## Login Flow

1. Google Sign-In → `POST /api/auth/google` with credential (ID token)
2. Backend validates with Google, checks denylist then whitelist, creates/fetches user in DB
3. Returns JWT (24h default, 30d if `remember_me: true`)
4. Middleware on every request: validates JWT → looks up user by **email** in DB → puts DB user in context

The middleware resolves by email (not JWT user_id) to handle in-memory UUID mismatches. If the user doesn't exist in DB yet, middleware auto-creates them.

## Dev Mode

Any token starting with `dev-mode-token-` bypasses JWT validation and uses hardcoded admin:
- Email: `simranjot@apyhub.com`
- ID: `08938fa6-27b4-446f-a9aa-b8fe5c7b97c4` (must exist in `users` table)

Dev login is hidden in production builds via `VITE_ENVIRONMENT=production` — clicking the title in `Login.tsx` only works when `IS_PROD` is false.

## Access Control

- `simranjot@apyhub.com` → always admin
- `@apyhub.com` domain → `member` role
- Configurable via `whitelist` table
- Blocked emails in `denied_emails` table → rejected before whitelist check with specific error message
- Non-whitelisted → "not authorised" error
- `AuthContext` catches 403 → sets `accessDenied` state → `App.tsx` renders `NoAccessPage`

## Key Files

- `backend/internal/auth/` — JWT generation/validation, Google OAuth
- `backend/internal/middleware/auth.go` — JWT extraction → DB user lookup → context injection
- `frontend/src/contexts/AuthContext.tsx` — auth state, token storage, 12h refresh interval
- `frontend/src/pages/Login.tsx` — Google Sign-In button, dev login toggle
