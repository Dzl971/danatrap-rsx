import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const supabaseUrl = String(process.env.DRSX_SUPABASE_URL || '').trim();
const supabaseAnonKey = String(process.env.DRSX_SUPABASE_ANON_KEY || '').trim();
const apiBaseUrl = String(process.env.DRSX_API_URL || '').replace(/\/$/, '');
const siteUrl = String(process.env.DRSX_SITE_URL || '').replace(/\/$/, '');
const requestedDemo = String(process.env.DRSX_DEMO_MODE || 'false').toLowerCase() === 'true';
const demoMode = requestedDemo || !supabaseUrl || !supabaseAnonKey || !apiBaseUrl;

const config = {
  demoMode,
  supabaseUrl,
  supabaseAnonKey,
  apiBaseUrl,
  driveWorkerUrl: apiBaseUrl,
  siteUrl,
  adminEmail: String(process.env.DRSX_ADMIN_EMAIL || 'admin@danatrap.fr').trim()
};

const output = `/* Généré automatiquement par Render. Ne place aucun secret ici. */\nwindow.DRSX_CONFIG = ${JSON.stringify(config, null, 2)};\n`;
fs.writeFileSync(path.join(here, 'config.js'), output, 'utf8');
console.log(`[DanaTrap RSX] config.js généré. Mode démonstration : ${demoMode ? 'oui' : 'non'}`);
