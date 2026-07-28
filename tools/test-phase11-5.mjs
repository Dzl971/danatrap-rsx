import fs from 'node:fs';

const app=fs.readFileSync('frontend/assets/app.js','utf8');
const css=fs.readFileSync('frontend/assets/styles.css','utf8');
const sw=fs.readFileSync('frontend/service-worker.js','utf8');
const server=fs.readFileSync('backend/render-api/src/server.js','utf8');

const checks=[
  ['garde impression A4 dans app.js',app.includes('margin-bottom:0!important;box-shadow:none!important;transform:none!important;transform-origin:top left!important')],
  ['garde CSS Phase 11.5',css.includes('Phase 11.5 — export A4 à taille réelle')],
  ['papier A4 sans transformation',css.includes('.invoice-print-stage > .invoice-paper')&&css.includes('transform:none!important')],
  ['cache Phase 11.5',sw.includes('drsx-v5-phase11-5-invoice-a4-fullsize')],
  ['version API Phase 11.5',server.includes('5.0.0-phase11.5')],
];
for(const [name,ok] of checks){
  if(!ok){console.error(`[ECHEC] ${name}`);process.exit(1);}
  console.log(`[OK] ${name}`);
}
console.log('Tests Phase 11.5 réussis.');
