import type { Coord } from './types';

// A route is [[lng,lat], ...]; `progress` is 0..1 by arc length along it.
// Every spatial question in BusMesh — where a bus is, whether it reached a stop,
// how far a relief bus is — reduces to a comparison on that single scalar.

const EARTH_R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: Coord, b: Coord): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/** Cumulative distance at each vertex, plus total length in metres. */
export function cumulative(line: Coord[]): { cum: number[]; total: number } {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1], line[i]));
  return { cum, total: cum[cum.length - 1] };
}

/** progress (0..1) -> interpolated position along the polyline. */
export function interpolate(line: Coord[], progress: number): { lat: number; lng: number } {
  const { cum, total } = cumulative(line);
  const target = Math.max(0, Math.min(1, progress)) * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const segStart = cum[i - 1];
  const segLen = cum[i] - segStart || 1;
  const f = (target - segStart) / segLen;
  const [lng1, lat1] = line[i - 1];
  const [lng2, lat2] = line[i];
  return { lng: lng1 + (lng2 - lng1) * f, lat: lat1 + (lat2 - lat1) * f };
}

/** Nearest polyline vertex to a stop, as progress 0..1. Used once, at seed time. */
export function progressOf(line: Coord[], lat: number, lng: number): number {
  const { cum, total } = cumulative(line);
  let best = { d: Infinity, p: 0 };
  for (let i = 0; i < line.length; i++) {
    const d = haversine(line[i], [lng, lat]);
    if (d < best.d) best = { d, p: cum[i] / total };
  }
  return best.p;
}

export const routeLength = (line: Coord[]): number => cumulative(line).total;
