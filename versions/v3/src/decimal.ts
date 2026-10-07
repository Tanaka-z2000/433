// Convert finite input decimals (including scientific notation) before arithmetic.
// BigInt keeps fee half-cent boundaries exact without another runtime dependency.
export interface Decimal {
  n: bigint;
  d: bigint;
}
export function decimal(value: number): Decimal {
  if (!Number.isFinite(value)) throw new Error("金額必須為有效數字");
  const [mantissa, exponent = "0"] = value.toString().toLowerCase().split("e");
  const places = (mantissa.split(".")[1] ?? "").length - Number(exponent);
  const n = BigInt(mantissa.replace(".", ""));
  return places >= 0
    ? { n, d: 10n ** BigInt(places) }
    : { n: n * 10n ** BigInt(-places), d: 1n };
}
export const add = (a: Decimal, b: Decimal): Decimal => ({
  n: a.n * b.d + b.n * a.d,
  d: a.d * b.d,
});
export const multiply = (a: Decimal, b: Decimal): Decimal => ({
  n: a.n * b.n,
  d: a.d * b.d,
});
export const maximum = (a: Decimal, b: Decimal): Decimal =>
  a.n * b.d >= b.n * a.d ? a : b;
export function roundMoney(a: Decimal): number {
  const sign = a.n < 0n ? -1n : 1n,
    numerator = a.n * sign * 100n;
  // Half away from zero, consistently for receipts and payments.
  return Number(sign * ((numerator * 2n + a.d) / (2n * a.d))) / 100;
}
export const exactProduct = (...values: number[]) =>
  values.map(decimal).reduce(multiply, { n: 1n, d: 1n });
