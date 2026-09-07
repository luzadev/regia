'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Append-only JSONL event log. Never throws: a failing log must not take the
 * show down, so write errors are reported once on stderr and then swallowed.
 */
function createLog(filePath) {
  const abs = path.resolve(filePath);
  let stream = null;
  let broken = false;

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    stream = fs.createWriteStream(abs, { flags: 'a' });
    stream.on('error', (e) => {
      if (!broken) console.error(`[log] write error: ${e.message}`);
      broken = true;
    });
  } catch (e) {
    console.error(`[log] cannot open ${abs}: ${e.message}`);
    broken = true;
  }

  return {
    path: abs,
    event(type, data = {}) {
      const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
      if (!broken && stream) stream.write(line + '\n');
      return line;
    },
    close() {
      if (stream) stream.end();
    }
  };
}

module.exports = { createLog };
