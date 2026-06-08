// ─────────────────────────────────────────────────────────────────────────────
// myRootFinder — Backend Server (Railway)
// Handles: Claude API proxy, Stripe webhooks, Supabase user checks
// ─────────────────────────────────────────────────────────────────────────────
import express    from "express";
import cors       from "cors";
import rateLimit  from "express-rate-limit";
import Stripe     from "stripe";
import { createClient } from "@supabase/supabase-js";
// Using Resend API via fetch (no npm install needed)

const app    = express();
const PORT   = process.env.PORT || 3001;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

// Supabase admin client (service role — never expose to frontend)
const supabase = createClient(
  process.env.SUPABASE_URL       || "",
  process.env.SUPABASE_SERVICE_KEY || ""
);

// Resend email function
async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.RESEND_API_KEY || '') },
    body: JSON.stringify({ from: 'myRootFinder <info@myrootfinder.com>', to, subject, html })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Resend error');
  return data;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowed = (process.env.FRONTEND_URL || "http://localhost:5173").split(",");
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.some(u => origin.startsWith(u.trim()))) cb(null, true);
    else cb(new Error("CORS blocked"));
  },
  credentials: true,
}));

// ── Raw body for Stripe webhooks (must come before express.json) ──────────────
app.use((req, res, next) => {
  if (req.originalUrl === "/webhooks/stripe") {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { data += chunk; });
    req.on("end",  () => { req.rawBody = data; next(); });
  } else {
    express.json()(req, res, next);
  }
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      30,
  message:  { error: "Too many requests — please wait a few minutes." },
  validate: { xForwardedForHeader: false }, // Railway sets X-Forwarded-For — disable this validation
});

// ── Helper: check user access ─────────────────────────────────────────────────
// Returns { tier: "free"|"paid"|"realtor"|"enterprise", reportsUsed: N }
async function getUserAccess(email) {
  if (!email) return { tier: "free", reportsUsed: 0 };

  const { data: user } = await supabase
    .from("users")
    .select("tier, reports_used, stripe_subscription_id")
    .eq("email", email.toLowerCase())
    .single();

  if (!user) {
    // First time — create free user record
    await supabase.from("users").insert({
      email: email.toLowerCase(),
      tier: "free",
      reports_used: 0,
      created_at: new Date().toISOString(),
    });
    return { tier: "free", reportsUsed: 0 };
  }

  return { tier: user.tier || "free", reportsUsed: user.reports_used || 0 };
}

// Tier hierarchy: free < paid < realtor < brokerage < enterprise < corporate

// ── POST /api/search — main AI proxy ─────────────────────────────────────────
app.post("/api/search", limiter, async (req, res) => {
  const { prompt, max_tokens = 1000, email } = req.body;

  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  // Check user access
  const { tier, reportsUsed } = await getUserAccess(email);

  // Free tier gate: 1 report max
  // (A "report" = a full search run, not individual API calls)
  // This endpoint is called many times per report — gating is done in /api/start-search
  // Here we just proxy the Claude call

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-5",
        max_tokens: Math.min(max_tokens, 4000),
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(502).json({ error: err.error?.message || "Claude API error" });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    res.json({ text });

  } catch (e) {
    console.error("Claude API error:", e);
    res.status(500).json({ error: "Server error — try again" });
  }
});

// ── POST /api/start-search — gate check before running a full report ──────────
app.post("/api/start-search", limiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const { tier, reportsUsed } = await getUserAccess(email);

  // Check corporate email domains
  const domain = email.split("@")[1]?.toLowerCase() || "";
  const { data: corp } = await supabase
    .from("corporate_domains")
    .select("company, plan")
    .eq("domain", domain)
    .single();

  if (corp) {
    return res.json({ allowed: true, tier: "corporate", company: corp.company });
  }

  // Free: 1 report max
  if (tier === "free" && reportsUsed >= 1) {
    return res.json({ allowed: false, reason: "free_limit", reportsUsed });
  }

  // Standard (paid): 10 reports/month
  if (tier === "paid") {
    const { data: u } = await supabase.from("users").select("reports_used, period_start").eq("email", email.toLowerCase()).single();
    const now = new Date();
    const periodStart = u?.period_start ? new Date(u.period_start) : null;
    const sameMonth = periodStart && periodStart.getMonth() === now.getMonth() && periodStart.getFullYear() === now.getFullYear();
    const monthlyCount = sameMonth ? (u.reports_used || 0) : 0;
    if (monthlyCount >= 10) {
      return res.json({ allowed: false, reason: "monthly_limit", reportsUsed: monthlyCount });
    }
    if (!sameMonth) {
      await supabase.from("users").update({ reports_used: 0, period_start: now.toISOString() }).eq("email", email.toLowerCase());
    }
  }

  // Increment report counter
  await supabase
    .from("users")
    .update({ reports_used: reportsUsed + 1, last_active: new Date().toISOString() })
    .eq("email", email.toLowerCase());

  res.json({ allowed: true, tier, reportsUsed: reportsUsed + 1 });
});

// ── POST /api/create-checkout — Stripe checkout session ──────────────────────
app.post("/api/create-checkout", async (req, res) => {
  const { email, plan } = req.body; // plan: "consumer" | "realtor" | "brokerage" | "enterprise"

  const prices = {
    standard:   process.env.STRIPE_PRICE_STANDARD,    // $7.99/mo — 10 reports/month
    unlimited:  process.env.STRIPE_PRICE_UNLIMITED,   // $9.99/mo — unlimited reports
    consumer:   process.env.STRIPE_PRICE_STANDARD,    // alias for legacy support
    realtor:    process.env.STRIPE_PRICE_REALTOR,     // $99/mo
    brokerage:  process.env.STRIPE_PRICE_BROKERAGE,   // $299/mo
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE,  // $499/mo
  };

  const priceId = prices[plan];
  if (!priceId) return res.status(400).json({ error: "Invalid plan" });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode:                 "subscription",
      customer_email:       email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/?cancelled=1`,
      metadata:    { email, plan },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Stripe error:", e);
    res.status(500).json({ error: "Could not create checkout session" });
  }
});

// ── POST /webhooks/stripe — handle subscription events ───────────────────────
app.post("/webhooks/stripe", async (req, res) => {
  const sig    = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email   = session.metadata?.email;
    const plan    = session.metadata?.plan;

    const tierMap = { standard: "paid", unlimited: "unlimited", consumer: "paid", realtor: "realtor", brokerage: "brokerage", enterprise: "enterprise" };
    const tier    = tierMap[plan] || "paid";

    await supabase.from("users")
      .update({ tier, stripe_subscription_id: session.subscription,
                updated_at: new Date().toISOString() })
      .eq("email", email);
  }

  if (event.type === "customer.subscription.deleted") {
    const sub   = event.data.object;
    const { data: user } = await supabase
      .from("users").select("email").eq("stripe_subscription_id", sub.id).single();
    if (user) {
      await supabase.from("users").update({ tier: "free" }).eq("email", user.email);
    }
  }

  res.json({ received: true });
});

// ── POST /api/register-corporate — add a domain for corporate access ──────────
app.post("/api/register-corporate", async (req, res) => {
  // This endpoint is called manually by you to onboard corporate clients
  const { domain, company, plan, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

  await supabase.from("corporate_domains").upsert({ domain, company, plan });
  res.json({ success: true });
});

// ── GET /api/places — Google Places Nearby Search proxy ──────────────────────
// Keeps the Google API key server-side (never exposed to frontend)
// ?lat=41.8&lng=-87.6&type=restaurant&keyword=&radius=8047
app.get("/api/places", limiter, async (req, res) => {
  const { lat, lng, type, keyword = "", radius = 8047 } = req.query; // 8047m = 5 miles

  if (!lat || !lng || !type) {
    return res.status(400).json({ error: "lat, lng, and type are required" });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Google Places API key not configured" });

  try {
    // Step 1: Nearby Search within radius, sorted by prominence then re-sorted by distance
    const params = new URLSearchParams({
      location: `${lat},${lng}`,
      radius:   String(radius),
      type:     type,
      key:      apiKey,
      ...(keyword ? { keyword } : {}),
    });

    const searchRes = await fetch(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`
    );
    const searchData = await searchRes.json();

    if (searchData.status !== "OK" && searchData.status !== "ZERO_RESULTS") {
      console.error("Places API error:", searchData.status, searchData.error_message);
      return res.status(502).json({ error: `Places API: ${searchData.status}` });
    }

    // Step 2: Enrich top 10 with Place Details (phone, hours, website)
    const top10 = (searchData.results || []).slice(0, 10);

    const enriched = await Promise.all(top10.map(async (place) => {
      try {
        const detailParams = new URLSearchParams({
          place_id: place.place_id,
          fields:   "name,formatted_address,formatted_phone_number,opening_hours,website,geometry,rating,user_ratings_total,price_level,types",
          key:      apiKey,
        });
        const detailRes  = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?${detailParams}`);
        const detailData = await detailRes.json();
        const d = detailData.result || {};

        // Compute distance from search origin
        const pLat = d.geometry?.location?.lat ?? place.geometry?.location?.lat ?? 0;
        const pLng = d.geometry?.location?.lng ?? place.geometry?.location?.lng ?? 0;
        const distMiles = haversineServer(parseFloat(lat), parseFloat(lng), pLat, pLng);

        return {
          name:         d.name         || place.name,
          address:      d.formatted_address || place.vicinity || "",
          lat:          pLat,
          lng:          pLng,
          phone:        d.formatted_phone_number || "",
          website:      d.website || "",
          rating:       d.rating  ?? place.rating ?? null,
          rating_count: d.user_ratings_total ?? place.user_ratings_total ?? 0,
          price_level:  d.price_level ?? place.price_level ?? null,
          hours:        d.opening_hours?.weekday_text?.join(" | ") || "",
          open_now:     d.opening_hours?.open_now ?? null,
          types:        (d.types || place.types || []).filter(t => t !== "point_of_interest" && t !== "establishment").slice(0, 3),
          distance_miles: Math.round(distMiles * 10) / 10,
          place_id:     place.place_id,
          source:       "google_places",
        };
      } catch (detailErr) {
        // If detail fetch fails, return basic info from nearby search
        const pLat = place.geometry?.location?.lat ?? 0;
        const pLng = place.geometry?.location?.lng ?? 0;
        return {
          name:           place.name,
          address:        place.vicinity || "",
          lat:            pLat,
          lng:            pLng,
          phone:          "",
          website:        "",
          rating:         place.rating ?? null,
          rating_count:   place.user_ratings_total ?? 0,
          price_level:    place.price_level ?? null,
          hours:          "",
          open_now:       place.opening_hours?.open_now ?? null,
          types:          (place.types || []).filter(t => t !== "point_of_interest" && t !== "establishment").slice(0, 3),
          distance_miles: Math.round(haversineServer(parseFloat(lat), parseFloat(lng), pLat, pLng) * 10) / 10,
          place_id:       place.place_id,
          source:         "google_places",
        };
      }
    }));

    // Sort by distance (closest first)
    enriched.sort((a, b) => a.distance_miles - b.distance_miles);

    res.json({ results: enriched, status: searchData.status });

  } catch (e) {
    console.error("Places proxy error:", e);
    res.status(500).json({ error: "Places lookup failed — try again" });
  }
});

// Server-side haversine helper (miles)
function haversineServer(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── POST /api/send-code
app.post('/api/send-code', async (req, res) => {
  // Skip verification for existing verified users — check before anything else
  const emailCheck = (req.body.email || '').toLowerCase().trim();
  if (emailCheck) {
    const { data: existingVerified } = await supabase.from('users').select('email_verified').eq('email', emailCheck).single();
    if (existingVerified?.email_verified) {
      return res.json({ ok: true, skip: true });
    }
  }
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await supabase.from('verification_codes').upsert({ email: email.toLowerCase(), code, expires_at: expiresAt, used: false }, { onConflict: 'email' });
  try {
    await sendEmail(email, 'Your myRootFinder verification code', '<div style="font-family:sans-serif;padding:32px"><h2>Verify your email</h2><p>Your 6-digit code:</p><div style="background:#F5C842;font-size:36px;font-weight:900;letter-spacing:8px;text-align:center;padding:20px;border-radius:12px">' + code + '</div><p style="color:#999;font-size:12px">Expires in 10 minutes.</p></div>');
    res.json({ ok: true });
  } catch (err) { console.error('Email error full:', JSON.stringify({msg: err.message, code: err.code, response: err.response})); res.status(500).json({ error: 'Failed to send email', detail: err.message }); }
});

app.post('/api/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
  const { data: row } = await supabase.from('verification_codes').select('code,expires_at,used').eq('email', email.toLowerCase()).single();
  if (!row) return res.json({ ok: false, error: 'No code found - request a new one' });
  if (row.used) return res.json({ ok: false, error: 'Code already used - request a new one' });
  if (new Date(row.expires_at) < new Date()) return res.json({ ok: false, error: 'Code expired - request a new one' });
  if (row.code !== code.trim()) return res.json({ ok: false, error: 'Incorrect code' });
  await supabase.from('verification_codes').update({ used: true }).eq('email', email.toLowerCase());
  const { data: existingUser } = await supabase.from('users').select('reports_used').eq('email', email.toLowerCase()).single();
  if (existingUser) {
    await supabase.from('users').update({ email_verified: true }).eq('email', email.toLowerCase());
  } else {
    await supabase.from('users').insert({ email: email.toLowerCase(), email_verified: true, tier: 'free', reports_used: 0, created_at: new Date().toISOString() });
  }
  res.json({ ok: true });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ── GET /api/autocomplete — Google Places Autocomplete proxy ──────────────────
app.get("/api/autocomplete", limiter, async (req, res) => {
  const { input } = req.query;
  if (!input || input.length < 3) return res.json({ predictions: [] });
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "No API key" });
  try {
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=address&components=country:us&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const predictions = (data.predictions || []).slice(0, 5).map(p => ({ description: p.description, place_id: p.place_id }));
    res.json({ predictions });
  } catch (err) {
    res.status(500).json({ error: "Autocomplete failed" });
  }
});

// ── GET /api/places-nearby — distance-ranked Places search (no radius needed) ─
// Used for neighborhood tab where closest matters more than prominence
app.get("/api/places-nearby", limiter, async (req, res) => {
  const { lat, lng, type, keyword = "" } = req.query;
  if (!lat || !lng || !type) return res.status(400).json({ error: "lat, lng, type required" });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "No API key" });

  try {
    // rankby=distance returns closest first — requires keyword or type (no radius)
    const params = new URLSearchParams({
      location: `${lat},${lng}`,
      rankby:   "distance",
      type:     type,
      key:      apiKey,
      ...(keyword ? { keyword } : {}),
    });

    const searchRes = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`);
    const searchData = await searchRes.json();

    if (searchData.status !== "OK" && searchData.status !== "ZERO_RESULTS") {
      return res.status(502).json({ error: `Places API: ${searchData.status}` });
    }

    const top10 = (searchData.results || []).slice(0, 10);

    const enriched = await Promise.all(top10.map(async (place) => {
      const pLat = place.geometry?.location?.lat ?? 0;
      const pLng = place.geometry?.location?.lng ?? 0;
      return {
        name:           place.name,
        address:        place.vicinity || "",
        lat:            pLat,
        lng:            pLng,
        phone:          "",
        website:        "",
        rating:         place.rating ?? null,
        rating_count:   place.user_ratings_total ?? 0,
        price_level:    null,
        hours:          "",
        open_now:       place.opening_hours?.open_now ?? null,
        types:          (place.types || []).filter(t => t !== "point_of_interest" && t !== "establishment").slice(0, 3),
        distance_miles: Math.round(haversineServer(parseFloat(lat), parseFloat(lng), pLat, pLng) * 10) / 10,
        place_id:       place.place_id,
        source:         "google_places",
      };
    }));

    enriched.sort((a, b) => a.distance_miles - b.distance_miles);
    res.json({ results: enriched, status: searchData.status });
  } catch (e) {
    console.error("Places-nearby error:", e);
    res.status(500).json({ error: "Places lookup failed" });
  }
});

// ── GET /api/geocode — Google Maps Geocoding API proxy ───────────────────────
app.get("/api/geocode", limiter, async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: "address required" });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "No API key" });

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&components=country:US&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== "OK" || !data.results?.[0]) {
      return res.status(404).json({ error: `Could not locate: ${data.status}` });
    }

    const result = data.results[0];
    const loc = result.geometry.location;
    const components = result.address_components || [];
    const city  = components.find(c => c.types.includes("locality"))?.long_name || "";
    const state = components.find(c => c.types.includes("administrative_area_level_1"))?.short_name || "";
    const display = city && state ? `${city}, ${state}` : result.formatted_address;

    res.json({ lat: loc.lat, lng: loc.lng, display, formatted: result.formatted_address });
  } catch (e) {
    console.error("Geocode error:", e);
    res.status(500).json({ error: "Geocoding failed" });
  }
});


// ── GET /api/school-district — Census Geocoder district lookup (free, no key) ─
// Uses US Census Bureau geocoder which returns school district info
app.get("/api/school-district", limiter, async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  try {
    // Census TIGERweb — layers 16 (unified), 17 (secondary), 18 (elementary)
    // Spatial ref is 102100 (Web Mercator) — must specify inSR=4326 for lat/lng input
    const headers = { "User-Agent": "MyRootFinder/1.0 (contact: info@myrootfinder.com)" };
    const baseParams = `geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=NAME,GEOID,LOGRADE,HIGRADE&returnGeometry=false&f=json&geometry=${parseFloat(lng)},${parseFloat(lat)}`;

    // Query all three district types in parallel
    const [unified, secondary, elementary] = await Promise.all([
      fetch(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/16/query?${baseParams}`, { headers }).then(r => r.json()).catch(() => ({ features: [] })),
      fetch(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/17/query?${baseParams}`, { headers }).then(r => r.json()).catch(() => ({ features: [] })),
      fetch(`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/18/query?${baseParams}`, { headers }).then(r => r.json()).catch(() => ({ features: [] })),
    ]);

    console.log("TIGERweb unified:", JSON.stringify(unified).slice(0, 200));
    console.log("TIGERweb elementary:", JSON.stringify(elementary).slice(0, 200));

    const allFeatures = [
      ...(unified.features || []),
      ...(secondary.features || []),
      ...(elementary.features || []),
    ];

    if (allFeatures.length === 0) {
      return res.json({ districts: [], found: false });
    }

    const districts = allFeatures.map(f => ({
      name:    f.attributes.NAME || f.attributes.BASENAME,
      geoid:   f.attributes.GEOID,
      lograde: f.attributes.LOGRADE,
      higrade: f.attributes.HIGRADE,
    })).filter(d => d.name);

    res.json({ districts, found: districts.length > 0 });
  } catch (e) {
    console.error("Census district lookup error:", e);
    res.json({ districts: [], found: false });
  }
});


// ── GET /api/schools-in-district — NCES school locations by district ──────────
// Returns real school names from NCES CCD data for a given district GEOID
app.get("/api/schools-in-district", limiter, async (req, res) => {
  const { lat, lng, type } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat, lng required" });

  try {
    // First get the district GEOID
    const distRes = await fetch(
      `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/18/query?geometry=${parseFloat(lng)},${parseFloat(lat)}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=NAME,GEOID,LOGRADE,HIGRADE&returnGeometry=false&f=json`,
      { headers: { "User-Agent": "MyRootFinder/1.0 (contact: info@myrootfinder.com)" } }
    );
    const distData = await distRes.json();
    const features = distData.features || [];
    if (features.length === 0) return res.json({ schools: [], found: false });

    const geoid = features[0].attributes.GEOID;

    // Query NCES school locations for this district
    // Layer 0 = public schools, filter by district LEAID (first 7 digits of NCES school ID match district)
    const gradeFilter = type === "high" ? "9,10,11,12"
      : type === "middle" ? "6,7,8"
      : type === "elementary" ? "KG,1,2,3,4,5"
      : "PK,KG";

    const schoolRes = await fetch(
      `https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2122/MapServer/0/query?where=LEAID%3D%27${geoid}%27&outFields=NAME,ADDRESS,CITY,STATE,ZIP,GRSPAN,MEMBER&returnGeometry=false&f=json`,
      { headers: { "User-Agent": "MyRootFinder/1.0 (contact: info@myrootfinder.com)" } }
    );
    const schoolData = await schoolRes.json();
    console.log("NCES schools response:", JSON.stringify(schoolData).slice(0, 400));

    const schools = (schoolData.features || []).map(f => ({
      name:    f.attributes.NAME,
      address: `${f.attributes.ADDRESS}, ${f.attributes.CITY}, ${f.attributes.STATE} ${f.attributes.ZIP}`,
      grades:  f.attributes.GRSPAN,
      enrollment: f.attributes.MEMBER,
    }));

    res.json({ schools, found: schools.length > 0, districtGeoid: geoid });
  } catch (e) {
    console.error("Schools in district error:", e);
    res.json({ schools: [], found: false });
  }
});

app.listen(PORT, () => console.log(`myRootFinder backend running on port ${PORT}`));
