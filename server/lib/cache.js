const fs = require("fs");
const path = require("path");

class Cache {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.data = { channels: {} };
    this._writing = false;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const raw = fs.readFileSync(this.cacheFile, "utf-8");
        this.data = JSON.parse(raw);
        if (!this.data.channels) this.data.channels = {};
      }
    } catch (err) {
      console.error(`Cache load failed: ${err.message}, starting fresh`);
      this.data = { channels: {} };
    }
  }

  save() {
    const tmpFile = this.cacheFile + ".tmp";
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(this.data), "utf-8");
      fs.renameSync(tmpFile, this.cacheFile);
    } catch (err) {
      console.error(`Cache save failed: ${err.message}`);
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  updateChannels(channelVideos) {
    Object.assign(this.data.channels, channelVideos);
    this.save();
  }

  getVideosForChannels(channelIds) {
    const videos = [];
    const seen = new Set();

    for (const cid of channelIds) {
      const entry = this.data.channels[cid];
      if (!entry || !entry.videos) continue;

      for (const v of entry.videos) {
        if (!seen.has(v.video_id)) {
          seen.add(v.video_id);
          videos.push(v);
        }
      }
    }

    videos.sort((a, b) => new Date(b.published) - new Date(a.published));
    return videos;
  }

  getAllVideos() {
    const videos = [];
    const seen = new Set();

    for (const entry of Object.values(this.data.channels)) {
      if (!entry.videos) continue;
      for (const v of entry.videos) {
        if (!seen.has(v.video_id)) {
          seen.add(v.video_id);
          videos.push(v);
        }
      }
    }

    videos.sort((a, b) => new Date(b.published) - new Date(a.published));
    return videos;
  }

  getStats() {
    const channelCount = Object.keys(this.data.channels).length;
    let videoCount = 0;
    for (const entry of Object.values(this.data.channels)) {
      videoCount += (entry.videos || []).length;
    }
    return { channelCount, videoCount };
  }
}

module.exports = Cache;
