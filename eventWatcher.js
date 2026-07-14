import { buildFromAuditLog, buildFromActivity, deliverNotification } from './eventHandlers.js';

/**
 * Watch audit_logs + user_activity and send in-app, email, and push for every business event.
 */
export function startEventWatchers({ firestore, notifications, admin }) {
  const seen = new Set();

  const handleChange = async (change, builder, isReady) => {
    if (!isReady() || change.type !== 'added') return;
    const id = change.doc.id;
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 5000) {
      [...seen].slice(0, 1000).forEach((k) => seen.delete(k));
    }

    const payload = builder(change.doc.data());
    if (!payload) return;

    try {
      await deliverNotification(firestore, notifications, admin, payload);
      console.log('Notification sent:', payload.type, payload.title);
    } catch (err) {
      console.warn('eventWatcher deliver:', err.message);
    }
  };

  let auditReady = false;
  firestore
    .collection('audit_logs')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .onSnapshot(
      (snapshot) => {
        if (!auditReady) {
          auditReady = true;
          return;
        }
        snapshot.docChanges().forEach((change) =>
          handleChange(change, buildFromAuditLog, () => auditReady)
        );
      },
      (err) => console.error('audit_logs watcher:', err.message)
    );

  let activityReady = false;
  firestore
    .collection('user_activity')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .onSnapshot(
      (snapshot) => {
        if (!activityReady) {
          activityReady = true;
          return;
        }
        snapshot.docChanges().forEach((change) =>
          handleChange(change, buildFromActivity, () => activityReady)
        );
      },
      (err) => console.error('user_activity watcher:', err.message)
    );

  console.log('Event notification watchers started (audit_logs, user_activity)');
}
