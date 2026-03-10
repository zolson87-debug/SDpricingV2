const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const SUPERDISPATCH_URL =
  process.env.SUPERDISPATCH_PRICING_URL ||
  "https://pricing-insights.superdispatch.com/api/v1/recommended-price";

const API_KEY = process.env.SUPERDISPATCH_API_KEY;
const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";

if (!API_KEY) {
  console.warn("WARNING: SUPERDISPATCH_API_KEY is not set.");
}
if (!APP_USERNAME || !APP_PASSWORD) {
  console.warn("WARNING: APP_USERNAME or APP_PASSWORD is not set.");
}

let rucaData = {};

try {
  const rucaPath = path.join(__dirname, "ruca_by_zip.json");
  const raw = fs.readFileSync(rucaPath, "utf8");
  rucaData = JSON.parse(raw);
  console.log("RUCA data loaded:", Object.keys(rucaData).length, "ZIP codes");
} catch (err) {
  console.error("Failed to load RUCA file:", err);
}

function rucaCategory(code) {
  if (code === undefined || code === null || code === "") return "Unknown";
  const n = Number(code);
  if (n >= 1 && n <= 3) return "Metro";
  if (n >= 4 && n <= 6) return "Suburban / Small City";
  if (n >= 7 && n <= 9) return "Rural";
  if (n === 10) return "Very Remote";
  return "Unknown";
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};

  header.split(";").forEach((part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) return;
    cookies[key] = decodeURIComponent(rest.join("="));
  });

  return cookies;
}

function signSession(username) {
  const payload = JSON.stringify({
    username,
    exp: Date.now() + 1000 * 60 * 60 * 12
  });

  const payloadBase64 = Buffer.from(payload).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  return `${payloadBase64}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;

  const [payloadBase64, sig] = token.split(".");
  const expectedSig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  if (sig !== expectedSig) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(payloadBase64, "base64url").toString("utf8")
    );

    if (!payload.exp || Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const session = verifySession(cookies.auth_session);

  if (!session) {
    return res.redirect("/login");
  }

  req.user = session;
  next();
}

app.get("/login", (req, res) => {
  const cookies = parseCookies(req);
  const session = verifySession(cookies.auth_session);

  if (session) {
    return res.redirect("/");
  }

  res.sendFile(path.join(__dirname, "login.html"));
});

app.post("/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!APP_USERNAME || !APP_PASSWORD) {
    return res.status(500).send("Server auth environment variables are not configured.");
  }

  if (username !== APP_USERNAME || password !== APP_PASSWORD) {
    return res.redirect("/login?error=1");
  }

  const token = signSession(username);
  const isProduction = process.env.NODE_ENV === "production";

  res.setHeader(
    "Set-Cookie",
    `auth_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${isProduction ? "; Secure" : ""}`
  );

  res.redirect("/");
});

app.post("/logout", (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";

  res.setHeader(
    "Set-Cookie",
    `auth_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${isProduction ? "; Secure" : ""}`
  );

  res.redirect("/login");
});

app.get("/health", (req, res) => {
  res.type("text/plain").send("OK");
});

app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/session", requireAuth, (req, res) => {
  res.json({
    authenticated: true,
    username: req.user.username
  });
});

app.post("/quote", requireAuth, async (req, res) => {
  try {
    const { pickup, delivery, vehicles, trailer_type } = req.body || {};

    if (!pickup?.zip || !delivery?.zip) {
      return res.status(400).json({
        error: "Pickup ZIP and delivery ZIP are required."
      });
    }

    if (!API_KEY) {
      return res.status(500).json({
        error: "Server misconfigured: SUPERDISPATCH_API_KEY is not set on the server."
      });
    }

    const pickupZip = String(pickup.zip).trim();
    const dropZip = String(delivery.zip).trim();

    const pickupRuca = rucaData[pickupZip];
    const dropRuca = rucaData[dropZip];

    const sdResponse = await fetch(SUPERDISPATCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": API_KEY
      },
      body: JSON.stringify({
        pickup,
        delivery,
        vehicles,
        trailer_type
      })
    });

    const rawText = await sdResponse.text();

    let sdJson;
    try {
      sdJson = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        error: "Super Dispatch did not return valid JSON.",
        status: sdResponse.status,
        raw_response_preview: rawText.slice(0, 500)
      });
    }

    return res.status(sdResponse.status).json({
      superdispatch: sdJson,
      pickup_access: {
        zip: pickupZip,
        ruca_code: pickupRuca ?? null,
        ruca_category: rucaCategory(pickupRuca)
      },
      dropoff_access: {
        zip: dropZip,
        ruca_code: dropRuca ?? null,
        ruca_category: rucaCategory(dropRuca)
      }
    });
  } catch (err) {
    console.error("Quote route error:", err);

    return res.status(500).json({
      error: "Server error",
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
