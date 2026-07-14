import os from 'os';
import {
  activateTerminal,
  confirmTerminalActivation,
  getLatestConfig,
  pingEis,
  getTerminalSiteProducts,
  getEisBaseUrl,
  mapActivationToTenantEis,
  mapConfigToTenantEis,
  syncMraProductsToInventory,
  normalizeMraProductsList,
  uploadInitialInventory,
  validateBuyerAuthorizationCode,
  mapPosItemToMraUploadProduct,
  getTerminalBlockingMessage,
} from './eisService.js';
import { fiscalizeSaleForTenant, flushOfflineQueue, runEisStartupSync } from './eisFiscalize.js';

const EIS_PRODUCT_ID = process.env.EIS_PRODUCT_ID || 'RetailFlow-POS/1.0.0';
const EIS_PRODUCT_VERSION = process.env.EIS_PRODUCT_VERSION || '1.0.0';

function platformInfo() {
  return {
    osName: os.type(),
    osVersion: os.release(),
    osBuild: process.platform,
    macAddress: '00-00-00-00-00-00',
  };
}

async function loadTenantEis(firestore, tenantId) {
  const tenantRef = firestore.collection('tenants').doc(tenantId);
  const tenantDoc = await tenantRef.get();
  if (!tenantDoc.exists) return null;
  const tenant = tenantDoc.data();
  const secretsDoc = await firestore.collection('eis_terminal_secrets').doc(tenantId).get();
  return {
    tenantRef,
    tenant,
    eis: tenant.eis || null,
    secrets: secretsDoc.exists ? secretsDoc.data() : null,
  };
}

async function saveEisState(firestore, admin, tenantId, publicEis, secrets) {
  const batch = firestore.batch();
  const tenantRef = firestore.collection('tenants').doc(tenantId);
  batch.update(tenantRef, {
    eis: publicEis,
    ebrSerial: publicEis.terminalId || undefined,
    taxOffice: publicEis.taxOfficeName || publicEis.taxOffice || undefined,
    tin: publicEis.tin || undefined,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  if (secrets) {
    const secretsRef = firestore.collection('eis_terminal_secrets').doc(tenantId);
    batch.set(secretsRef, {
      ...secrets,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}

async function resolveWorkspaceUserId(firestore, tenantId, userId) {
  const tenantDoc = await firestore.collection('tenants').doc(tenantId).get();
  if (!tenantDoc.exists) return userId;
  const tenant = tenantDoc.data();
  return tenant.dataOwnerId || tenant.createdBy || userId;
}

async function runMraInventorySync(firestore, admin, loaded, { workspaceUserId, updateExisting = true } = {}) {
  const siteId = loaded.eis?.siteId;
  const tin = loaded.eis?.tin || loaded.tenant?.tin || loaded.tenant?.companyInfo?.taxId;
  if (!siteId || !tin) {
    throw new Error('Site ID and TIN are required to sync MRA products');
  }
  const baseUrl = getEisBaseUrl(loaded.eis.environment);
  const productsResponse = await getTerminalSiteProducts({
    baseUrl,
    jwtToken: loaded.secrets.jwtToken,
    tin,
    siteId,
  });
  const products = normalizeMraProductsList(productsResponse);
  const stats = await syncMraProductsToInventory(firestore, admin, {
    workspaceUserId,
    tenantId: loaded.tenantRef.id,
    products,
    updateExisting,
  });
  return { products, stats, remark: productsResponse?.remark };
}

export function createEisRoutes({ app, firestore, admin, verifyToken, resolveTenantId }) {
  /** GET /api/eis/status — public EIS status for tenant */
  app.get('/api/eis/status', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.query.tenantId);
      if (!tenantId) return res.status(404).json({ success: false, message: 'Tenant not found' });
      const loaded = await loadTenantEis(firestore, tenantId);
      return res.json({
        success: true,
        eis: loaded?.eis || { enabled: false, activated: false },
        hasCredentials: !!loaded?.secrets?.jwtToken,
      });
    } catch (err) {
      console.error('[EIS] status:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** POST /api/eis/activate — activate terminal with TAC from MRA portal */
  app.post('/api/eis/activate', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.body.tenantId);
      if (!tenantId) return res.status(404).json({ success: false, message: 'Tenant not found' });

      const { terminalActivationCode, environment = 'dev', siteId } = req.body;
      if (!terminalActivationCode) {
        return res.status(400).json({ success: false, message: 'Terminal Activation Code (TAC) is required' });
      }

      const baseUrl = getEisBaseUrl(environment);
      const activationResponse = await activateTerminal({
        baseUrl,
        terminalActivationCode: String(terminalActivationCode).trim(),
        platform: platformInfo(),
        pos: { productID: EIS_PRODUCT_ID, productVersion: EIS_PRODUCT_VERSION },
      });

      if (activationResponse?.statusCode !== 1 && activationResponse?.statusCode !== 0) {
        return res.status(400).json({
          success: false,
          message: activationResponse?.remark || 'Terminal activation failed',
          errors: activationResponse?.errors,
        });
      }

      const mapped = mapActivationToTenantEis(activationResponse, {
        environment,
        siteId: siteId || req.body.siteId || '',
        productId: EIS_PRODUCT_ID,
      });

      if (!mapped.secrets.jwtToken || !mapped.secrets.secretKey) {
        return res.status(400).json({ success: false, message: 'MRA did not return terminal credentials' });
      }

      const terminalId = mapped.public.terminalId;
      const confirmResponse = await confirmTerminalActivation({
        baseUrl,
        terminalId,
        secretKey: mapped.secrets.secretKey,
        activationCode: String(terminalActivationCode).trim(),
      });

      mapped.public.activated = confirmResponse?.statusCode === 1 || confirmResponse?.statusCode === 0;
      mapped.public.confirmedAt = new Date().toISOString();

      await saveEisState(firestore, admin, tenantId, mapped.public, mapped.secrets);

      let inventorySync = null;
      if (mapped.public.autoSyncProducts && mapped.public.siteId) {
        try {
          const workspaceUserId = await resolveWorkspaceUserId(firestore, tenantId, req.user.uid);
          const loadedAfter = await loadTenantEis(firestore, tenantId);
          inventorySync = await runMraInventorySync(firestore, admin, loadedAfter, { workspaceUserId });
          mapped.public.lastProductSyncAt = new Date().toISOString();
          await saveEisState(firestore, admin, tenantId, mapped.public, null);
        } catch (syncErr) {
          console.warn('[EIS] auto product sync after activation failed:', syncErr.message);
          inventorySync = { error: syncErr.message };
        }
      }

      return res.json({
        success: true,
        message: 'Terminal activated with MRA EIS',
        eis: mapped.public,
        confirmRemark: confirmResponse?.remark,
        inventorySync,
      });
    } catch (err) {
      console.error('[EIS] activate:', err.response?.data || err.message);
      return res.status(500).json({
        success: false,
        message: err.response?.data?.remark || err.message || 'Activation failed',
      });
    }
  });

  /** POST /api/eis/sync-config — fetch latest MRA configuration */
  app.post('/api/eis/sync-config', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.body.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded?.eis?.activated || !loaded?.secrets?.jwtToken) {
        return res.status(400).json({ success: false, message: 'EIS terminal not activated' });
      }

      const baseUrl = getEisBaseUrl(loaded.eis.environment);
      const configResponse = await getLatestConfig({ baseUrl, jwtToken: loaded.secrets.jwtToken });
      const updatedEis = mapConfigToTenantEis(loaded.eis, configResponse);
      await saveEisState(firestore, admin, tenantId, updatedEis, null);

      return res.json({ success: true, eis: updatedEis, remark: configResponse?.remark });
    } catch (err) {
      console.error('[EIS] sync-config:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** GET /api/eis/ping */
  app.get('/api/eis/ping', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.query.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded?.secrets?.jwtToken) {
        return res.status(400).json({ success: false, message: 'EIS not configured' });
      }
      const baseUrl = getEisBaseUrl(loaded.eis?.environment);
      const result = await pingEis({ baseUrl, jwtToken: loaded.secrets.jwtToken });
      return res.json({ success: true, result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** GET /api/eis/products — MRA registered products for this terminal site */
  app.get('/api/eis/products', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.query.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded?.secrets?.jwtToken) {
        return res.status(400).json({ success: false, message: 'EIS not configured' });
      }
      const siteId = loaded.eis?.siteId;
      const tin = loaded.eis?.tin || loaded.tenant?.tin || loaded.tenant?.companyInfo?.taxId;
      if (!siteId || !tin) {
        return res.status(400).json({ success: false, message: 'Site ID and TIN required' });
      }
      const baseUrl = getEisBaseUrl(loaded.eis?.environment);
      const result = await getTerminalSiteProducts({
        baseUrl,
        jwtToken: loaded.secrets.jwtToken,
        tin,
        siteId,
      });
      return res.json({ success: true, products: normalizeMraProductsList(result), raw: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** POST /api/eis/sync-inventory — import MRA products into Firestore inventory */
  app.post('/api/eis/sync-inventory', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.body.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded?.eis?.activated || !loaded?.secrets?.jwtToken) {
        return res.status(400).json({ success: false, message: 'EIS terminal not activated' });
      }

      const workspaceUserId =
        req.body.workspaceUserId ||
        (await resolveWorkspaceUserId(firestore, tenantId, req.user.uid));

      const { products, stats, remark } = await runMraInventorySync(firestore, admin, loaded, {
        workspaceUserId,
        updateExisting: req.body.updateExisting !== false,
      });

      const updatedEis = {
        ...(loaded.eis || {}),
        lastProductSyncAt: new Date().toISOString(),
        lastProductSyncStats: stats,
      };
      await saveEisState(firestore, admin, tenantId, updatedEis, null);

      return res.json({
        success: true,
        message: `Synced ${stats.created} new and ${stats.updated} updated products from MRA`,
        stats,
        productCount: products.length,
        remark,
      });
    } catch (err) {
      console.error('[EIS] sync-inventory:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** POST /api/eis/fiscalize-sale — submit sale to MRA (online or offline queue) */
  app.post('/api/eis/fiscalize-sale', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.body.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      const result = await fiscalizeSaleForTenant(firestore, admin, loaded, req.body);
      return res.json(result);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) {
        console.error('[EIS] fiscalize-sale:', err.response?.data || err.message);
      }
      return res.status(status).json({
        success: false,
        message: err.response?.data?.remark || err.message || 'Fiscalization failed',
      });
    }
  });

  /** POST /api/eis/startup-sync — config + block check + offline flush (call on app load) */
  app.post('/api/eis/startup-sync', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.body.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded?.eis?.enabled) {
        return res.json({ success: true, skipped: true, message: 'EIS not enabled' });
      }
      const result = await runEisStartupSync(firestore, admin, loaded);
      return res.json({ success: true, ...result });
    } catch (err) {
      console.error('[EIS] startup-sync:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** GET /api/eis/block-status — terminal block message from MRA */
  app.get('/api/eis/block-status', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.query.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded?.secrets?.jwtToken) {
        return res.status(400).json({ success: false, message: 'EIS not configured' });
      }
      const baseUrl = getEisBaseUrl(loaded.eis?.environment);
      const blockResponse = await getTerminalBlockingMessage({ baseUrl, jwtToken: loaded.secrets.jwtToken });
      const blocked = !!(blockResponse?.data?.isBlocked ?? blockResponse?.data?.blocked ?? loaded.eis?.blocked);
      const blockMessage = blockResponse?.data?.message || blockResponse?.remark || loaded.eis?.blockReason || null;
      if (blocked !== loaded.eis?.blocked) {
        await loaded.tenantRef.update({
          'eis.blocked': blocked,
          'eis.blockReason': blockMessage,
        });
      }
      return res.json({ success: true, blocked, blockMessage, eis: { ...loaded.eis, blocked, blockReason: blockMessage } });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** POST /api/eis/flush-offline — retry queued offline sales */
  app.post('/api/eis/flush-offline', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.body.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded?.secrets?.jwtToken) {
        return res.status(400).json({ success: false, message: 'EIS not configured' });
      }
      const stats = await flushOfflineQueue(firestore, admin, loaded);
      return res.json({ success: true, ...stats });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** POST /api/eis/upload-inventory — push POS items to MRA (one-time initial upload) */
  app.post('/api/eis/upload-inventory', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.body.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded?.secrets?.jwtToken) {
        return res.status(400).json({ success: false, message: 'EIS not configured' });
      }

      const tin = loaded.eis?.tin || loaded.tenant?.tin || loaded.tenant?.companyInfo?.taxId;
      if (!tin) {
        return res.status(400).json({ success: false, message: 'TIN required — activate terminal first' });
      }

      const workspaceUserId =
        req.body.workspaceUserId ||
        (await resolveWorkspaceUserId(firestore, tenantId, req.user.uid));

      const itemsSnap = await firestore.collection('users').doc(workspaceUserId).collection('Item').limit(500).get();
      const products = itemsSnap.docs.map((d) => mapPosItemToMraUploadProduct({ id: d.id, ...d.data() }));

      if (!products.length) {
        return res.status(400).json({ success: false, message: 'No inventory items to upload' });
      }

      const baseUrl = getEisBaseUrl(loaded.eis.environment);
      const mraResponse = await uploadInitialInventory({
        baseUrl,
        jwtToken: loaded.secrets.jwtToken,
        tin,
        isLastBatch: req.body.isLastBatch !== false,
        products,
      });

      const updatedEis = {
        ...(loaded.eis || {}),
        inventoryUploadedAt: new Date().toISOString(),
        inventoryUploadCount: products.length,
      };
      await saveEisState(firestore, admin, tenantId, updatedEis, null);

      return res.json({
        success: true,
        productCount: products.length,
        remark: mraResponse?.remark,
        raw: mraResponse,
      });
    } catch (err) {
      console.error('[EIS] upload-inventory:', err.message);
      return res.status(500).json({
        success: false,
        message: err.response?.data?.remark || err.message,
      });
    }
  });

  /** POST /api/eis/validate-vat5 — validate buyer authorization for VAT relief */
  app.post('/api/eis/validate-vat5', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.body.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded?.secrets?.jwtToken) {
        return res.status(400).json({ success: false, message: 'EIS not configured' });
      }
      const { buyerTIN, authorizationCode } = req.body;
      if (!buyerTIN || !authorizationCode) {
        return res.status(400).json({ success: false, message: 'buyerTIN and authorizationCode are required' });
      }
      const baseUrl = getEisBaseUrl(loaded.eis.environment);
      const result = await validateBuyerAuthorizationCode({
        baseUrl,
        jwtToken: loaded.secrets.jwtToken,
        buyerTIN,
        authorizationCode,
      });
      const valid = result?.statusCode === 0 || result?.statusCode === 1;
      return res.json({ success: valid, valid, remark: result?.remark, raw: result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** GET /api/eis/offline-queue — pending offline sales count */
  app.get('/api/eis/offline-queue', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.query.tenantId);
      const snap = await firestore
        .collection('eis_offline_queue')
        .doc(tenantId)
        .collection('pending')
        .where('status', '==', 'pending')
        .limit(100)
        .get();
      const pending = snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString?.() || null }));
      return res.json({ success: true, count: pending.length, pending });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  /** PATCH /api/eis/settings — update non-secret EIS settings */
  app.patch('/api/eis/settings', verifyToken, async (req, res) => {
    try {
      const tenantId = await resolveTenantId(req.user.uid, req.body.tenantId);
      const loaded = await loadTenantEis(firestore, tenantId);
      if (!loaded) return res.status(404).json({ success: false, message: 'Tenant not found' });

      const { enabled, siteId, environment, autoSyncProducts } = req.body;
      const updated = {
        ...(loaded.eis || {}),
        ...(enabled !== undefined ? { enabled: !!enabled } : {}),
        ...(siteId !== undefined ? { siteId: String(siteId) } : {}),
        ...(environment ? { environment } : {}),
        ...(autoSyncProducts !== undefined ? { autoSyncProducts: !!autoSyncProducts } : {}),
      };

      await saveEisState(firestore, admin, tenantId, updated, null);
      return res.json({ success: true, eis: updated });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });
}
