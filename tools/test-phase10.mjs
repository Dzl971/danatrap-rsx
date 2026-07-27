import fs from 'node:fs';

const files = {
  app: 'frontend/assets/app.js',
  data: 'frontend/assets/data-service.js',
  css: 'frontend/assets/styles.css',
  api: 'backend/render-api/src/server.js',
  pkg: 'backend/render-api/package.json',
  lock: 'backend/render-api/package-lock.json',
  sw: 'frontend/service-worker.js'
};
for (const [name, path] of Object.entries(files)) {
  if (!fs.existsSync(path)) throw new Error(`${name}: fichier manquant ${path}`);
}
const read = path => fs.readFileSync(path, 'utf8');
const app = read(files.app), data = read(files.data), css = read(files.css), api = read(files.api), pkg = read(files.pkg), lock = read(files.lock), sw = read(files.sw);

const checks = [
  ['Version API Phase 10', api.includes("5.0.0-phase10") && pkg.includes('5.0.0-phase10') && lock.includes('5.0.0-phase10')],
  ['Cache Phase 10', sw.includes('drsx-v5-phase10')],
  ['Notifications e-mail', api.includes('processNotificationEmails') && api.includes('RESEND_API_KEY') && api.includes('EMAIL_FROM')],
  ['Rappels et expirations', api.includes('send_reservation_reminders_v5') && api.includes('expire_reservations_v5')],
  ['Sauvegarde automatique', api.includes('runAutomaticBackup') && api.includes("scope = 'automatic'")],
  ['Corbeille Drive 30 jours', api.includes('purgeExpiredTrash') && api.includes('permanentlyDeleteDriveFile') && api.includes('setDriveTrash')],
  ['Tâches automatiques', api.includes('/api/v1/jobs/tick') && data.includes('runBackgroundJobs')],
  ['Récupération sécurisée', api.includes('sendRecoveryLink') && data.includes('adminSendRecoveryLink') && app.includes('data-admin-recovery-link')],
  ['Mode maintenance', app.includes('maintenancePage') && app.includes('maintenanceSettings') && data.includes('getSiteSetting')],
  ['Brouillons automatiques', app.includes('setupPageAutoDrafts') && app.includes('Brouillon local sauvegardé') && css.includes('.autosave-status')],
  ['Avertissement avant départ', app.includes('beforeunload') && app.includes('confirmDiscardChanges')],
  ['Historique réservation', app.includes('reservation-history') && app.includes('license_snapshot') && app.includes('status_history')],
  ['Santé plateforme enrichie', api.includes("provider:emailConfigured()?'Resend'") && app.includes('Automatisation')]
];
for (const [label, ok] of checks) {
  console.log(`${ok ? 'OK' : 'ERREUR'} - ${label}`);
  if (!ok) process.exitCode = 1;
}
if (process.exitCode) throw new Error('Tests Phase 10 échoués.');
console.log('Tous les tests Phase 10 sont réussis.');
