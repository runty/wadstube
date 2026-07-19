const express = require("express");
const path = require("path");

function mountFrontend(app, clientDist) {
  app.use(express.static(clientDist, {
    setHeaders(res, filePath) {
      const relative = path.relative(clientDist, filePath);
      if (relative === "index.html") {
        res.setHeader("Cache-Control", "no-store");
      } else if (relative.split(path.sep)[0] === "assets") {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));

  // Hashed bundles disappear on deployment. Never send index.html for a stale
  // asset URL: browsers reject that HTML as a module and leave the SPA blank.
  app.use("/assets", (_req, res) => {
    res.status(404).type("text/plain").send("Asset not found");
  });

  app.get("/{*splat}", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

module.exports = { mountFrontend };
