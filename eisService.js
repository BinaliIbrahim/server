import crypto from 'crypto';
import axios from 'axios';

export const EIS_BASE_URLS = {
  dev: 'https://dev-eis-api.mra.mw/api/v1',
  production: 'https://eis-api.mra.mw/api/v1',
};

export function getEisBaseUrl(environment = 'dev') {
  return EIS_BASE_URLS[environment] || EIS_BASE_URLS.dev;
}

/** HMAC-SHA512 of activation code using secret key, Base64-encoded (MRA spec). */
export function computeXSignature(activationCode, secretKey) {
  return crypto.createHmac('sha512', secretKey).update(activationCode).digest('base64');
}

function eisHeaders(jwtToken, extra = {}) {
  return {
    accept: 'text/plain',
    'Content-Type': 'application/json',
    Authorization: jwtToken,
    ...extra,
  };
}

export async function activateTerminal({ baseUrl, terminalActivationCode, platform, pos }) {
  const { data } = await axios.post(
    `${baseUrl}/onboarding/activate-terminal`,
    { terminalActivationCode, environment: { platform, pos } },
    { headers: { accept: 'text/plain', 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return data;
}

export async function confirmTerminalActivation({ baseUrl, terminalId, secretKey, activationCode }) {
  const xSignature = computeXSignature(activationCode, secretKey);
  const { data } = await axios.post(
    `${baseUrl}/onboarding/terminal-activated-confirmation`,
    { terminalId },
    {
      headers: {
        accept: 'text/plain',
        'Content-Type': 'application/json',
        'x-signature': xSignature,
      },
      timeout: 30000,
    }
  );
  return data;
}

export async function getLatestConfig({ baseUrl, jwtToken }) {
  const { data } = await axios.get(`${baseUrl}/configuration/get-latest-configs`, {
    headers: { accept: 'application/json', Authorization: jwtToken },
    timeout: 30000,
  });
  return data;
}

export async function submitSalesTransaction({ baseUrl, jwtToken, payload }) {
  const { data } = await axios.post(`${baseUrl}/sales/submit-sales-transaction`, payload, {
    headers: eisHeaders(jwtToken),
    timeout: 45000,
  });
  return data;
}

export async function pingEis({ baseUrl, jwtToken }) {
  const { data } = await axios.get(`${baseUrl}/utilities/ping`, {
    headers: { accept: 'application/json', Authorization: jwtToken },
    timeout: 15000,
  });
  return data;
}

export async function getTerminalSiteProducts({ baseUrl, jwtToken, tin, siteId }) {
  const { data } = await axios.post(
    `${baseUrl}/utilities/get-terminal-site-products`,
    { tin: String(tin), siteId: String(siteId) },
    {
      headers: eisHeaders(jwtToken),
      timeout: 45000,
    }
  );
  return data;
}

/** Normalize MRA tax rates from activation/config response. */
export function extractTaxRates(configuration = {}) {
  const global = configuration.globalConfiguration || configuration.globalConfig || {};
  const rates = global.taxrates || global.taxRates || [];
  return rates.map((r) => ({
    id: r.id,
    name: r.name,
    rate: r.rate != null ? Number(r.rate) : null,
    chargeMode: r.chargeMode,
  }));
}

/** Pick default VAT rate id (prefer standard VAT). */
export function defaultVatRateId(taxRates = [], fallback = 'A') {
  if (!taxRates.length) return fallback;
  const vat = taxRates.find((r) => /vat/i.test(r.name || '') && r.rate != null);
  return vat?.id || taxRates[0]?.id || fallback;
}

/**
 * Build MRA submit-sales-transaction payload from a POS sale.
 * Prices are treated as VAT-exclusive; VAT is computed per line.
 */
export function buildSalesPayload({
  saleId,
  items = [],
  sellerTIN,
  siteId,
  configVersions = {},
  paymentMethod = 'Cash',
  buyerTIN = '',
  buyerName = '',
  buyerAuthorizationCode = '',
  amountTendered,
  taxRateId,
  vatRatePercent = 17.5,
  isReliefSupply = false,
}) {
  const invoiceDateTime = new Date().toISOString();
  const vatRate = Number(vatRatePercent) || 17.5;
  const rateId = taxRateId || 'A';

  const invoiceLineItems = items.map((item, index) => {
    const unitPrice = Number(item.price ?? item.unitPrice) || 0;
    const quantity = Number(item.quantity) || 0;
    const discount = Number(item.discount) || 0;
    const net = unitPrice * quantity - discount;
    const totalVAT = (net * vatRate) / 100;
    return {
      id: index + 1,
      productCode: String(item.mraProductCode || item.productCode || item.barcode || item.item_id || `ITEM-${index + 1}`),
      description: String(item.item_name || item.name || item.description || 'Item').slice(0, 200),
      unitPrice,
      quantity,
      discount,
      total: Number(net.toFixed(2)),
      totalVAT: Number(totalVAT.toFixed(2)),
      taxRateId: item.taxRateId || rateId,
      isProduct: item.isProduct !== false,
    };
  });

  const taxableAmount = invoiceLineItems.reduce((s, l) => s + l.total, 0);
  const totalVAT = invoiceLineItems.reduce((s, l) => s + l.totalVAT, 0);
  const invoiceTotal = Number((taxableAmount + totalVAT).toFixed(2));
  const tendered = amountTendered != null ? Number(amountTendered) : invoiceTotal;

  return {
    invoiceHeader: {
      invoiceNumber: String(saleId),
      invoiceDateTime,
      sellerTIN: String(sellerTIN),
      buyerTIN: buyerTIN || undefined,
      buyerName: buyerName || undefined,
      buyerAuthorizationCode: buyerAuthorizationCode || undefined,
      siteId: String(siteId),
      globalConfigVersion: Number(configVersions.globalConfigVersion) || 1,
      taxpayerConfigVersion: Number(configVersions.taxpayerConfigVersion) || 1,
      terminalConfigVersion: Number(configVersions.terminalConfigVersion) || 1,
      isReliefSupply: !!isReliefSupply,
      paymentMethod,
    },
    invoiceLineItems,
    invoiceSummary: {
      taxBreakDown: [
        {
          rateId,
          taxableAmount: Number(taxableAmount.toFixed(2)),
          taxAmount: Number(totalVAT.toFixed(2)),
        },
      ],
      levyBreakDown: [],
      totalVAT: Number(totalVAT.toFixed(2)),
      invoiceTotal,
      amountTendered: Number(tendered.toFixed(2)),
    },
  };
}

export function mapActivationToTenantEis(activationResponse, { environment, siteId, productId }) {
  const data = activationResponse?.data || {};
  const activated = data.activatedTerminal || {};
  const creds = activated.terminalCredentials || {};
  const config = data.configuration || {};
  const global = config.globalConfiguration || {};
  const terminal = config.terminalConfiguration || {};
  const taxpayer = config.taxpayerConfiguration || {};
  const taxRates = extractTaxRates(config);

  return {
    public: {
      enabled: false,
      activated: false,
      autoSyncProducts: false,
      environment,
      terminalId: activated.terminalId || '',
      siteId: siteId || terminal.siteId || '',
      productId,
      globalConfigVersion: global.versionNo || global.id || 1,
      taxpayerConfigVersion: taxpayer.versionNo || 1,
      terminalConfigVersion: terminal.versionNo || 1,
      tin: taxpayer.tin || '',
      isVATRegistered: taxpayer.isVATRegistered !== false,
      taxOffice: taxpayer.taxOffice?.code || taxpayer.taxOfficeCode || '',
      taxOfficeName: taxpayer.taxOffice?.name || '',
      tradingName: terminal.tradingName || '',
      taxRates,
      defaultTaxRateId: defaultVatRateId(taxRates),
      blocked: false,
      activatedAt: activated.activationDate || null,
    },
    secrets: {
      jwtToken: creds.jwtToken || '',
      secretKey: creds.secretKey || '',
    },
  };
}

export function mapConfigToTenantEis(existingEis, configResponse) {
  const data = configResponse?.data || configResponse || {};
  const global = data.globalConfiguration || {};
  const terminal = data.terminalConfiguration || {};
  const taxpayer = data.taxpayerConfiguration || {};
  const taxRates = extractTaxRates(data);

  return {
    ...existingEis,
    globalConfigVersion: global.versionNo || existingEis.globalConfigVersion,
    taxpayerConfigVersion: taxpayer.versionNo || existingEis.taxpayerConfigVersion,
    terminalConfigVersion: terminal.versionNo || existingEis.terminalConfigVersion,
    tin: taxpayer.tin || existingEis.tin,
    isVATRegistered: taxpayer.isVATRegistered ?? existingEis.isVATRegistered,
    taxOffice: taxpayer.taxOffice?.code || existingEis.taxOffice,
    taxOfficeName: taxpayer.taxOffice?.name || existingEis.taxOfficeName,
    taxRates: taxRates.length ? taxRates : existingEis.taxRates,
    defaultTaxRateId: defaultVatRateId(taxRates, existingEis.defaultTaxRateId),
    configSyncedAt: new Date().toISOString(),
  };
}

/** Map one MRA product record to RetailFlow inventory fields. */
export function mapMraProductToInventoryItem(product, { tenantId }) {
  const stock = Number(product.quantity) || 0;
  const price = Number(product.price) || 0;
  const code = String(product.productCode || '').trim();
  const isService = product.isProduct === false;

  return {
    item_name: String(product.productName || product.description || code || 'MRA Item').trim(),
    Catalogue: code || 'MRA',
    Category: isService ? 'Services' : 'Products',
    Stock: stock,
    Quantity: stock,
    price,
    order_price: price,
    totalValue: stock * price,
    description: String(product.description || product.productName || '').trim(),
    barcode: code,
    mraProductCode: code,
    sku: code,
    unitOfMeasure: product.unitOfMeasure || 'pcs',
    minStock: Number(product.minimumStockLevel) || 10,
    reorderLevel: Number(product.minimumStockLevel) || 5,
    mraTaxRateId: product.taxRateId || null,
    mraSiteId: product.siteId || null,
    mraSyncedAt: new Date().toISOString(),
    tenantId,
    source: 'mra_eis',
    isProduct: !isService,
  };
}

/** Upsert MRA products into users/{workspaceUserId}/Item */
export async function syncMraProductsToInventory(firestore, admin, {
  workspaceUserId,
  tenantId,
  products = [],
  updateExisting = true,
}) {
  if (!workspaceUserId || !products.length) {
    return { created: 0, updated: 0, skipped: 0, total: 0 };
  }

  const itemsCol = firestore.collection('users').doc(workspaceUserId).collection('Item');
  const existingSnap = await itemsCol.get();
  const byMraCode = new Map();
  const byBarcode = new Map();

  existingSnap.docs.forEach((docSnap) => {
    const data = docSnap.data();
    if (data.mraProductCode) byMraCode.set(String(data.mraProductCode), docSnap.ref);
    if (data.barcode) byBarcode.set(String(data.barcode), docSnap.ref);
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let batch = firestore.batch();
  let ops = 0;
  const now = admin.firestore.FieldValue.serverTimestamp();

  const commitBatch = async () => {
    if (ops > 0) {
      await batch.commit();
      batch = firestore.batch();
      ops = 0;
    }
  };

  for (const product of products) {
    const code = String(product.productCode || '').trim();
    if (!code) {
      skipped += 1;
      continue;
    }

    const mapped = mapMraProductToInventoryItem(product, { tenantId });
    const existingRef =
      updateExisting ? byMraCode.get(code) || byBarcode.get(code) : null;

    if (existingRef) {
      batch.update(existingRef, { ...mapped, updatedAt: now });
      updated += 1;
    } else {
      const newRef = itemsCol.doc();
      batch.set(newRef, {
        ...mapped,
        createdAt: now,
        createdBy: 'mra_eis_sync',
      });
      created += 1;
    }

    ops += 1;
    if (ops >= 400) await commitBatch();
  }

  await commitBatch();

  return { created, updated, skipped, total: products.length };
}

export function normalizeMraProductsList(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(response)) return response;
  return [];
}

export async function getTerminalBlockingMessage({ baseUrl, jwtToken }) {
  const { data } = await axios.get(`${baseUrl}/configuration/get-terminal-blocking-message`, {
    headers: { accept: 'application/json', Authorization: jwtToken },
    timeout: 20000,
  });
  return data;
}

export async function uploadInitialInventory({ baseUrl, jwtToken, tin, isLastBatch, products }) {
  const { data } = await axios.post(
    `${baseUrl}/utilities/taxpayer-initial-inventory-upload`,
    { tin: String(tin), isLastBatch: !!isLastBatch, products },
    { headers: eisHeaders(jwtToken), timeout: 120000 }
  );
  return data;
}

export async function validateBuyerAuthorizationCode({ baseUrl, jwtToken, buyerTIN, authorizationCode }) {
  const { data } = await axios.post(
    `${baseUrl}/utilities/validate-buyer-authorization-code`,
    { buyerTIN: String(buyerTIN), authorizationCode: String(authorizationCode) },
    { headers: eisHeaders(jwtToken), timeout: 30000 }
  );
  return data;
}

/** Map POS inventory item to MRA initial inventory upload row. */
export function mapPosItemToMraUploadProduct(item) {
  const stock = Number(item.Stock ?? item.Quantity) || 0;
  const price = Number(item.price) || 0;
  const cost = Number(item.order_price ?? item.costPrice) || price;
  const code = String(item.mraProductCode || item.barcode || item.sku || item.Catalogue || '').trim();
  return {
    BarCode: code || `SKU-${String(item.id || item.item_id || '').slice(0, 12)}`,
    ProductName: String(item.item_name || item.name || 'Product').slice(0, 200),
    ProductDescription: String(item.description || item.item_name || item.name || 'Product').slice(0, 500),
    QuantityInStock: stock,
    UnitPrice: price,
    CostPrice: cost,
    SellingPrice: price,
    ReorderLevel: Number(item.reorderLevel ?? item.minStock) || 5,
    OverQuantityStockLevel: Number(item.maxStock) || 9999,
  };
}

export function isMraSuccessResponse(response) {
  return response?.statusCode === 0 || response?.statusCode === 1;
}
