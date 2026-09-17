'use strict';

/**
 * Before building the Windows installer: the OBSBOT bridge and the SDK DLLs
 * must be in agent/native, because the installer carries them (distribution
 * authorized by OBSBOT). An installer without them would install stations
 * that the control room cannot aim - so the build stops instead.
 *
 * REGIA_ALLOW_NO_BRIDGE=1 builds anyway (video and audio only, no camera control).
 */

const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', '..', '..', 'agent', 'native');
const FILES = ['obsbot_bridge.dll', 'libdev.dll', 'w32-pthreads.dll'];

const missing = FILES.filter((f) => !fs.existsSync(path.join(DIR, f)));
if (!missing.length) {
  console.log(`ponte OBSBOT incluso: ${FILES.join(', ')} da ${DIR}`);
} else if (process.env.REGIA_ALLOW_NO_BRIDGE === '1') {
  console.warn(`ATTENZIONE: installer senza ponte OBSBOT (mancano ${missing.join(', ')}): niente controlli telecamera`);
} else {
  console.error(`Mancano in ${DIR}: ${missing.join(', ')}`);
  console.error('Compila il ponte su Windows con agent\\bridge\\build.cmd (vedi docs/INSTALLAZIONE.md) e copia qui i tre file.');
  console.error('Per un installer senza controlli telecamera: REGIA_ALLOW_NO_BRIDGE=1');
  process.exit(1);
}
