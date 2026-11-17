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
    let defaultEntity = 'sensor.flightradar24_current_in_area';
    if (hass && hass.states && !hass.states[defaultEntity]) {
      const candidate = Object.keys(hass.states).find(
        (id) =>
          id.startsWith('sensor.') &&
          (id.includes('flightradar24') || id.endsWith('_nearest_aircraft') || id.endsWith('_closest_aircraft'))
      );
      if (candidate) defaultEntity = candidate;
    }
    return {
      entity: defaultEntity,
      title: 'OVERHEAD RADAR',
      columns: 20,
      cycle_seconds: 12,
      flip_speed_ms: 45,
    };
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error('Please select a flight sensor entity.');
    }
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

  _clearCellTimers(cell) {
    if (!cell) return;
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
    cells.forEach((cell) => this._clearCellTimers(cell));
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

  _formatDistanceFromNm(nmVal) {
    if (nmVal == null || Number.isNaN(Number(nmVal))) return '';
    const nm = Number(nmVal);
    if (this._useMetricDistance()) {
      return `${(nm * 1.852).toFixed(1)}KM`;
    }
    return `${(nm * 1.15078).toFixed(1)}MI`;
  }

  _isInactiveState(stateVal) {
    const inactive = [
      '',
      'OFF',
      'UNAVAILABLE',
      'UNKNOWN',
      'NONE',
      'N/A',
      'NO AIRCRAFT',
      'NO AIRCRAFT DETECTED',
      '0 AIRCRAFT',
      '0',
    ];
    return inactive.includes(stateVal) || /^\d+\s+AIRCRAFT\s+DETECTED$/i.test(stateVal);
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

  _normalizeAdsbItem(f, fallbackCallsign = '') {
    const rawCallsign = this._pickValidCallsign(
      f.flight,
      f.callsign,
      f.tail,
      f.r,
      f.registration,
      fallbackCallsign,
      f.hex,
      f.icao
    );
    const alt = f.altitude_ft != null ? f.altitude_ft : f.alt_baro != null ? f.alt_baro : f.altitude;
    const spd = f.speed_kts != null ? f.speed_kts : f.gs != null ? f.gs : f.ground_speed;
    const hdg = f.heading != null ? f.heading : f.track;

    let distanceStr = '';
    let distanceMiles = NaN;
    if (f.distance_km != null && !Number.isNaN(Number(f.distance_km))) {
      const km = Number(f.distance_km);
      distanceStr = this._formatDistanceFromKm(km);
      distanceMiles = km * 0.621371;
    } else if (f.dst != null && !Number.isNaN(Number(f.dst))) {
      const nm = Number(f.dst);
      distanceStr = this._formatDistanceFromNm(nm);
      distanceMiles = nm * 1.15078;
    } else if (f.distance != null && !Number.isNaN(Number(f.distance))) {
      const nm = Number(f.distance);
      distanceStr = this._formatDistanceFromNm(nm);
      distanceMiles = nm * 1.15078;
    }

    const numericAlt = typeof alt === 'number' ? alt : alt === 'ground' ? 0 : Number(alt);
    const numericSpd = spd != null ? Number(spd) : NaN;
    const numericHdg = hdg != null ? Number(hdg) : NaN;
    const latVal = f.latitude != null ? Number(f.latitude) : f.lat != null ? Number(f.lat) : NaN;
    const lonVal = f.longitude != null ? Number(f.longitude) : f.lon != null ? Number(f.lon) : NaN;

    const cleanReg = this._pickValidCallsign(f.tail, f.r, f.registration);

    return {
      callsign: rawCallsign,
      airline: String(f.operator || f.ownOp || '').toUpperCase(),
      origin: String(f.origin_iata || f.origin_icao || f.origin || '').toUpperCase(),
      dest: String(f.destination_iata || f.destination_icao || f.destination || '').toUpperCase(),
      aircraftCode: String(f.aircraft_type || f.t || f.type || 'N/A').trim().toUpperCase(),
      aircraftModel: String(f.aircraft_description || f.desc || f.aircraft_model || '').toUpperCase(),
      reg: cleanReg === 'LADD BLOCKED' ? '' : cleanReg,
      heading: !Number.isNaN(numericHdg) ? `${Math.round(numericHdg)}DEG` : '',
      altitude: !Number.isNaN(numericAlt) ? (numericAlt <= 0 ? 'GND' : `${Math.round(numericAlt)}FT`) : 'GND',
      speed: !Number.isNaN(numericSpd) ? `${Math.round(numericSpd)}KT` : '--KT',
      distance: distanceStr,
      depTime: '',
      arrTime: '',
      _rawAlt: numericAlt,
      _rawSpd: numericSpd,
      _rawHdg: numericHdg,
      _rawDstMiles: distanceMiles,
      _lat: latVal,
      _lon: lonVal,
    };
  }

  _getAdsbPool() {
    if (!this._config.adsb_entity || !this._hass) return [];
    const adsbState = this._hass.states[this._config.adsb_entity];
    if (!adsbState) return [];

    const stateVal = String(adsbState.state || '').trim().toUpperCase();
    const attrs = adsbState.attributes || {};

    // 1. adsb_nearby "Nearest Aircraft" numbered keys (aircraft_1, aircraft_2, ...)
    const numberedList = this._extractNumberedAircraft(attrs);
    if (numberedList.length > 0) {
      return numberedList.map((item) => this._normalizeAdsbItem(item));
    }

    // 2. Array-based ADS-B attributes (aircraft or nearby)
    const list = Array.isArray(attrs.aircraft) ? attrs.aircraft : Array.isArray(attrs.nearby) ? attrs.nearby : [];
    if (list.length > 0) {
      return list.map((item) => this._normalizeAdsbItem(item));
    }

    // 3. Single aircraft sensor fallback (e.g., Closest Aircraft)
    if (!this._isInactiveState(stateVal)) {
      return [this._normalizeAdsbItem(attrs, stateVal)];
    }
    return [];
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
    if (!stateObj || !stateObj.attributes) return [];
    const attrs = stateObj.attributes;
    const stateVal = String(stateObj.state || '').trim().toUpperCase();

    // 1. Flightradar24 integration format (attributes.flights)
    if (Array.isArray(attrs.flights)) {
      const adsbPool = this._getAdsbPool();
      const knownCallsigns = new Set();

      attrs.flights.forEach((f) => {
        const cs = (f.callsign || f.flight_number || '').trim().toUpperCase();
        if (cs && cs !== 'BLOCKED' && cs !== 'N/A') {
          knownCallsigns.add(cs);
        }
      });

      return attrs.flights.map((f) => {
        let rawCallsign = (f.callsign || f.flight_number || f.aircraft_registration || '').trim().toUpperCase();
        let reg = (f.aircraft_registration || '').trim().toUpperCase();
        const isBlocked = !rawCallsign || rawCallsign === 'BLOCKED' || rawCallsign === 'N/A';

        if (isBlocked) {
          const matched = this._matchAdsbFlight(f, adsbPool, knownCallsigns);
          if (matched) {
            knownCallsigns.add(matched.callsign);
            rawCallsign = `${matched.callsign} (LADD)`;
            if (!reg && matched.reg) reg = matched.reg;
          } else {
            rawCallsign = 'LADD BLOCKED';
          }
        }

        return {
          callsign: rawCallsign,
          airline: (f.airline_short || f.airline || '').toUpperCase(),
          origin: (f.airport_origin_code_iata || f.airport_origin_code_icao || '').toUpperCase(),
          dest: (f.airport_destination_code_iata || f.airport_destination_code_icao || '').toUpperCase(),
          aircraftCode: (f.aircraft_code || 'N/A').toUpperCase(),
          aircraftModel: (f.aircraft_model || '').toUpperCase(),
          reg,
          heading: f.heading != null ? `${Math.round(f.heading)}DEG` : '',
          altitude: f.altitude != null ? `${Math.round(f.altitude)}FT` : 'GND',
          speed: f.ground_speed != null ? `${Math.round(f.ground_speed)}KT` : '--KT',
          distance: f.distance != null ? this._formatDistanceFromKm(f.distance) : '',
          depTime: this._formatUnixTime(f.time_scheduled_departure || f.time_real_departure),
          arrTime: this._formatUnixTime(f.time_estimated_arrival || f.time_scheduled_arrival),
        };
      });
    }

    // 2. adsb_nearby "Nearest Aircraft" numbered attributes (aircraft_1, aircraft_2, ...)
    const numberedList = this._extractNumberedAircraft(attrs);
    if (numberedList.length > 0) {
      return numberedList.map((f) => this._normalizeAdsbItem(f));
    }

    // 3. Array-based ADS-B sensor format (attributes.aircraft or attributes.nearby)
    const list = Array.isArray(attrs.aircraft) ? attrs.aircraft : Array.isArray(attrs.nearby) ? attrs.nearby : [];
    if (list.length > 0) {
      return list.map((f) => this._normalizeAdsbItem(f));
    }

    // 4. Single "Closest Aircraft" sensor format (top-level attributes)
    const hasSingleAircraftAttrs =
      attrs.altitude_ft != null ||
      attrs.alt_baro != null ||
      attrs.altitude != null ||
      attrs.speed_kts != null ||
      attrs.gs != null ||
      attrs.ground_speed != null ||
      attrs.hex != null ||
      attrs.icao != null ||
      attrs.aircraft_type != null ||
      attrs.t != null ||
      attrs.tail != null ||
      attrs.r != null;

    if (!this._isInactiveState(stateVal) && hasSingleAircraftAttrs) {
      return [this._normalizeAdsbItem(attrs, stateVal)];
    }

    return [];
  }

  _formatUnixTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toTimeString().slice(0, 5);
  }

  _pad(str, len) {
    const clean = String(str || '').toUpperCase();
    return clean.length >= len ? clean.slice(0, len) : clean + ' '.repeat(len - clean.length);
  }

  _buildBoardLines(flights) {
    const cols = Number(this._config.columns) || 20;
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

    const row1 = this._pad(f.callsign, cols - counter.length) + counter;

    const hasRoute = f.origin && f.dest;
    const row2Text = hasRoute
      ? `${f.origin} > ${f.dest}  ${f.airline}`
      : f.aircraftModel || f.airline || 'UNSCHEDULED FLIGHT';
    const row2 = this._pad(row2Text, cols);

    const hasTimes = f.depTime || f.arrTime;
    const row3Text = hasTimes
      ? `DEP ${f.depTime || '--:--'}  ARR ${f.arrTime || '--:--'}`
      : `REG ${f.reg || 'PRIVATE'}  HDG ${f.heading || '--'}`;
    const row3 = this._pad(row3Text, cols);

    const row4 = this._pad(`ALT ${f.altitude}  ${f.speed}`, cols);
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
    if (!this._hass || !this._config.entity) return;
    const stateObj = this._hass.states[this._config.entity];
    const flights = this._extractFlights(stateObj);
    const lines = this._buildBoardLines(flights);
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
    }
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.schema = [
        {
          name: 'entity',
          required: true,
          selector: { entity: { domain: 'sensor' } },
        },
        {
          name: 'adsb_entity',
          selector: { entity: { domain: 'sensor' } },
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

      this._form.computeLabel = (schema) => {
        const labels = {
          entity: 'Primary Flight Sensor (Flightradar24 Current in Area or ADS-B Nearest Aircraft)',
          adsb_entity: 'Secondary ADS-B Sensor (Select *_nearest_aircraft for LADD Unmasking)',
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
