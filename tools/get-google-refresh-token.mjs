import http from 'node:http';
import { URL } from 'node:url';
import readline from 'node:readline/promises';
import process from 'node:process';

const rl=readline.createInterface({input:process.stdin,output:process.stdout});
const clientId=process.env.GOOGLE_CLIENT_ID||await rl.question('GOOGLE_CLIENT_ID : ');
const clientSecret=process.env.GOOGLE_CLIENT_SECRET||await rl.question('GOOGLE_CLIENT_SECRET : ');
const redirectUri='http://localhost:8788/callback';
const scope='https://www.googleapis.com/auth/drive.file';
const authUrl=new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope,access_type:'offline',prompt:'consent',include_granted_scopes:'true'}).toString();

console.log('\n1) Copie cette adresse dans ton navigateur :\n');
console.log(authUrl.toString());
console.log('\n2) Autorise ton propre compte Google Drive. Le navigateur reviendra automatiquement sur localhost.\n');
console.log('IMPORTANT : si ton écran OAuth est en mode Testing, Google peut faire expirer le refresh token après 7 jours. Passe l’application OAuth en Production avant l’utilisation publique.\n');

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,redirectUri);
    if(url.pathname!='/callback')return;
    const code=url.searchParams.get('code');
    if(!code)throw new Error(url.searchParams.get('error')||'Code OAuth absent');
    const tokenResp=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code'})});
    const token=await tokenResp.json();if(!tokenResp.ok)throw new Error(JSON.stringify(token));
    const createFolder=async(name,parent='')=>{
      const body={name,mimeType:'application/vnd.google-apps.folder'};if(parent)body.parents=[parent];
      const r=await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name',{method:'POST',headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!r.ok)throw new Error(await r.text());return r.json();
    };
    const root=await createFolder('DanaTrap RSX');
    const previews=await createFolder('Previews',root.id);
    const images=await createFolder('Images',root.id);
    const privateFolder=await createFolder('Fichiers privés',root.id);
    console.log('\n=== À conserver dans un endroit privé ===');
    console.log('GOOGLE_REFRESH_TOKEN =',token.refresh_token||'(Google n’a pas renvoyé de refresh token : retire l’accès de l’application puis relance avec prompt=consent)');
    console.log('DRIVE_ROOT_FOLDER_ID =',root.id);
    console.log('DRIVE_PREVIEWS_FOLDER_ID =',previews.id);
    console.log('DRIVE_IMAGES_FOLDER_ID =',images.id);
    console.log('DRIVE_PRIVATE_FOLDER_ID =',privateFolder.id);
    console.log('\nNe mets jamais le refresh token dans config.js ou GitHub. Il doit être enregistré uniquement dans les variables d’environnement du Web Service Render.');
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<h1>DanaTrap RSX connecté à Google Drive</h1><p>Tu peux fermer cette page et revenir au terminal.</p>');
  }catch(error){console.error(error);res.writeHead(500);res.end('Erreur OAuth. Regarde le terminal.');}
  setTimeout(()=>{server.close();rl.close();},800);
});
server.listen(8788,'127.0.0.1',()=>console.log('Serveur OAuth local démarré sur http://localhost:8788'));
