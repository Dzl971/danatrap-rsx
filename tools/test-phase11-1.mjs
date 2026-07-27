import fs from 'node:fs';

const app = fs.readFileSync('frontend/assets/app.js', 'utf8');
const data = fs.readFileSync('frontend/assets/data-service.js', 'utf8');
const sw = fs.readFileSync('frontend/service-worker.js', 'utf8');
const server = fs.readFileSync('backend/render-api/src/server.js', 'utf8');

const checks = [
  [app.includes("const destination=state.user?'#/app':'#/'"), 'Le logo doit diriger les membres connectés vers #/app.'],
  [app.includes("state.user&&['/','/connexion','/inscription'].includes(raw)"), 'Les pages publiques d’entrée doivent rediriger un membre connecté vers son accueil.'],
  [data.includes('persistSession:true'), 'La session Supabase doit être conservée.'],
  [data.includes('autoRefreshToken:true'), 'Le jeton Supabase doit être renouvelé automatiquement.'],
  [data.includes('storage:window.localStorage'), 'La session doit utiliser le stockage persistant du navigateur.'],
  [sw.includes('drsx-v5-phase11-1-navigation-session'), 'Le cache PWA doit être renouvelé.'],
  [server.includes("const VERSION = '5.0.0-phase11.1'"), 'La version API doit être 5.0.0-phase11.1.'],
];

for (const [ok, message] of checks) {
  if (!ok) {
    console.error(`[ECHEC] ${message}`);
    process.exit(1);
  }
}
console.log('Tests Phase 11.1 réussis : navigation du logo et session persistante.');
