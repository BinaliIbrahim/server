const COLLECTION_LABELS = {
  Sale: 'Sale',
  SaleItem: 'Sale item',
  Purchase: 'Purchase',
  PurchaseItem: 'Purchase item',
  PurchaseOrder: 'Purchase order',
  Expense: 'Expense',
  Item: 'Product',
  Customer: 'Customer',
  CreditSale: 'Credit sale',
  Payment: 'Payment',
  Supplier: 'Supplier',
  Category: 'Category',
  Warehouse: 'Warehouse',
  GoodsReceiptNote: 'Goods receipt',
  Tenant: 'Business',
  User: 'User',
  Period: 'Accounting period',
  Role: 'Role',
  Settings: 'Settings',
};

const ACTION_LABELS = {
  CREATE: 'created',
  UPDATE: 'updated',
  DELETE: 'deleted',
  UPDATE_STOCK: 'stock updated',
  PERIOD_LOCK: 'locked',
  PERIOD_UNLOCK: 'unlocked',
  ASSIGN_ROLE: 'assign role',
};

const SKIP_AUDIT = new Set(['sale|create']);

const SKIP_ACTIVITY = new Set(['dashboard_view']);

const ACTIVITY_TITLES = {
  team_user_created: 'New team member',
  team_user_approved: 'Team member approved',
  team_user_deleted: 'Team member removed',
  low_stock: 'Low stock alert',
  out_of_stock: 'Out of stock',
  large_movement: 'Large stock movement',
  item_created: 'Product added',
  item_updated: 'Product updated',
  item_deleted: 'Product removed',
  credit_sale_created: 'Credit sale recorded',
  credit_payment_received: 'Credit payment received',
  credit_reminders_sent: 'Credit payment reminders',
  credit_due_soon: 'Credit payment due soon',
  credit_due_today: 'Credit payment due today',
  credit_overdue: 'Credit payment overdue',
  credit_unpaid: 'Unpaid credit sale',
  customer_saved: 'Customer saved',
  grn_received: 'Goods received',
  subscription_activated: 'Subscription activated',
  warehouse_created: 'Warehouse added',
  warehouse_updated: 'Warehouse updated',
  warehouse_deleted: 'Warehouse removed',
  customer_created: 'Customer added',
  customer_updated: 'Customer updated',
  tenant_registered: 'Business registered',
  owner_payment_recorded: 'Owner payment recorded',
  category_created: 'Category added',
  category_updated: 'Category updated',
  supplier_created: 'Supplier added',
  supplier_updated: 'Supplier updated',
  supplier_deleted: 'Supplier removed',
};

function resolveWorkspaceUserId(data) {
  const newData = data.newData || {};
  const oldData = data.oldData || {};
  const meta = data.meta || {};
  return (
    data.workspaceUserId ||
    meta.workspaceUserId ||
    meta.targetUserId ||
    meta.notifyUserId ||
    newData.createdFor ||
    newData.userId ||
    oldData.createdFor ||
    data.userId ||
    null
  );
}

function nameSuffix(newData, oldData) {
  const name =
    newData?.item_name ||
    newData?.name ||
    newData?.expense_name ||
    newData?.customerName ||
    oldData?.item_name ||
    oldData?.name;
  return name ? `: ${name}` : '';
}

export function buildFromAuditLog(data) {
  const action = data.action || '';
  const collectionName = data.collection || '';
  const skipKey = `${String(collectionName).toLowerCase()}|${String(action).toLowerCase()}`;
  if (SKIP_AUDIT.has(skipKey)) return null;

  const wsUserId = resolveWorkspaceUserId(data);
  if (!wsUserId) return null;

  const label = COLLECTION_LABELS[collectionName] || collectionName || 'Record';
  const verb = ACTION_LABELS[action] || String(action).toLowerCase();
  const title = `${label} ${verb}`;
  const message =
    (data.description || '').trim() ||
    `${data.fullName || 'Someone'} ${verb} ${label.toLowerCase()}${nameSuffix(data.newData, data.oldData)}`;

  return {
    workspaceUserId: wsUserId,
    tenantId: data.tenantId || null,
    type: `audit_${String(collectionName).toLowerCase()}_${String(action).toLowerCase()}`,
    title,
    message,
    emailSubject: `RetailFlow — ${title}`,
    emailHtml: `<h2>${title}</h2><p>${message}</p><p><em>RetailFlow</em></p>`,
    data: { action, collection: collectionName },
  };
}

export function buildFromActivity(data) {
  const action = data.action || '';
  if (SKIP_ACTIVITY.has(action)) return null;

  const wsUserId = resolveWorkspaceUserId(data);
  if (!wsUserId) return null;

  const title = ACTIVITY_TITLES[action] || `${data.module || 'System'} update`;
  const message =
    data.meta?.message ||
    `${data.fullName || 'Someone'} — ${action.replace(/_/g, ' ')}`;

  return {
    workspaceUserId: wsUserId,
    tenantId: data.tenantId || null,
    type: `activity_${action}`,
    title,
    message,
    emailSubject: `RetailFlow — ${title}`,
    emailHtml: `<h2>${title}</h2><p>${message}</p><p><em>RetailFlow</em></p>`,
    data: { action, module: data.module || '' },
  };
}

export async function deliverNotification(firestore, notifications, admin, payload) {
  if (!payload?.workspaceUserId) return;

  await firestore.collection(`users/${payload.workspaceUserId}/notifications`).add({
    tenantId: payload.tenantId || null,
    type: payload.type || 'event',
    title: payload.title,
    message: payload.message,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await notifications.sendNotification(payload);
}
