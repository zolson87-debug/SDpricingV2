const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.type("text/plain").send("OK");
});

app.post("/quote", async (req, res) => {
  try {
    const { pickup, delivery, vehicles, trailer_type } = req.body || {};

    if (!pickup?.zip || !delivery?.zip) {
      return res.status(400).json({ error: "Pickup ZIP and delivery ZIP are required." });
    }

    const pickupZip = String(pickup.zip).trim();
    const dropZip = String(delivery.zip).trim();

    const pickupRuca = rucaData[pickupZip];
    const dropRuca = rucaData[dropZip];

    const sdResponse = await fetch(process.env.SUPERDISPATCH_PRICING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.SUPERDISPATCH_API_KEY}`
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
