const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  next();
}

function normalizeOrigin(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function corsOriginPolicy(allowedOrigins = [], publicOrigin = null) {
  const configured = new Set(allowedOrigins.map(normalizeOrigin).filter(Boolean));
  const publicAppOrigin = normalizeOrigin(publicOrigin);
  return function originPolicy(req, res, next) {
    const origin = req.get("origin");
    // Non-browser clients do not normally send Origin. Authentication is
    // intentionally left to the deployment/reverse proxy.
    if (!origin) return next();
    const normalized = normalizeOrigin(origin);
    // Express's req.host and req.protocol honor X-Forwarded-Host/Proto only
    // when the connecting proxy is trusted, preserving the external port.
    const requestHost = req.host;
    const requestOrigin = requestHost
      ? normalizeOrigin(`${req.protocol}://${requestHost}`)
      : null;
    const sameOrigin = normalized && normalized === requestOrigin;
    const allowed =
      normalized &&
      (sameOrigin || normalized === publicAppOrigin || configured.has(normalized));
    if (!allowed) {
      if (MUTATION_METHODS.has(req.method) || req.method === "OPTIONS") {
        return res.status(403).json({ error: "Cross-origin request blocked" });
      }
      return next();
    }

    res.vary("Origin");
    res.setHeader("Access-Control-Allow-Origin", normalized);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Disposition, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset",
    );
    if (req.method === "OPTIONS") {
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        req.get("access-control-request-headers") || "Content-Type, Authorization",
      );
      res.setHeader("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }
    return next();
  };
}

function rateLimit({ windowMs, max, name }) {
  const buckets = new Map();
  let calls = 0;
  return function limit(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: `Too many ${name} requests` });
    }

    // Opportunistic cleanup avoids an unbounded map without another timer.
    calls++;
    if (calls % 500 === 0) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    next();
  };
}

function postOnly(middleware) {
  return function postOnlyMiddleware(req, res, next) {
    if (req.method !== "POST") return next();
    return middleware(req, res, next);
  };
}

module.exports = {
  securityHeaders,
  corsOriginPolicy,
  rateLimit,
  postOnly,
  normalizeOrigin,
};
