const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const UNACKNOWLEDGED_RETURN_SQL =
  "(v.highlight_reason IS NOT NULL AND s.highlight_acknowledged_at IS NULL)";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Unknown',
  last_checked_at TEXT,
  last_etag TEXT,
  last_modified TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  last_refresh_status TEXT,
  last_error TEXT,
  last_success_at TEXT,
  last_refreshed_at TEXT,
  last_refresh_attempt_at TEXT,
  latest_upload_at TEXT,
  last_refresh_had_upload INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS videos (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  published TEXT NOT NULL,
  is_short INTEGER NOT NULL DEFAULT 0,
  short_status TEXT NOT NULL DEFAULT 'unknown',
  highlight_reason TEXT,
  pending_highlight_reason TEXT,
  short_check_attempts INTEGER NOT NULL DEFAULT 0,
  short_last_checked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_state (
  video_id TEXT PRIMARY KEY,
  watched_at TEXT,
  starred_at TEXT,
  hidden_at TEXT,
  highlight_acknowledged_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_usage (
  quota_day TEXT NOT NULL,
  bucket TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (quota_day, bucket, endpoint)
);

CREATE TABLE IF NOT EXISTS refresh_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL,
  mode TEXT NOT NULL,
  requested_mode TEXT,
  effective_mode TEXT,
  rss_fallbacks INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT,
  scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  requested_channels INTEGER NOT NULL DEFAULT 0,
  checked INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  new_videos INTEGER NOT NULL DEFAULT 0,
  new_shorts INTEGER NOT NULL DEFAULT 0,
  classification_unknown INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  api_calls INTEGER NOT NULL DEFAULT 0,
  api_units INTEGER NOT NULL DEFAULT 0,
  api_by_endpoint TEXT NOT NULL DEFAULT '{}',
  rss_requests INTEGER NOT NULL DEFAULT 0,
  shorts_probes INTEGER NOT NULL DEFAULT 0,
  daily_remaining INTEGER,
  pending_unknown_total INTEGER NOT NULL DEFAULT 0,
  pending_unknown_due INTEGER NOT NULL DEFAULT 0,
  pending_reclassified INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_channel_published
  ON videos(channel_id, published DESC);
CREATE INDEX IF NOT EXISTS idx_videos_published
  ON videos(published DESC);
`;

class Db {
  constructor(dbFile) {
    this.dbFile = dbFile;
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = OFF");
    this.db.exec(SCHEMA);
    this._migrate();
    this._initializeFts();
    this._prepare();
  }

  _migrate() {
    const hasColumn = (table, name) => this.db
      .prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
    const addColumn = (table, name, definition) => {
      if (!hasColumn(table, name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    };
    const migrations = [
      () => {
        const missing = !hasColumn("videos", "short_status");
        addColumn("videos", "short_status", "TEXT NOT NULL DEFAULT 'unknown'");
        if (missing) this.db.exec("UPDATE videos SET short_status = CASE WHEN is_short = 1 THEN 'short' ELSE 'long' END");
      },
      () => addColumn("videos", "highlight_reason", "TEXT"),
      () => {
        addColumn("channels", "favorite", "INTEGER NOT NULL DEFAULT 0");
        addColumn("channels", "last_refresh_status", "TEXT");
        addColumn("channels", "last_error", "TEXT");
        addColumn("channels", "last_success_at", "TEXT");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS video_state (
            video_id TEXT PRIMARY KEY, watched_at TEXT, starred_at TEXT,
            hidden_at TEXT, updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_video_state_watched ON video_state(watched_at);
          CREATE INDEX IF NOT EXISTS idx_video_state_starred ON video_state(starred_at);
          CREATE INDEX IF NOT EXISTS idx_video_state_hidden ON video_state(hidden_at);
        `);
      },
      () => {
        addColumn("channels", "last_refreshed_at", "TEXT");
        addColumn("channels", "latest_upload_at", "TEXT");
        addColumn("videos", "short_check_attempts", "INTEGER NOT NULL DEFAULT 0");
        addColumn("videos", "short_last_checked_at", "TEXT");
        this.db.exec(`
          UPDATE channels
          SET latest_upload_at = (
            SELECT MAX(v.published) FROM videos v WHERE v.channel_id = channels.id
          )
          WHERE latest_upload_at IS NULL
        `);
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_channels_smart_refresh ON channels(last_refreshed_at, latest_upload_at)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_videos_pending_shorts ON videos(short_status, short_last_checked_at)");
      },
      () => this.db.exec(`
        CREATE TABLE IF NOT EXISTS api_usage (
          quota_day TEXT NOT NULL, bucket TEXT NOT NULL, endpoint TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0, units INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (quota_day, bucket, endpoint)
        );
        CREATE TABLE IF NOT EXISTS refresh_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL,
          finished_at TEXT, trigger TEXT NOT NULL, mode TEXT NOT NULL,
          scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
          requested_channels INTEGER NOT NULL DEFAULT 0,
          checked INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
          updated INTEGER NOT NULL DEFAULT 0, new_videos INTEGER NOT NULL DEFAULT 0,
          new_shorts INTEGER NOT NULL DEFAULT 0,
          classification_unknown INTEGER NOT NULL DEFAULT 0,
          errors INTEGER NOT NULL DEFAULT 0, api_calls INTEGER NOT NULL DEFAULT 0,
          api_units INTEGER NOT NULL DEFAULT 0, api_by_endpoint TEXT NOT NULL DEFAULT '{}',
          rss_requests INTEGER NOT NULL DEFAULT 0, shorts_probes INTEGER NOT NULL DEFAULT 0,
          daily_remaining INTEGER, error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_refresh_runs_started ON refresh_runs(started_at DESC);
      `),
      () => {},
      () => {
        addColumn("channels", "last_refresh_attempt_at", "TEXT");
        addColumn("channels", "consecutive_failures", "INTEGER NOT NULL DEFAULT 0");
        addColumn("videos", "pending_highlight_reason", "TEXT");
        addColumn("refresh_runs", "pending_unknown_total", "INTEGER NOT NULL DEFAULT 0");
        addColumn("refresh_runs", "pending_unknown_due", "INTEGER NOT NULL DEFAULT 0");
        addColumn("refresh_runs", "pending_reclassified", "INTEGER NOT NULL DEFAULT 0");
        // Existing versions used last_refreshed_at for attempts. Preserve it
        // as the best-known success and seed the attempt timestamp from it.
        this.db.exec(`
          UPDATE channels SET last_refresh_attempt_at = last_refreshed_at
          WHERE last_refresh_attempt_at IS NULL AND last_refreshed_at IS NOT NULL
        `);
      },
      () => {
        addColumn("channels", "last_refresh_had_upload", "INTEGER NOT NULL DEFAULT 0");
        // Preserve the meaning of the most recent completed refresh when
        // upgrading: a video first stored within ten minutes of that
        // channel's success timestamp was discovered by that refresh.
        this.db.exec(`
          UPDATE channels
          SET last_refresh_had_upload = 1
          WHERE last_refreshed_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM videos v
              WHERE v.channel_id = channels.id
                AND ABS(julianday(v.created_at) - julianday(channels.last_refreshed_at)) <= (10.0 / 1440.0)
            )
        `);
      },
      () => {
        addColumn("refresh_runs", "requested_mode", "TEXT");
        addColumn("refresh_runs", "effective_mode", "TEXT");
        addColumn("refresh_runs", "rss_fallbacks", "INTEGER NOT NULL DEFAULT 0");
        addColumn("refresh_runs", "fallback_reason", "TEXT");
        this.db.exec(`
          UPDATE refresh_runs
          SET requested_mode = COALESCE(requested_mode, mode),
              effective_mode = COALESCE(effective_mode, mode)
        `);
      },
      () => this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `),
      () => {
        addColumn("video_state", "highlight_acknowledged_at", "TEXT");
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_video_state_highlight_ack
          ON video_state(highlight_acknowledged_at);
          DELETE FROM video_state
          WHERE NOT EXISTS (
            SELECT 1 FROM videos WHERE videos.video_id = video_state.video_id
          )
        `);
      },
    ];
    let version = this.db.pragma("user_version", { simple: true });
    if (version > migrations.length) throw new Error(`Database schema ${version} is newer than this app supports`);
    while (version < migrations.length) {
      const next = version + 1;
      this.db.transaction(() => {
        migrations[version]();
        this.db.pragma(`user_version = ${next}`);
      })();
      version = next;
    }
  }

  _initializeFts() {
    this.ftsAvailable = false;
    try {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
            title, description, content='videos', content_rowid='rowid'
          );
          CREATE TRIGGER IF NOT EXISTS videos_fts_ai AFTER INSERT ON videos BEGIN
            INSERT INTO videos_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
          END;
          CREATE TRIGGER IF NOT EXISTS videos_fts_ad AFTER DELETE ON videos BEGIN
            INSERT INTO videos_fts(videos_fts, rowid, title, description)
            VALUES ('delete', old.rowid, old.title, old.description);
          END;
          CREATE TRIGGER IF NOT EXISTS videos_fts_au AFTER UPDATE OF title, description ON videos BEGIN
            INSERT INTO videos_fts(videos_fts, rowid, title, description)
            VALUES ('delete', old.rowid, old.title, old.description);
            INSERT INTO videos_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
          END;
        `);
        // External-content row counts do not prove that the private index is
        // populated. Rebuild inside the same transaction as trigger setup so
        // interruption cannot leave partial FTS artifacts.
        this.db.prepare("INSERT INTO videos_fts(videos_fts) VALUES ('rebuild')").run();
      })();
      this.ftsAvailable = true;
    } catch (err) {
      console.warn(`[db] FTS5 unavailable; falling back to LIKE search: ${err.message}`);
    }
  }

  _prepare() {
    this.stmts = {
      upsertChannel: this.db.prepare(`
        INSERT INTO channels (id, title) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
          WHERE channels.title != excluded.title
      `),
      getChannelMeta: this.db.prepare(`
        SELECT id, title, last_checked_at, last_etag, last_modified, favorite,
               last_refresh_status, last_error, last_success_at,
               last_refreshed_at, last_refresh_attempt_at, latest_upload_at,
               last_refresh_had_upload, consecutive_failures
        FROM channels WHERE id = ?
      `),
      updateChannelMeta: this.db.prepare(`
        UPDATE channels
        SET last_checked_at = ?, last_etag = ?, last_modified = ?
        WHERE id = ?
      `),
      setChannelFavorite: this.db.prepare(`
        UPDATE channels SET favorite = ? WHERE id = ?
      `),
      setVideoState: this.db.prepare(`
        INSERT INTO video_state
          (video_id, watched_at, starred_at, hidden_at,
           highlight_acknowledged_at, updated_at)
        VALUES
          (@video_id, @watched_at, @starred_at, @hidden_at,
           @highlight_acknowledged_at, @updated_at)
        ON CONFLICT(video_id) DO UPDATE SET
          watched_at = excluded.watched_at,
          starred_at = excluded.starred_at,
          hidden_at = excluded.hidden_at,
          highlight_acknowledged_at = excluded.highlight_acknowledged_at,
          updated_at = excluded.updated_at
      `),
      getVideoState: this.db.prepare(`
        SELECT watched_at, starred_at, hidden_at, highlight_acknowledged_at
        FROM video_state WHERE video_id = ?
      `),
      acknowledgeHighlight: this.db.prepare(`
        INSERT INTO video_state
          (video_id, highlight_acknowledged_at, updated_at)
        SELECT video_id, ?, ? FROM videos
        WHERE video_id = ? AND highlight_reason IS NOT NULL
        ON CONFLICT(video_id) DO UPDATE SET
          highlight_acknowledged_at = excluded.highlight_acknowledged_at,
          updated_at = excluded.updated_at
        WHERE video_state.highlight_acknowledged_at IS NULL
      `),
      insertVideo: this.db.prepare(`
        INSERT INTO videos
          (video_id, channel_id, title, description, thumbnail,
           published, is_short, short_status, highlight_reason,
           pending_highlight_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          thumbnail = excluded.thumbnail,
          is_short = CASE
            WHEN videos.short_status = 'unknown' AND excluded.short_status != 'unknown'
              THEN excluded.is_short
            ELSE videos.is_short
          END,
          short_status = CASE
            WHEN videos.short_status = 'unknown' AND excluded.short_status != 'unknown'
              THEN excluded.short_status
            ELSE videos.short_status
          END,
          highlight_reason = COALESCE(videos.highlight_reason, excluded.highlight_reason),
          pending_highlight_reason = COALESCE(videos.pending_highlight_reason, excluded.pending_highlight_reason)
      `),
      getVideoClassification: this.db.prepare(`
        SELECT short_status, short_check_attempts, short_last_checked_at,
               pending_highlight_reason FROM videos WHERE video_id = ?
      `),
      listPendingShorts: this.db.prepare(`
        SELECT video_id, channel_id, title, description, thumbnail, published,
               short_check_attempts, short_last_checked_at
        FROM videos
        WHERE short_status = 'unknown'
          AND (
            short_last_checked_at IS NULL OR
            datetime(short_last_checked_at, '+' || MIN(1440, 5 * (1 << MIN(short_check_attempts, 8))) || ' minutes') <= datetime(?)
          )
        ORDER BY COALESCE(short_last_checked_at, '') ASC, published DESC
        LIMIT ?
      `),
      recordVideoClassification: this.db.prepare(`
        UPDATE videos
        SET short_status = CASE WHEN ? IN ('short', 'long') THEN ? ELSE short_status END,
            is_short = CASE WHEN ? = 'short' THEN 1 WHEN ? = 'long' THEN 0 ELSE is_short END,
            highlight_reason = CASE
              WHEN ? = 'long' THEN COALESCE(highlight_reason, pending_highlight_reason)
              ELSE highlight_reason END,
            pending_highlight_reason = CASE
              WHEN ? IN ('short', 'long') THEN NULL ELSE pending_highlight_reason END,
            short_check_attempts = short_check_attempts + 1,
            short_last_checked_at = ?
        WHERE video_id = ?
      `),
      listPrunableVideos: this.db.prepare(`
        SELECT video_id FROM videos
        WHERE channel_id = ?
          AND video_id NOT IN (
            SELECT video_id FROM videos
            WHERE channel_id = ? AND short_status != 'short'
            ORDER BY published DESC, video_id DESC LIMIT ?
          )
          AND video_id NOT IN (
            SELECT video_id FROM videos
            WHERE channel_id = ? AND short_status = 'short'
            ORDER BY published DESC, video_id DESC LIMIT ?
          )
      `),
      deleteVideo: this.db.prepare(`DELETE FROM videos WHERE video_id = ?`),
      deleteChannelVideos: this.db.prepare(
        `DELETE FROM videos WHERE channel_id = ?`,
      ),
      deleteChannelVideoState: this.db.prepare(`
        DELETE FROM video_state
        WHERE video_id IN (SELECT video_id FROM videos WHERE channel_id = ?)
      `),
      deleteChannel: this.db.prepare(`DELETE FROM channels WHERE id = ?`),
      deleteVideoState: this.db.prepare(`DELETE FROM video_state WHERE video_id = ?`),
      allChannelIds: this.db.prepare(`SELECT id FROM channels`),
      channelNames: this.db.prepare(`SELECT id, title FROM channels`),
      stats: this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM channels) AS channels,
          video_counts.videos,
          video_counts.total_videos,
          video_counts.shorts,
          video_counts.return_videos,
          video_counts.unknown_videos,
          (SELECT COUNT(*) FROM video_state) AS video_state_rows
        FROM (
          SELECT
            COUNT(*) AS total_videos,
            COUNT(CASE WHEN short_status != 'short' THEN 1 END) AS videos,
            COUNT(CASE WHEN short_status = 'short' THEN 1 END) AS shorts,
            COUNT(CASE WHEN highlight_reason IS NOT NULL THEN 1 END) AS return_videos,
            COUNT(CASE WHEN short_status = 'unknown' THEN 1 END) AS unknown_videos
          FROM videos
        ) AS video_counts
      `),
      getSetting: this.db.prepare(`
        SELECT value_json, updated_at FROM app_settings WHERE key = ?
      `),
      setSetting: this.db.prepare(`
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `),
      deleteSetting: this.db.prepare(`DELETE FROM app_settings WHERE key = ?`),
    };
  }

  // --- channel metadata ---

  upsertChannel(id, title) {
    if (typeof id !== "string" || !/^UC[A-Za-z0-9_-]{22}$/.test(id)) {
      throw new Error("Invalid resolved YouTube channel ID");
    }
    this.stmts.upsertChannel.run(id, title || "Unknown");
  }

  getChannelMeta(id) {
    return this.stmts.getChannelMeta.get(id) || null;
  }

  updateChannelMeta(id, { last_checked_at, last_etag, last_modified }) {
    this.stmts.updateChannelMeta.run(
      last_checked_at ?? null,
      last_etag ?? null,
      last_modified ?? null,
      id,
    );
  }

  recordChannelRefreshAttempt(id, at = new Date().toISOString()) {
    this.db.prepare(`
      UPDATE channels
      SET last_refresh_attempt_at = ?, last_checked_at = ?
      WHERE id = ?
    `).run(at, at, id);
  }

  recordChannelRefreshSuccess(id, at = new Date().toISOString(), status = "ok", hadUpload = false) {
    this.db.prepare(`
      UPDATE channels SET last_refreshed_at = ?, last_success_at = ?,
        last_refresh_status = ?, last_error = NULL, consecutive_failures = 0,
        last_refresh_had_upload = ?
      WHERE id = ?
    `).run(at, at, status, hadUpload ? 1 : 0, id);
  }

  recordChannelRefreshFailure(id, error, at = new Date().toISOString()) {
    this.db.prepare(`
      UPDATE channels SET last_refresh_status = 'error', last_error = ?,
        last_refresh_attempt_at = COALESCE(last_refresh_attempt_at, ?),
        consecutive_failures = consecutive_failures + 1
      WHERE id = ?
    `).run(error || "Refresh failed", at, id);
  }

  setLatestUploadAt(id, latestUploadAt) {
    if (!latestUploadAt) return;
    this.db.prepare(`
      UPDATE channels SET latest_upload_at = CASE
        WHEN latest_upload_at IS NULL OR latest_upload_at < ? THEN ?
        ELSE latest_upload_at END
      WHERE id = ?
    `).run(latestUploadAt, latestUploadAt, id);
  }

  listChannelRefreshMeta(ids = null) {
    if (Array.isArray(ids) && !ids.length) return [];
    const params = [];
    const where = Array.isArray(ids)
      ? `WHERE id IN (${ids.map(() => "?").join(",")})`
      : "";
    if (Array.isArray(ids)) params.push(...ids);
    return this.db.prepare(`
      SELECT id, title, last_refreshed_at, last_refresh_attempt_at,
             latest_upload_at, last_refresh_status, last_error,
             last_success_at, last_refresh_had_upload, consecutive_failures
      FROM channels ${where}
    `).all(...params);
  }

  setChannelFavorite(id, favorite) {
    const result = this.stmts.setChannelFavorite.run(favorite ? 1 : 0, id);
    if (!result.changes) throw new Error(`Channel "${id}" not found`);
    return this.getChannelMeta(id);
  }

  setChannelsFavorite(ids, favorite, titles = {}) {
    const unique = [...new Set(ids)];
    const tx = this.db.transaction(() => {
      for (const id of unique) {
        if (!this.stmts.getChannelMeta.get(id)) {
          this.stmts.upsertChannel.run(id, titles[id] || "Unknown");
        }
      }
      for (const id of unique) {
        this.stmts.setChannelFavorite.run(favorite ? 1 : 0, id);
      }
      return unique.map((id) => this.getChannelMeta(id));
    });
    return tx();
  }

  updateChannelHealth(id, { status, error = null, checkedAt, successAt } = {}) {
    const fields = [];
    const params = [];
    if (status !== undefined) { fields.push("last_refresh_status = ?"); params.push(status); }
    if (error !== undefined) { fields.push("last_error = ?"); params.push(error); }
    if (checkedAt !== undefined) { fields.push("last_checked_at = ?"); params.push(checkedAt); }
    if (successAt !== undefined) { fields.push("last_success_at = ?"); params.push(successAt); }
    if (!fields.length) return;
    params.push(id);
    this.db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  }

  listChannelHealth({ status, favorite, staleBefore } = {}) {
    const wheres = [];
    const params = [];
    if (status === "error") wheres.push("last_refresh_status = 'error'");
    if (status === "stale") {
      wheres.push("(last_checked_at IS NULL OR last_checked_at < ?)");
      params.push(staleBefore || new Date(Date.now() - 24 * 3600_000).toISOString());
    }
    if (favorite === true) wheres.push("favorite = 1");
    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT id, title, favorite, last_checked_at, last_success_at,
             last_refresh_status, last_error, last_refreshed_at,
             last_refresh_attempt_at, latest_upload_at, consecutive_failures
      FROM channels ${where}
      ORDER BY favorite DESC,
               CASE WHEN last_refresh_status = 'error' THEN 0 ELSE 1 END,
               COALESCE(last_checked_at, '') ASC, title COLLATE NOCASE
    `).all(...params).map((row) => ({ ...row, favorite: !!row.favorite }));
  }

  setVideoState(videoId, changes) {
    const video = this.db.prepare("SELECT 1 FROM videos WHERE video_id = ?").get(videoId);
    if (!video) throw new Error(`Video "${videoId}" not found`);
    const current = this.stmts.getVideoState.get(videoId) || {};
    const now = new Date().toISOString();
    const valueFor = (key) => {
      if (!(key in changes)) return current[key] || null;
      return changes[key] ? now : null;
    };
    const state = {
      video_id: videoId,
      watched_at: valueFor("watched_at"),
      starred_at: valueFor("starred_at"),
      hidden_at: valueFor("hidden_at"),
      highlight_acknowledged_at: current.highlight_acknowledged_at || null,
      updated_at: now,
    };
    this.stmts.setVideoState.run(state);
    return {
      watched: !!state.watched_at,
      starred: !!state.starred_at,
      hidden: !!state.hidden_at,
      ...state,
    };
  }

  acknowledgeHighlights(videoIds, at = new Date().toISOString()) {
    if (!Array.isArray(videoIds) || videoIds.length < 1 || videoIds.length > 5000) {
      throw new Error("videoIds must contain 1 to 5000 IDs");
    }
    if (videoIds.some((id) => typeof id !== "string" || !id || id.length > 128)) {
      throw new Error("videoIds must contain valid strings");
    }
    const ids = [...new Set(videoIds)];
    const tx = this.db.transaction(() => {
      let acknowledged = 0;
      for (const id of ids) {
        acknowledged += this.stmts.acknowledgeHighlight.run(at, at, id).changes;
      }
      return acknowledged;
    });
    return tx();
  }

  hasVideo(videoId) {
    return !!this.stmts.getVideoClassification.get(videoId);
  }

  getVideoClassification(videoId) {
    return this.stmts.getVideoClassification.get(videoId)?.short_status || null;
  }

  getVideoClassificationMeta(videoId) {
    return this.stmts.getVideoClassification.get(videoId) || null;
  }

  isVideoClassificationDue(videoId, now = new Date()) {
    const meta = this.getVideoClassificationMeta(videoId);
    if (!meta) return true;
    if (meta.short_status !== "unknown") return false;
    if (!meta.short_last_checked_at) return true;
    const attempts = Math.min(Math.max(Number(meta.short_check_attempts) || 0, 0), 8);
    const delayMinutes = Math.min(1440, 5 * (2 ** attempts));
    return new Date(now).getTime() >=
      new Date(meta.short_last_checked_at).getTime() + delayMinutes * 60_000;
  }

  listPendingShorts(limit = 50, now = new Date().toISOString()) {
    return this.stmts.listPendingShorts.all(now, Math.min(Math.max(Number(limit) || 50, 1), 500));
  }

  recordVideoClassification(videoId, status, at = new Date().toISOString()) {
    this.stmts.recordVideoClassification.run(
      status, status, status, status, status, status, at, videoId,
    );
  }

  countUnknownShorts() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM videos WHERE short_status = 'unknown'").get().count;
  }

  // videos: [{ video_id, channel_id, title, description, thumbnail,
  //            published, short_status }]
  upsertVideos(videos) {
    const now = new Date().toISOString();
    const tx = this.db.transaction((rows) => {
      for (const v of rows) {
        const status = ["unknown", "short", "long"].includes(v.short_status)
          ? v.short_status
          : v.is_short === true || v.is_short === 1
            ? "short"
            : "long";
        this.stmts.insertVideo.run(
          v.video_id,
          v.channel_id,
          v.title,
          v.description || "",
          v.thumbnail || "",
          v.published,
          status === "short" ? 1 : 0,
          status,
          v.highlight_reason || null,
          v.pending_highlight_reason || null,
          now,
        );
      }
    });
    tx(videos);
  }

  pruneChannel(channelId, keep = 50) {
    // Keep the requested number of visible videos independently from a
    // bounded cache of known Shorts. Unknown rows remain visible and are
    // retried by the refresh pipeline until classification succeeds.
    const tx = this.db.transaction(() => {
      const rows = this.stmts.listPrunableVideos.all(
        channelId, channelId, keep, channelId, keep,
      );
      for (const row of rows) {
        this.stmts.deleteVideoState.run(row.video_id);
        this.stmts.deleteVideo.run(row.video_id);
      }
    });
    tx();
  }

  // --- reads ---

  // Unified video query with optional channel scope, single-channel filter,
  // full-text-ish search, composite keyset pagination (before + before_id
  // for the next page — both needed so ties on `published` don't skip
  // rows), and a hard limit.
  _videoWhere({ channelIds, channelId, q, before, beforeId, beforeFavorite,
    beforeReturning, view, favorites, sort } = {}, { pagination = true } = {}) {
    const wheres = ["v.short_status != 'short'"];
    const params = [];

    if (Array.isArray(channelIds) && channelIds.length) {
      wheres.push(`v.channel_id IN (${channelIds.map(() => "?").join(",")})`);
      params.push(...channelIds);
    }
    if (channelId) {
      wheres.push("v.channel_id = ?");
      params.push(channelId);
    }
    if (q && q.trim()) {
      const query = q.trim();
      const like = `%${query}%`;
      if (this.ftsAvailable) {
        const fts = query.split(/\s+/).filter(Boolean)
          .map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
        wheres.push("(v.rowid IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH ?) OR c.title LIKE ?)");
        params.push(fts, like);
      } else {
        wheres.push("(v.title LIKE ? OR v.description LIKE ? OR c.title LIKE ?)");
        params.push(like, like, like);
      }
    }
    if (view === "returns") {
      wheres.push(UNACKNOWLEDGED_RETURN_SQL);
      wheres.push("s.hidden_at IS NULL");
    } else if (view === "unread") wheres.push("s.watched_at IS NULL AND s.hidden_at IS NULL");
    else if (view === "starred") wheres.push("s.starred_at IS NOT NULL AND s.hidden_at IS NULL");
    else if (view === "hidden") wheres.push("s.hidden_at IS NOT NULL");
    else wheres.push("s.hidden_at IS NULL");
    if (favorites) wheres.push("c.favorite = 1");
    if (pagination && before && beforeId && sort === "favorite") {
      const op = sort === "oldest" ? ">" : "<";
      wheres.push(`(c.favorite < ? OR (c.favorite = ? AND (v.published ${op} ? OR (v.published = ? AND v.video_id ${op} ?))))`);
      params.push(beforeFavorite ? 1 : 0, beforeFavorite ? 1 : 0, before, before, beforeId);
    } else if (pagination && before && beforeId && sort === "returning") {
      const returning = beforeReturning ? 1 : 0;
      wheres.push(`(${UNACKNOWLEDGED_RETURN_SQL} < ? OR
        (${UNACKNOWLEDGED_RETURN_SQL} = ? AND
          (v.published < ? OR (v.published = ? AND v.video_id < ?))))`);
      params.push(returning, returning, before, before, beforeId);
    } else if (pagination && before && beforeId) {
      // Tiebreak on video_id when multiple rows share `published`.
      const op = sort === "oldest" ? ">" : "<";
      wheres.push(`(v.published ${op} ? OR (v.published = ? AND v.video_id ${op} ?))`);
      params.push(before, before, beforeId);
    } else if (pagination && before) {
      wheres.push(`v.published ${sort === "oldest" ? ">" : "<"} ?`);
      params.push(before);
    }
    return { wheres, params };
  }

  queryVideos(options = {}) {
    const { limit, favorites, sort } = options;
    const { wheres, params } = this._videoWhere(options);

    const capped = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);

    const sql =
      `SELECT v.video_id, v.channel_id, v.title, v.description,
              v.thumbnail, v.published,
              CASE WHEN ${UNACKNOWLEDGED_RETURN_SQL}
                THEN v.highlight_reason ELSE NULL END AS highlight_reason,
              v.highlight_reason AS highlight_history_reason,
              c.title AS channel, c.favorite AS channel_favorite,
              s.watched_at, s.starred_at, s.hidden_at,
              s.highlight_acknowledged_at
       FROM videos v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN video_state s ON s.video_id = v.video_id
       WHERE ${wheres.join(" AND ")}
       ORDER BY ${sort === "returning" ? `${UNACKNOWLEDGED_RETURN_SQL} DESC, ` : ""}
                ${favorites || sort === "favorite" ? "c.favorite DESC, " : ""}
                v.published ${sort === "oldest" ? "ASC" : "DESC"},
                v.video_id ${sort === "oldest" ? "ASC" : "DESC"}
       LIMIT ?`;
    params.push(capped);

    return this.db.prepare(sql).all(...params).map(shape);
  }

  listUnacknowledgedReturns(options = {}) {
    const { wheres, params } = this._videoWhere(
      { ...options, view: "returns" },
      { pagination: false },
    );
    const joins = `FROM videos v
      LEFT JOIN channels c ON c.id = v.channel_id
      LEFT JOIN video_state s ON s.video_id = v.video_id`;
    const count = this.db.prepare(`
      SELECT COUNT(*) AS count ${joins} WHERE ${wheres.join(" AND ")}
    `).get(...params).count;
    const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 5000);
    const direction = options.sort === "oldest" ? "ASC" : "DESC";
    const leadingOrder = options.sort === "favorite" ? "c.favorite DESC, " : "";
    const videoIds = this.db.prepare(`
      SELECT v.video_id ${joins}
      WHERE ${wheres.join(" AND ")}
      ORDER BY ${leadingOrder}v.published ${direction}, v.video_id ${direction}
      LIMIT ?
    `).all(...params, limit).map((row) => row.video_id);
    return { count, videoIds };
  }

  getUnreadCounts() {
    const rows = this.db.prepare(`
      SELECT v.channel_id, COUNT(*) AS unread
      FROM videos v
      LEFT JOIN video_state s ON s.video_id = v.video_id
      WHERE v.short_status != 'short'
        AND s.watched_at IS NULL
        AND s.hidden_at IS NULL
      GROUP BY v.channel_id
    `).all();
    const out = Object.create(null);
    for (const row of rows) out[row.channel_id] = row.unread;
    return out;
  }

  getChannelNames() {
    const out = Object.create(null);
    for (const row of this.stmts.channelNames.all()) {
      out[row.id] = row.title;
    }
    return out;
  }

  getStats() {
    const s = this.stmts.stats.get();
    return { channelCount: s.channels, videoCount: s.videos };
  }

  getSystemStats() {
    const s = this.stmts.stats.get();
    return {
      channelCount: s.channels,
      visibleVideoCount: s.videos,
      totalVideoCount: s.total_videos,
      shortCount: s.shorts,
      returnVideoCount: s.return_videos,
      unknownVideoCount: s.unknown_videos,
      videoStateCount: s.video_state_rows,
    };
  }

  getSetting(key) {
    const row = this.stmts.getSetting.get(key);
    if (!row) return null;
    return JSON.parse(row.value_json);
  }

  setSetting(key, value, at = new Date().toISOString()) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error(`Setting "${key}" is not JSON serializable`);
    this.stmts.setSetting.run(key, encoded, at);
    return value;
  }

  deleteSetting(key) {
    return this.stmts.deleteSetting.run(key).changes > 0;
  }

  reserveApiUsage({ day, bucket, endpoint, units = 1, limit }) {
    const tx = this.db.transaction(() => {
      const used = this.db.prepare(
        "SELECT COALESCE(SUM(units), 0) AS used FROM api_usage WHERE quota_day = ? AND bucket = ?",
      ).get(day, bucket).used;
      if (used + units > limit) {
        const err = new Error(`YouTube ${bucket} quota budget exhausted (${used}/${limit} used)`);
        err.code = "quotaBudgetExceeded";
        err.bucket = bucket;
        err.used = used;
        err.limit = limit;
        throw err;
      }
      this.db.prepare(`
        INSERT INTO api_usage (quota_day, bucket, endpoint, calls, units)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(quota_day, bucket, endpoint) DO UPDATE SET
          calls = calls + 1, units = units + excluded.units
      `).run(day, bucket, endpoint, units);
    });
    tx();
  }

  getApiUsage(day) {
    return this.db.prepare(`
      SELECT quota_day, bucket, endpoint, calls, units
      FROM api_usage WHERE quota_day = ? ORDER BY bucket, endpoint
    `).all(day);
  }

  getApiUsageRange(startDay, endDay) {
    return this.db.prepare(`
      SELECT quota_day, bucket, endpoint, calls, units
      FROM api_usage
      WHERE quota_day >= ? AND quota_day <= ?
      ORDER BY quota_day, bucket, endpoint
    `).all(startDay, endDay);
  }

  startRefreshRun(metrics) {
    const result = this.db.prepare(`
      INSERT INTO refresh_runs
        (started_at, trigger, mode, requested_mode, effective_mode,
         rss_fallbacks, fallback_reason, scope, requested_channels)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      metrics.started_at,
      metrics.trigger,
      metrics.mode,
      metrics.requested_mode || metrics.mode,
      metrics.effective_mode || metrics.mode,
      metrics.rss_fallbacks || 0,
      metrics.fallback_reason || null,
      metrics.scope,
      metrics.requested_channels,
    );
    return Number(result.lastInsertRowid);
  }

  finishRefreshRun(id, summary, metrics, { status = "complete", error = null, dailyRemaining = null } = {}) {
    this.db.prepare(`
      UPDATE refresh_runs SET
        finished_at = ?, status = ?, checked = ?, skipped = ?, updated = ?,
        new_videos = ?, new_shorts = ?, classification_unknown = ?, errors = ?,
        api_calls = ?, api_units = ?, api_by_endpoint = ?, rss_requests = ?,
        shorts_probes = ?, daily_remaining = ?, pending_unknown_total = ?,
        pending_unknown_due = ?, pending_reclassified = ?, requested_mode = ?,
        effective_mode = ?, rss_fallbacks = ?, fallback_reason = ?, error = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(), status, summary.checked || 0, summary.skipped || 0,
      summary.updated || 0, summary.new_videos || 0, summary.new_shorts || 0,
      summary.classification_unknown || 0, summary.errors || 0,
      metrics.api_calls || 0, metrics.api_units || 0,
      JSON.stringify(metrics.api_by_endpoint || {}), metrics.rss_requests || 0,
      metrics.shorts_probes || 0, dailyRemaining,
      summary.pending_unknown_total || 0, summary.pending_unknown_due || 0,
      summary.pending_reclassified || 0,
      metrics.requested_mode || metrics.mode,
      metrics.effective_mode || metrics.mode,
      metrics.rss_fallbacks || 0,
      metrics.fallback_reason || null,
      error, id,
    );
    this.pruneRefreshRuns();
  }

  pruneRefreshRuns(limit = 2_000) {
    const bounded = Math.min(Math.max(Number(limit) || 2_000, 1), 100_000);
    return this.db.prepare(`
      DELETE FROM refresh_runs
      WHERE id NOT IN (SELECT id FROM refresh_runs ORDER BY id DESC LIMIT ?)
    `).run(bounded).changes;
  }

  markAbandonedRefreshRuns(at = new Date().toISOString()) {
    return this.db.prepare(`
      UPDATE refresh_runs SET status = 'abandoned', finished_at = ?,
        error = COALESCE(error, 'Application stopped before refresh completed')
      WHERE status = 'running'
    `).run(at).changes;
  }

  listRefreshRuns(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM refresh_runs ORDER BY id DESC LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 20, 1), 100)).map((row) => ({
      ...row,
      api_by_endpoint: (() => { try { return JSON.parse(row.api_by_endpoint); } catch { return {}; } })(),
    }));
  }

  quickCheck() {
    return this.db.pragma("quick_check", { simple: true });
  }

  getStorageStats() {
    const size = (file) => {
      try { return fs.statSync(file).size; } catch { return 0; }
    };
    const databaseBytes = size(this.dbFile);
    const walBytes = size(`${this.dbFile}-wal`);
    const shmBytes = size(`${this.dbFile}-shm`);
    return {
      databaseBytes,
      walBytes,
      shmBytes,
      totalBytes: databaseBytes + walBytes + shmBytes,
      journalMode: this.db.pragma("journal_mode", { simple: true }),
    };
  }

  // Remove a single channel and its videos.
  removeChannel(channelId) {
    const tx = this.db.transaction(() => {
      this.stmts.deleteChannelVideoState.run(channelId);
      this.stmts.deleteChannelVideos.run(channelId);
      this.stmts.deleteChannel.run(channelId);
    });
    tx();
  }

  removeChannels(channelIds) {
    const unique = [...new Set(channelIds)];
    const tx = this.db.transaction(() => {
      for (const id of unique) {
        this.stmts.deleteChannelVideoState.run(id);
        this.stmts.deleteChannelVideos.run(id);
        this.stmts.deleteChannel.run(id);
      }
    });
    tx();
    return unique.length;
  }

  // Delete every channel (and its videos) whose id isn't in the given
  // referenced set. Called after a folder/channel deletion in tube.json
  // so the DB doesn't accumulate rows for subscriptions that no longer
  // exist anywhere in the folder tree. Returns the number purged.
  purgeOrphanChannels(referencedIds) {
    const rows = this.stmts.allChannelIds.all();
    const stale = rows.filter((r) => !referencedIds.has(r.id)).map((r) => r.id);
    if (!stale.length) return 0;
    const tx = this.db.transaction(() => {
      for (const id of stale) {
        this.stmts.deleteChannelVideoState.run(id);
        this.stmts.deleteChannelVideos.run(id);
        this.stmts.deleteChannel.run(id);
      }
    });
    tx();
    return stale.length;
  }

  // --- backup ---

  vacuumInto(destPath) {
    // Clean up any stale destination first — VACUUM INTO refuses to overwrite.
    try {
      fs.rmSync(destPath, { force: true });
    } catch {}
    this.db.prepare(`VACUUM INTO ?`).run(destPath);
  }

  close() {
    this.db.close();
  }
}

function shape(row) {
  return {
    video_id: row.video_id,
    title: row.title,
    description: row.description,
    url: `https://www.youtube.com/watch?v=${row.video_id}`,
    thumbnail:
      row.thumbnail ||
      `https://i.ytimg.com/vi/${row.video_id}/mqdefault.jpg`,
    channel: row.channel || "Unknown",
    channel_id: row.channel_id,
    published: row.published,
    watched: !!row.watched_at,
    starred: !!row.starred_at,
    hidden: !!row.hidden_at,
    channel_favorite: !!row.channel_favorite,
    highlight_reason: row.highlight_reason || null,
    highlight_history_reason: row.highlight_history_reason || null,
    highlight_acknowledged_at: row.highlight_acknowledged_at || null,
  };
}

module.exports = Db;
