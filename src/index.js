/**
 * my-site Worker — Spotify pipeline backbone
 * ------------------------------------------
 * Routes (everything else falls through to static assets):
 *   GET /api/health            sanity check: config + token + last sync status
 *   GET /api/login?key=...     one-time Spotify OAuth kickoff (guarded by SETUP_KEY)
 *   GET /api/callback          OAuth redirect target; stores refresh token in KV
 *   GET /api/sync?key=...      manual sync trigger for testing (guarded)
 *   GET /api/music             public: cached recent tracks for the site to render
 *
 * Cron (every 30 min): pulls recently-played from Spotify, stores a snapshot
 * for /api/music, and appends into per-day play logs (spotify:log:YYYY-MM-DD)
 * that the mood summarizer will read later.
 *
 * KV keys:
 *   spotify:refresh_token   long-lived token (from one-time OAuth)
 *   spotify:oauth_state     CSRF state during login flow (60s TTL)
 *   spotify:recent          {updatedAt, tracks:[...]} snapshot for the site
 *   spotify:log:YYYY-MM-DD  deduped play log per NY-time day (mood pipeline fuel)
 *
 * Secrets (dashboard): SPOTIFY_CLIENT_SECRET, SETUP_KEY
 * Vars (wrangler.jsonc): SPOTIFY_CLIENT_ID, SITE_ORIGIN
 */

const SPOTIFY_SCOPES = "user-read-recently-played user-read-currently-playing user-top-read";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/api/health":   return health(env);
        case "/api/login":    return login(url, env);
        case "/api/callback": return callback(url, env);
        case "/api/sync":     return manualSync(url, env);
        case "/api/music":    return music(env);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      console.error("api error", url.pathname, err);
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncSpotify(env));
  },
};

/* ---------------- routes ---------------- */

async function health(env) {
  const [token, recent] = await Promise.all([
    env.SITE_DATA.get("spotify:refresh_token"),
    env.SITE_DATA.get("spotify:recent", "json"),
  ]);
  return json({
    ok: true,
    configured: Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
    spotifyLinked: Boolean(token),
    lastSync: recent?.updatedAt ?? null,
    trackCount: recent?.tracks?.length ?? 0,
  });
}

async function login(url, env) {
  const guard = requireKey(url, env);
  if (guard) return guard;

  const state = crypto.randomUUID();
  await env.SITE_DATA.put("spotify:oauth_state", state, { expirationTtl: 300 });

  const auth = new URL("https://accounts.spotify.com/authorize");
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", env.SPOTIFY_CLIENT_ID);
  auth.searchParams.set("scope", SPOTIFY_SCOPES);
  auth.searchParams.set("redirect_uri", `${env.SITE_ORIGIN}/api/callback`);
  auth.searchParams.set("state", state);
  return Response.redirect(auth.toString(), 302);
}

async function callback(url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = await env.SITE_DATA.get("spotify:oauth_state");

  if (!code || !state || state !== saved) {
    return json({ error: "bad or expired oauth state — start again at /api/login" }, 400);
  }
  await env.SITE_DATA.delete("spotify:oauth_state");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${env.SITE_ORIGIN}/api/callback`,
    }),
  });
  if (!res.ok) {
    console.error("token exchange failed", res.status, await res.text());
    return json({ error: "token exchange failed" }, 502);
  }
  const tokens = await res.json();
  if (!tokens.refresh_token) return json({ error: "no refresh token returned" }, 502);

  await env.SITE_DATA.put("spotify:refresh_token", tokens.refresh_token);
  await syncSpotify(env); // first pull immediately so /api/music has data

  return new Response(
    "<body style='font-family:monospace;padding:40px'>spotify linked. first sync done. " +
    "check <a href='/api/music'>/api/music</a> — you can close this tab.</body>",
    { headers: { "Content-Type": "text/html" } },
  );
}

async function manualSync(url, env) {
  const guard = requireKey(url, env);
  if (guard) return guard;
  const result = await syncSpotify(env);
  return json(result);
}

async function music(env) {
  const recent = await env.SITE_DATA.get("spotify:recent", "json");
  if (!recent) return json({ error: "no data yet" }, 404);
  return json(recent, 200, {
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
  });
}

/* ---------------- sync engine ---------------- */

async function syncSpotify(env) {
  const refreshToken = await env.SITE_DATA.get("spotify:refresh_token");
  if (!refreshToken) return { ok: false, reason: "not linked yet — visit /api/login" };

  // Refresh token -> short-lived access token (simple: fresh one per sync)
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!tokenRes.ok) {
    console.error("token refresh failed", tokenRes.status, await tokenRes.text());
    return { ok: false, reason: "token refresh failed" };
  }
  const tokenData = await tokenRes.json();
  // Spotify sometimes rotates refresh tokens — keep the newest
  if (tokenData.refresh_token) {
    await env.SITE_DATA.put("spotify:refresh_token", tokenData.refresh_token);
  }

  const playedRes = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=50", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!playedRes.ok) {
    console.error("recently-played failed", playedRes.status, await playedRes.text());
    return { ok: false, reason: "spotify api error" };
  }
  const played = await playedRes.json();

  const tracks = (played.items ?? []).map((item) => ({
    playedAt: item.played_at,
    id: item.track?.id ?? null,
    name: item.track?.name ?? "unknown",
    artists: (item.track?.artists ?? []).map((a) => a.name),
    album: item.track?.album?.name ?? null,
    image: item.track?.album?.images?.slice(-1)[0]?.url ?? null, // smallest
    url: item.track?.external_urls?.spotify ?? null,
    durationMs: item.track?.duration_ms ?? null,
  }));

  const updatedAt = new Date().toISOString();

  // 1) Snapshot for the site
  await env.SITE_DATA.put("spotify:recent", JSON.stringify({ updatedAt, tracks }));

  // 2) Accumulate per-day logs (NY time) for the mood summarizer.
  //    Deduped by playedAt; kept 30 days.
  const byDay = new Map();
  for (const t of tracks) {
    const day = nyDate(t.playedAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }
  for (const [day, plays] of byDay) {
    const key = `spotify:log:${day}`;
    const existing = (await env.SITE_DATA.get(key, "json")) ?? [];
    const seen = new Set(existing.map((p) => p.playedAt));
    const merged = existing.concat(plays.filter((p) => !seen.has(p.playedAt)));
    merged.sort((a, b) => a.playedAt.localeCompare(b.playedAt));
    await env.SITE_DATA.put(key, JSON.stringify(merged), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
  }

  return { ok: true, updatedAt, pulled: tracks.length };
}

/* ---------------- helpers ---------------- */

function nyDate(isoString) {
  // YYYY-MM-DD in America/New_York for a given instant
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoString));
}

function requireKey(url, env) {
  if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
