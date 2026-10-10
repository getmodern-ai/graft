/**
 * Open-Meteo's current weather in a named city (GRA-238, the first stock tool): the city's
 * coordinates from the geocoding API, then the current conditions there from the forecast API. Two
 * reads, each naming its host, so the module runs over any Open-Meteo connection whatever its
 * primary host (ADR 0010 as amended 2026-09-24). Hand-made; typed and checked against its manifest's
 * schema by the check (`src/workspace.test.ts`), which is where `Input` and `Context` come from.
 */
type Place = {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
};

type Current = {
  time: string;
  temperature_2m: number;
  wind_speed_10m: number;
  weather_code: number;
};

export default async (input: Input, ctx: Context) => {
  const search = new URLSearchParams({ name: input.city, count: "1", format: "json" });
  const geo = await ctx.fetch(`/v1/search?${search}`, { host: "geocoding-api.open-meteo.com" });
  if (!geo.ok) throw new Error(`GET /v1/search ${geo.status}: ${await geo.text()}`);
  const found = (await geo.json()) as { results?: Place[] };
  const place = found.results?.[0];
  if (!place) return { found: false, city: input.city };

  const query = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,wind_speed_10m,weather_code",
    timezone: "auto",
  });
  const res = await ctx.fetch(`/v1/forecast?${query}`, { host: "api.open-meteo.com" });
  if (!res.ok) throw new Error(`GET /v1/forecast ${res.status}: ${await res.text()}`);
  const forecast = (await res.json()) as {
    current: Current;
    current_units: { temperature_2m: string; wind_speed_10m: string };
  };
  return {
    found: true,
    city: place.name,
    country: place.country ?? null,
    latitude: place.latitude,
    longitude: place.longitude,
    time: forecast.current.time,
    temperature: forecast.current.temperature_2m,
    temperatureUnit: forecast.current_units.temperature_2m,
    windSpeed: forecast.current.wind_speed_10m,
    windSpeedUnit: forecast.current_units.wind_speed_10m,
    weatherCode: forecast.current.weather_code,
  };
};
