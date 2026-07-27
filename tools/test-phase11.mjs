import fs from 'node:fs';
const read=p=>fs.readFileSync(p,'utf8');
const app=read('frontend/assets/app.js');
const data=read('frontend/assets/data-service.js');
const server=read('backend/render-api/src/server.js');
const styles=read('frontend/assets/styles.css');
const sw=read('frontend/service-worker.js');
const checks=[
 ['onglet Factures',app.includes("navItem('/app/factures','Factures','invoice')")],
 ['éditeur facture',app.includes('async function invoiceEditor')],
 ['signature manager',app.includes('manager_signature')&&app.includes('VALIDATION MANAGER')],
 ['logo optionnel',app.includes('show_dantrap_logo')&&app.includes('invoice-danatrap-logo')],
 ['prévisualisation A4',app.includes('invoice-live-preview')&&styles.includes('.invoice-paper')],
 ['API factures',server.includes("'/api/v1/invoices'")&&server.includes('saveInvoiceApi')],
 ['Drive privé',server.includes("kind:'invoice'")&&server.includes("folderFor('private')")],
 ['service frontend',data.includes('async listInvoices')&&data.includes('async saveInvoice')],
 ['version API',server.includes("5.0.0-phase11")],
 ['cache Phase 11',sw.includes('drsx-v5-phase11-invoices')]
];
let failed=false;
for(const [name,ok] of checks){console.log(`${ok?'OK':'ERREUR'} - ${name}`);if(!ok)failed=true;}
if(failed)process.exit(1);
console.log('Tests Phase 11 réussis.');
