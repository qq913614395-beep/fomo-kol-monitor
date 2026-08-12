function normalizeParts(value) {
  const raw = String(value ?? "0").trim();
  if (!raw) return { coefficient: 0n, scale: 0 };
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new Error(`Invalid decimal: ${raw}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = match[3] || "";
  const exponent = Number(match[4] || 0);
  let coefficient = sign * BigInt(`${match[2]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function renderParts(coefficient, scale) {
  if (coefficient === 0n) return "0";
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
  }
  return `${negative ? "-" : ""}${digits}`;
}

export function decimal(value) {
  const parts = normalizeParts(value);
  return renderParts(parts.coefficient, parts.scale);
}

export function addDecimals(values) {
  const parts = values.map(normalizeParts);
  const scale = parts.reduce((max, item) => Math.max(max, item.scale), 0);
  const coefficient = parts.reduce((sum, item) =>
    sum + item.coefficient * 10n ** BigInt(scale - item.scale), 0n);
  return renderParts(coefficient, scale);
}

export function compareDecimals(left, right) {
  const a = normalizeParts(left);
  const b = normalizeParts(right);
  const scale = Math.max(a.scale, b.scale);
  const av = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bv = b.coefficient * 10n ** BigInt(scale - b.scale);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

export function absoluteDecimal(value) {
  const parts = normalizeParts(value);
  return renderParts(parts.coefficient < 0n ? -parts.coefficient : parts.coefficient, parts.scale);
}
