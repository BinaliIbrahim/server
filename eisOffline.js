import crypto from 'crypto';

function base64Url(input) {
  const str = typeof input === 'string' ? input : String(input);
  return Buffer.from(str, 'utf8').toString('base64url');
}

/** Julian day number for MRA offline receipt encoding. */
export function toJulianDay(date = new Date()) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m2 + 2) / 5) +
    365 * y2 +
    Math.floor(y2 / 4) -
    Math.floor(y2 / 100) +
    Math.floor(y2 / 400) -
    32045
  );
}

/**
 * Build MRA offline invoice number components.
 * Format: base64(TIN)-base64(position)-base64(julianDay)-base64(serial)
 */
export function buildOfflineInvoiceNumber({ tin, terminalPosition = 1, serial, date = new Date() }) {
  const julian = toJulianDay(date);
  return `${base64Url(tin)}-${base64Url(String(terminalPosition))}-${base64Url(String(julian))}-${base64Url(String(serial))}`;
}

/**
 * Generate offline signature per MRA EIS spec (HMAC-SHA256, base64url).
 */
export function generateOfflineSignature({
  secretKey,
  tin,
  terminalPosition = 1,
  serial,
  numItems,
  invoiceTotal,
  vatAmount,
  date = new Date(),
}) {
  const invoiceNo = buildOfflineInvoiceNumber({ tin, terminalPosition, serial, date });
  const julianB64 = base64Url(String(toJulianDay(date)));
  const query = `TI=${invoiceNo}&N=${numItems}&I=${Number(invoiceTotal).toFixed(2)}&V=${Number(vatAmount).toFixed(2)}&T=${julianB64}`;
  const signature = crypto.createHmac('sha256', secretKey).update(query).digest('base64url');
  return { invoiceNo, query, signature, offlineSignature: signature };
}

export function buildOfflineValidationUrl({ query, signature, portalBase = 'https://dev-eis-portal.mra.mw' }) {
  const base = portalBase.replace(/\/$/, '');
  return `${base}/ReceiptValidation/Validate/?${query}&S=${signature}`;
}

export function portalBaseForEnvironment(environment = 'dev') {
  return environment === 'production' ? 'https://eis-portal.mra.mw' : 'https://dev-eis-portal.mra.mw';
}
