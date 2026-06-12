# zerodb-neon

**Neon serverless Postgres compatible driver backed by ZeroDB.** Same tagged template syntax you already know. Zero config. Auto-provisioning. Plus DB event triggers that Neon doesn't have.

[![npm](https://img.shields.io/npm/v/zerodb-neon)](https://www.npmjs.com/package/zerodb-neon)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why switch?

| Feature | @neondatabase/serverless | zerodb-neon |
|---------|------------------------|-------------|
| Tagged template SQL | Yes | Yes |
| Auto-provisioning | No (need connection string) | Yes (zero config) |
| DB event triggers | No | Yes (onInsert/onUpdate/onDelete) |
| Vendor lock-in | Neon only | Runs anywhere |
| Free tier | 512 MB | 100 MB + vectors + files |

## Quick Start

```bash
npm install zerodb-neon
```

```javascript
import { neon } from 'zerodb-neon';

// Auto-provisions a free ZeroDB Postgres instance (no connection string needed)
const sql = neon();

// Query with tagged template syntax (identical to Neon)
const users = await sql`SELECT * FROM users WHERE active = ${true}`;
console.log(users); // [{ id: 1, name: 'Alice', active: true }]

// Parameterized queries — safe by default
const name = 'Bob';
const result = await sql`INSERT INTO users (name) VALUES (${name}) RETURNING *`;
```

## Migration from Neon

```diff
- import { neon } from '@neondatabase/serverless';
+ import { neon } from 'zerodb-neon';

- const sql = neon(process.env.DATABASE_URL);
+ const sql = neon(); // auto-provisions, or pass { apiKey, projectId }

// Everything else stays the same
const users = await sql`SELECT * FROM users`;
```

## DB Event Triggers

The killer feature Neon doesn't have:

```javascript
import { neon } from 'zerodb-neon';

const sql = neon();

// React to database changes in real-time
sql.onInsert('users', async (row) => {
  console.log('New user:', row);
  // Send welcome email, update analytics, etc.
});

sql.onUpdate('orders', async (row) => {
  console.log('Order updated:', row);
});

sql.onDelete('sessions', async (row) => {
  console.log('Session expired:', row);
});
```

## Full Results Mode

```javascript
const sql = neon({ fullResults: true });

const result = await sql`SELECT * FROM users`;
// { rows: [...], fields: [...], rowCount: 5, command: 'SELECT' }
```

## Array Mode

```javascript
const sql = neon({ arrayMode: true });

const rows = await sql`SELECT id, name FROM users`;
// [[1, 'Alice'], [2, 'Bob']]
```

## Transactions

```javascript
const sql = neon();

await sql.transaction(async (tx) => {
  await tx`INSERT INTO accounts (name, balance) VALUES (${'Alice'}, ${1000})`;
  await tx`UPDATE accounts SET balance = balance - ${100} WHERE name = ${'Bob'}`;
});
```

## Pool & Client (Neon compat)

```javascript
import { Pool, Client } from 'zerodb-neon';

// Pool — ZeroDB manages connection pooling server-side
const pool = new Pool({ apiKey: 'your-key', projectId: 'your-project' });
const result = await pool.query('SELECT * FROM users WHERE id = $1', [1]);
await pool.end();

// Client
const client = new Client();
await client.connect();
const rows = await client.query('SELECT NOW()');
await client.end();
```

## Configuration

```javascript
// Option 1: Environment variables (recommended)
// ZERODB_API_KEY=your-key
// ZERODB_PROJECT_ID=your-project
const sql = neon();

// Option 2: Explicit config
const sql = neon({
  apiKey: 'your-key',
  projectId: 'your-project',
  fullResults: false,
  arrayMode: false,
});

// Option 3: Connection string (Neon compat)
const sql = neon('postgresql://apiKey@zerodb/projectId');
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ZERODB_API_KEY` | ZeroDB API key |
| `ZERODB_PROJECT_ID` | ZeroDB project ID |
| `NEON_API_KEY` | Alias for ZERODB_API_KEY (migration compat) |

---

> **Built by [AINative Studio](https://ainative.studio)** | [ZeroDB Docs](https://zerodb.ai) | [GitHub](https://github.com/AINative-Studio/zerodb-neon)
>
> Migrate from Neon in 2 minutes. Get DB event triggers for free.
> ```bash
> npm install zerodb-neon
> ```

---

## Zero-Config Auto-Provisioning

**No account needed to start.** On first run, this package automatically:

1. Provisions a **free ZeroDB instance** (~800ms)
2. Saves credentials locally (`.env`, `.mcp.json`)
3. Prints a **claim link** in your terminal

### The 72-Hour Window

Your auto-provisioned instance is **free for 72 hours**. To keep your data permanently, visit the **claim URL** printed in your terminal.

### For AI Agents

If a coding agent (Claude Code, Cursor, Windsurf) installs this package:
- Auto-provisions without human intervention
- The **claim URL** appears in agent output — visit it to take ownership
- `.claude/CLAUDE.md` instructs agents to surface the claim link to you
- Check `.env` or `~/.ainative/config.json` for your project ID if you miss it
