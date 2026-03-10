const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const SUPERDISPATCH_PRICING_URL =
  process.env.SUPERDISPATCH_PRICING_URL ||
  'https://pricing-insights.superdispatch.com/api/v1/recommended-price';
const SUPERDISPATCH_API_KEY = process.env.SUPERDISPATCH_API_KEY || '';
const RUCA_FILE = process.env.RUCA_FILE || path.join(__dirname, 'data', 'ruca_by_zip.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizeZip(zip) {
  return String(zip || '').trim().slice(0, 5);
}

function rucaCategory(code) {
  if (code >= 1 && code <= 3) return 'Metro';
  if (code >= 4 && code <= 6) return 'Suburban / Small City';
  if (code >= 7 && code <= 9) return 'Rural';
  if (code === 10) return 'Very Remote';
  return 'Unknown';
}

function safeJsonParse(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Failed to read RUCA file at ${filePath}:`, error.message);
    return {};
  }
}

let rucaLookup = safeJsonParse(RUCA_FILE);

function getRucaInfo(zip) {
  const normalized = normalizeZip(zip);
  const raw = rucaLookup[normalized];
  const code = raw === undefined || raw === null || raw === '' ? null : Number(raw);

  return {
    zip: normalized,
    ruca_code: Number.isFinite(code) ? code : null,
    ruca_category: Number.isFinite(code) ? rucaCategory(code) : 'Unknown'
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    hasSuperDispatchApiKey: Boolean(SUPERDISPATCH_API_KEY),
    rucaFile: RUCA_FILE,
    rucaRows: Object.keys(rucaLookup).length
  });
});

app.get('/api/ruca/:zip', (req, res) => {
  res.json(getRucaInfo(req.params.zip));
});

app.post('/api/quote', async (req, res) => {
  try {
    if (!SUPERDISPATCH_API_KEY) {
      return res.status(500).json({
        error: 'Missing SUPERDISPATCH_API_KEY environment variable on the server.'
      });
    }

    const body = req.body || {};
    const pickupZip = normalizeZip(body?.pickup?.zip);
    const deliveryZip = normalizeZip(body?.delivery?.zip);

    if (!pickupZip || !deliveryZip) {
      return res.status(400).json({ error: 'Pickup ZIP and delivery ZIP are required.' });
    }

    const pickupRuca = getRucaInfo(pickupZip);
    const deliveryRuca = getRucaInfo(deliveryZip);

    const sdResponse = await fetch(SUPERDISPATCH_PRICING_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': SUPERDISPATCH_API_KEY
      },
      body: JSON.stringify(body)
    });

    const text = await sdResponse.text();
    let parsed;

    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (_error) {
      parsed = { raw: text };
    }

    if (!sdResponse.ok) {
      return res.status(sdResponse.status).json({
        error: `Super Dispatch API error (${sdResponse.status})`,
        details: parsed,
        pickup_access: pickupRuca,
        dropoff_access: deliveryRuca
      });
    }

    return res.json({
      superdispatch: parsed,
      pickup_access: pickupRuca,
      dropoff_access: deliveryRuca
    });
  } catch (error) {
    console.error('Quote request failed:', error);
    return res.status(500).json({
      error: 'Server error while requesting quote.',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`RUCA file: ${RUCA_FILE}`);
  console.log(`RUCA rows loaded: ${Object.keys(rucaLookup).length}`);
});
