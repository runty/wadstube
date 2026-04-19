const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Unknown',
  last_checked_at TEXT,
  last_etag TEXT,
  last_modified TEXT
);

CREATE TABLE IF NOT EXISTS videos (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  published TEXT NOT NULL,
  is_short INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
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
    this._prepare();
  }

  _prepare() {
    this.stmts = {
      upsertChannel: this.db.prepare(`
        INSERT INTO channels (id, title) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title
          WHERE channels.title != excluded.title
      `),
      getChannelMeta: this.db.prepare(`
        SELECT id, title, last_checked_at, last_etag, last_modified
        FROM channels WHERE id = ?
      `),
      updateChannelMeta: this.db.prepare(`
        UPDATE channels
        SET last_checked_at = ?, last_etag = ?, last_modified = ?
        WHERE id = ?
      `),
      insertVideo: this.db.prepare(`
        INSERT INTO videos
          (video_id, channel_id, title, description, thumbnail,
           published, is_short, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          thumbnail = excluded.thumbnail
      `),
      hasVideo: this.db.prepare(`SELECT 1 FROM videos WHERE video_id = ?`),
      pruneChannel: this.db.prepare(`
        DELETE FROM videos
        WHERE channel_id = ?
          AND video_id NOT IN (
            SELECT video_id FROM videos
            WHERE channel_id = ?
            ORDER BY published DESC
            LIMIT ?
          )
      `),
      deleteChannelVideos: this.db.prepare(
        `DELETE FROM videos WHERE channel_id = ?`,
      ),
      deleteChannel: this.db.prepare(`DELETE FROM channels WHERE id = ?`),
      allChannelIds: this.db.prepare(`SELECT id FROM channels`),
      channelNames: this.db.prepare(`SELECT id, title FROM channels`),
      stats: this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM channels) AS channels,
          (SELECT COUNT(*) FROM videos WHERE is_short = 0) AS videos
      `),
    };
  }

  // --- channel metadata ---

  upsertChannel(id, title) {
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

  hasVideo(videoId) {
    return !!this.stmts.hasVideo.get(videoId);
  }

  // videos: [{ video_id, channel_id, title, description, thumbnail,
  //            published, is_short }]
  upsertVideos(videos) {
    const now = new Date().toISOString();
    const tx = this.db.transaction((rows) => {
      for (const v of rows) {
        this.stmts.insertVideo.run(
          v.video_id,
          v.channel_id,
          v.title,
          v.description || "",
          v.thumbnail || "",
          v.published,
          v.is_short ? 1 : 0,
          now,
        );
      }
    });
    tx(videos);
  }

  pruneChannel(channelId, keep = 50) {
    this.stmts.pruneChannel.run(channelId, channelId, keep);
  }

  // --- reads ---

  // Unified video query with optional channel scope, single-channel filter,
  // full-text-ish search, composite keyset pagination (before + before_id
  // for the next page — both needed so ties on `published` don't skip
  // rows), and a hard limit.
  queryVideos({ channelIds, channelId, q, before, beforeId, limit } = {}) {
    const wheres = ["v.is_short = 0"];
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
      const like = `%${q.trim()}%`;
      wheres.push("(v.title LIKE ? OR v.description LIKE ? OR c.title LIKE ?)");
      params.push(like, like, like);
    }
    if (before && beforeId) {
      // Tiebreak on video_id when multiple rows share `published`.
      wheres.push("(v.published < ? OR (v.published = ? AND v.video_id < ?))");
      params.push(before, before, beforeId);
    } else if (before) {
      wheres.push("v.published < ?");
      params.push(before);
    }

    const capped = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);

    const sql =
      `SELECT v.video_id, v.channel_id, v.title, v.description,
              v.thumbnail, v.published, c.title AS channel
       FROM videos v
       LEFT JOIN channels c ON c.id = v.channel_id
       WHERE ${wheres.join(" AND ")}
       ORDER BY v.published DESC, v.video_id DESC
       LIMIT ?`;
    params.push(capped);

    return this.db.prepare(sql).all(...params).map(shape);
  }

  getChannelNames() {
    const out = {};
    for (const row of this.stmts.channelNames.all()) {
      out[row.id] = row.title;
    }
    return out;
  }

  getStats() {
    const s = this.stmts.stats.get();
    return { channelCount: s.channels, videoCount: s.videos };
  }

  // Remove a single channel and its videos.
  removeChannel(channelId) {
    const tx = this.db.transaction(() => {
      this.stmts.deleteChannelVideos.run(channelId);
      this.stmts.deleteChannel.run(channelId);
    });
    tx();
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
  };
}

module.exports = Db;
