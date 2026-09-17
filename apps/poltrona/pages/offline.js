'use strict';
const q = new URLSearchParams(location.search);
document.getElementById('msg').textContent = q.get('msg') || 'Server regia non raggiungibile. Riprovo…';
document.getElementById('station').textContent = q.get('station') || '';
