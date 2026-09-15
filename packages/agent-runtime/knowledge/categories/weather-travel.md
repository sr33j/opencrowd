# Weather, geocoding, and travel

## Ranked paid paths
- **StableTravel Google Flights** — `https://stabletravel.dev/api/google-flights/search`; x402 Base; $0.02; **4.25/5, n_eff 3.4**.
  - GET airport IDs, dates, type, and filters; returned itineraries, prices, baggage, emissions, insights, and booking tokens [svc_744daf328cce98bb3e6e#r1] [svc_744daf328cce98bb3e6e#r2].
- **agenttoll Current Weather** — `https://agenttoll.dev/paid/env/weather-current`; x402 Base; price unreported; **3.91/5, n_eff 1.7**.
  - Coordinate-based request returned timestamp, temperature, humidity, precipitation, wind, and units [svc_96a8e00322354ea0351b#r1].
- **StableTravel airport observations** — `https://stabletravel.dev/api/flightaware/airports/KAUS/weather/observations`; mppx Tempo; ~$0.004; **3.74/5, n_eff 2.5**.
  - Rich METAR data supported airport decisions [svc_956af70cb0a94495356d#r1]. Substitute the actual airport code in the path; do not use a literal placeholder.
- **OpenWeather geocode** — `https://openweather.mpp.paywithlocus.com/openweather/geocode`; mppx Tempo; price unreported; **3.12/5, n_eff 4.9**.
  - Compact coordinates and region metadata; inspect the exact POST body before paying.

## Cheapest correct path
- Weather: Open-Meteo or national feeds. Geocoding: Nominatim. Once a free response supplies the requested current value, stop rather than buying confirmation. Use paid flights for structured comparison, not simple airport facts.
