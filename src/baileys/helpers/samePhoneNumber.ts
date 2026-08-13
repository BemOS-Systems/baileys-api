import { normalizeBrazilPhoneNumber } from "./normalizeBrazilPhoneNumber";

/**
 * @description Reduce a phone number to a comparable key: digits only, with the
 * Brazilian 8-vs-9-digit mobile ambiguity collapsed in BOTH directions.
 *
 * `normalizeBrazilPhoneNumber` only widens 8 -> 9 digits, so it cannot tell that
 * a 9-digit number is the same line as its legacy 8-digit form when the input
 * arrives already widened, or without the leading `+`. WhatsApp hands us either
 * shape depending on how old the registration is, so the comparison has to be
 * symmetric.
 */
function comparableKey(phoneNumber: string): string {
  const digits = normalizeBrazilPhoneNumber(
    phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`,
  ).replace(/\D/g, "");

  // Brazilian mobile: 55 + 2-digit DDD + 9 + 8 digits. Drop the 9 so both forms
  // land on the same key. Landlines (8 digits, no leading 9) are untouched.
  const brMobile = digits.match(/^55(\d{2})9(\d{8})$/);
  return brMobile ? `55${brMobile[1]}${brMobile[2]}` : digits;
}

/**
 * @description Whether two phone numbers denote the same line.
 *
 * NOTE: this is deliberately NOT a general E.164 library. It handles the one
 * country whose numbering plan WhatsApp is inconsistent about, and otherwise
 * falls back to digit equality. If more countries are onboarded, replace this
 * with libphonenumber-js rather than growing the regex.
 */
export function samePhoneNumber(a: string, b: string): boolean {
  return comparableKey(a) === comparableKey(b);
}
