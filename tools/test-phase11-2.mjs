import fs from 'node:fs';

const app = fs.readFileSync('frontend/assets/app.js', 'utf8');
const css = fs.readFileSync('frontend/assets/styles.css', 'utf8');
const sw = fs.readFileSync('frontend/service-worker.js', 'utf8');
const server = fs.readFileSync('backend/render-api/src/server.js', 'utf8');

const checks = [
  [app.includes('class="invoice-print-stage"'), 'La facture imprimée doit être placée dans une page A4 dédiée.'],
  [app.includes('stage.clientHeight/naturalHeight'), 'Le document doit être réduit automatiquement si son contenu dépasse une page.'],
  [app.includes("window.addEventListener('beforeprint',fit)"), 'La mise à l’échelle doit être recalculée avant l’impression.'],
  [css.includes('@page{size:A4 portrait;margin:0}'), 'Le format d’impression doit être A4 sans marge navigateur.'],
  [css.includes('width:210mm!important;height:297mm!important'), 'La zone imprimée doit mesurer exactement 210 × 297 mm.'],
  [css.includes('break-inside:avoid'), 'Les blocs de facture ne doivent pas être coupés entre deux pages.'],
  [sw.includes('drsx-v5-phase11-2-invoice-a4-single-page'), 'Le cache PWA doit être renouvelé.'],
  [server.includes("const VERSION = '5.0.0-phase11.2'"), 'La version API doit être 5.0.0-phase11.2.'],
];

for (const [ok, message] of checks) {
  if (!ok) {
    console.error(`[ECHEC] ${message}`);
    process.exit(1);
  }
}
console.log('Tests Phase 11.2 réussis : facture A4 forcée sur une seule page.');
