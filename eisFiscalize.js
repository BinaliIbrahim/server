import {
  submitSalesTransaction,
  getLatestConfig,
  buildSalesPayload,
  mapConfigToTenantEis,
  getEisBaseUrl,
  isMraSuccessResponse,
} from './eisService.js';
import {
  generateOfflineSignature,
  buildOfflineValidationUrl,
  portalBaseForEnvironment,
} from './eisOffline.js';

function resolveVatRate(loaded) {
  return (
    loaded.tenant?.settings?.vatRate ??
    loaded.tenant?.taxRate ??
    loaded.eis?.taxRates?.find((r) => r.id === loaded.eis?.defaultTaxRateId)?.rate ??
    17.5
  );
}

function buildPayloadFromRequest(loaded, body) {
  const {
    saleId,
    items = [],
    paymentMethod = 'Cash',
    buyerTIN = '',
    buyerName = '',
    buyerAuthorizationCode = '',
    amountTendered,
    isReliefSupply = false,
  } = body;

  const siteId = loaded.eis.siteId || loaded.secrets?.siteId;
  const vatRate = resolveVatRate(loaded);

  return buildSalesPayload({
    saleId,
    items,
    sellerTIN: loaded.eis.tin || loaded.tenant?.tin || loaded.tenant?.companyInfo?.taxId,
    siteId,
    configVersions: {
      globalConfigVersion: loaded.eis.globalConfigVersion,
      taxpayerConfigVersion: loaded.eis.taxpayerConfigVersion,
      terminalConfigVersion: loaded.eis.terminalConfigVersion,
    },
    paymentMethod,
    buyerTIN,
    buyerName,
    buyerAuthorizationCode,
    amountTendered,
    taxRateId: loaded.eis.defaultTaxRateId || 'A',
    vatRatePercent: vatRate,
    isReliefSupply,
  });
}

export async function reserveOfflineSerial(firestore, tenantId) {
  const tenantRef = firestore.collection('tenants').doc(tenantId);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(tenantRef);
    const current = Number(snap.data()?.eis?.offlineSerial) || 0;
    const next = current + 1;
    tx.update(tenantRef, { 'eis.offlineSerial': next });
    return next;
  });
}

export async function queueOfflineSale(firestore, admin, tenantId, { saleId, payload, offlineMeta }) {
  await firestore
    .collection('eis_offline_queue')
    .doc(tenantId)
    .collection('pending')
    .doc(String(saleId))
    .set({
      saleId: String(saleId),
      payload,
      offlineMeta,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      attempts: 0,
    });
}

async function applyMraPostSubmit(firestore, admin, tenantId, loaded, mraResponse) {
  if (mraResponse?.data?.shouldBlockTerminal) {
    await loaded.tenantRef.update({
      'eis.blocked': true,
      'eis.blockReason': mraResponse?.data?.validationErrors?.join('; ') || 'Blocked by MRA',
    });
  }

  if (mraResponse?.data?.shouldDownloadLatestConfig) {
    try {
      const baseUrl = getEisBaseUrl(loaded.eis.environment);
      const configResponse = await getLatestConfig({ baseUrl, jwtToken: loaded.secrets.jwtToken });
      const updatedEis = mapConfigToTenantEis(loaded.eis, configResponse);
      await firestore.collection('tenants').doc(tenantId).update({ eis: updatedEis });
    } catch (syncErr) {
      console.warn('[EIS] auto config sync failed:', syncErr.message);
    }
  }
}

function isNetworkOrTimeoutError(err) {
  const code = err?.code;
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'ECONNABORTED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    msg.includes('network') ||
    msg.includes('timeout')
  );
}

/**
 * Fiscalize a sale online; on network failure queue offline signature for later flush.
 */
export async function fiscalizeSaleForTenant(firestore, admin, loaded, body, { allowOffline = true } = {}) {
  const { saleId, items = [], paymentMethod = 'Cash' } = body;

  if (!saleId || !items.length) {
    throw Object.assign(new Error('saleId and items are required'), { status: 400 });
  }
  if (!loaded?.eis?.enabled || !loaded?.eis?.activated) {
    throw Object.assign(new Error('EIS is not enabled or terminal not activated'), { status: 400 });
  }
  if (!loaded?.secrets?.jwtToken) {
    throw Object.assign(new Error('Missing EIS credentials'), { status: 400 });
  }
  if (loaded.eis.blocked) {
    throw Object.assign(new Error('Terminal blocked by MRA'), { status: 403 });
  }

  const siteId = loaded.eis.siteId || loaded.secrets?.siteId;
  if (!siteId) {
    throw Object.assign(new Error('Site ID is required. Set it in Settings → MRA EIS.'), { status: 400 });
  }

  const payload = buildPayloadFromRequest(loaded, body);
  const baseUrl = getEisBaseUrl(loaded.eis.environment);
  const tenantId = loaded.tenantRef.id;

  try {
    const mraResponse = await submitSalesTransaction({
      baseUrl,
      jwtToken: loaded.secrets.jwtToken,
      payload,
    });

    await applyMraPostSubmit(firestore, admin, tenantId, loaded, mraResponse);

    const validationURL = mraResponse?.data?.validationURL || null;
    const accepted = isMraSuccessResponse(mraResponse);

    return {
      success: accepted,
      mode: 'online',
      validationURL,
      remark: mraResponse?.remark,
      shouldBlockTerminal: mraResponse?.data?.shouldBlockTerminal,
      validationErrors: mraResponse?.data?.validationErrors,
      errors: mraResponse?.errors,
      raw: mraResponse,
    };
  } catch (err) {
    if (!allowOffline || !loaded.secrets.secretKey || !isNetworkOrTimeoutError(err)) {
      throw err;
    }

    const serial = await reserveOfflineSerial(firestore, tenantId);
    const numItems = payload.invoiceLineItems?.length || items.length;
    const invoiceTotal = payload.invoiceSummary?.invoiceTotal || 0;
    const vatAmount = payload.invoiceSummary?.totalVAT || 0;
    const tin = loaded.eis.tin || loaded.tenant?.tin || loaded.tenant?.companyInfo?.taxId;

    const offline = generateOfflineSignature({
      secretKey: loaded.secrets.secretKey,
      tin,
      terminalPosition: 1,
      serial,
      numItems,
      invoiceTotal,
      vatAmount,
    });

    const validationURL = buildOfflineValidationUrl({
      query: offline.query,
      signature: offline.signature,
      portalBase: portalBaseForEnvironment(loaded.eis.environment),
    });

    await queueOfflineSale(firestore, admin, tenantId, {
      saleId,
      payload,
      offlineMeta: {
        invoiceNo: offline.invoiceNo,
        query: offline.query,
        signature: offline.signature,
        validationURL,
        paymentMethod,
        queuedAt: new Date().toISOString(),
      },
    });

    return {
      success: true,
      mode: 'offline',
      validationURL,
      offline: true,
      remark: 'Sale stored offline — will sync when MRA connection is restored',
      invoiceNo: offline.invoiceNo,
    };
  }
}

/** Submit queued offline sales when MRA is reachable. */
export async function flushOfflineQueue(firestore, admin, loaded) {
  const tenantId = loaded.tenantRef.id;
  const pendingRef = firestore.collection('eis_offline_queue').doc(tenantId).collection('pending');
  const snap = await pendingRef.where('status', '==', 'pending').limit(50).get();

  if (snap.empty) {
    return { flushed: 0, failed: 0, remaining: 0 };
  }

  const baseUrl = getEisBaseUrl(loaded.eis.environment);
  let flushed = 0;
  let failed = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    try {
      const mraResponse = await submitSalesTransaction({
        baseUrl,
        jwtToken: loaded.secrets.jwtToken,
        payload: data.payload,
      });
      if (isMraSuccessResponse(mraResponse)) {
        await docSnap.ref.update({
          status: 'submitted',
          submittedAt: admin.firestore.FieldValue.serverTimestamp(),
          mraValidationURL: mraResponse?.data?.validationURL || data.offlineMeta?.validationURL || null,
        });
        flushed += 1;
      } else {
        await docSnap.ref.update({
          attempts: (data.attempts || 0) + 1,
          lastError: mraResponse?.remark || 'MRA rejected offline sale',
        });
        failed += 1;
      }
    } catch (err) {
      await docSnap.ref.update({
        attempts: (data.attempts || 0) + 1,
        lastError: err.message,
      });
      failed += 1;
      break;
    }
  }

  const remainingSnap = await pendingRef.where('status', '==', 'pending').get();
  const remaining = remainingSnap.size;

  return { flushed, failed, remaining };
}

/** Startup sync: latest config, block status, flush offline queue. */
export async function runEisStartupSync(firestore, admin, loaded) {
  const result = {
    configSynced: false,
    blocked: loaded.eis?.blocked || false,
    blockMessage: null,
    offlineQueue: null,
  };

  if (!loaded?.eis?.activated || !loaded?.secrets?.jwtToken) {
    return result;
  }

  const baseUrl = getEisBaseUrl(loaded.eis.environment);
  const tenantId = loaded.tenantRef.id;

  try {
    const configResponse = await getLatestConfig({ baseUrl, jwtToken: loaded.secrets.jwtToken });
    const updatedEis = mapConfigToTenantEis(loaded.eis, configResponse);
    updatedEis.startupSyncedAt = new Date().toISOString();
    await firestore.collection('tenants').doc(tenantId).update({ eis: updatedEis });
    loaded.eis = updatedEis;
    result.configSynced = true;
  } catch (err) {
    console.warn('[EIS] startup config sync failed:', err.message);
  }

  try {
    const { getTerminalBlockingMessage } = await import('./eisService.js');
    const blockResponse = await getTerminalBlockingMessage({ baseUrl, jwtToken: loaded.secrets.jwtToken });
    const blocked = !!(blockResponse?.data?.isBlocked ?? blockResponse?.data?.blocked);
    const blockMessage = blockResponse?.data?.message || blockResponse?.remark || null;
    if (blocked !== loaded.eis.blocked || blockMessage) {
      await firestore.collection('tenants').doc(tenantId).update({
        'eis.blocked': blocked,
        'eis.blockReason': blockMessage || loaded.eis.blockReason || null,
      });
    }
    result.blocked = blocked;
    result.blockMessage = blockMessage;
  } catch (err) {
    console.warn('[EIS] block status check failed:', err.message);
  }

  try {
    result.offlineQueue = await flushOfflineQueue(firestore, admin, loaded);
  } catch (err) {
    console.warn('[EIS] offline flush failed:', err.message);
    result.offlineQueue = { error: err.message };
  }

  return result;
}
