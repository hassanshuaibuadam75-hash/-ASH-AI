// Presentation helpers shared by the marketplace screens.
//
// Commission rates are stored and returned by the server as fractions (0.03, 0.05,
// 0.025, 0.02). The marketplace used to interpolate that fraction directly, which
// rendered "0.03%" instead of the approved "3%". Every rate now goes through pct().
export function pct(rate, fallback = '—') {
  const n = Number(rate);
  if (!Number.isFinite(n)) return fallback;
  const value = n * 100;
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(2));
  return `${rounded}%`;
}
