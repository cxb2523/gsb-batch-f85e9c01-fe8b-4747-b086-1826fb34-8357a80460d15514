# Abyssal Infinite: the multiplayer server

One shared sea for everyone, on Cloudflare Workers. The server relays **players** only - where each one is, what it
looks like, its gurgling, and the bites between players. Bots stay in every player's own browser, so the server knows
nothing of the terrain and costs next to nothing to run.

```
server/
  src/sea.js       the sea itself: players, the packets of neighbors, the rules of a bite (no Cloudflare in it)
  src/worker.js    the Worker and its one Durable Object around sea.js; also serves the game
  public/          the game (index.html), copied here by `npm run build` in ../source
  wrangler.toml    the Cloudflare configuration
  test/local.mjs   the same sea as a plain Node server, for trying at home
  test/sea.test.mjs  the protocol test: three players, then a crowd, over real WebSockets
  openresty/       the same sea for a server of your own: nginx with Lua instead of Cloudflare (see below)
```

## Run it at home

```
cd source && npm install && npm run build     # puts the game into server/public
cd ../server && npm install
npm run local                                 # http://localhost:8787 - open it in two windows
npm test                                      # the protocol test
npm run dev                                   # the real Worker, locally (wrangler dev)
```

## Put it on Cloudflare

A free Cloudflare account is enough.

```
cd server
npx wrangler login      # once: opens the browser
npx wrangler deploy
```

Wrangler prints the address, `https://abyssal-infinite.<your-subdomain>.workers.dev`. That address **is the game**:
the Worker serves `public/index.html` and takes the WebSockets at `/ws`, so everyone who opens it dives into the same
sea. `/status` answers with how many are in. After a change to the game, `npm run build` in `source` and
`npx wrangler deploy` again.

The game can also live elsewhere (GitHub Pages, a file on disk) and be pointed at the server:
`index.html?server=abyssal-infinite.<your-subdomain>.workers.dev`, or once in the browser's console
`localStorage.abyssalServer = 'abyssal-infinite.<your-subdomain>.workers.dev'`.

## On a server of your own (OpenResty)

`openresty/sea.lua` is the same sea and the same protocol, written for [OpenResty](https://openresty.org) (nginx with
Lua), and `openresty/abyssal-infinite.conf` is the site's configuration: the page, `/ws` and `/status` under one
host. Nothing is counted per message there, so the sea takes 300 players (`set $abyssal_max` in the configuration;
each is still told of the 40 nearest).

```
/var/www/<host>/public/index.html     the game: server/public/index.html
/var/www/<host>/sea.lua               the sea (outside the web root)
<nginx conf>/sites/<host>.conf        openresty/abyssal-infinite.conf with your host, certificate and paths
nginx -t && nginx -s reload
```

After a change to the game only `index.html` is copied again; after a change to `sea.lua`, the file and a reload
(the players' connections are closed and the game connects again by itself).

nginx's workers share the sea through one `lua_shared_dict`; each reads it twenty times a second and builds its
players' packets from that. What it checks of what comes in - sizes, rates, names, bites, the page's origin - is
listed at the top of `sea.lua`; the limits per address (8 connections, 2 new ones a second) are in the configuration.
Measured with 100 players all in one place, the worst case: 13% of one processor core, 25 MB of memory, 12 kB a
second down to each player (a player alone gets 40 bytes a second).

To try it at home, with the protocol test against it:

```
docker run -d --name sea -p 18080:8080 -v ./openresty/sea.lua:/sea/sea.lua:ro -v ./public:/sea/public:ro \
  -v ./openresty/test/nginx.conf:/usr/local/openresty/nginx/conf/nginx.conf:ro openresty/openresty:alpine
SEA_PORT=18080 npm test
```

## What the free plan carries

Cloudflare counts 20 incoming WebSocket messages as one request and allows 100,000 requests a day on the free plan;
messages going out are free. A player sends 8 messages a second, which is 1,440 requests an hour - so the free plan
carries about **69 player-hours a day** (for example 10 players for nearly 7 hours). Past that the server refuses new
messages until midnight UTC and everyone simply plays alone. The Durable Object is billed for the time it has
players in it: 24 hours a day is about 11,000 GB-s, under the free 13,000. The sea takes up to 100 players at once
(`MAXP` in `src/sea.js`); the next one is told it is full and plays alone. Each player is told of the 40 nearest
others at most (`SHOWN`), and the game thins its own bots as players gather (`BOTN`, `BOTMIN` in `source/src/bots.js`).

## The protocol

Text messages are JSON, the two frequent ones are binary (little-endian).

| From | Message | |
|---|---|---|
| client | `{t:'hi', name}` | first thing after connecting; again to change the name |
| server | `{t:'hi', id, tick, near, max, shown}`, `{t:'who', list:[[id, name], ...]}` | the answer; `{t:'full'}` and the connection closed when the sea is full |
| server | `{t:'in', id, name}`, `{t:'out', id}` | someone came, changed name, or left |
| client | state, 28 bytes, 8 a second | `[1, species (255: only watching), flags, 0, x, y, z, yaw, pitch, speed]`, the six numbers float32 |
| server | neighbors, 10 a second | `[2, 0, count u16]` then per player within 170 m (the 40 nearest at most) `[id u16, species, flags, 0, 0, x, y, z, yaw, pitch, speed]` |
| client | `{t:'bite', to}` | the server checks: could it eat that species (or crab against crab), is it within reach, not more than one in 0.4 s |
| server | `{t:'bit', from, s, dmg}` | to the bitten one; a crab's strike also carries `blk` (1: its raised claws blocked most of it) |
| server | `{t:'eaten', from}` | to a beaten crab (flag 16) that another crab has just eaten; the eater gets `fed` |
| client | `{t:'ate'}` | the bitten one, if that bite killed it |
| server | `{t:'fed', id, gain}` | to the one who bit |

Flags: 1 gurgling (a crab: claws up, blocking), 2 the mouth or claws have just snapped, 4 and 8 the claws a crab has
lost, 16 a beaten crab lying on its back.

A fight of crabs is settled from those flags: a strike lands from 1 m at most (0.53 m in the game) and only on a
crab ahead of the striker, where its claws are; it takes 0.14 of the other's health (0.085 from a crab with one
claw, nothing from one with none, with its claws up or beaten itself), and 0.3 of that if the other holds its claws
up. A crab whose health runs out says so with flag 16 and lies there for eight seconds; a bite on it in that time is
the meal.

The server trusts positions as sent (there is no terrain here to check them against); what it does check is who may
bite whom, from how far and how often. A connection silent for 30 seconds is dropped; the client reconnects by itself.

## A resident crab (optional)

[`bot/krabs.py`](bot/krabs.py) is a scripted player: a crab that strolls around one place, gurgles now and then,
answers the gurgle of other players' crabs and spars with them by the game's own rules. It speaks the protocol above as a browser does, so the
server does not know it from a player (it counts as one). Python 3 with the standard library is all it needs:

```bash
python3 bot/krabs.py wss://sea.example.com/ws --name "Mr.Krabs" --at 8,-43.3,18 --floor bot/floor.json --roam 3
```

`--at` is `x,y,z` with `y` the sea floor at that place. The script knows nothing of the world, so `--floor` gives
it the heights of the floor around home (`bot/floor.json` is the floor around the default place; for another place
make one with the `floor` hook of `dev.html`); with it the crab walks up to `--roam` metres from home, without it
the crab stays where it is. On the server that runs the sea, add `--connect 127.0.0.1`
to open the socket over the loopback (the host of the URL still goes into the handshake). It reconnects by itself;
run it under a service manager (a systemd unit with `Restart=always`) to keep it in the sea. Its numbers mirror the
crab fight in `source/src/bots.js`: change them together.
