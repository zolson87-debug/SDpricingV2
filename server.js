const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

/* ---------------------------
   Load RUCA Data
--------------------------- */

let rucaData = {};

try {
  const rucaPath = path.join(__dirname, "ruca_by_zip.json");
  const raw = fs.readFileSync(rucaPath);
  rucaData = JSON.parse(raw);
  console.log("RUCA data loaded:", Object.keys(rucaData).length, "ZIP codes");
} catch (err) {
  console.error("Failed to load RUCA file:", err);
}

/* ---------------------------
   RUCA Category Logic
--------------------------- */

function rucaCategory(code) {
  if (!code) return "Unknown";

  if (code >= 1 && code <= 3) return "Metro";
  if (code >= 4 && code <= 6) return "Suburban / Small City";
  if (code >= 7 && code <= 9) return "Rural";
  if (code === 10) return "Very Remote";

  return "Unknown";
}

/* ---------------------------
   Serve UI
--------------------------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ---------------------------
   Super Dispatch Quote Proxy
--------------------------- */

app.post("/quote", async (req, res) => {
  try {
    const { pickup, delivery, vehicles, trailer_type } = req.body;

    const pickupZip = pickup.zip;
    const dropZip = delivery.zip;

    const pickupRuca = rucaData[pickupZip];
    const dropRuca = rucaData[dropZip];

    const pickupCategory = rucaCategory(pickupRuca);
    const dropCategory = rucaCategory(dropRuca);

    const sdResponse = await fetch(process.env.SUPERDISPATCH_PRICING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SUPERDISPATCH_API_KEY}`
      },
      body: JSON.stringify({
        pickup,
        delivery,
        vehicles,
        trailer_type
      })
    });

    const data = await sdResponse.json();

    res.json({
      superdispatch: data,
      pickup_access: {
        zip: pickupZip,
        ruca_code: pickupRuca,
        ruca_category: pickupCategory
      },
      dropoff_access: {
        zip: dropZip,
        ruca_code: dropRuca,
        ruca_category: dropCategory
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------------
   Health Check
--------------------------- */

app.get("/health", (req, res) => {
  res.send("OK");
});

/* ---------------------------
   Start Server
--------------------------- */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
