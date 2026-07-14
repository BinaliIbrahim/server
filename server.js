/**
 * RetailFlow API — PayChangu subscriptions + notifications (app.ibratechinnovations.com)
 *
 * Subscriptions (src/Subscription.jsx):
 *   POST /api/start-free-trial
 *   POST /api/charge-mobile-money
 *   GET  /api/check-payment/:tx_ref
 *   GET  /payment-callback
 *
 * Notifications (src/services/saleNotificationService.js):
 *   POST /api/notifications/sale-completed
 *   POST /api/notifications/send
 *
 * Payment records: users/{uid}/Payments/{tx_ref}
 * Tenant subscription fields: subscriptionPlan, subscriptionStart, subscriptionEnd, isActive
 */
import express from 'express';
import admin from 'firebase-admin';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import {
  PLAN_IDS,
  monthsForAmount,
  planDisplayName,
  validateChargePayload,
  fetchSubscriptionMarkup,
} from './subscriptionPlans.js';
import { createNotificationService } from './notificationService.js';
import { startEventWatchers } from './eventWatcher.js';
import { createShopOrderHandler } from './shopOrders.js';
import { createEisRoutes } from './eisRoutes.js';

dotenv.config();

const PORT = Number(process.env.PORT) || 5000;
const APP_ORIGIN = (process.env.APP_ORIGIN || 'https://salesmanagement.ibratechinnovations.com').replace(/\/$/, '');
const API_PUBLIC_ORIGIN = (process.env.API_PUBLIC_ORIGIN || 'https://app.ibratechinnovations.com').replace(/\/$/, '');

const defaultCors = [
  APP_ORIGIN,
  API_PUBLIC_ORIGIN,
  'http://localhost:3000',
  'http://localhost:3003',
  'http://localhost:5000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3003',
  'http://127.0.0.1:5173',
];
const extraCors = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const corsOrigins = [...new Set([...defaultCors, ...extraCors])];

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (corsOrigins.includes(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.ibratechinnovations.com') ||
      hostname === 'ibratechinnovations.com'
    );
  } catch {
    return false;
  }
}

const PROVIDER_MAP = {
  airtel: 'airtel_money',
  tnm: 'tnm_mpamba',
};

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (isAllowedCorsOrigin(origin)) {
        callback(null, origin);
      } else {
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
    optionsSuccessStatus: 204,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path} — ${new Date().toISOString()}`);
  next();
});

let firestore = null;
let auth = null;
let notifications = null;
let shopPlaceOrder = null;
let firestoreReady = false;
let firestoreDegradedReason = '';

async function initializeFirebase() {
  if (!process.env.PROJECT_ID || !process.env.CLIENT_EMAIL || !process.env.PRIVATE_KEY) {
    throw new Error('Missing Firebase credentials (PROJECT_ID, CLIENT_EMAIL, PRIVATE_KEY)');
  }
  const serviceAccount = {
    projectId: process.env.PROJECT_ID,
    clientEmail: process.env.CLIENT_EMAIL,
    privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
  if (admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  firestore = admin.firestore();
  auth = admin.auth();
  notifications = createNotificationService({ firestore, admin });

  try {
    await firestore.collection('tenants').limit(1).get();
    firestoreReady = true;
    console.log('Firebase connected');
  } catch (error) {
    firestoreReady = false;
    firestoreDegradedReason = error.message || 'Firestore unavailable';
    console.warn('Firebase degraded (server will start in limited mode):', firestoreDegradedReason);
    if (String(firestoreDegradedReason).includes('RESOURCE_EXHAUSTED')) {
      console.warn(
        'Firestore daily quota exceeded. Wait for reset (midnight Pacific) or upgrade to Blaze. ' +
          'Online shop checkout still works via client Firestore fallback when rules are deployed.'
      );
    }
  }
  return firestoreReady;
}

async function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token provided' });
  }
  try {
    req.user = await auth.verifyIdToken(token);
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
      error: error.message,
    });
  }
}

async function resolveTenantId(userId, tenantIdFromBody) {
  if (tenantIdFromBody) return tenantIdFromBody;

  const userDoc = await firestore.collection('users').doc(userId).get();
  if (userDoc.exists && userDoc.data().tenantId) {
    return userDoc.data().tenantId;
  }

  const tenantUserQuery = await firestore
    .collection('tenant_users')
    .where('userId', '==', userId)
    .where('isActive', '==', true)
    .limit(1)
    .get();

  if (!tenantUserQuery.empty) {
    return tenantUserQuery.docs[0].data().tenantId;
  }
  return null;
}

function computeSubscriptionEnd(tenantData, monthsToAdd) {
  const currentDate = new Date();
  let endDate = new Date(currentDate);

  if (tenantData?.subscriptionEnd) {
    const raw = tenantData.subscriptionEnd;
    const currentEnd = raw.toDate ? raw.toDate() : new Date(raw);
    if (currentEnd > currentDate) {
      endDate = new Date(currentEnd);
    }
  }
  endDate.setMonth(endDate.getMonth() + monthsToAdd);
  return { currentDate, endDate };
}

async function activateTenantSubscription(tenantId, paymentData) {
  if (!tenantId) return;

  const tenantRef = firestore.collection('tenants').doc(tenantId);
  const tenantDoc = await tenantRef.get();
  if (!tenantDoc.exists) return;

  const tenantData = tenantDoc.data();
  const monthsToAdd = monthsForAmount(paymentData.amount);
  const { currentDate, endDate } = computeSubscriptionEnd(tenantData, monthsToAdd);
  const planId = paymentData.plan || PLAN_IDS.SOLE;

  await tenantRef.update({
    subscriptionPlan: planId,
    subscriptionStart: admin.firestore.Timestamp.fromDate(currentDate),
    subscriptionEnd: admin.firestore.Timestamp.fromDate(endDate),
    isActive: true,
    updatedAt: admin.firestore.Timestamp.fromDate(currentDate),
  });
  console.log(`Subscription updated for tenant ${tenantId} → ${planId} until ${endDate.toISOString()}`);
}

async function verifyPayChangu(txRef) {
  const verifyResponse = await axios.get(`https://api.paychangu.com/verify-payment/${txRef}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
    },
    timeout: 30000,
  });
  return verifyResponse.data?.status === 'success';
}

async function finalizePayment(userId, txRef, isSuccessful, verifyMessage) {
  const paymentRef = firestore.collection('users').doc(userId).collection('Payments').doc(txRef);
  const paymentDoc = await paymentRef.get();
  if (!paymentDoc.exists) {
    return { found: false };
  }

  const paymentData = paymentDoc.data();
  const now = admin.firestore.Timestamp.fromDate(new Date());

  if (isSuccessful) {
    await paymentRef.update({
      status: 'successful',
      verifiedAt: now,
      start_date: new Date().toISOString(),
      error: null,
    });
    await activateTenantSubscription(paymentData.tenantId, paymentData);

    if (notifications && paymentData.tenantId) {
      const tenantSnap = await firestore.collection('tenants').doc(paymentData.tenantId).get();
      const ownerId = tenantSnap.data()?.createdBy || userId;
      await notifications.sendNotification({
        workspaceUserId: ownerId,
        tenantId: paymentData.tenantId,
        type: 'subscription_activated',
        title: 'Subscription activated',
        message: `Payment received — ${paymentData.plan || 'plan'} is now active.`,
        emailSubject: 'RetailFlow — Subscription activated',
        emailHtml: `<h2>Subscription activated</h2><p>Your payment was successful and your subscription is active.</p><p><em>RetailFlow</em></p>`,
        data: { plan: paymentData.plan || '', tx_ref: txRef },
      }).catch((err) => console.warn('payment notification:', err.message));
    }

    return { found: true, paymentData, status: 'successful' };
  }

  await paymentRef.update({
    status: 'failed',
    verifiedAt: now,
    error: verifyMessage || 'Payment failed',
  });
  return { found: true, paymentData, status: 'failed' };
}

// ——— Routes ———

app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'RetailFlow API running',
    origin: API_PUBLIC_ORIGIN,
    endpoints: [
      'POST /api/start-free-trial',
      'POST /api/charge-mobile-money',
      'GET /api/check-payment/:tx_ref',
      'GET /payment-callback',
      'POST /api/notifications/sale-completed',
      'POST /api/notifications/send',
    ],
  });
});

app.get('/api/test', (_req, res) => {
  res.json({ success: true, message: 'API reachable', timestamp: new Date().toISOString() });
});

/** 30-day trial on tenant */
app.post('/api/start-free-trial', verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { tenantId: bodyTenantId } = req.body;

  try {
    const targetTenantId = await resolveTenantId(userId, bodyTenantId);
    if (!targetTenantId) {
      return res.status(400).json({
        success: false,
        message: 'No active tenant found. Complete business setup first.',
        needsBusinessSetup: true,
      });
    }

    const tenantRef = firestore.collection('tenants').doc(targetTenantId);
    const tenantDoc = await tenantRef.get();
    if (!tenantDoc.exists) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    const tenantData = tenantDoc.data();
    if (tenantData.trialUsed === true) {
      return res.status(400).json({
        success: false,
        message: 'Your business has already used the free trial period.',
      });
    }

    const currentDate = new Date();
    const endDate = new Date(currentDate);
    endDate.setDate(endDate.getDate() + 30);

    await tenantRef.update({
      subscriptionPlan: PLAN_IDS.TRIAL,
      subscriptionStart: admin.firestore.Timestamp.fromDate(currentDate),
      subscriptionEnd: admin.firestore.Timestamp.fromDate(endDate),
      trialUsed: true,
      isActive: true,
      updatedAt: admin.firestore.Timestamp.fromDate(currentDate),
      updatedBy: userId,
    });

    res.status(200).json({
      success: true,
      message: '30-day free trial started successfully',
      endDate: endDate.toISOString(),
      plan: PLAN_IDS.TRIAL,
    });
  } catch (error) {
    console.error('start-free-trial:', error.message);
    res.status(500).json({ success: false, message: 'Failed to start free trial', error: error.message });
  }
});

/** PayChangu mobile money checkout */
app.post('/api/charge-mobile-money', verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { amount, currency = 'MWK', phone, provider, plan, tenantId } = req.body;

  const subscriptionMarkup = await fetchSubscriptionMarkup(firestore);
  const validation = validateChargePayload({ amount, plan, phone, provider }, subscriptionMarkup);
  if (!validation.ok) {
    return res.status(400).json({ success: false, message: validation.message });
  }

  if (!process.env.PAYCHANGU_SECRET_KEY) {
    return res.status(500).json({ success: false, message: 'Payment gateway not configured' });
  }

  try {
    const targetTenantId = await resolveTenantId(userId, tenantId);
    const userRecord = await auth.getUser(userId);
    const nameParts = (userRecord.displayName || 'User').split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || '';
    const txRef = `${userId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const numAmount = validation.amount;
    const planName = planDisplayName(plan);

    const payChanguPayload = {
      amount: String(numAmount),
      currency,
      email: userRecord.email,
      first_name: firstName,
      last_name: lastName,
      callback_url: `${API_PUBLIC_ORIGIN}/payment-callback`,
      return_url: `${APP_ORIGIN}/subscription?status=completed&plan=${plan}`,
      tx_ref: txRef,
      customization: {
        title: 'Ibratech Subscription',
        description: planName,
      },
      meta: {
        uuid: userId,
        phone,
        provider: PROVIDER_MAP[provider],
        plan,
        tenantId: targetTenantId,
        amount: numAmount,
      },
    };

    const payChanguResponse = await axios.post('https://api.paychangu.com/payment', payChanguPayload, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });

    if (payChanguResponse.data.status !== 'success' || !payChanguResponse.data.data?.checkout_url) {
      return res.status(500).json({
        success: false,
        message: payChanguResponse.data.message || 'Failed to initiate payment',
      });
    }

    await firestore
      .collection('users')
      .doc(userId)
      .collection('Payments')
      .doc(txRef)
      .set({
        userId,
        email: userRecord.email,
        firstName,
        lastName,
        amount: numAmount,
        currency,
        plan,
        tenantId: targetTenantId || null,
        tx_ref: txRef,
        checkout_url: payChanguResponse.data.data.checkout_url,
        status: 'pending',
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        phone,
        provider: PROVIDER_MAP[provider],
      });

    res.status(200).json({
      success: true,
      message: `Payment initiated for ${planName}.`,
      checkout_url: payChanguResponse.data.data.checkout_url,
      tx_ref: txRef,
      status: 'pending',
    });
  } catch (error) {
    console.error('charge-mobile-money:', error.message, error.response?.data);
    let message = 'Failed to initiate payment. ';
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      message += 'Payment gateway timed out. Try again.';
    } else if (error.response?.data?.message) {
      message += error.response.data.message;
    } else if (error.message === 'Network Error') {
      message += 'Network error.';
    } else {
      message += error.message;
    }
    res.status(500).json({ success: false, message, error: error.message });
  }
});

/** Poll payment status (authenticated owner) */
app.get('/api/check-payment/:tx_ref', verifyToken, async (req, res) => {
  const { tx_ref } = req.params;
  const userId = req.user.uid;

  try {
    const paymentRef = firestore.collection('users').doc(userId).collection('Payments').doc(tx_ref);
    const paymentDoc = await paymentRef.get();

    if (!paymentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    const paymentData = paymentDoc.data();
    if (paymentData.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (paymentData.status !== 'pending') {
      return res.status(200).json({
        success: paymentData.status === 'successful',
        status: paymentData.status,
        plan: paymentData.plan,
      });
    }

    try {
      const isSuccessful = await verifyPayChangu(tx_ref);
      if (isSuccessful) {
        await finalizePayment(userId, tx_ref, true);
        return res.status(200).json({
          success: true,
          status: 'successful',
          plan: paymentData.plan,
          message: `Subscription activated (${planDisplayName(paymentData.plan)})`,
        });
      }

      await paymentRef.update({
        status: 'failed',
        error: 'Payment not completed',
      });
      return res.status(200).json({ success: false, status: 'failed' });
    } catch (verifyError) {
      console.error('verify pending:', verifyError.message);
      return res.status(200).json({
        success: false,
        status: 'pending',
        message: 'Payment still processing',
      });
    }
  } catch (error) {
    console.error('check-payment:', error.message);
    res.status(500).json({ success: false, message: 'Failed to check payment', error: error.message });
  }
});

/** Sale completed — email registered users + FCM push */
app.post('/api/notifications/sale-completed', verifyToken, async (req, res) => {
  const {
    workspaceUserId,
    saleData,
    cartItems,
    totalAmount,
    tenantId,
    currency = 'MWK',
  } = req.body || {};

  if (!workspaceUserId || !saleData || !Array.isArray(cartItems) || totalAmount == null) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: workspaceUserId, saleData, cartItems, totalAmount',
    });
  }

  try {
    const result = await notifications.notifySaleCompleted({
      workspaceUserId,
      saleData,
      cartItems,
      totalAmount,
      tenantId: tenantId || null,
      currency,
    });
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('notifications/sale-completed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to send sale notification',
      error: error.message,
    });
  }
});

/** Generic notification — email + push */
app.post('/api/notifications/send', verifyToken, async (req, res) => {
  const {
    workspaceUserId,
    tenantId,
    type,
    title,
    message,
    emailSubject,
    emailHtml,
    data,
  } = req.body || {};

  if (!workspaceUserId || !type || !title || !message) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: workspaceUserId, type, title, message',
    });
  }

  try {
    const result = await notifications.sendNotification({
      workspaceUserId,
      tenantId: tenantId || null,
      type,
      title,
      message,
      emailSubject,
      emailHtml,
      data: data || {},
    });
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('notifications/send:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to send notification',
      error: error.message,
    });
  }
});

/** Health check */
app.get('/api/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    firestoreReady,
    degraded: !firestoreReady,
    reason: firestoreDegradedReason || null,
    shopOrders: !!shopPlaceOrder && firestoreReady,
  });
});

/** Public online shop — no auth (guest checkout) */
app.post('/api/shop/place-order', (req, res) => {
  if (!shopPlaceOrder || !firestoreReady) {
    return res.status(503).json({
      success: false,
      message:
        firestoreDegradedReason?.includes('RESOURCE_EXHAUSTED')
          ? 'Server Firestore quota exceeded. The storefront will retry checkout directly — deploy firestore rules if needed.'
          : 'Shop API unavailable. Try again shortly.',
    });
  }
  return shopPlaceOrder(req, res);
});

/** PayChangu redirect (no auth — uses tx_ref prefix as userId) */
app.get('/payment-callback', async (req, res) => {
  const { tx_ref, plan: queryPlan } = req.query;

  if (!tx_ref) {
    return res.redirect(
      `${APP_ORIGIN}/subscription?status=notpaid&error=${encodeURIComponent('Missing transaction reference')}`
    );
  }

  const userId = String(tx_ref).split('-')[0];
  if (!userId) {
    return res.redirect(
      `${APP_ORIGIN}/subscription?status=notpaid&error=${encodeURIComponent('Invalid transaction reference')}`
    );
  }

  try {
    const isSuccessful = await verifyPayChangu(tx_ref);
    const result = await finalizePayment(
      userId,
      tx_ref,
      isSuccessful,
      isSuccessful ? null : 'Verification failed'
    );

    const paymentPlan = result.paymentData?.plan || queryPlan || '';
    res.redirect(
      `${APP_ORIGIN}/subscription?status=${isSuccessful ? 'paid' : 'notpaid'}&tx_ref=${tx_ref}&plan=${paymentPlan}`
    );
  } catch (error) {
    console.error('payment-callback:', error.message);
    res.redirect(
      `${APP_ORIGIN}/subscription?status=notpaid&error=${encodeURIComponent(error.message)}`
    );
  }
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled:', err.message);
  res.status(500).json({ success: false, message: 'Internal Server Error', error: err.message });
});

const startServer = async () => {
  try {
    await initializeFirebase();
    if (firestore) {
      shopPlaceOrder = createShopOrderHandler({ firestore, admin, notifications });
      createEisRoutes({ app, firestore, admin, verifyToken, resolveTenantId });
    }

    const watchersEnabled = process.env.ENABLE_EVENT_WATCHERS !== 'false';
    if (watchersEnabled && firestoreReady && firestore) {
      startEventWatchers({ firestore, notifications, admin });
    } else if (!watchersEnabled) {
      console.log('Event watchers disabled (ENABLE_EVENT_WATCHERS=false)');
    } else {
      console.warn('Event watchers skipped — Firestore not ready');
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`RetailFlow API on port ${PORT}`);
      console.log(`Public: ${API_PUBLIC_ORIGIN}`);
      console.log(`App origin: ${APP_ORIGIN}`);
      console.log(`Health: http://localhost:${PORT}/api/health`);
      console.log(`Shop orders: POST /api/shop/place-order (${firestoreReady ? 'ready' : 'degraded'})`);
      console.log('MRA EIS: POST /api/eis/activate, POST /api/eis/fiscalize-sale, POST /api/eis/sync-inventory');
      if (firestoreReady && watchersEnabled) {
        console.log('Watching audit_logs + user_activity for notifications');
      }
    });
  } catch (error) {
    console.error('Startup failed:', error.message);
    process.exit(1);
  }
};

startServer();
