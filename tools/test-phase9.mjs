import fs from 'node:fs';
const files={app:'frontend/assets/app.js',data:'frontend/assets/data-service.js',api:'backend/render-api/src/server.js',sw:'frontend/service-worker.js',index:'frontend/index.html'};
for(const [name,path] of Object.entries(files)){if(!fs.existsSync(path))throw new Error(`${name}: fichier manquant ${path}`);}
const app=fs.readFileSync(files.app,'utf8'),data=fs.readFileSync(files.data,'utf8'),api=fs.readFileSync(files.api,'utf8'),sw=fs.readFileSync(files.sw,'utf8');
const checks=[
 ['Consentement légal',app.includes('consentGate')&&data.includes('acceptLegalDocuments')],
 ['Export personnel',app.includes('data-export-my-data')&&api.includes('accountExport')],
 ['Fermeture de compte',app.includes('data-request-account-deletion')&&api.includes('requestAccountDeletion')],
 ['Notifications navigateur',app.includes('showBrowserNotification')&&sw.includes('notificationclick')],
 ['API versionnée',api.includes('/api/v1/health')&&api.includes('/api/v1/account/export')],
 ['Aperçu de rôle',app.includes('data-view-as-role')&&app.includes('drsx-view-as-role')],
 ['Version Phase 9',api.includes("5.0.0-phase9")&&sw.includes('drsx-v5-phase9')]
];
for(const [label,ok] of checks){console.log(`${ok?'OK':'ERREUR'} - ${label}`);if(!ok)process.exitCode=1;}
if(process.exitCode)throw new Error('Tests Phase 9 échoués.');
console.log('Tous les tests Phase 9 sont réussis.');
