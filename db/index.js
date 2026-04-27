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
    call_type         TEXT,        -- 'confession' | 'speak' | 'question'
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
`);

// Migration: add flagged column for existing databases
try {
  db.exec(`ALTER TABLE calls ADD COLUMN flagged INTEGER DEFAULT 0`);
} catch (_) {
  // column already exists
}

const stmts = {
  upsertCall: db.prepare(`
    INSERT INTO calls (call_sid, caller_number, call_type)
    VALUES (@callSid, @callerNumber, @callType)
    ON CONFLICT(call_sid) DO UPDATE SET
      call_type    = COALESCE(excluded.call_type, call_type),
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

  getCall: db.prepare(`SELECT * FROM calls WHERE call_sid = ?`),

  getCallById: db.prepare(`SELECT * FROM calls WHERE id = ?`),

  flagCall: db.prepare(`UPDATE calls SET flagged = @flagged WHERE id = @id`),

  clearRecording: db.prepare(`
    UPDATE calls SET recording_url = NULL, recording_sid = NULL,
      transcript = NULL, transcript_status = 'none'
    WHERE id = @id
  `),

  getCallByRecordingSid: db.prepare(`SELECT * FROM calls WHERE recording_sid = ?`),

  listCalls: db.prepare(`
    SELECT * FROM calls ORDER BY created_at DESC LIMIT ? OFFSET ?
  `),

  countCalls: db.prepare(`SELECT COUNT(*) as total FROM calls`),

  stats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN call_type = 'confession' THEN 1 ELSE 0 END) as confessions,
      SUM(CASE WHEN call_type = 'speak'      THEN 1 ELSE 0 END) as speak_calls,
      SUM(CASE WHEN call_type = 'question'   THEN 1 ELSE 0 END) as questions,
      SUM(CASE WHEN recording_url IS NOT NULL THEN 1 ELSE 0 END) as recordings
    FROM calls
  `),
};

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

  clearRecording: (id) => stmts.clearRecording.run({ id }),

  getCall: (callSid) => stmts.getCall.get(callSid),

  getCallById: (id) => stmts.getCallById.get(id),

  getCallByRecordingSid: (recordingSid) => stmts.getCallByRecordingSid.get(recordingSid),

  listCalls: (limit = 50, offset = 0) => stmts.listCalls.all(limit, offset),

  countCalls: () => stmts.countCalls.get().total,

  stats: () => stmts.stats.get(),
};
