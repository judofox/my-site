/**
 * my-site Worker — Spotify pipeline + mood engine
 * -----------------------------------------------
 * Routes (everything else falls through to static assets):
 *   GET /api/health            sanity check: config + token + last sync status
 *   GET /api/login?key=...     one-time Spotify OAuth kickoff (guarded by SETUP_KEY)
 *   GET /api/callback          OAuth redirect target; stores refresh token in KV
 *   GET /api/sync?key=...      manual Spotify sync trigger (guarded)
 *   GET /api/music             public: cached recent tracks
 *   GET /api/mood              public: cached AI mood read
 *   GET /api/mood/refresh?key= force-regenerate today's mood (guarded)
 *
 * Cron (every 30 min): syncs Spotify; generates the daily mood if missing.
 *
 * KV keys:
 *   spotify:refresh_token / spotify:oauth_state / spotify:recent
 *   spotify:log:YYYY-MM-DD   deduped per-day play log (NY time)
 *   mood:current             {day, generatedAt, mood, emoji, score, blurb, ...}
 *   mood:YYYY-MM-DD          history (90-day TTL) — tamagotchi fuel
 *
 * Secrets (dashboard): SPOTIFY_CLIENT_SECRET, SETUP_KEY, LLM_API_KEY
 * Vars (wrangler.jsonc): SPOTIFY_CLIENT_ID, SITE_ORIGIN, LLM_PROVIDER, LLM_MODEL
 */

const SPOTIFY_SCOPES = "user-read-recently-played user-read-currently-playing user-top-read";
const MIN_PLAYS_FOR_MOOD = 5;
const MOOD_INTERVAL_HOURS = 12;
const MOOD_WINDOW_HOURS = 12;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/api/health":       return health(env);
        case "/api/login":        return login(url, env);
        case "/api/callback":     return callback(url, env);
        case "/api/sync":         return manualSync(url, env);
        case "/api/music":        return music(env);
        case "/api/mood":         return mood(env);
        case "/api/mood/refresh": return moodRefresh(url, env);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      console.error("api error", url.pathname, err);
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      syncSpotify(env).then(() => maybeGenerateMood(env, false)),
    );
  },
};

/* ---------------- routes ---------------- */

async function health(env) {
  const [token, recent, cur] = await Promise.all([
    env.SITE_DATA.get("spotify:refresh_token"),
    env.SITE_DATA.get("spotify:recent", "json"),
    env.SITE_DATA.get("mood:current", "json"),
  ]);
  return json({
    ok: true,
    configured: Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
    spotifyLinked: Boolean(token),
    lastSync: recent?.updatedAt ?? null,
    trackCount: recent?.tracks?.length ?? 0,
    llm: { provider: env.LLM_PROVIDER ?? "anthropic", model: env.LLM_MODEL ?? null, keySet: Boolean(env.LLM_API_KEY) },
    moodDay: cur?.day ?? null,
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

async function mood(env) {
  const cur = await env.SITE_DATA.get("mood:current", "json");
  if (!cur) return json({ error: "no mood yet" }, 404);
  return json(cur, 200, {
    "Cache-Control": "public, max-age=600",
    "Access-Control-Allow-Origin": "*",
  });
}

async function moodRefresh(url, env) {
  const guard = requireKey(url, env);
  if (guard) return guard;
  const result = await maybeGenerateMood(env, true); // force
  return json(result);
}

/* ---------------- spotify sync engine ---------------- */

async function syncSpotify(env) {
  const refreshToken = await env.SITE_DATA.get("spotify:refresh_token");
  if (!refreshToken) return { ok: false, reason: "not linked yet — visit /api/login" };

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
    image: item.track?.album?.images?.slice(-1)[0]?.url ?? null,
    url: item.track?.external_urls?.spotify ?? null,
    durationMs: item.track?.duration_ms ?? null,
  }));

  const updatedAt = new Date().toISOString();
  await env.SITE_DATA.put("spotify:recent", JSON.stringify({ updatedAt, tracks }));

  // per-day logs (NY time), deduped, 30-day TTL — mood + tamagotchi fuel
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
    await env.SITE_DATA.put(key, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  return { ok: true, updatedAt, pulled: tracks.length };
}

/* ---------------- mood engine ---------------- */

async function maybeGenerateMood(env, force) {
  if (!env.LLM_API_KEY) return { ok: false, reason: "LLM_API_KEY not set" };

  const today = nyDate(new Date().toISOString());
  const current = await env.SITE_DATA.get("mood:current", "json");
  const ageMs = current ? Date.now() - Date.parse(current.generatedAt) : Infinity;
  if (!force && ageMs < MOOD_INTERVAL_HOURS * 3600e3) {
    return { ok: true, skipped: `current mood is ${Math.round(ageMs/3600e3)}h old — regenerates at ${MOOD_INTERVAL_HOURS}h` };
  }

  // plays from the last MOOD_WINDOW_HOURS only (may span two calendar days)
  const cutoff = Date.now() - MOOD_WINDOW_HOURS * 3600e3;
  const days = lastNDays(2);
  const logs = await Promise.all(days.map((d) => env.SITE_DATA.get(`spotify:log:${d}`, "json")));
  const plays = days.map((d, i) => ({
    day: d,
    plays: (logs[i] ?? []).filter((p) => Date.parse(p.playedAt) >= cutoff),
  }));
  const total = plays.reduce((n, p) => n + p.plays.length, 0);
  if (total < MIN_PLAYS_FOR_MOOD) return { ok: false, reason: `only ${total} plays in the last ${MOOD_WINDOW_HOURS}h — keeping previous mood` };

  const digest = buildDigest(plays);
  const prompt = buildMoodPrompt(digest);

  let text;
  try {
    text = await llmComplete(env, prompt);
  } catch (err) {
    console.error("llm call failed", err);
    return { ok: false, reason: "llm call failed: " + err.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    console.error("llm returned unparseable output", text);
    return { ok: false, reason: "llm output was not valid JSON" };
  }

  const record = {
    day: today,
    generatedAt: new Date().toISOString(),
    mood: String(parsed.mood ?? "").slice(0, 40),
    emoji: String(parsed.emoji ?? "🎧").slice(0, 8),
    score: clampInt(parsed.score, 0, 100, 50),
    blurb: String(parsed.blurb ?? "").slice(0, 280),
    basedOn: { plays: total, windowHours: MOOD_WINDOW_HOURS, topArtists: digest.topArtists.slice(0, 5).map((a) => a.name) },
    provider: env.LLM_PROVIDER ?? "anthropic",
  };

  await env.SITE_DATA.put("mood:current", JSON.stringify(record));
  await env.SITE_DATA.put(`mood:${today}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
  return { ok: true, record };
}

function buildDigest(plays) {
  const artistCount = new Map();
  const sampleTracks = [];
  const hourBuckets = { morning: 0, afternoon: 0, evening: 0, latenight: 0 };

  for (const { plays: dayPlays } of plays) {
    for (const t of dayPlays) {
      for (const a of t.artists ?? []) artistCount.set(a, (artistCount.get(a) ?? 0) + 1);
      if (sampleTracks.length < 25) sampleTracks.push(`${t.name} — ${(t.artists ?? []).join(", ")}`);
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(t.playedAt)));
      if (hour >= 5 && hour < 12) hourBuckets.morning++;
      else if (hour >= 12 && hour < 18) hourBuckets.afternoon++;
      else if (hour >= 18 && hour < 24) hourBuckets.evening++;
      else hourBuckets.latenight++;
    }
  }
  const topArtists = [...artistCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    topArtists,
    sampleTracks,
    hourBuckets,
    perDay: plays.map((p) => ({ day: p.day, count: p.plays.length })),
  };
}

function buildMoodPrompt(d) {
  return `You write a one-line daily mood read for David's personal website, based on his recent Spotify listening. It appears in a retro Mac OS "Jukebox" window.

Voice rules:
- dry, specific, casual — like a sharp friend noticing a pattern
- reference 1 or 2 actual artists or tracks from the data
- never use: "vibes", "journey", "soundtrack", "eclectic", exclamation points, or generic hype
- blurb max 25 words

Listening data (last 12 hours, America/New_York):
Top artists: ${d.topArtists.slice(0, 8).map((a) => `${a.name} (${a.count} plays)`).join(", ") || "none"}
Plays per day: ${d.perDay.map((p) => `${p.day}: ${p.count}`).join(", ")}
Time of day: morning ${d.hourBuckets.morning}, afternoon ${d.hourBuckets.afternoon}, evening ${d.hourBuckets.evening}, late-night ${d.hourBuckets.latenight}
Sample tracks:
${d.sampleTracks.map((t) => "- " + t).join("\n")}

Respond with ONLY this JSON, no markdown fences, no other text:
{"mood": "<one or two word mood label, lowercase>", "emoji": "<single emoji>", "score": <0-100 int, energy/positivity of the listening>, "blurb": "<the mood read>"}`;
}

/* ---------------- provider-agnostic LLM adapter ---------------- */

async function llmComplete(env, prompt) {
  const provider = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  const model = env.LLM_MODEL ?? defaultModel(provider);

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.LLM_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  if (provider === "google") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.LLM_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    if (!res.ok) throw new Error(`google ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") ?? "";
  }

  throw new Error(`unknown LLM_PROVIDER: ${provider}`);
}

function defaultModel(provider) {
  if (provider === "anthropic") return "claude-sonnet-4-6";
  if (provider === "openai") return "gpt-4o-mini";
  if (provider === "google") return "gemini-2.0-flash";
  return "";
}

/* ---------------- helpers ---------------- */

function nyDate(isoString) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoString));
}

function lastNDays(n) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) out.push(nyDate(new Date(now - i * 86400000).toISOString()));
  return out;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
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