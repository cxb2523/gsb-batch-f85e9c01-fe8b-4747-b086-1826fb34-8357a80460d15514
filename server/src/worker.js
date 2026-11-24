// Abyssal Infinite: the multiplayer server, for Cloudflare Workers.
// One Durable Object is the whole sea (src/sea.js). The Worker hands it every WebSocket at /ws, answers /status with
// how many are in, and serves the game itself (public/index.html) at every other address.
import { DurableObject } from 'cloudflare:workers';
import { Sea } from './sea.js';

export class SeaObject extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.sea = new Sea(); }
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return Response.json(this.sea.status(), { headers: { 'access-control-allow-origin': '*' } });
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    server.accept();
    this.sea.join(server);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/ws' || path === '/status') return env.SEA.get(env.SEA.idFromName('sea')).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
