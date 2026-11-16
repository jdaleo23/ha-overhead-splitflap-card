[![Release](https://img.shields.io/github/v/release/jdaleo23/ha-overhead-splitflap-card?style=for-the-badge)](https://github.com/jdaleo23/ha-overhead-splitflap-card/releases)
[![HACS Badge](https://img.shields.io/badge/HACS-custom-blue.svg?style=for-the-badge)](https://github.com/hacs/integration)
![Downloads](https://img.shields.io/github/downloads/jdaleo23/ha-overhead-splitflap-card/total?style=for-the-badge)
![Latest Downloads](https://img.shields.io/github/downloads/jdaleo23/ha-overhead-splitflap-card/latest/total?style=for-the-badge)

[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-red.svg?style=for-the-badge)](https://paypal.me/jordandaleo)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_☕-red?style=for-the-badge&logo=ko-fi&logoColor=white&labelColor=grey)](https://ko-fi.com/jdaleo23)

# Overhead Split-Flap Radar Card

A mechanical airport-style split-flap (Solari) Lovelace card for Home Assistant that displays live aircraft flying over your home.

![Overhead Split-Flap Radar Card Preview](preview.png)

## Supported Integrations & Required Entities

This card is a **frontend dashboard card**, it reads flight telemetry from existing Home Assistant flight-tracking integrations rather than polling external APIs directly.

You need **at least one** of the following HACS integrations installed and configured for your home coordinates:

### 1. Flightradar24 (Recommended for Commercial Routes & Schedules)
- **Integration:** [AlexandrErohin/home-assistant-flightradar24](https://github.com/AlexandrErohin/home-assistant-flightradar24)
- **Entity to use:** `sensor.flightradar24_current_in_area` *(Friendly name: **Current in area**)*
- **What it provides:** Callsign, airline, origin/destination airport codes, scheduled/estimated departure and arrival times, aircraft type, altitude, speed, and distance.

### 2. ADS-B Nearby / adsb.lol (Recommended for Unfiltered & Private Traffic)
- **Integration:** [matthewgall/homeassistant-nearbyaircraft](https://github.com/matthewgall/homeassistant-nearbyaircraft)
- **Entity to use:** `sensor.adsb_nearby_..._nearest_aircraft` *(Friendly name: **Nearest Aircraft**, numbered list icon)*
- **What it provides:** Unfiltered ADS-B transponder data including private/LADD-blocked tail numbers, military aircraft, aircraft model descriptions, origin/destination airports (when available), altitude, speed, heading, and distance. *(Note: Raw ADS-B feeds do not include scheduled departure or arrival times.)*

### 3. Hybrid Mode (Best of Both Worlds)
If you run **both** integrations, set **Primary Flight Sensor** (`entity`) to your Flightradar24 `Current in area` sensor and **Secondary ADS-B Sensor** (`adsb_entity`) to your ADS-B Nearby `Nearest Aircraft` sensor.

Whenever Flightradar24 masks a private jet as `BLOCKED` (FAA LADD filtering), the card automatically cross-references all aircraft in your `Nearest Aircraft` sensor using multi-factor telemetry matching (ICAO aircraft type, GPS proximity, compass heading, and altitude/speed bands) to unmask the real tail number while preserving full schedules and route data for commercial flights.

> **Important, `Nearest Aircraft` vs. `Closest Aircraft` (`adsb_nearby`):**
> The `adsb_nearby` integration creates several sensors per location. **Always select `Nearest Aircraft` (`*_nearest_aircraft`)** rather than `Closest Aircraft` or `Aircraft in Range`:
> - **`Nearest Aircraft`** exposes a ranked list of **all** aircraft detected in your radius (`aircraft_1`, `aircraft_2`, etc.), allowing the card to cycle through multiple flights and accurately match LADD-blocked aircraft even when commercial airliners are closer.
> - **`Closest Aircraft`** only exposes data for the single nearest plane and hides all other traffic in range.

> **Future Integration Support:** Support for additional flight and local ADS-B integrations, including **OpenSky Network**, **airplanes.live**, **adsb.fi**, and local **`dump1090` / `readsb`** receivers, is planned for future releases.

---

## Installation

### Via HACS
1. Open **HACS** in Home Assistant and search for **Overhead Split-Flap Radar Card**. *(If it is not yet listed in the default store, click the three dots `⋮` in the top-right corner, select **Custom repositories**, paste `https://github.com/jdaleo23/ha-overhead-splitflap-card`, and choose **Dashboard**.)*
2. Click **Download**.
3. Refresh your browser (`Ctrl+Shift+R` / `Cmd+Shift+R`) or clear cache in the Home Assistant Companion App.

### Manual Installation
1. Download `overhead-splitflap-card.js` from the [latest release](https://github.com/jdaleo23/ha-overhead-splitflap-card/releases/latest).
2. Copy it to `/config/www/overhead-splitflap-card.js`.
3. Add `/local/overhead-splitflap-card.js` as a **JavaScript Module** under **Settings → Dashboards → Resources**.

---

## Configuration

### Visual Card Editor (Recommended)
1. Open your dashboard, click **Edit Dashboard** (pencil icon), and select **+ Add Card**.
2. Search for **Overhead Split-Flap Radar Card** and click it.
3. Choose your entities from the dropdown menus and adjust your board settings visually, no YAML required:

| Field | Flightradar24 Setup | ADS-B Nearby Setup | Hybrid Setup (Recommended) |
| :--- | :--- | :--- | :--- |
| **Primary Flight Sensor** (`entity`) | `sensor.flightradar24_current_in_area` | `sensor.adsb_nearby_..._nearest_aircraft` | `sensor.flightradar24_current_in_area` |
| **Secondary ADS-B Sensor** (`adsb_entity`) | *Leave blank* | *Leave blank* | `sensor.adsb_nearby_..._nearest_aircraft` |

### YAML Configuration
If you prefer YAML, add the card using the manual card editor:

```yaml
type: custom:overhead-splitflap-card
entity: sensor.flightradar24_current_in_area
adsb_entity: sensor.adsb_nearby_nearest_aircraft # Optional
title: OVERHEAD AIRSPACE
columns: 20
cycle_seconds: 12
flip_speed_ms: 45
```

### Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `entity` | string | **Required** | Primary flight sensor (`sensor.flightradar24_current_in_area` or `sensor.adsb_nearby_..._nearest_aircraft`). |
| `adsb_entity` | string | `null` | Optional `*_nearest_aircraft` sensor used to unmask LADD-blocked flights when using Flightradar24. |
| `title` | string | `OVERHEAD RADAR` | Header text displayed in the top-left corner of the board. |
| `columns` | number | `20` | Number of split-flap character tiles per row (`14`-`32`). |
| `cycle_seconds` | number | `12` | Seconds before auto-cycling to the next overhead aircraft (`0` disables auto-cycle). |
| `flip_speed_ms` | number | `45` | Animation speed in milliseconds per character flip step (`15`-`150`). |

---

## Roadmap & Planned Features

- **Custom Themes & Colors:** Configurable tile background colors, hinge styles, and per-row text color presets (classic amber, crisp white, emerald radar green, or custom hex codes).
- **Customizable Rows & Field Toggles:** Ability to reorder rows, adjust row counts, and include or exclude specific telemetry fields (e.g., squawk code, vertical speed, heading, or registration).
- **Configurable Timing Controls:** Independent controls for cycle intervals, animation cascade delays, and idle board behavior when airspace is empty.
- **Optional Mechanical Sound Effects:** Toggleable synthesized split-flap clacking audio when tiles flip.
- **Expanded Data Sources:** Native attribute parsers for OpenSky Network and local RTL-SDR (`readsb` / `dump1090`) sensors.
