/**
 * Payee name cleaning and matching utilities.
 * Ported from the frontend importTransactionsCtrl.js to be reused
 * by the Plaid sync service for consistent payee handling.
 */

/**
 * Clean a raw bank transaction description into a human-friendly payee name.
 * Strips Canadian bank prefixes (POS, EFT, etc.), trailing reference numbers,
 * and normalizes to Title Case.
 *
 * @param {string} raw - Raw transaction name from the bank/Plaid
 * @returns {string} Cleaned payee name
 */
function cleanPayeeName(raw) {
  if (!raw) return "";
  let clean = raw.trim();

  // Amazon variants
  if (/amzn\s+mktp/i.test(clean) || /amazon\.ca/i.test(clean) || /amazon\s+ca/i.test(clean)) {
    return "Amazon";
  }

  // Canadian bank transaction prefixes to strip
  const prefixes = [
    /^pos merchandise\s+/i,
    /^pos merch\s+/i,
    /^pos\s+/i,
    /^pre-authorized debit\s+/i,
    /^miscellaneous payments\s+/i,
    /^payroll deposit\s+/i,
    /^eft debit\s+/i,
    /^eft credit\s+/i,
    /^interac e-transfer receive\s+/i,
    /^interac e-transfer send\s+/i,
    /^abm withdrawal/i,
    /^cheque image deposit/i,
    /^cable bill payment\s+/i,
    /^auto insurance\s+/i,
  ];

  for (const prefix of prefixes) {
    clean = clean.replace(prefix, "");
  }

  // Strip trailing noise
  clean = clean.replace(/\s+cheque\s*$/i, "");
  clean = clean.replace(/\s+\d+\s*$/g, "");
  clean = clean.replace(/\s+c\d+\s*$/i, "");
  clean = clean.replace(/\s+store\s*$/i, "");

  clean = clean.trim();

  // Convert to Title Case
  clean = clean.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  return clean || raw;
}

/**
 * Suggest a matching existing payee for a cleaned name.
 * Tries exact match first, then substring match.
 *
 * @param {string} cleanName - The cleaned payee name to match
 * @param {Array<{id: string, name: string}>} existingPayees - Array of existing payees
 * @returns {string|null} The matched payee ID, or null if no match
 */
function suggestPayee(cleanName, existingPayees) {
  const cleanLower = cleanName.toLowerCase();

  // 1. Exact match
  for (const ep of existingPayees) {
    if (ep.name && ep.name.toLowerCase() === cleanLower) {
      return ep.id;
    }
  }

  // 2. Substring match (only if cleaned name is at least 3 chars to avoid false positives)
  if (cleanLower.length >= 3) {
    for (const ep of existingPayees) {
      if (!ep.name) continue;
      const epNameLower = ep.name.toLowerCase();
      if (cleanLower.includes(epNameLower) || epNameLower.includes(cleanLower)) {
        return ep.id;
      }
    }
  }

  return null;
}

/**
 * Get the best payee name from a Plaid transaction.
 * Prefers merchant_name (cleaner) over name (raw bank description).
 *
 * @param {object} plaidTxn - Plaid transaction object
 * @returns {string} Best available payee name
 */
function getPlaidPayeeName(plaidTxn) {
  // Plaid's merchant_name is usually cleaner than name
  if (plaidTxn.merchant_name && plaidTxn.merchant_name.trim()) {
    return plaidTxn.merchant_name.trim();
  }
  return plaidTxn.name || "Unknown";
}

module.exports = { cleanPayeeName, suggestPayee, getPlaidPayeeName };
