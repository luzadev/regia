'use strict';

/**
 * Diagnostics for the NDI setup: asks Studio Monitor what it can see on the
 * network, so `stations[].ndi_source` can be filled in with the exact names.
 *
 *   npm run ndi:sources
 *   npm run ndi:sources -- --url http://192.168.10.10:80
 */

const fs = require('fs');
const path = require('path');
const { create } = require('../server/drivers/video.ndi');

const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(process.env.REGIA_CONFIG || path.join(ROOT, 'config.json'), 'utf8'));

const argv = process.argv.slice(2);
const urlIndex = argv.indexOf('--url');
if (urlIndex !== -1) config.ndi_monitor_url = argv[urlIndex + 1];
config.driver_timeout_ms = Math.max(config.driver_timeout_ms || 0, 4000);

const driver = create(config, { event() {} });

function names(payload) {
  if (Array.isArray(payload)) return payload.map((s) => (typeof s === 'string' ? s : s.name || JSON.stringify(s)));
  if (payload && Array.isArray(payload.ndi_sources)) return names(payload.ndi_sources);
  if (payload && Array.isArray(payload.sources)) return names(payload.sources);
  return null;
}

(async () => {
  console.log(`Studio Monitor: ${config.ndi_monitor_url}`);
  console.log('(la PRIMA finestra di Studio Monitor ascolta sulla porta 80, la seconda sulla 81, ecc.)\n');

  let sources;
  try {
    sources = await driver.sources();
  } catch (e) {
    console.error(`Impossibile leggere le sorgenti: ${e.message}`);
    console.error('\nControlla che: Studio Monitor sia aperto; il web server sia abilitato;');
    console.error('la porta sia quella della finestra giusta; il firewall di Windows non blocchi la porta.');
    process.exit(1);
  }

  const list = names(sources);
  if (list) {
    console.log('Sorgenti NDI viste da Studio Monitor:');
    list.forEach((n) => console.log(`  - ${n}`));
  } else {
    console.log('Risposta di /v1/sources (formato non riconosciuto, copiala pure così com\'è):');
    console.log(JSON.stringify(sources, null, 2));
  }

  console.log('\nMappatura attuale in config.json:');
  for (const st of config.stations) {
    const configured = st.ndi_source || '(non impostata)';
    const seen = list ? (list.includes(configured) ? 'OK, vista in rete' : 'NON vista in rete') : 'non verificabile';
    console.log(`  ${st.id}  ${configured}  ->  ${seen}`);
  }

  try {
    const current = await driver.configuration();
    console.log(`\nSorgente attualmente mostrata: ${JSON.stringify(current.NDI_source ?? current)}`);
  } catch {
    /* configuration is optional for this report */
  }
})();
