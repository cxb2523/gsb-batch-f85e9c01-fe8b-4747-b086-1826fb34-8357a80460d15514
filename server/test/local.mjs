// The same sea without Cloudflare: a small Node server for trying things at home.
//   npm run local            then open http://localhost:8787
// It serves public/index.html and takes WebSockets at /ws, exactly as the Worker does.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { Sea } from '../src/sea.js';

const port = +process.env.PORT || 8787, sea = new Sea();
const page = new URL('../public/index.html', import.meta.url);
const http = createServer((req, res) => {
  if (req.url === '/status') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(sea.status())); return; }
  try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(readFileSync(page)); } catch { res.writeHead(404); res.end('Run "npm run build" in ../source first.'); }
});
const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => { ws.binaryType = 'arraybuffer'; sea.join(ws); });
});
http.listen(port, () => console.log('The sea is at http://localhost:' + port));
