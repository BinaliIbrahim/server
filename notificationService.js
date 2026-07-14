import nodemailer from 'nodemailer';

function buildSaleEmailHtml({ saleData, cartItems, totalAmount, currency = 'MWK' }) {
  let rows = '';
  (cartItems || []).forEach((item) => {
    rows += `
      <tr>
        <td>${item.item_name || 'Item'}</td>
        <td>${item.quantity}</td>
        <td>${currency} ${Number(item.price || 0).toLocaleString()}</td>
        <td>${currency} ${Number(item.total || 0).toLocaleString()}</td>
      </tr>`;
  });

  return `
    <h2>Sale completed</h2>
    <p>A new sale was recorded in RetailFlow.</p>
    <p><strong>Sale ID:</strong> ${saleData?.Sale_id || '—'}</p>
    <p><strong>Date:</strong> ${saleData?.Saledate || '—'}</p>
    <p><strong>Total:</strong> ${currency} ${Number(totalAmount || 0).toLocaleString()}</p>
    <h3>Items</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
      <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p><em>Automated message from RetailFlow.</em></p>`;
}

function createMailTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

export function createNotificationService({ firestore, admin }) {
  async function resolveRecipientEmails(workspaceUserId, tenantId) {
    const emails = new Set();
    const ownerSnap = await firestore.collection('users').doc(workspaceUserId).get();
    const owner = ownerSnap.data() || {};

    if (owner.email && owner.settings?.emailNotifications !== false) {
      emails.add(owner.email);
    }

    if (tenantId) {
      const links = await firestore
        .collection('tenant_users')
        .where('tenantId', '==', tenantId)
        .where('role', '==', 'admin')
        .limit(10)
        .get();

      for (const link of links.docs) {
        const uid = link.data().userId;
        if (!uid) continue;
        const profile = await firestore.collection('users').doc(uid).get();
        const data = profile.data() || {};
        if (data.email && data.settings?.emailNotifications !== false) {
          emails.add(data.email);
        }
      }
    }

    return [...emails];
  }

  async function collectFcmTokens(workspaceUserId, tenantId) {
    const tokens = new Set();

    const addFromUser = async (uid) => {
      const snap = await firestore.collection('users').doc(uid).get();
      const data = snap.data() || {};
      if (data.settings?.pushNotifications === false) return;
      (data.fcmTokens || []).forEach((t) => tokens.add(t));
    };

    await addFromUser(workspaceUserId);

    if (tenantId) {
      const links = await firestore
        .collection('tenant_users')
        .where('tenantId', '==', tenantId)
        .limit(25)
        .get();
      for (const link of links.docs) {
        if (link.data().userId) await addFromUser(link.data().userId);
      }
    }

    return [...tokens];
  }

  async function sendEmails({ to, subject, html }) {
    const transporter = createMailTransporter();
    if (!transporter || !to.length) {
      return { sent: 0, skipped: !transporter };
    }

    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    let sent = 0;
    for (const email of to) {
      try {
        await transporter.sendMail({
          from: `"RetailFlow" <${from}>`,
          to: email,
          subject,
          html,
        });
        sent += 1;
      } catch (err) {
        console.warn('Email failed:', email, err.message);
      }
    }
    return { sent };
  }

  async function sendPush({ tokens, title, body, data = {} }) {
    if (!tokens.length) return { pushSent: 0 };
    try {
      const res = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v ?? '')])
        ),
      });
      return { pushSent: res.successCount, pushFailed: res.failureCount };
    } catch (err) {
      console.warn('FCM multicast failed:', err.message);
      return { pushSent: 0, error: err.message };
    }
  }

  async function notifySaleCompleted({
    workspaceUserId,
    saleData,
    cartItems,
    totalAmount,
    tenantId,
    currency = 'MWK',
  }) {
    const title = 'Sale completed';
    const message = `${cartItems.length} item(s) sold — ${currency} ${Number(totalAmount).toLocaleString()}`;

    const emails = await resolveRecipientEmails(workspaceUserId, tenantId);
    const emailResult = await sendEmails({
      to: emails,
      subject: `Sale completed — ${currency} ${Number(totalAmount).toLocaleString()}`,
      html: buildSaleEmailHtml({ saleData, cartItems, totalAmount, currency }),
    });

    const fcmTokens = await collectFcmTokens(workspaceUserId, tenantId);
    const pushResult = await sendPush({
      tokens: fcmTokens,
      title,
      body: message,
      data: {
        type: 'sale_completed',
        saleId: saleData?.Sale_id || '',
        totalAmount: String(totalAmount),
      },
    });

    return {
      ok: true,
      emailsSent: emailResult.sent || 0,
      pushSent: pushResult.pushSent || 0,
    };
  }

  /** Generic notification (email + push) for future event types */
  async function sendNotification({
    workspaceUserId,
    tenantId,
    type,
    title,
    message,
    emailSubject,
    emailHtml,
    data = {},
  }) {
    const emails = await resolveRecipientEmails(workspaceUserId, tenantId);
    const emailResult = await sendEmails({
      to: emails,
      subject: emailSubject || title,
      html: emailHtml || `<p>${message}</p><p><em>RetailFlow</em></p>`,
    });

    const fcmTokens = await collectFcmTokens(workspaceUserId, tenantId);
    const pushResult = await sendPush({
      tokens: fcmTokens,
      title,
      body: message,
      data: { type, ...data },
    });

    return {
      ok: true,
      emailsSent: emailResult.sent || 0,
      pushSent: pushResult.pushSent || 0,
    };
  }

  return { notifySaleCompleted, sendNotification };
}
