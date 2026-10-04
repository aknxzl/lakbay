const routeData = JSON.parse(sessionStorage.getItem('lakbayRoute') || 'null');

const summaryEl = document.getElementById('route-summary');
const mapEl = document.getElementById('map');

function formatDuration(minutes) {
  const total = Math.round(minutes);
  const hrs = Math.floor(total / 60);
  const mins = total % 60;
  return hrs > 0 ? `${hrs} hr ${mins} min` : `${mins} min`;
}

function peso(amount) {
  return `₱${amount.toFixed(2)}`;
}

function setFare(id, text, muted = false) {
  const el = document.querySelector(`#${id} .fare-value`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('fare-muted', muted);
}

function setNote(id, text) {
  const el = document.querySelector(`#${id} .fare-note`);
  if (el) el.textContent = text;
}

if (!routeData) {
  summaryEl.textContent = 'No route selected. Please go back and set a start and destination.';
  mapEl.style.display = 'none';
} else {
  const { start, end, distanceKm, durationMin, coordinates } = routeData;

  summaryEl.innerHTML = `<b>${start.name}</b> &rarr; <b>${end.name}</b>`;

  // Static display map: reuses the route already fetched on the previous page
  // instead of calling OSRM again.
  const map = L.map('map', {
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  L.marker([start.lat, start.lng]).addTo(map).bindPopup(`<b>Start:</b> ${start.name}`);
  L.marker([end.lat, end.lng]).addTo(map).bindPopup(`<b>Destination:</b> ${end.name}`);

  const routeLine = L.polyline(coordinates, { color: '#0066ff', weight: 5 }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });

  // --- Road-based fares: these only need distance/duration, already known ---
  const d = distanceKm;
  const t = durationMin;

  const tradJeepney = 14 + 2.00 * Math.max(0, d - 1);
  const modernJeepney = 17 + 2.40 * Math.max(0, d - 1);
  const cityBus = 15 + 2.49 * Math.max(0, d - 1);
  const tricycleLow = 10 + 1 * Math.max(0, d - 4);
  const tricycleHigh = 22 + 5 * Math.max(0, d - 4);
  const kmCharged = Math.floor(d);
  const taxi = 50 + 13.50 * kmCharged + 2.00 * t;

  setFare('Trad-jeepney', peso(tradJeepney));
  setFare('Modern-jeepney', peso(modernJeepney));
  setFare('City-bus', peso(cityBus));
  setFare('Tricycle', `${peso(tricycleLow)} - ${peso(tricycleHigh)}`);
  setFare('Taxi', peso(taxi));

  // --- Rail fares: need to know which stations are nearest start/end first ---
  renderRailFares(start, end);
}

// ---------------------------------------------------------------------------
// Rail station lookup
//
// Station coordinates aren't hand-typed here: each station name is geocoded
// through the same Nominatim service index.js already uses, then cached in
// localStorage (keyed by line + station name) so it's only ever done once
// per browser - station locations don't change. Nominatim's usage policy
// caps requests at 1/second, so the very first time this runs it can take
// under a minute; every visit after that reads straight from the cache.
// ---------------------------------------------------------------------------

const STATION_CACHE_KEY = 'lakbayStationCoords';
const STATION_SNAP_METERS = 1500; // how close a point must be to "count" as at a station

function loadStationCache() {
  try {
    return JSON.parse(localStorage.getItem(STATION_CACHE_KEY) || '{}');
  } catch (err) {
    return {};
  }
}

function saveStationCache(cache) {
  try {
    localStorage.setItem(STATION_CACHE_KEY, JSON.stringify(cache));
  } catch (err) {
    console.error('Failed to cache station coordinates:', err);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocodeStation(name, suffix) {
  const query = `${name} ${suffix}, Metro Manila, Philippines`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }
  return null;
}

async function ensureStationCoords(onProgress) {
  const cache = loadStationCache();
  const toFetch = [];

  for (const lineId of Object.keys(RAIL_LINES)) {
    const suffix = RAIL_LINES[lineId].geocodeSuffix || 'Station';
    for (const name of RAIL_LINES[lineId].stations) {
      const key = `${lineId}|${name}`;
      if (!cache[key]) toFetch.push({ key, name, suffix });
    }
  }

  for (let i = 0; i < toFetch.length; i++) {
    const { key, name, suffix } = toFetch[i];
    if (onProgress) onProgress(i + 1, toFetch.length);
    try {
      const coords = await geocodeStation(name, suffix);
      if (coords) cache[key] = coords;
    } catch (err) {
      console.error(`Failed to geocode station ${name}:`, err);
    }
    if (i < toFetch.length - 1) await sleep(1100);
  }

  saveStationCache(cache);
  return cache;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Closest station on a given line to a point, only if within STATION_SNAP_METERS.
function nearestStation(lineId, lat, lng, cache) {
  const stations = RAIL_LINES[lineId].stations;
  let best = null;

  stations.forEach((name, index) => {
    const coords = cache[`${lineId}|${name}`];
    if (!coords) return;
    const dist = haversineMeters(lat, lng, coords.lat, coords.lng);
    if (!best || dist < best.dist) {
      best = { name, index, dist };
    }
  });

  return best && best.dist <= STATION_SNAP_METERS ? best : null;
}

async function renderRailFares(start, end) {
  const lineIds = Object.keys(RAIL_LINES);

  lineIds.forEach(lineId => setFare(lineId, 'Locating stations...', true));

  const cache = await ensureStationCoords((done, total) => {
    lineIds.forEach(lineId => setFare(lineId, `Locating stations... (${done}/${total})`, true));
  });

  // Once every station has a coordinate (cached or freshly looked up), offer a
  // one-click way to grab that data so it can be hardcoded into stations.js
  // instead of being looked up again on anyone else's first visit.
  showStationExportButton(cache);

  lineIds.forEach(lineId => {
    const fromStation = nearestStation(lineId, start.lat, start.lng, cache);
    const toStation = nearestStation(lineId, end.lat, end.lng, cache);

    if (!fromStation || !toStation) {
      setFare(lineId, 'No nearby station', true);
      setNote(lineId, '');
      return;
    }

    if (fromStation.index === toStation.index) {
      setFare(lineId, '–', true);
      setNote(lineId, `Both points are near ${fromStation.name} station`);
      return;
    }

    if (lineId === 'MRT-3') {
      const stops = Math.abs(fromStation.index - toStation.index);
      let regular;
      if (stops <= 2) regular = 13;
      else if (stops <= 4) regular = 16;
      else if (stops <= 7) regular = 20;
      else if (stops <= 10) regular = 24;
      else regular = 28;
      const discounted = regular / 2;

      setFare(lineId, `${peso(discounted)} (${peso(regular)} regular)`);
      setNote(lineId, `${fromStation.name} → ${toStation.name}`);
    } else if (lineId === 'LRT-2') {
      // Fixed, already-discounted range - not station-dependent.
      setFare(lineId, `${peso(6.50)} - ${peso(16.50)}`);
      setNote(lineId, `${fromStation.name} → ${toStation.name} (stored value fare)`);
    } else if (lineId === 'LRT-1') {
      // No verified exact stored-value matrix is wired in yet (public sources
      // disagreed with each other), so this shows the nearest stations and
      // the known overall single-journey range rather than a specific number.
      setFare(lineId, `${peso(15)} - ${peso(35)}`, true);
      setNote(lineId, `${fromStation.name} → ${toStation.name} · estimate, exact fare needs the official matrix`);
    } else if (lineId === 'BRT') {
      // Same situation as LRT-1: DOTr's EDSA Busway fare is a published
      // distance-based matrix (image, not numbers), so this shows the known
      // overall range rather than inventing a per-stop figure.
      setFare(lineId, `${peso(15)} - ${peso(75)}`, true);
      setNote(lineId, `${fromStation.name} → ${toStation.name} · estimate, exact fare needs the official DOTr matrix`);
    }
  });
}

// Copies the geocoded station cache to the clipboard as formatted JSON, so it
// can be pasted somewhere durable (a message, a file) and later hardcoded
// into stations.js - removing the need for anyone else's browser to look
// these up again.
function showStationExportButton(cache) {
  const btn = document.getElementById('export-stations-btn');
  if (!btn) return;

  btn.style.display = 'block';
  btn.addEventListener('click', async () => {
    const json = JSON.stringify(cache, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      btn.textContent = 'Copied! Paste it wherever you need it.';
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      // Fallback for browsers/contexts that block clipboard access.
      window.prompt('Copy this text:', json);
    }
    setTimeout(() => {
      btn.textContent = 'Copy station coordinates (for developer)';
    }, 3000);
  });
}
