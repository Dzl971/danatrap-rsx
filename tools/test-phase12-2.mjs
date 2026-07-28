import fs from "node:fs";
const files={data:"frontend/assets/data-service.js",app:"frontend/assets/app.js",server:"backend/render-api/src/server.js",sw:"frontend/service-worker.js"};
for(const [name,file] of Object.entries(files)){if(!fs.existsSync(file))throw new Error(`${name} manquant`);}
const data=fs.readFileSync(files.data,"utf8"),server=fs.readFileSync(files.server,"utf8"),sw=fs.readFileSync(files.sw,"utf8");
for(const token of ["freshAccessToken","apiFetch('/api/v1/beats/trash'","apiFetch('/api/v1/admin/delete-user'"])if(!data.includes(token))throw new Error(`Data service incomplet: ${token}`);
for(const token of ["5.0.0-phase12.2","should_soft_delete","/api/v1/beats/trash","/api/v1/admin/delete-user","method:'DELETE'"])if(!server.includes(token))throw new Error(`Serveur incomplet: ${token}`);
if(!sw.includes('phase12-2'))throw new Error('Cache non versionné');
console.log('Tests Phase 12.2 OK');
