// The sun for the real style: where it stands at a time and place, and that direction in the
// model's axes. Pure functions; the core loads this module like the kit, not as a layer.
const D2R = Math.PI / 180;
// L-EST97 is a Lambert conformal projection with its central meridian at 24 E; true north turns
// from grid north by the cone constant, this many degrees per degree of longitude from there
const CONVERGENCE = 0.854;
const CENTRAL_MERIDIAN = 24;

const sin = d => Math.sin(d * D2R), cos = d => Math.cos(d * D2R), tan = d => Math.tan(d * D2R);
const mod = (a, n) => ((a % n) + n) % n;

/**
 * sunPosition(date, lat, lon) -> { altitude, azimuth } in degrees, azimuth clockwise from true
 * north. NOAA's solar position equations (the General Solar Position spreadsheet), without
 * atmospheric refraction.
 */
export function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + sin(2 * M) * (0.019993 - 0.000101 * T) + sin(3 * M) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * sin(omega);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * cos(omega);
  const decl = Math.asin(sin(eps) * sin(lambda)) / D2R;
  const y = tan(eps / 2) ** 2;
  const eqTime = 4 / D2R * (y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0) - 0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M));
  const minutes = mod(date.getTime() / 60000, 1440);
  const solar = mod(minutes + eqTime + 4 * lon, 1440);
  const hour = solar / 4 - 180;
  const cz = Math.min(1, Math.max(-1, sin(lat) * sin(decl) + cos(lat) * cos(decl) * cos(hour)));
  const zenith = Math.acos(cz) / D2R;
  const sz = sin(zenith);
  let azimuth;
  if (Math.abs(sz) < 1e-9) azimuth = 180;
  else {
    const a = Math.acos(Math.min(1, Math.max(-1, (sin(lat) * cz - sin(decl)) / (cos(lat) * sz)))) / D2R;
    azimuth = hour > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }
  return { altitude: 90 - zenith, azimuth };
}

/** gridBearing(trueAzimuth, lon) -> the same direction as an L-EST97 grid azimuth. */
export function gridBearing(trueAzimuth, lon) {
  return trueAzimuth - CONVERGENCE * (lon - CENTRAL_MERIDIAN);
}

/**
 * sunDirection(altitude, gridAzimuth, bearing) -> [x, y, z], the unit vector towards the sun in
 * the model's axes, where bearing is the grid azimuth of the model's +x axis.
 */
export function sunDirection(altitude, gridAzimuth, bearing) {
  const a = gridAzimuth - bearing, h = cos(altitude);
  return [cos(a) * h, sin(altitude), sin(a) * h];
}
