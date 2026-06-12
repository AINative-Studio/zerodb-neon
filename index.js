/**
 * zerodb-neon — Neon serverless Postgres compatible driver backed by ZeroDB.
 *
 * Drop-in replacement for @neondatabase/serverless with the same tagged
 * template literal syntax. Zero config: auto-provisions a ZeroDB Postgres
 * instance on first use.
 *
 * BONUS over Neon: real-time DB event triggers via .onInsert(), .onUpdate(),
 * .onDelete() — something Neon doesn't offer natively.
 *
 * Refs #4008
 */

const ZERODB_API_BASE = 'https://api.ainative.studio';
const INSTANT_DB_ENDPOINT = `${ZERODB_API_BASE}/api/v1/public/instant-db`;
const POSTGRES_QUERY_ENDPOINT = (projectId) =>
  `${ZERODB_API_BASE}/v1/zerodb/${projectId}/postgres/query`;
const HOOKS_ENDPOINT = `${ZERODB_API_BASE}/api/v1/zerodb/hooks`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`ZeroDB API error ${res.status}: ${body}`);
    err.statusCode = res.status;
    throw err;
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res;
}

// ---------------------------------------------------------------------------
// Auto-provisioning
// ---------------------------------------------------------------------------

async function autoProvision(source) {
  const data = await httpRequest(INSTANT_DB_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: source || 'zerodb-neon' }),
  });

  return {
    projectId: data.project_id,
    apiKey: data.api_key,
    claimUrl: data.claim_url || null,
  };
}

// ---------------------------------------------------------------------------
// NeonSQL — tagged template query function
// ---------------------------------------------------------------------------

class NeonSQL {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.apiKey]     — ZeroDB API key (env: ZERODB_API_KEY or NEON_API_KEY)
   * @param {string} [opts.projectId]  — ZeroDB project ID (env: ZERODB_PROJECT_ID)
   * @param {string} [opts.endpoint]   — API base URL (env: ZERODB_ENDPOINT)
   * @param {boolean} [opts.fullResults] — Return full result objects (default: false, returns rows only)
   * @param {boolean} [opts.arrayMode]   — Return rows as arrays instead of objects (default: false)
   */
  constructor(opts = {}) {
    this._apiKey =
      opts.apiKey ||
      process.env.ZERODB_API_KEY ||
      process.env.NEON_API_KEY ||
      '';
    this._projectId =
      opts.projectId || process.env.ZERODB_PROJECT_ID || '';
    this._endpoint =
      opts.endpoint || process.env.ZERODB_ENDPOINT || ZERODB_API_BASE;
    this._fullResults = opts.fullResults || false;
    this._arrayMode = opts.arrayMode || false;
    this._provisioned = false;
    this._provisionPromise = null;
    this._hooks = [];
    this._pollInterval = null;
    this._pollIntervalMs = opts.pollInterval || 5000;

    // Return a callable proxy — sql`query` syntax
    const handler = {
      apply: (target, thisArg, args) => {
        // Tagged template: sql`SELECT ...`
        if (Array.isArray(args[0]) && args[0].raw) {
          return this._query(args[0], ...args.slice(1));
        }
        // Direct call: sql('SELECT ...')
        if (typeof args[0] === 'string') {
          return this._queryDirect(args[0], args[1]);
        }
        throw new Error('sql() expects a tagged template literal or (query, params)');
      },
      get: (target, prop) => {
        if (prop === 'onInsert') return this.onInsert.bind(this);
        if (prop === 'onUpdate') return this.onUpdate.bind(this);
        if (prop === 'onDelete') return this.onDelete.bind(this);
        if (prop === 'transaction') return this.transaction.bind(this);
        if (prop === 'end') return this.end.bind(this);
        if (prop === 'unsafe') return this.unsafe.bind(this);
        if (prop === '_execute') return this._execute.bind(this);
        if (prop === '_hooks') return this._hooks;
        if (prop === '_apiKey') return this._apiKey;
        if (prop === '_projectId') return this._projectId;
        if (prop === '_provisioned') return this._provisioned;
        if (prop === '_endpoint') return this._endpoint;
        if (prop === '_ensureProvisioned') return this._ensureProvisioned.bind(this);
        if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
        return undefined;
      },
    };

    return new Proxy(function () {}, handler);
  }

  // -----------------------------------------------------------------------
  // Provisioning
  // -----------------------------------------------------------------------

  async _ensureProvisioned() {
    if (this._apiKey && this._projectId) return;

    if (this._provisionPromise) {
      await this._provisionPromise;
      return;
    }

    this._provisionPromise = (async () => {
      const result = await autoProvision('zerodb-neon');
      this._projectId = result.projectId;
      this._apiKey = result.apiKey;
      this._provisioned = true;

      if (result.claimUrl) {
        console.log(`\n  ZeroDB Postgres auto-provisioned (free, 72h trial).`);
        console.log(`  Claim to keep permanently: ${result.claimUrl}\n`);
      }
    })();

    await this._provisionPromise;
  }

  // -----------------------------------------------------------------------
  // Query execution
  // -----------------------------------------------------------------------

  _buildQuery(strings, ...values) {
    let query = '';
    const params = [];

    for (let i = 0; i < strings.length; i++) {
      query += strings[i];
      if (i < values.length) {
        params.push(values[i]);
        query += `$${params.length}`;
      }
    }

    return { query, params };
  }

  async _query(strings, ...values) {
    const { query, params } = this._buildQuery(strings, ...values);
    return this._execute(query, params);
  }

  async _queryDirect(query, params) {
    return this._execute(query, params || []);
  }

  async _execute(query, params = []) {
    await this._ensureProvisioned();

    const url = POSTGRES_QUERY_ENDPOINT(this._projectId);

    const result = await httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this._apiKey,
      },
      body: JSON.stringify({ query, params }),
    });

    const rows = result.rows || [];
    const fields = result.fields || [];

    if (this._arrayMode) {
      const arrayRows = rows.map((row) =>
        fields.map((f) => row[f.name])
      );
      if (this._fullResults) {
        return { rows: arrayRows, fields, rowCount: result.row_count || rows.length, command: result.command || '' };
      }
      return arrayRows;
    }

    if (this._fullResults) {
      return { rows, fields, rowCount: result.row_count || rows.length, command: result.command || '' };
    }

    return rows;
  }

  // -----------------------------------------------------------------------
  // Neon-compatible extras
  // -----------------------------------------------------------------------

  /**
   * Execute an unsafe (unparameterized) query. Use with caution.
   */
  async unsafe(query) {
    return this._execute(query, []);
  }

  /**
   * Execute multiple queries in a transaction.
   * @param {Function} fn — async function receiving sql tagged template
   */
  async transaction(fn) {
    await this._ensureProvisioned();

    // Build inner sql function that collects queries
    const queries = [];
    const innerSql = (strings, ...values) => {
      const { query, params } = this._buildQuery(strings, ...values);
      const promise = this._execute(query, params);
      queries.push(promise);
      return promise;
    };

    await this._execute('BEGIN', []);
    try {
      const result = await fn(innerSql);
      await this._execute('COMMIT', []);
      return result;
    } catch (err) {
      await this._execute('ROLLBACK', []);
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // DB Event Triggers (BONUS over Neon)
  // -----------------------------------------------------------------------

  /**
   * Register a callback for INSERT events on a table.
   * @param {string} table — Table name
   * @param {Function} callback — async function(row)
   */
  onInsert(table, callback) {
    this._hooks.push({
      table,
      event: 'INSERT',
      callback,
      eventType: `zerodb.postgres.${table}.insert`,
    });
    this._registerHook(`zerodb.postgres.${table}.insert`, `on_insert_${table}`, { table, operation: 'INSERT' });
    return this;
  }

  /**
   * Register a callback for UPDATE events on a table.
   * @param {string} table — Table name
   * @param {Function} callback — async function(row)
   */
  onUpdate(table, callback) {
    this._hooks.push({
      table,
      event: 'UPDATE',
      callback,
      eventType: `zerodb.postgres.${table}.update`,
    });
    this._registerHook(`zerodb.postgres.${table}.update`, `on_update_${table}`, { table, operation: 'UPDATE' });
    return this;
  }

  /**
   * Register a callback for DELETE events on a table.
   * @param {string} table — Table name
   * @param {Function} callback — async function(row)
   */
  onDelete(table, callback) {
    this._hooks.push({
      table,
      event: 'DELETE',
      callback,
      eventType: `zerodb.postgres.${table}.delete`,
    });
    this._registerHook(`zerodb.postgres.${table}.delete`, `on_delete_${table}`, { table, operation: 'DELETE' });
    return this;
  }

  async _registerHook(eventType, hookName, config) {
    try {
      await this._ensureProvisioned();
      await httpRequest(HOOKS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this._apiKey,
        },
        body: JSON.stringify({
          event_type: eventType,
          hook_name: hookName,
          project_id: this._projectId,
          hook_config: config,
        }),
      });
    } catch (err) {
      // 409 = hook already exists, that's fine
      if (err.statusCode !== 409) {
        console.error(`Failed to register hook ${hookName}:`, err.message);
      }
    }
  }

  /**
   * Clean up polling intervals.
   */
  end() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — matches Neon's export shape
// ---------------------------------------------------------------------------

/**
 * Create a Neon-compatible SQL function backed by ZeroDB Postgres.
 *
 * @param {string} [connectionString] — Ignored (kept for Neon compat). ZeroDB auto-provisions.
 * @param {Object} [opts] — Configuration options
 * @returns {Function} Tagged template SQL function
 */
export function neon(connectionString, opts = {}) {
  // If first arg is an object (no connection string), treat as opts
  if (typeof connectionString === 'object' && connectionString !== null) {
    opts = connectionString;
    connectionString = undefined;
  }

  // Parse connection string for compat (extract project info if present)
  let parsedOpts = { ...opts };
  if (typeof connectionString === 'string' && connectionString.length > 0) {
    // Accept postgresql://apiKey@zerodb/projectId format
    try {
      const url = new URL(connectionString);
      if (!parsedOpts.apiKey && url.username) parsedOpts.apiKey = url.username;
      if (!parsedOpts.projectId && url.pathname) parsedOpts.projectId = url.pathname.replace(/^\//, '');
    } catch {
      // Not a URL — ignore
    }
  }

  return new NeonSQL(parsedOpts);
}

/**
 * Pool class — Neon compat shim. ZeroDB manages pooling server-side.
 */
export class Pool {
  constructor(opts = {}) {
    this._sql = neon(opts.connectionString, opts);
  }

  async query(text, params) {
    if (Array.isArray(text) && text.raw) {
      return this._sql(text, ...params);
    }
    return this._sql._execute(text, params || []);
  }

  async end() {
    this._sql.end();
  }
}

/**
 * Client class — Neon compat shim.
 */
export class Client {
  constructor(opts = {}) {
    this._sql = neon(opts.connectionString, opts);
  }

  async connect() {
    await this._sql._ensureProvisioned();
  }

  async query(text, params) {
    return this._sql._execute(text, params || []);
  }

  async end() {
    this._sql.end();
  }
}

export default neon;
