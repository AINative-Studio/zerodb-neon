/**
 * zerodb-neon — CommonJS entry point.
 *
 * Neon serverless Postgres compatible driver backed by ZeroDB.
 * Zero config: auto-provisions a ZeroDB Postgres instance on first use.
 *
 * Refs #4008
 */

'use strict';

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
// NeonSQL
// ---------------------------------------------------------------------------

class NeonSQL {
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

    const self = this;
    const handler = {
      apply: (target, thisArg, args) => {
        if (Array.isArray(args[0]) && args[0].raw) {
          return self._query(args[0], ...args.slice(1));
        }
        if (typeof args[0] === 'string') {
          return self._queryDirect(args[0], args[1]);
        }
        throw new Error('sql() expects a tagged template literal or (query, params)');
      },
      get: (target, prop) => {
        if (prop === 'onInsert') return self.onInsert.bind(self);
        if (prop === 'onUpdate') return self.onUpdate.bind(self);
        if (prop === 'onDelete') return self.onDelete.bind(self);
        if (prop === 'transaction') return self.transaction.bind(self);
        if (prop === 'end') return self.end.bind(self);
        if (prop === 'unsafe') return self.unsafe.bind(self);
        if (prop === '_execute') return self._execute.bind(self);
        if (prop === '_hooks') return self._hooks;
        if (prop === '_apiKey') return self._apiKey;
        if (prop === '_projectId') return self._projectId;
        if (prop === '_provisioned') return self._provisioned;
        if (prop === '_endpoint') return self._endpoint;
        if (prop === '_ensureProvisioned') return self._ensureProvisioned.bind(self);
        if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
        return undefined;
      },
    };

    return new Proxy(function () {}, handler);
  }

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

  async unsafe(query) {
    return this._execute(query, []);
  }

  async transaction(fn) {
    await this._ensureProvisioned();

    const self = this;
    const innerSql = (strings, ...values) => {
      const { query, params } = self._buildQuery(strings, ...values);
      return self._execute(query, params);
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
      if (err.statusCode !== 409) {
        console.error(`Failed to register hook ${hookName}:`, err.message);
      }
    }
  }

  end() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function neon(connectionString, opts = {}) {
  if (typeof connectionString === 'object' && connectionString !== null) {
    opts = connectionString;
    connectionString = undefined;
  }

  let parsedOpts = { ...opts };
  if (typeof connectionString === 'string' && connectionString.length > 0) {
    try {
      const url = new URL(connectionString);
      if (!parsedOpts.apiKey && url.username) parsedOpts.apiKey = url.username;
      if (!parsedOpts.projectId && url.pathname) parsedOpts.projectId = url.pathname.replace(/^\//, '');
    } catch {
      // Not a URL
    }
  }

  return new NeonSQL(parsedOpts);
}

class Pool {
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

class Client {
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

module.exports = { neon, Pool, Client, default: neon };
