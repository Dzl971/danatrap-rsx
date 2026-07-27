import fs from 'node:fs';
const read=p=>fs.readFileSync(p,'utf8');
const app=read('frontend/assets/app.js');
const css=read('frontend/assets/styles.css');
const sw=read('frontend/service-worker.js');
const server=read('backend/render-api/src/server.js');
const checks=[
 ['date locale sans décalage',app.includes('function invoiceDisplayDate')&&app.includes('iso[3]}/${iso[2]}/${iso[1]')],
 ['contenu séparé du pied de page',app.includes('class="invoice-content"')],
 ['ajustement du contenu uniquement',app.includes("content.style.transform='scale('")&&!app.includes("paper.style.transform='scale('")],
 ['attente des images',app.includes('await Promise.all(images.map')],
 ['pied de page fixe',css.includes('.invoice-footer{position:absolute')&&css.includes('bottom:0')],
 ['page A4 exacte',css.includes('width:210mm!important;height:297mm!important')],
 ['libellé paiement non coupé',css.includes('white-space:nowrap')],
 ['cache phase 11.3',sw.includes('drsx-v5-phase11-3-invoice-a4-layout')],
 ['version API phase 11.3',server.includes("5.0.0-phase11.3")]
];
const failed=checks.filter(([,ok])=>!ok);
for(const [name,ok] of checks)console.log(`${ok?'OK':'ERREUR'} - ${name}`);
if(failed.length)process.exit(1);
