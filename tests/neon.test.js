/**
 * zerodb-neon unit tests.
 *
 * All HTTP calls are mocked via globalThis.fetch — no real API calls.
 * Uses Node.js built-in test runner (node:test).
 *
 * Refs #4008
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { neon, Pool, Client } from '../index.js';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockResponses = [];

function pushMock(status, body, contentType = 'application/json') {
  mockResponses.push({ status, body, contentType });
}

function createMockFetch() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const mock = mockResponses.shift();
    if (!mock) throw new Error(`Unexpected fetch call: ${url}`);

    return {
      ok: mock.status >= 200 && mock.status < 300,
      status: mock.status,
      headers: {
        get: (name) => {
          if (name === 'content-type') return mock.contentType;
          return null;
        },
      },
      json: async () => (typeof mock.body === 'string' ? JSON.parse(mock.body) : mock.body),
      text: async () => (typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

let mockFetch;

beforeEach(() => {
  mockResponses.length = 0;
  mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  delete globalThis.fetch;
  delete process.env.ZERODB_API_KEY;
  delete process.env.ZERODB_PROJECT_ID;
  delete process.env.NEON_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('neon() factory', () => {
  it('returns a callable function', () => {
    const sql = neon({ apiKey: 'k', projectId: 'p' });
    assert.equal(typeof sql, 'function');
  });

  it('reads credentials from env vars', () => {
    process.env.ZERODB_API_KEY = 'env-key';
    process.env.ZERODB_PROJECT_ID = 'env-proj';

    const sql = neon();
    assert.equal(sql._apiKey, 'env-key');
    assert.equal(sql._projectId, 'env-proj');
  });

  it('accepts NEON_API_KEY for compat', () => {
    process.env.NEON_API_KEY = 'neon-key';

    const sql = neon();
    assert.equal(sql._apiKey, 'neon-key');
  });

  it('accepts connection string (ignored gracefully)', () => {
    const sql = neon('postgresql://mykey@zerodb/myproject');
    assert.equal(sql._apiKey, 'mykey');
    assert.equal(sql._projectId, 'myproject');
  });

  it('opts override connection string', () => {
    const sql = neon('postgresql://old@zerodb/old', { apiKey: 'new', projectId: 'new-proj' });
    assert.equal(sql._apiKey, 'new');
    assert.equal(sql._projectId, 'new-proj');
  });
});

describe('tagged template queries', () => {
  it('executes a simple SELECT', async () => {
    pushMock(200, {
      rows: [{ id: 1, name: 'Alice' }],
      fields: [{ name: 'id' }, { name: 'name' }],
      row_count: 1,
    });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    const rows = await sql`SELECT * FROM users`;

    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Alice');

    const body = JSON.parse(mockFetch.calls[0].opts.body);
    assert.equal(body.query, 'SELECT * FROM users');
    assert.deepEqual(body.params, []);
  });

  it('parameterizes values', async () => {
    pushMock(200, {
      rows: [{ id: 1, name: 'Bob' }],
      fields: [{ name: 'id' }, { name: 'name' }],
    });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    const name = 'Bob';
    const age = 30;
    await sql`SELECT * FROM users WHERE name = ${name} AND age > ${age}`;

    const body = JSON.parse(mockFetch.calls[0].opts.body);
    assert.equal(body.query, 'SELECT * FROM users WHERE name = $1 AND age > $2');
    assert.deepEqual(body.params, ['Bob', 30]);
  });

  it('handles empty result sets', async () => {
    pushMock(200, { rows: [], fields: [] });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    const rows = await sql`SELECT * FROM empty_table`;

    assert.equal(rows.length, 0);
  });

  it('supports fullResults mode', async () => {
    pushMock(200, {
      rows: [{ id: 1 }],
      fields: [{ name: 'id' }],
      row_count: 1,
      command: 'SELECT',
    });

    const sql = neon({ apiKey: 'k', projectId: 'p', fullResults: true });
    const result = await sql`SELECT 1 AS id`;

    assert.equal(result.rowCount, 1);
    assert.equal(result.command, 'SELECT');
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.deepEqual(result.fields, [{ name: 'id' }]);
  });

  it('supports arrayMode', async () => {
    pushMock(200, {
      rows: [{ id: 1, name: 'Alice' }],
      fields: [{ name: 'id' }, { name: 'name' }],
    });

    const sql = neon({ apiKey: 'k', projectId: 'p', arrayMode: true });
    const rows = await sql`SELECT * FROM users`;

    assert.deepEqual(rows, [[1, 'Alice']]);
  });
});

describe('direct call syntax', () => {
  it('executes sql(query, params)', async () => {
    pushMock(200, {
      rows: [{ count: 5 }],
      fields: [{ name: 'count' }],
    });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    const rows = await sql('SELECT count(*) FROM users', []);

    assert.equal(rows[0].count, 5);
  });
});

describe('unsafe()', () => {
  it('sends unparameterized query', async () => {
    pushMock(200, { rows: [], fields: [] });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    await sql.unsafe('DROP TABLE IF EXISTS temp');

    const body = JSON.parse(mockFetch.calls[0].opts.body);
    assert.equal(body.query, 'DROP TABLE IF EXISTS temp');
    assert.deepEqual(body.params, []);
  });
});

describe('auto-provisioning', () => {
  it('provisions when no credentials', async () => {
    pushMock(200, {
      project_id: 'auto-proj',
      api_key: 'auto-key',
      claim_url: 'https://zerodb.ai/claim/test',
    });
    pushMock(200, { rows: [{ n: 1 }], fields: [{ name: 'n' }] });

    const sql = neon();
    const rows = await sql`SELECT 1 AS n`;

    assert.equal(rows[0].n, 1);
    assert.equal(sql._provisioned, true);
    assert.equal(sql._projectId, 'auto-proj');
  });

  it('skips provisioning when credentials exist', async () => {
    pushMock(200, { rows: [], fields: [] });

    const sql = neon({ apiKey: 'existing', projectId: 'existing-proj' });
    await sql`SELECT 1`;

    // Only 1 call (the query), no provisioning call
    assert.equal(mockFetch.calls.length, 1);
    assert.ok(mockFetch.calls[0].url.includes('/postgres/query'));
  });
});

describe('transaction()', () => {
  it('wraps queries in BEGIN/COMMIT', async () => {
    // BEGIN
    pushMock(200, { rows: [], fields: [] });
    // INSERT
    pushMock(200, { rows: [], fields: [], command: 'INSERT' });
    // COMMIT
    pushMock(200, { rows: [], fields: [] });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    await sql.transaction(async (tx) => {
      await tx`INSERT INTO users (name) VALUES (${'Alice'})`;
    });

    const queries = mockFetch.calls.map((c) => JSON.parse(c.opts.body).query);
    assert.equal(queries[0], 'BEGIN');
    assert.ok(queries[1].includes('INSERT'));
    assert.equal(queries[2], 'COMMIT');
  });

  it('rolls back on error', async () => {
    // BEGIN
    pushMock(200, { rows: [], fields: [] });
    // Failed query
    pushMock(500, { error: 'constraint violation' });
    // ROLLBACK
    pushMock(200, { rows: [], fields: [] });

    const sql = neon({ apiKey: 'k', projectId: 'p' });

    await assert.rejects(
      () =>
        sql.transaction(async (tx) => {
          await tx`INSERT INTO users (name) VALUES (${'bad'})`;
        }),
      /ZeroDB API error 500/
    );

    const lastCall = mockFetch.calls[mockFetch.calls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    assert.equal(body.query, 'ROLLBACK');
  });
});

describe('onInsert / onUpdate / onDelete hooks', () => {
  it('registers onInsert hook', async () => {
    // Hook registration call
    pushMock(201, { id: 'hook-1', event_type: 'zerodb.postgres.users.insert' });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    const callback = async (row) => {};
    sql.onInsert('users', callback);

    // Wait for async hook registration
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sql._hooks.length, 1);
    assert.equal(sql._hooks[0].table, 'users');
    assert.equal(sql._hooks[0].event, 'INSERT');
    assert.equal(sql._hooks[0].eventType, 'zerodb.postgres.users.insert');
  });

  it('registers onUpdate hook', async () => {
    pushMock(201, { id: 'hook-2' });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    sql.onUpdate('orders', async (row) => {});

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sql._hooks.length, 1);
    assert.equal(sql._hooks[0].event, 'UPDATE');
    assert.equal(sql._hooks[0].eventType, 'zerodb.postgres.orders.update');
  });

  it('registers onDelete hook', async () => {
    pushMock(201, { id: 'hook-3' });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    sql.onDelete('sessions', async (row) => {});

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sql._hooks.length, 1);
    assert.equal(sql._hooks[0].event, 'DELETE');
  });

  it('handles 409 conflict silently (hook already exists)', async () => {
    pushMock(409, { detail: 'Hook already exists' });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    sql.onInsert('users', async () => {});

    // Should not throw
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sql._hooks.length, 1);
  });

  it('chains multiple hooks', async () => {
    pushMock(201, { id: 'h1' });
    pushMock(201, { id: 'h2' });

    const sql = neon({ apiKey: 'k', projectId: 'p' });
    sql.onInsert('users', async () => {}).onUpdate('users', async () => {});

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sql._hooks.length, 2);
  });
});

describe('Pool class', () => {
  it('executes queries via query()', async () => {
    pushMock(200, { rows: [{ id: 1 }], fields: [{ name: 'id' }] });

    const pool = new Pool({ apiKey: 'k', projectId: 'p' });
    const rows = await pool.query('SELECT 1 AS id', []);

    assert.equal(rows[0].id, 1);
  });

  it('end() completes without error', async () => {
    const pool = new Pool({ apiKey: 'k', projectId: 'p' });
    await pool.end();
  });
});

describe('Client class', () => {
  it('connects and queries', async () => {
    pushMock(200, { rows: [{ n: 42 }], fields: [{ name: 'n' }] });

    const client = new Client({ apiKey: 'k', projectId: 'p' });
    await client.connect();
    const rows = await client.query('SELECT 42 AS n', []);

    assert.equal(rows[0].n, 42);
  });

  it('end() completes without error', async () => {
    const client = new Client({ apiKey: 'k', projectId: 'p' });
    await client.end();
  });
});

describe('error handling', () => {
  it('throws on API errors with status code', async () => {
    pushMock(403, { error: 'Forbidden' });

    const sql = neon({ apiKey: 'bad', projectId: 'p' });
    await assert.rejects(() => sql`SELECT 1`, /ZeroDB API error 403/);
  });

  it('throws on invalid call syntax', () => {
    const sql = neon({ apiKey: 'k', projectId: 'p' });
    assert.throws(() => sql(123), /expects a tagged template literal/);
  });
});

describe('API key header', () => {
  it('sends X-API-Key header on queries', async () => {
    pushMock(200, { rows: [], fields: [] });

    const sql = neon({ apiKey: 'my-secret-key', projectId: 'proj-123' });
    await sql`SELECT 1`;

    const headers = mockFetch.calls[0].opts.headers;
    assert.equal(headers['X-API-Key'], 'my-secret-key');
  });
});
