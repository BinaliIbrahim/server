/**
 * Public online shop — place order with stock validation (Firebase Admin).
 */

function normalizeWhatsAppPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('265') && digits.length >= 12) return digits;
  if (digits.startsWith('0') && digits.length >= 9) return `265${digits.slice(1)}`;
  if (digits.length === 9) return `265${digits}`;
  return digits;
}

function buildWhatsAppUrl(phone, message) {
  const normalized = normalizeWhatsAppPhone(phone);
  if (!normalized) return null;
  const text = encodeURIComponent(String(message || '').trim());
  return `https://wa.me/${normalized}${text ? `?text=${text}` : ''}`;
}

function buildShopOrderWhatsAppMessage({
  storeName,
  orderNumber,
  customerName,
  customerPhone,
  items,
  total,
  currency,
  fulfillment,
  deliveryAddress,
  notes,
}) {
  const lines = [
    `Hello, I placed an order on ${storeName || 'your online shop'}.`,
    '',
    `Order: ${orderNumber}`,
    `Name: ${customerName}`,
    `Phone: ${customerPhone}`,
    fulfillment === 'delivery' && deliveryAddress ? `Delivery to: ${deliveryAddress}` : 'Pickup in store',
    '',
    'Items:',
  ];
  (items || []).forEach((line) => {
    lines.push(`• ${line.item_name} × ${line.quantity} — ${currency} ${Number(line.lineTotal || 0).toLocaleString()}`);
  });
  lines.push('', `Total: ${currency} ${Number(total || 0).toLocaleString()}`);
  if (notes?.trim()) lines.push('', `Notes: ${notes.trim()}`);
  lines.push('', 'Please confirm my order. Thank you!');
  return lines.join('\n');
}

export function createShopOrderHandler({ firestore, admin, notifications }) {
  const FieldValue = admin.firestore.FieldValue;

  async function getStoreBySlug(slug) {
    const snap = await firestore.collection('public_stores').doc(slug).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data.enabled) return null;
    return { id: snap.id, ...data };
  }

  async function nextOrderNumber(tenantId) {
    const counterRef = firestore.collection('shop_counters').doc(tenantId);
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(counterRef);
      const next = (snap.exists ? snap.data().orderCount || 0 : 0) + 1;
      tx.set(counterRef, { orderCount: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return `WEB-${String(next).padStart(4, '0')}`;
    });
  }

  return async function placeShopOrder(req, res) {
    try {
      const {
        storeSlug,
        customerName,
        customerPhone,
        customerEmail,
        deliveryAddress,
        fulfillment,
        paymentMethod,
        notes,
        items,
      } = req.body || {};

      if (!storeSlug || !customerName?.trim() || !customerPhone?.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Store, customer name, and phone are required.',
        });
      }

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Cart is empty.' });
      }

      const store = await getStoreBySlug(String(storeSlug).toLowerCase().trim());
      if (!store) {
        return res.status(404).json({ success: false, message: 'Store not found or not open.' });
      }

      const fulfillmentType = fulfillment === 'delivery' ? 'delivery' : 'pickup';
      if (fulfillmentType === 'delivery' && !deliveryAddress?.trim()) {
        return res.status(400).json({ success: false, message: 'Delivery address is required.' });
      }

      const workspaceUserId = store.workspaceUserId;
      const tenantId = store.tenantId;
      const catalogRef = firestore.collection('public_catalog').doc(tenantId).collection('items');

      const orderLines = [];
      let subtotal = 0;

      for (const line of items) {
        const itemId = String(line.itemId || '');
        const qty = Number(line.quantity);
        if (!itemId || !Number.isFinite(qty) || qty <= 0) {
          return res.status(400).json({ success: false, message: 'Invalid cart item.' });
        }

        const catSnap = await catalogRef.doc(itemId).get();
        if (!catSnap.exists || catSnap.data().enabled === false) {
          return res.status(400).json({
            success: false,
            message: `Product unavailable: ${line.name || itemId}`,
          });
        }

        const cat = catSnap.data();
        const stock = Number(cat.stock) || 0;
        if (stock < qty) {
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for ${cat.item_name}. Available: ${stock}`,
          });
        }

        const price = Number(cat.price) || 0;
        const lineTotal = price * qty;
        subtotal += lineTotal;
        orderLines.push({
          itemId,
          item_name: cat.item_name,
          price,
          quantity: qty,
          lineTotal,
        });
      }

      const orderNumber = await nextOrderNumber(tenantId);
      const orderRef = firestore.collection('online_orders').doc();
      const now = FieldValue.serverTimestamp();

      await firestore.runTransaction(async (tx) => {
        for (const line of orderLines) {
          const catDoc = catalogRef.doc(line.itemId);
          const itemDoc = firestore.collection('users').doc(workspaceUserId).collection('Item').doc(line.itemId);
          const catSnap = await tx.get(catDoc);
          const itemSnap = await tx.get(itemDoc);

          if (!catSnap.exists) throw new Error(`Product removed: ${line.item_name}`);
          const catStock = Number(catSnap.data().stock) || 0;
          if (catStock < line.quantity) {
            throw new Error(`Insufficient stock for ${line.item_name}`);
          }

          tx.update(catDoc, {
            stock: catStock - line.quantity,
            updatedAt: now,
          });

          if (itemSnap.exists) {
            const liveStock = Number(itemSnap.data().Stock) || 0;
            tx.update(itemDoc, {
              Stock: Math.max(0, liveStock - line.quantity),
              updatedAt: now,
            });
          }
        }

        tx.set(orderRef, {
          orderNumber,
          tenantId,
          workspaceUserId,
          storeSlug: store.slug,
          storeName: store.name,
          status: 'pending',
          customerName: customerName.trim(),
          customerPhone: customerPhone.trim(),
          customerEmail: (customerEmail || '').trim(),
          deliveryAddress: (deliveryAddress || '').trim(),
          fulfillment: fulfillmentType,
          paymentMethod: 'whatsapp',
          notes: (notes || '').trim(),
          items: orderLines,
          subtotal,
          total: subtotal,
          currency: store.currency || 'MWK',
          createdAt: now,
          updatedAt: now,
          source: 'web_storefront',
          inventoryDeducted: true,
        });
      });

      const whatsappMessage = buildShopOrderWhatsAppMessage({
        storeName: store.name,
        orderNumber,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        items: orderLines,
        total: subtotal,
        currency: store.currency || 'MWK',
        fulfillment: fulfillmentType,
        deliveryAddress,
        notes,
      });
      const whatsappUrl = buildWhatsAppUrl(store.contactPhone, whatsappMessage);

      if (notifications?.sendNotification) {
        try {
          await notifications.sendNotification({
            workspaceUserId,
            tenantId,
            type: 'online_order',
            title: 'New online order',
            message: `${orderNumber} — ${customerName.trim()} ordered ${orderLines.length} item(s) for ${store.currency || 'MWK'} ${subtotal.toLocaleString()}`,
            data: { orderId: orderRef.id, orderNumber },
          });
        } catch (notifyErr) {
          console.warn('shop order notification:', notifyErr.message);
        }
      }

      return res.status(200).json({
        success: true,
        orderId: orderRef.id,
        orderNumber,
        total: subtotal,
        currency: store.currency || 'MWK',
        whatsappUrl,
        contactPhone: store.contactPhone || null,
      });
    } catch (error) {
      console.error('placeShopOrder:', error.message);
      return res.status(500).json({
        success: false,
        message: error.message || 'Could not place order. Please try again.',
      });
    }
  };
}
