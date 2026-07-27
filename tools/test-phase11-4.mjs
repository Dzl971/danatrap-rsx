import fs from 'node:fs';

const app = fs.readFileSync('frontend/assets/app.js', 'utf8');
const css = fs.readFileSync('frontend/assets/styles.css', 'utf8');
const sw = fs.readFileSync('frontend/service-worker.js', 'utf8');
const server = fs.readFileSync('backend/render-api/src/server.js', 'utf8');

const checks = [
  [app.includes('function scheduleFormPreview('), 'planificateur d’aperçu manquant'],
  [app.includes('const BEAT_PREVIEW_FIELDS=new Set'), 'filtrage des champs de production manquant'],
  [app.includes('scheduleBeatPreview(pf,e.target,false)'), 'formulaire production non optimisé'],
  [!app.includes('if(detail){detail.innerHTML=productionDetailPreviewMarkup(current);}bind();'), 'bind global encore lancé par l’aperçu production'],
  [app.includes('runWhenBrowserIdle'), 'sauvegarde locale inactive en période idle'],
  [app.includes('scheduleInvoiceRefresh'), 'aperçu facture non temporisé'],
  [app.includes('now-(input._lastTypingSent||0)>900'), 'indicateur de saisie non limité'],
  [css.includes('Phase 11.4 — formulaires et aperçus plus fluides'), 'CSS de confinement manquant'],
  [sw.includes('drsx-v5-phase11-4-form-performance'), 'cache Phase 11.4 absent'],
  [server.includes("const VERSION = '5.0.0-phase11.4';"), 'version API incorrecte']
];

const failed = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failed.length) {
  console.error('Échec Phase 11.4 :');
  failed.forEach(message => console.error(`- ${message}`));
  process.exit(1);
}
console.log('Tests Phase 11.4 réussis.');
