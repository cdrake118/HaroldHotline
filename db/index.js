const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'harold.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid          TEXT UNIQUE NOT NULL,
    caller_number     TEXT,
    call_type         TEXT,        -- 'confession' | 'speak' | 'question' | 'wisdom'
    call_status       TEXT,
    duration          INTEGER,
    recording_url     TEXT,
    recording_sid     TEXT,
    transcript        TEXT,
    transcript_status TEXT DEFAULT 'none',  -- 'none' | 'pending' | 'completed' | 'failed'
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TRIGGER IF NOT EXISTS calls_updated_at
    AFTER UPDATE ON calls
  BEGIN
    UPDATE calls SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

  CREATE TABLE IF NOT EXISTS blocked_numbers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    number     TEXT UNIQUE NOT NULL,
    reason     TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS harold_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS wisdoms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT UNIQUE NOT NULL,
    source     TEXT DEFAULT 'ai',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Indexes for common query patterns — safe to run on existing DBs
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_calls_created_at    ON calls(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_calls_caller_number ON calls(caller_number, created_at);
  CREATE INDEX IF NOT EXISTS idx_calls_recording_sid ON calls(recording_sid);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS studio_posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id    INTEGER,
    call_type  TEXT,
    caption    TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS page_views (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    referrer TEXT,
    device   TEXT
  );

  CREATE TABLE IF NOT EXISTS link_clicks (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'phone'
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_page_views_ts ON page_views(ts);
`);

// Migrations for existing databases
try { db.exec(`ALTER TABLE calls ADD COLUMN flagged INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE calls ADD COLUMN wisdom_text TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE calls ADD COLUMN harold_response TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE page_views ADD COLUMN country TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE page_views ADD COLUMN city TEXT`); } catch (_) {}

const stmts = {
  upsertCall: db.prepare(`
    INSERT INTO calls (call_sid, caller_number, call_type)
    VALUES (@callSid, @callerNumber, @callType)
    ON CONFLICT(call_sid) DO UPDATE SET
      call_type     = COALESCE(excluded.call_type, call_type),
      caller_number = COALESCE(excluded.caller_number, caller_number)
  `),

  updateStatus: db.prepare(`
    UPDATE calls SET call_status = @callStatus, duration = @duration
    WHERE call_sid = @callSid
  `),

  updateRecording: db.prepare(`
    UPDATE calls SET recording_url = @recordingUrl, recording_sid = @recordingSid,
      transcript_status = 'pending'
    WHERE call_sid = @callSid
  `),

  updateTranscript: db.prepare(`
    UPDATE calls SET transcript = @transcript, transcript_status = @transcriptStatus
    WHERE call_sid = @callSid
  `),

  updateTranscriptByRecordingSid: db.prepare(`
    UPDATE calls SET transcript = @transcript, transcript_status = @transcriptStatus
    WHERE recording_sid = @recordingSid
  `),

  getCall:    db.prepare(`SELECT * FROM calls WHERE call_sid = ?`),
  getCallById: db.prepare(`SELECT * FROM calls WHERE id = ?`),

  flagCall: db.prepare(`UPDATE calls SET flagged = @flagged WHERE id = @id`),

  clearRecording: db.prepare(`
    UPDATE calls SET recording_url = NULL, recording_sid = NULL,
      transcript = NULL, transcript_status = 'none'
    WHERE id = @id
  `),

  getCallByRecordingSid: db.prepare(`SELECT * FROM calls WHERE recording_sid = ?`),

  countCallsByNumber: db.prepare(`
    SELECT COUNT(*) as count FROM calls WHERE caller_number = ?
  `),

  countCallsByNumberInLastHour: db.prepare(`
    SELECT COUNT(*) as count FROM calls
    WHERE caller_number = ? AND created_at >= datetime('now', '-1 hour')
  `),

  stats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN call_type = 'confession' THEN 1 ELSE 0 END) as confessions,
      SUM(CASE WHEN call_type = 'speak'      THEN 1 ELSE 0 END) as speak_calls,
      SUM(CASE WHEN call_type = 'question'   THEN 1 ELSE 0 END) as questions,
      SUM(CASE WHEN call_type = 'wisdom'     THEN 1 ELSE 0 END) as wisdom_calls,
      SUM(CASE WHEN recording_url IS NOT NULL THEN 1 ELSE 0 END) as recordings
    FROM calls
  `),

  statsDaily: db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM calls
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `),

  // Blocklist
  isBlocked: db.prepare(`SELECT 1 FROM blocked_numbers WHERE number = ? LIMIT 1`),
  listBlocklist: db.prepare(`SELECT * FROM blocked_numbers ORDER BY created_at DESC`),
  addToBlocklist: db.prepare(`
    INSERT INTO blocked_numbers (number, reason) VALUES (@number, @reason)
    ON CONFLICT(number) DO UPDATE SET reason = excluded.reason
  `),
  removeFromBlocklist: db.prepare(`DELETE FROM blocked_numbers WHERE id = ?`),

  // Settings
  getSetting: db.prepare(`SELECT value FROM harold_settings WHERE key = ?`),
  setSetting: db.prepare(`
    INSERT INTO harold_settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),

  getRateLimitedCallers: db.prepare(`
    SELECT caller_number, COUNT(*) as call_count
    FROM calls
    WHERE caller_number IS NOT NULL
      AND created_at >= datetime('now', '-1 hour')
    GROUP BY caller_number
    HAVING call_count >= ?
    ORDER BY call_count DESC
  `),

  updateWisdomText:     db.prepare(`UPDATE calls SET wisdom_text     = @wisdomText     WHERE call_sid = @callSid`),
  updateHaroldResponse: db.prepare(`UPDATE calls SET harold_response = @haroldResponse WHERE id = @id`),

  savePost:  db.prepare(`INSERT INTO studio_posts (call_id, call_type, caption) VALUES (@callId, @callType, @caption)`),
  listPosts: db.prepare(`SELECT * FROM studio_posts ORDER BY created_at DESC LIMIT ?`),

  // Wisdom pool
  pickWisdom:     db.prepare(`SELECT id, text FROM wisdoms ORDER BY RANDOM() LIMIT 1`),
  getWisdomCount: db.prepare(`SELECT COUNT(*) as count FROM wisdoms`),
  listWisdoms:    db.prepare(`SELECT id, text, source, created_at FROM wisdoms ORDER BY id DESC LIMIT @limit`),
  insertWisdom:   db.prepare(`INSERT OR IGNORE INTO wisdoms (text, source) VALUES (@text, @source)`),

  // Analytics
  insertPageView: db.prepare(`
    INSERT INTO page_views (ts, referrer, device, country, city)
    VALUES (CAST(strftime('%s','now') AS INTEGER), ?, ?, ?, ?)
  `),
  insertLinkClick: db.prepare(`
    INSERT INTO link_clicks (ts, type)
    VALUES (CAST(strftime('%s','now') AS INTEGER), ?)
  `),
  analyticsOverview: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM page_views) as total_views,
      (SELECT COUNT(*) FROM page_views
        WHERE ts >= CAST(strftime('%s','now','-7 days') AS INTEGER)) as views_7d,
      (SELECT COUNT(*) FROM page_views
        WHERE ts >= CAST(strftime('%s','now','-30 days') AS INTEGER)) as views_30d,
      (SELECT COUNT(*) FROM link_clicks WHERE type = 'phone') as total_clicks,
      (SELECT COUNT(*) FROM link_clicks
        WHERE type = 'phone'
          AND ts >= CAST(strftime('%s','now','-30 days') AS INTEGER)) as clicks_30d
  `),
  analyticsDaily: db.prepare(`
    SELECT date(ts, 'unixepoch') as day, COUNT(*) as count
    FROM page_views
    WHERE ts >= CAST(strftime('%s','now','-30 days') AS INTEGER)
    GROUP BY day
    ORDER BY day ASC
  `),
  analyticsReferrers: db.prepare(`
    SELECT COALESCE(NULLIF(referrer,''), 'direct') as referrer, COUNT(*) as count
    FROM page_views
    GROUP BY referrer
    ORDER BY count DESC
    LIMIT 15
  `),
  analyticsDevices: db.prepare(`
    SELECT COALESCE(device, 'unknown') as device, COUNT(*) as count
    FROM page_views
    GROUP BY device
    ORDER BY count DESC
  `),
  analyticsCountries: db.prepare(`
    SELECT country, COUNT(*) as count
    FROM page_views
    WHERE country IS NOT NULL
    GROUP BY country
    ORDER BY count DESC
    LIMIT 20
  `),
};

// Dynamic query helpers (can't be pre-prepared due to variable WHERE clauses)
function buildCallsQuery(opts, countOnly = false) {
  const { hasRecording = false, callType = null, dateFrom = null, dateTo = null } = opts;
  const conditions = [];
  const params = [];

  if (hasRecording) conditions.push('c.recording_url IS NOT NULL');
  if (callType)    { conditions.push('c.call_type = ?');                params.push(callType); }
  if (dateFrom)    { conditions.push("date(c.created_at) >= date(?)");  params.push(dateFrom); }
  if (dateTo)      { conditions.push("date(c.created_at) <= date(?)");  params.push(dateTo); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  if (countOnly) {
    return { sql: `SELECT COUNT(*) as total FROM calls c ${where}`, params };
  }

  return {
    sql: `
      SELECT c.*,
        (SELECT COUNT(*) FROM calls c2
         WHERE c2.caller_number = c.caller_number
           AND c2.caller_number IS NOT NULL) as caller_call_count
      FROM calls c
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `,
    params,
  };
}

module.exports = {
  upsertCall: (callSid, callerNumber, callType) =>
    stmts.upsertCall.run({ callSid, callerNumber: callerNumber || null, callType: callType || null }),

  updateStatus: (callSid, callStatus, duration) =>
    stmts.updateStatus.run({ callSid, callStatus, duration: duration ? parseInt(duration, 10) : null }),

  updateRecording: (callSid, recordingUrl, recordingSid) =>
    stmts.updateRecording.run({ callSid, recordingUrl, recordingSid }),

  updateTranscript: (callSid, transcript, transcriptStatus) =>
    stmts.updateTranscript.run({ callSid, transcript, transcriptStatus }),

  updateTranscriptByRecordingSid: (recordingSid, transcript, transcriptStatus) =>
    stmts.updateTranscriptByRecordingSid.run({ recordingSid, transcript, transcriptStatus }),

  flagCall: (id, flagged) => stmts.flagCall.run({ id, flagged }),
  clearRecording: (id)    => stmts.clearRecording.run({ id }),

  getCall: (callSid)       => stmts.getCall.get(callSid),
  getCallById: (id)        => stmts.getCallById.get(id),
  getCallByRecordingSid:   (sid) => stmts.getCallByRecordingSid.get(sid),

  countCallsByNumber: (number) =>
    stmts.countCallsByNumber.get(number)?.count ?? 0,

  countCallsByNumberInLastHour: (number) =>
    stmts.countCallsByNumberInLastHour.get(number)?.count ?? 0,

  listCallsFiltered: (opts = {}) => {
    const { limit = 50, offset = 0, ...rest } = opts;
    const { sql, params } = buildCallsQuery(rest, false);
    return db.prepare(sql).all(...params, limit, offset);
  },

  countCallsFiltered: (opts = {}) => {
    const { sql, params } = buildCallsQuery(opts, true);
    return db.prepare(sql).get(...params)?.total ?? 0;
  },

  // Keep old names as aliases for back-compat
  listCalls: (limit = 50, offset = 0) =>
    db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM calls c2
         WHERE c2.caller_number = c.caller_number AND c2.caller_number IS NOT NULL) as caller_call_count
      FROM calls c ORDER BY c.created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset),

  listCallsWithRecording: (limit = 50, offset = 0) =>
    db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM calls c2
         WHERE c2.caller_number = c.caller_number AND c2.caller_number IS NOT NULL) as caller_call_count
      FROM calls c WHERE c.recording_url IS NOT NULL ORDER BY c.created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset),

  countCalls: () =>
    db.prepare(`SELECT COUNT(*) as total FROM calls`).get().total,

  countCallsWithRecording: () =>
    db.prepare(`SELECT COUNT(*) as total FROM calls WHERE recording_url IS NOT NULL`).get().total,

  searchCalls: (q, limit = 25, offset = 0) => {
    const p = `%${q}%`;
    return db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM calls c2
         WHERE c2.caller_number = c.caller_number AND c2.caller_number IS NOT NULL) as caller_call_count
      FROM calls c
      WHERE c.transcript LIKE ? OR c.caller_number LIKE ? OR c.call_type LIKE ?
      ORDER BY c.created_at DESC LIMIT ? OFFSET ?
    `).all(p, p, p, limit, offset);
  },

  countSearchCalls: (q) => {
    const p = `%${q}%`;
    return db.prepare(`
      SELECT COUNT(*) as total FROM calls
      WHERE transcript LIKE ? OR caller_number LIKE ? OR call_type LIKE ?
    `).get(p, p, p)?.total ?? 0;
  },

  stats:      () => stmts.stats.get(),
  statsDaily: () => stmts.statsDaily.all(),

  // Blocklist
  isBlocked:           (number) => !!stmts.isBlocked.get(number),
  listBlocklist:       ()       => stmts.listBlocklist.all(),
  addToBlocklist:      (number, reason) => stmts.addToBlocklist.run({ number, reason: reason || null }),
  removeFromBlocklist: (id)     => stmts.removeFromBlocklist.run(id),

  // Settings
  getSetting: (key)        => stmts.getSetting.get(key)?.value ?? null,
  setSetting: (key, value) => stmts.setSetting.run({ key, value }),

  getRateLimitedCallers: (limit) => stmts.getRateLimitedCallers.all(limit),

  updateWisdomText:     (callSid, wisdomText)       => stmts.updateWisdomText.run({ callSid, wisdomText }),
  updateHaroldResponse: (id, haroldResponse)        => stmts.updateHaroldResponse.run({ id, haroldResponse }),

  savePost:  (callId, callType, caption) => stmts.savePost.run({ callId: callId || null, callType: callType || null, caption }),
  listPosts: (limit = 50)                => stmts.listPosts.all(limit),

  // Wisdom pool
  pickWisdom:     ()             => stmts.pickWisdom.get(),
  getWisdomCount: ()             => stmts.getWisdomCount.get().count,
  listWisdoms:    (limit = 500)  => stmts.listWisdoms.all({ limit }),
  insertWisdom:   (text, source) => stmts.insertWisdom.run({ text, source }),

  // Analytics
  insertPageView:     (referrer, device, country, city) => stmts.insertPageView.run(referrer || 'direct', device || 'unknown', country || null, city || null),
  insertLinkClick:    (type)             => stmts.insertLinkClick.run(type || 'phone'),
  analyticsOverview:  ()                 => stmts.analyticsOverview.get(),
  analyticsDaily:     ()                 => stmts.analyticsDaily.all(),
  analyticsReferrers: ()                 => stmts.analyticsReferrers.all(),
  analyticsDevices:   ()                 => stmts.analyticsDevices.all(),
  analyticsCountries: ()                 => stmts.analyticsCountries.all(),
};
