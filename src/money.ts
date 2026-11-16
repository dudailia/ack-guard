// Money helpers. Amounts are bigint in the currency's smallest subunit,
// following the BigInt money convention used in Catena's ACK demos.

export function formatAmount(amount: bigint, decimals = 2, currency = "USD"): string {
  const neg = amount < 0n
  const abs = neg ? -amount : amount
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, "0")
  const symbol = currency === "USD" ? "$" : ""
  const suffix = currency === "USD" ? "" : ` ${currency}`
  return `${neg ? "-" : ""}${symbol}${whole}${decimals > 0 ? "." + frac : ""}${suffix}`
}

/** Parse an ACK PaymentOption amount (number or positive integer string). Throws on garbage. */
export function parseSubunits(amount: string | number): bigint {
  if (typeof amount === "number") {
    if (!Number.isInteger(amount)) throw new Error("amount must be an integer")
    return BigInt(amount)
  }
  if (!/^\d+$/.test(amount)) throw new Error("amount must be an integer string")
  return BigInt(amount)
}
