// Finds the Flightradar24 and ADS-B Nearby sensors that are already set up in
// Home Assistant, so the card and its editor can offer them without typing.
function detectSources(hass) {
  const found = { fr24: [], adsb: [] };
  if (!hass || !hass.states) return found;
  const registry = hass.entities || null;
  const ids = registry ? Object.keys(registry) : Object.keys(hass.states);
  for (const id of ids) {
    if (!id.startsWith('sensor.') || !hass.states[id]) continue;
    const reg = registry ? registry[id] : null;
    const platform = reg ? reg.platform : '';
    const key = reg && reg.translation_key ? reg.translation_key : '';
    if (platform === 'flightradar24' || (!registry && id.includes('flightradar24'))) {
      const attrs = hass.states[id].attributes || {};
      if (id.endsWith('_in_area') || key === 'in_area' || Array.isArray(attrs.flights)) {
        found.fr24.push(id);
      }
    } else if (platform === 'adsb_nearby' || (!registry && id.includes('adsb_nearby'))) {
      if (id.endsWith('_nearest_aircraft') || key === 'nearest_aircraft') {
        found.adsb.push(id);
      }
    }
  }
  return found;
}
class OverheadSplitflapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._currentIndex = 0;
    this._lastRenderedLines = [];
    this._cycleTimer = null;
    this._resizeObserver = null;
    this._chars = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/:.>';
    this._onVisibilityChange = this._handleVisibilityChange.bind(this);
  }

  static getConfigElement() {
    return document.createElement('overhead-splitflap-card-editor');
  }

  static getStubConfig(hass) {
    const found = detectSources(hass);
    const config = {
      entity: found.fr24[0] || 'sensor.flightradar24_current_in_area',
      title: 'OVERHEAD RADAR',
      columns: 20,
      cycle_seconds: 12,
      flip_speed_ms: 45,
    };
    if (found.adsb[0]) config.adsb_entity = found.adsb[0];
    return config;
  }

  // Which sensors to read. With `entity` set, the config is used as written.
  // Without it, the card uses the Flightradar24 and ADS-B sensors it finds in
  // Home Assistant (so a bare `type:` card works). `entity` is null when none exist.
  _sources() {
    if (this._config.entity) {
      return { entity: this._config.entity, adsb: this._config.adsb_entity };
    }
    const cached = this._autoSources;
    if (cached && this._hass.states[cached.entity]) return cached;
    const found = detectSources(this._hass);
    const sources = { entity: found.fr24[0] || null, adsb: found.adsb[0] || null };
    this._autoSources = sources.entity ? sources : null;
    return sources;
  }

  setConfig(config) {
    this._autoSources = null;
    this._config = {
      title: 'OVERHEAD RADAR',
      columns: 20,
      cycle_seconds: 12,
      flip_speed_ms: 45,
      ...config,
    };
    this._lastRenderedLines = [];
    this._renderShell();
    if (this.isConnected) {
      this._resetCycleTimer();
      this._updateBoard(true);
    }
  }

  set hass(hass) {
    this._hass = hass;
    this._updateBoard();
  }

  connectedCallback() {
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    this._resetCycleTimer();
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this._stopCycleTimer();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._clearAllCellTimers();
  }

  _handleVisibilityChange() {
    if (!document.hidden) {
      this._clearAllCellTimers();
      this._lastRenderedLines = [];
      this._updateBoard(true);
      this._resetCycleTimer();
    } else {
      this._stopCycleTimer();
    }
  }

  _stopCycleTimer() {
    if (this._cycleTimer !== null) {
      clearInterval(this._cycleTimer);
      this._cycleTimer = null;
    }
  }

  _resetCycleTimer() {
    this._stopCycleTimer();
    const seconds = Number(this._config.cycle_seconds);
    if (seconds > 0) {
      this._cycleTimer = setInterval(() => {
        if (!document.hidden) {
          this._currentIndex++;
          this._updateBoard();
        }
      }, seconds * 1000);
    }
  }

  // Stops any running flip on a cell. With finish=true, a flip that was cut short
  // is completed immediately so the tile never stays stuck on a random glyph.
  _clearCellTimers(cell, finish = false) {
    if (!cell) return;
    const interrupted = !!(cell._flipTimeout || cell._flipInterval);
    if (finish && interrupted && cell._flipTarget != null) {
      const span = cell.querySelector('span');
      if (span) span.textContent = cell._flipTarget;
    }
    if (cell._flipTimeout) {
      clearTimeout(cell._flipTimeout);
      cell._flipTimeout = null;
    }
    if (cell._flipInterval) {
      clearInterval(cell._flipInterval);
      cell._flipInterval = null;
    }
    cell.classList.remove('flipping');
  }

  _clearAllCellTimers() {
    if (!this.shadowRoot) return;
    const cells = this.shadowRoot.querySelectorAll('.flap-cell');
    cells.forEach((cell) => this._clearCellTimers(cell, true));
  }

  _useMetricDistance() {
    const lengthUnit = this._hass && this._hass.config && this._hass.config.unit_system && this._hass.config.unit_system.length;
    return lengthUnit === 'km';
  }

  _formatDistanceFromKm(kmVal) {
    if (kmVal == null || Number.isNaN(Number(kmVal))) return '';
    const km = Number(kmVal);
    if (this._useMetricDistance()) {
      return `${km.toFixed(1)}KM`;
    }
    return `${(km * 0.621371).toFixed(1)}MI`;
  }

  _pickValidCallsign(...candidates) {
    const invalid = new Set(['', 'N/A', 'NONE', 'UNKNOWN', 'BLOCKED', 'NULL', 'UNDEFINED']);
    for (const val of candidates) {
      if (val == null) continue;
      const clean = String(val).trim().toUpperCase();
      if (!invalid.has(clean) && !/^\d+\s+AIRCRAFT\s+DETECTED$/i.test(clean)) {
        return clean;
      }
    }
    return 'LADD BLOCKED';
  }

  _extractNumberedAircraft(attrs) {
    if (!attrs || typeof attrs !== 'object') return [];
    return Object.keys(attrs)
      .filter((key) => /^aircraft_\d+$/.test(key) && attrs[key] && typeof attrs[key] === 'object')
      .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]))
      .map((key) => attrs[key]);
  }

  // Normalizes one ADS-B aircraft into the fields used for LADD matching.
  // Distances are kept in miles internally so scoring is unit-independent.
  _normalizeAdsbItem(f) {
    const rawCallsign = this._pickValidCallsign(
      f.flight,
      f.callsign,
      f.tail,
      f.r,
      f.registration,
      f.hex,
      f.icao
    );
    const alt = f.altitude_ft != null ? f.altitude_ft : f.alt_baro != null ? f.alt_baro : f.altitude;
    const spd = f.speed_kts != null ? f.speed_kts : f.gs != null ? f.gs : f.ground_speed;
    const hdg = f.heading != null ? f.heading : f.track;

    let distanceMiles = NaN;
    if (f.distance_km != null && !Number.isNaN(Number(f.distance_km))) {
      distanceMiles = Number(f.distance_km) * 0.621371;
    } else if (f.dst != null && !Number.isNaN(Number(f.dst))) {
      distanceMiles = Number(f.dst) * 1.15078;
    } else if (f.distance != null && !Number.isNaN(Number(f.distance))) {
      distanceMiles = Number(f.distance) * 1.15078;
    }

    const numericAlt = typeof alt === 'number' ? alt : alt === 'ground' ? 0 : Number(alt);
    const numericSpd = spd != null ? Number(spd) : NaN;
    const numericHdg = hdg != null ? Number(hdg) : NaN;
    const latVal = f.latitude != null ? Number(f.latitude) : f.lat != null ? Number(f.lat) : NaN;
    const lonVal = f.longitude != null ? Number(f.longitude) : f.lon != null ? Number(f.lon) : NaN;

    return {
      callsign: rawCallsign,
      aircraftCode: String(f.aircraft_type || f.t || f.type || 'N/A').trim().toUpperCase(),
      _rawAlt: numericAlt,
      _rawSpd: numericSpd,
      _rawHdg: numericHdg,
      _rawDstMiles: distanceMiles,
      _lat: latVal,
      _lon: lonVal,
    };
  }

  _getAdsbPool() {
    if (!this._hass) return [];
    const adsbEntity = this._sources().adsb;
    if (!adsbEntity) return [];
    const adsbState = this._hass.states[adsbEntity];
    if (!adsbState) return [];

    const stateVal = String(adsbState.state || '').trim().toLowerCase();
    if (stateVal === 'unavailable' || stateVal === 'unknown') return [];

    const attrs = adsbState.attributes || {};

    // adsb_nearby "Nearest Aircraft" numbered keys (aircraft_1, aircraft_2, ...)
    const numberedList = this._extractNumberedAircraft(attrs);
    if (numberedList.length > 0) {
      return numberedList.map((item) => this._normalizeAdsbItem(item));
    }

    // Array fallback if the ADS-B sensor exposes a list instead
    const list = Array.isArray(attrs.aircraft) ? attrs.aircraft : Array.isArray(attrs.nearby) ? attrs.nearby : [];
    return list.map((item) => this._normalizeAdsbItem(item));
  }

  _matchAdsbFlight(frFlight, adsbPool, excludedCallsigns) {
    if (!adsbPool.length) return null;

    const frType = (frFlight.aircraft_code || '').trim().toUpperCase();
    const frAlt = frFlight.altitude != null ? Number(frFlight.altitude) : NaN;
    const frSpd = frFlight.ground_speed != null ? Number(frFlight.ground_speed) : NaN;
    const frHdg = frFlight.heading != null ? Number(frFlight.heading) : NaN;
    const frLat = frFlight.latitude != null ? Number(frFlight.latitude) : NaN;
    const frLon = frFlight.longitude != null ? Number(frFlight.longitude) : NaN;
    const frDstMiles = frFlight.distance != null ? Number(frFlight.distance) * 0.621371 : NaN;

    let bestMatch = null;
    let bestScore = -Infinity;

    for (const candidate of adsbPool) {
      if (!candidate.callsign || candidate.callsign === 'LADD BLOCKED') continue;
      if (excludedCallsigns.has(candidate.callsign)) continue;

      let score = 0;

      // 1. Aircraft ICAO type check (strongest discriminator)
      const candType = candidate.aircraftCode;
      if (frType && frType !== 'N/A' && candType && candType !== 'N/A') {
        if (frType === candType) {
          score += 100;
        } else if (
          frType.length >= 3 &&
          candType.length >= 3 &&
          frType.slice(0, 3) === candType.slice(0, 3)
        ) {
          // Same aircraft family (e.g. E75S vs E75L): the two services label
          // subtypes differently, so allow it with a lower score.
          score += 70;
        } else {
          continue;
        }
      }

      // 2. Geographic proximity (separates two identical aircraft models in different spots)
      if (
        !Number.isNaN(frLat) &&
        !Number.isNaN(frLon) &&
        !Number.isNaN(candidate._lat) &&
        !Number.isNaN(candidate._lon)
      ) {
        const dLat = (frLat - candidate._lat) * 69.0;
        const dLon = (frLon - candidate._lon) * 54.6;
        const distMiles = Math.hypot(dLat, dLon);
        if (distMiles <= 5) score += 45;
        else if (distMiles <= 12) score += 20;
        else if (distMiles > 25) score -= 40;
      } else if (!Number.isNaN(frDstMiles) && !Number.isNaN(candidate._rawDstMiles)) {
        const dstDiff = Math.abs(frDstMiles - candidate._rawDstMiles);
        if (dstDiff <= 3) score += 30;
        else if (dstDiff <= 8) score += 10;
        else if (dstDiff > 15) score -= 30;
      }

      // 3. Compass heading / track tolerance (within +/- 25 deg)
      if (!Number.isNaN(frHdg) && !Number.isNaN(candidate._rawHdg)) {
        const rawDiff = Math.abs(frHdg - candidate._rawHdg) % 360;
        const hdgDiff = rawDiff > 180 ? 360 - rawDiff : rawDiff;
        if (hdgDiff <= 25) score += 25;
        else if (hdgDiff <= 50) score += 5;
        else score -= 35;
      }

      // 4. Wide altitude & speed bands (absorbs polling lag between sources)
      if (!Number.isNaN(frAlt) && !Number.isNaN(candidate._rawAlt)) {
        const altDiff = Math.abs(frAlt - candidate._rawAlt);
        if (altDiff <= 2500) score += 20;
        else if (altDiff <= 5000) score += 5;
        else score -= 40;
      }

      if (!Number.isNaN(frSpd) && !Number.isNaN(candidate._rawSpd)) {
        const spdDiff = Math.abs(frSpd - candidate._rawSpd);
        if (spdDiff <= 60) score += 15;
        else if (spdDiff > 120) score -= 25;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    return bestScore >= 80 ? bestMatch : null;
  }

  _extractFlights(stateObj) {
    // Flightradar24 is the required primary source. If it is missing, down, or
    // has no flights feed, report offline instead of showing partial data.
    if (!stateObj) {
      return { offline: true, reason: 'ENTITY NOT FOUND', flights: [] };
    }

    const rawState = String(stateObj.state || '').trim().toLowerCase();
    const attrs = stateObj.attributes || {};

    if (
      rawState === 'unavailable' ||
      rawState === 'unknown' ||
      rawState === 'off' ||
      !Array.isArray(attrs.flights)
    ) {
      return { offline: true, reason: 'CHECK INTEGRATION', flights: [] };
    }

    const adsbPool = this._getAdsbPool();
    const knownCallsigns = new Set();

    attrs.flights.forEach((f) => {
      const cs = (f.callsign || f.flight_number || '').trim().toUpperCase();
      if (cs && cs !== 'BLOCKED' && cs !== 'N/A') {
        knownCallsigns.add(cs);
      }
    });

    const flights = attrs.flights.map((f) => {
      let rawCallsign = (f.callsign || f.flight_number || f.aircraft_registration || '').trim().toUpperCase();
      const isBlocked = !rawCallsign || rawCallsign === 'BLOCKED' || rawCallsign === 'N/A';

      if (isBlocked) {
        const matched = this._matchAdsbFlight(f, adsbPool, knownCallsigns);
        if (matched) {
          knownCallsigns.add(matched.callsign);
          rawCallsign = `${matched.callsign} (LADD)`;
        } else {
          rawCallsign = 'LADD BLOCKED';
        }
      }

      // Flightradar24 flags aircraft on the ground (on_ground: 1). Barometric altitude
      // alone is unreliable for this: it can read 0 or negative while airborne at
      // high pressure, and shows field elevation (not 0) at high-elevation airports.
      // GND = on the ground, a number = reported altitude, --- = altitude unknown.
      const alt = f.altitude != null ? Number(f.altitude) : NaN;
      const onGround = Number(f.on_ground) === 1 || f.on_ground === true;

      return {
        callsign: rawCallsign,
        airline: this._cleanAirline(f.airline_short || f.airline),
        airlineCode: (f.airline_icao || f.airline_iata || '').trim().toUpperCase(),
        origin: (f.airport_origin_code_iata || f.airport_origin_code_icao || '').trim().toUpperCase(),
        dest: (f.airport_destination_code_iata || f.airport_destination_code_icao || '').trim().toUpperCase(),
        aircraftCode: (f.aircraft_code || 'N/A').trim().toUpperCase(),
        altitude: onGround ? 'GND' : Number.isNaN(alt) ? '---' : `${Math.round(alt)}FT`,
        speed: f.ground_speed != null ? `${Math.round(f.ground_speed)}KT` : '--KT',
        distance: f.distance != null ? this._formatDistanceFromKm(f.distance) : '',
        depTime: this._formatUnixTime(f.time_scheduled_departure || f.time_real_departure),
        arrTime: this._formatUnixTime(f.time_estimated_arrival || f.time_scheduled_arrival),
        isBlocked,
      };
    });

    return { offline: false, reason: '', flights };
  }
  _formatUnixTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toTimeString().slice(0, 5);
  }

  // Normalizes an airline name; Flightradar24 reports "Private owner" for private aircraft.
  _cleanAirline(name) {
    const clean = String(name || '').trim().toUpperCase();
    return /^PRIVATE\b/.test(clean) ? 'PRIVATE' : clean;
  }

  // Fits an airline name into the space left on row 2. Names that already fit are
  // kept as-is; longer ones drop a trailing generic word (DELTA AIR LINES -> DELTA).
  // If it still does not fit, use the airline's code (AIR FRANCE -> AFR) when known.
  _fitAirline(name, maxLen, code = '') {
    if (name.length <= maxLen) return name;
    const shorter = name.replace(/\s+(AIR\s?LINES?|AIRWAYS?|AIR)$/, '') || name;
    if (shorter.length <= maxLen) return shorter;
    return code && code.length <= maxLen ? code : shorter;
  }

  _pad(str, len) {
    const clean = String(str || '').toUpperCase();
    return clean.length >= len ? clean.slice(0, len) : clean + ' '.repeat(len - clean.length);
  }

  // Shown when no Flightradar24 sensor is configured or detected.
  _setupLines() {
    const cols = Number(this._config.columns) || 20;
    return ['SETUP NEEDED', 'USE THE VISUAL', 'EDITOR TO PICK', 'YOUR FR24', 'SENSOR'].map((line) =>
      this._pad(line, cols)
    );
  }

  _buildBoardLines(result) {
    const cols = Number(this._config.columns) || 20;

    if (result.offline) {
      return [
        this._pad('FR24 FEED OFFLINE', cols),
        this._pad(result.reason || 'CHECK INTEGRATION', cols),
        this._pad('NO DATA AVAILABLE', cols),
        this._pad('', cols),
        this._pad('', cols),
      ];
    }

    const flights = result.flights;
    if (!flights.length) {
      return [
        this._pad('NO AIRCRAFT IN RANGE', cols),
        this._pad('SCANNING AIRSPACE...', cols),
        this._pad('', cols),
        this._pad('', cols),
        this._pad('', cols),
      ];
    }

    const idx = this._currentIndex % flights.length;
    const f = flights[idx];
    const counter = `${idx + 1}/${flights.length}`;

    // Row 1: Flight / callsign + rotation counter
    const row1 = this._pad(f.callsign, cols - counter.length) + counter;

    // Row 2: Origin > Destination + airline
    const routeText = `${f.origin || '---'} > ${f.dest || '---'}  `;
    const airlineLabel = f.airline
      ? this._fitAirline(f.airline, cols - routeText.length, f.airlineCode)
      : f.isBlocked
      ? 'PRIVATE'
      : 'UNKNOWN';
    const row2 = this._pad(routeText + airlineLabel, cols);

    // Row 3: Departure & arrival times
    const row3 = this._pad(`DEP ${f.depTime || '--:--'}  ARR ${f.arrTime || '--:--'}`, cols);

    // Row 4: Telemetry (altitude & speed)
    const row4 = this._pad(`ALT ${f.altitude}  ${f.speed}`, cols);

    // Row 5: Aircraft type & distance from home
    const row5 = this._pad(`ACFT ${f.aircraftCode}  ${f.distance}`, cols);

    return [row1, row2, row3, row4, row5];
  }
  _renderShell() {
    const cols = Number(this._config.columns) || 20;
    const rows = 5;

    let gridHtml = '';
    for (let r = 0; r < rows; r++) {
      gridHtml += `<div class="flap-row" data-row="${r}">`;
      for (let c = 0; c < cols; c++) {
        gridHtml += `<div class="flap-cell" data-row="${r}" data-col="${c}"><span> </span></div>`;
      }
      gridHtml += `</div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: 'Roboto Condensed', 'Arial Narrow', 'Liberation Sans', 'Helvetica Neue', sans-serif;
          --flap-font-size: 16px;
        }
        ha-card {
          display: block;
          background: #121316;
          border: 2px solid #2c2f33;
          border-radius: 12px;
          padding: 12px;
          color: #ffcf40;
          box-shadow: 0 8px 24px rgba(0,0,0,0.45);
          cursor: pointer;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-family: 'Roboto Mono', monospace;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 1.2px;
          color: #9ba0a6;
          margin-bottom: 10px;
          border-bottom: 1px solid #26282c;
          padding-bottom: 6px;
        }
        .board {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .flap-row {
          display: grid;
          grid-template-columns: repeat(${cols}, minmax(0, 1fr));
          gap: 2.5px;
        }
        .flap-cell {
          position: relative;
          aspect-ratio: 0.62;
          background: linear-gradient(
            to bottom,
            #282b32 0%,
            #22252b 48%,
            #111215 50%,
            #1c1e23 52%,
            #191b20 100%
          );
          border-radius: 3px;
          overflow: hidden;
          box-shadow: inset 0 1px 1px rgba(255,255,255,0.12), 0 1px 3px rgba(0,0,0,0.8);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 900;
          font-size: var(--flap-font-size);
          line-height: 1;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
        }
        .flap-cell::after {
          content: '';
          position: absolute;
          top: 50%;
          left: 0;
          right: 0;
          height: 1px;
          background: rgba(0, 0, 0, 0.55);
          pointer-events: none;
        }
        .flap-cell span {
          display: block;
          text-align: center;
          transform: scaleY(1.08);
        }
        .flap-row[data-row="0"] .flap-cell {
          color: #ffffff;
        }
        .flap-row[data-row="1"] .flap-cell {
          color: #ffcf40;
        }
        .flap-row[data-row="2"] .flap-cell,
        .flap-row[data-row="3"] .flap-cell,
        .flap-row[data-row="4"] .flap-cell {
          color: #f2be35;
        }
        .flap-cell.flipping {
          animation: flapPulse 0.14s ease-in-out;
        }
        @keyframes flapPulse {
          0% { transform: scaleY(1); }
          50% { transform: scaleY(0.15); filter: brightness(1.35); }
          100% { transform: scaleY(1); }
        }
      </style>
      <ha-card>
        <div class="header">
          <span class="title"></span>
          <span>TAP TO CYCLE</span>
        </div>
        <div class="board">${gridHtml}</div>
      </ha-card>
    `;

    this.shadowRoot.querySelector('.header .title').textContent = this._config.title;

    const boardEl = this.shadowRoot.querySelector('.board');
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width > 0) {
          const cellWidth = (width - (cols - 1) * 2.5) / cols;
          const fontSize = Math.max(10, Math.floor(cellWidth * 1.15));
          this.style.setProperty('--flap-font-size', `${fontSize}px`);
        }
      }
    });
    this._resizeObserver.observe(boardEl);

    this.shadowRoot.querySelector('ha-card').addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._resetCycleTimer();
      this._currentIndex++;
      this._updateBoard();
    });
  }

  _updateBoard(snap = false) {
    if (!this._hass) return;
    const entity = this._sources().entity;
    const lines = entity
      ? this._buildBoardLines(this._extractFlights(this._hass.states[entity]))
      : this._setupLines();
    const immediate = snap || document.hidden;

    lines.forEach((line, r) => {
      const prevLine = this._lastRenderedLines[r] || '';
      if (!immediate && line === prevLine) return;

      for (let c = 0; c < line.length; c++) {
        const targetChar = line[c];
        if (!immediate && prevLine[c] === targetChar) continue;

        const cell = this.shadowRoot.querySelector(`.flap-cell[data-row="${r}"][data-col="${c}"]`);
        if (!cell) continue;

        if (immediate) {
          this._clearCellTimers(cell);
          const span = cell.querySelector('span');
          if (span) span.textContent = targetChar;
        } else {
          this._animateCell(cell, targetChar, c * 18);
        }
      }
    });

    this._lastRenderedLines = lines;
  }

  _animateCell(cell, targetChar, delayMs) {
    this._clearCellTimers(cell);
    const span = cell.querySelector('span');
    cell._flipTarget = targetChar;

    cell._flipTimeout = setTimeout(() => {
      cell._flipTimeout = null;
      let steps = 4 + Math.floor(Math.random() * 5);

      cell._flipInterval = setInterval(() => {
        steps--;
        cell.classList.remove('flipping');
        void cell.offsetWidth;
        cell.classList.add('flipping');

        if (steps <= 0) {
          this._clearCellTimers(cell);
          span.textContent = targetChar;
        } else {
          span.textContent = this._chars[Math.floor(Math.random() * this._chars.length)];
        }
      }, this._config.flip_speed_ms);
    }, delayMs);
  }

  getCardSize() {
    return 4;
  }
}

class OverheadSplitflapCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._form = null;
    this._schemaSig = '';
  }

  setConfig(config) {
    this._config = {
      title: 'OVERHEAD RADAR',
      columns: 20,
      cycle_seconds: 12,
      flip_speed_ms: 45,
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) {
      this._form.hass = hass;
      this._refreshSchema();
    }
  }

  // Limit a sensor picker to the sensors found in Home Assistant, plus the
  // value already configured. With nothing found, the picker stays unfiltered.
  _entitySelector(detected, current) {
    if (!detected.length) return { entity: { domain: 'sensor' } };
    const include = [...new Set([...detected, current].filter(Boolean))];
    return { entity: { domain: 'sensor', include_entities: include } };
  }

  _buildSchema() {
    const found = detectSources(this._hass);
    return [
      {
        name: 'entity',
        required: true,
        selector: this._entitySelector(found.fr24, this._config.entity),
      },
      {
        name: 'adsb_entity',
        selector: this._entitySelector(found.adsb, this._config.adsb_entity),
      },
      {
        name: 'title',
        selector: { text: {} },
      },
      {
        type: 'grid',
        name: '',
        schema: [
          {
            name: 'columns',
            selector: { number: { min: 14, max: 32, mode: 'box' } },
          },
          {
            name: 'cycle_seconds',
            selector: { number: { min: 0, max: 120, unit_of_measurement: 's', mode: 'box' } },
          },
          {
            name: 'flip_speed_ms',
            selector: { number: { min: 15, max: 150, unit_of_measurement: 'ms', mode: 'box' } },
          },
        ],
      },
    ];
  }

  _refreshSchema() {
    const schema = this._buildSchema();
    const sig = JSON.stringify(schema.slice(0, 2));
    if (sig !== this._schemaSig) {
      this._schemaSig = sig;
      this._form.schema = schema;
    }
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement('ha-form');

      this._form.computeLabel = (schema) => {
        const labels = {
          entity: 'Flightradar24 Sensor (Required: sensor.flightradar24_current_in_area)',
          adsb_entity: 'ADS-B Nearest Aircraft Sensor (Optional: sensor.adsb_nearby_nearest_aircraft, unmasks LADD-blocked flights)',
          title: 'Board Header Title',
          columns: 'Columns (Tiles per Row)',
          cycle_seconds: 'Auto-Cycle Interval (0 = Manual Only)',
          flip_speed_ms: 'Flap Flip Speed',
        };
        return labels[schema.name] || schema.name;
      };

      this._form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        const updated = { ...ev.detail.value };
        if (!updated.adsb_entity) {
          delete updated.adsb_entity;
        }
        this._config = updated;
        this.dispatchEvent(
          new CustomEvent('config-changed', {
            detail: { config: updated },
            bubbles: true,
            composed: true,
          })
        );
      });

      this.appendChild(this._form);
    }

    if (this._hass) {
      this._form.hass = this._hass;
    }
    this._refreshSchema();
    this._form.data = this._config;
  }
}
customElements.define('overhead-splitflap-card', OverheadSplitflapCard);
customElements.define('overhead-splitflap-card-editor', OverheadSplitflapCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'overhead-splitflap-card',
  name: 'Overhead Split-Flap Radar Card',
  description: 'Displays live overhead flights on a mechanical airport split-flap board.',
  preview: true,
});
