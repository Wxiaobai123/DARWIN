/**
 * Database layer — uses Node.js 22 built-in sqlite module.
 * No native compilation required.
 */

import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'
import { config } from './config.js'

const DB_PATH = config.db.path
const DB_DIR = path.dirname(DB_PATH)

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const db = new DatabaseSync(DB_PATH)

// WAL mode for better concurrent access + busy timeout
db.exec('PRAGMA journal_mode=WAL')
db.exec('PRAGMA busy_timeout=5000')

db.exec(`
  CREATE TABLE IF NOT EXISTS market_states (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset       TEXT NOT NULL,
    state       TEXT NOT NULL,
    confidence  REAL NOT NULL,
    indicators  TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS strategies (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    author            TEXT NOT NULL,
    spec              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'shadow',
    shadow_started_at TEXT,
    live_started_at   TEXT,
    demotion_count    INTEGER DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS strategy_performance (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id    TEXT NOT NULL,
    market_state   TEXT NOT NULL,
    trades         INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    total_return   REAL DEFAULT 0,
    max_drawdown   REAL DEFAULT 0,
    last_updated   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS strategy_performance_daily (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id    TEXT NOT NULL,
    recorded_date  TEXT NOT NULL,
    trades         INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    total_return   REAL DEFAULT 0,
    max_drawdown   REAL DEFAULT 0,
    market_state   TEXT,
    last_updated   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(strategy_id, recorded_date)
  );

  CREATE TABLE IF NOT EXISTS circuit_breaker_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tier           INTEGER NOT NULL,
    trigger_reason TEXT NOT NULL,
    affected       TEXT NOT NULL,
    triggered_at   TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at    TEXT,
    resolved_by    TEXT
  );

  CREATE TABLE IF NOT EXISTS daily_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date TEXT NOT NULL UNIQUE,
    content     TEXT NOT NULL,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shadow_bots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    algo_id     TEXT NOT NULL,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    stopped_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS kv_store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

export default db
