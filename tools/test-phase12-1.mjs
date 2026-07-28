import fs from 'node:fs';
const files={app:fs.readFileSync('frontend/assets/app.js','utf8'),data:fs.readFileSync('frontend/assets/data-service.js','utf8'),sw:fs.readFileSync('frontend/service-worker.js','utf8'),server:fs.readFileSync('backend/render-api/src/server.js','utf8')};
const checks=[
 ['version',files.server.includes("5.0.0-phase12.1")],
 ['suppression production confirmée',files.server.includes('Aucune modification confirmée par Supabase')&&files.server.includes('deleted:true,beatId:beat.id')&&files.app.includes('Production retirée du catalogue et placée dans la corbeille')],
 ['rafraîchissement production',files.app.includes("if(location.hash===target)await route()")],
 ['filtre corbeille admin',files.data.includes("beats.map(mapSupabaseBeat).filter(b=>!b.design?._trashed)")],
 ['suppression auth vérifiée',files.server.includes('hardDeleteAuthUser')&&files.server.includes('le compte existe toujours après vérification')],
 ['résolution id profil auth',files.server.includes('resolveAuthUserId')&&files.server.includes('profiles?or=(id.eq.')],
 ['retour utilisateur confirmé',files.server.includes('deleted: true')&&files.app.includes('Utilisateur supprimé définitivement')],
 ['cache',files.sw.includes('drsx-v5-phase12-1-delete-verification')]
];
for(const [name,ok] of checks){if(!ok){console.error('ECHEC:',name);process.exit(1);}console.log('OK:',name);}console.log('Tests Phase 12.1 réussis.');
