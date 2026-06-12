# zerodb-neon

Neon serverless Postgres compatible driver backed by ZeroDB.

## Rules

- This package has ZERO runtime dependencies (uses native fetch)
- ES module (index.js) and CommonJS (index.cjs) entry points
- Tagged template literal syntax matches Neon's API: sql`SELECT * FROM users`
- Auto-provisioning uses POST /api/v1/public/instant-db
- Queries hit POST /v1/zerodb/{projectId}/postgres/query
- Event triggers (onInsert/onUpdate/onDelete) use the ZeroDB Hooks API
- Never store credentials in code or tests
- Tests use mocked fetch — no real API calls in CI
- Pool and Client classes are thin shims — ZeroDB manages pooling server-side
