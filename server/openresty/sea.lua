-- Abyssal Infinite: the multiplayer server for OpenResty (nginx with Lua), in place of the Cloudflare Worker.
-- The same sea and the same protocol as ../src/sea.js (see ../README.md); this file is run by content_by_lua_file
-- for /ws and /status (abyssal-infinite.conf).
--
-- nginx runs several worker processes and a connection lands on any of them, so the sea lives in a shared
-- dictionary (lua_shared_dict abyssal_sea) that all of them see:
--   p:<id>   a player: its name and its last state; it expires by itself when the player falls silent
--   q:<id>   messages waiting for that player from another one (a bite, a meal)
--   by:<id>  who bit that player last (for four seconds)
--   e:<id>   that player, a beaten crab, has just been eaten (for three seconds: it is eaten once)
--   seq      the last id given out
-- Each worker reads all players from it twenty times a second into a table of its own (the snapshot), and every
-- connection builds its packets from that table: nothing is asked of the dictionary per neighbour.
--
-- What is checked, since anyone can connect and send anything:
--   * a frame longer than 1024 bytes closes the connection; a state is exactly 28, a JSON message at most 300;
--   * a connection may send RATE messages a second (the game sends 8), more closes it;
--   * numbers must be finite; a name is cut to 16 characters of valid UTF-8 without control characters or markup
--     (a text frame that is not UTF-8 would make every browser it is relayed to drop its connection);
--   * a bite: only what the biter could eat, within reach, once in 0.4 s; a crab's strike by its own flags and the
--     other's (claws lost, claws up, beaten); the dictionary's queues are capped;
--   * a browser page of another site is refused (Origin); the per-address limits are in the nginx configuration.

local S = package.loaded.abyssal_sea
if not S then
  local ffi, bit, cjson, wsserver = require 'ffi', require 'bit', require 'cjson.safe', require 'resty.websocket.server'
  local semaphore = require 'ngx.semaphore'
  local byte, char, sub, find, concat, floor, sqrt = string.byte, string.char, string.sub, string.find, table.concat, math.floor, math.sqrt
  local dict = ngx.shared.abyssal_sea

  -- The limits. On Cloudflare's free plan every message costs (../src/sea.js: 100 players); here they cost only
  -- processor time and traffic, so the sea takes more. SHOWN stays what the game draws (PEERMAX, source/src/bots.js).
  local MAXP = tonumber(ngx.var.abyssal_max) or 300 -- players in the sea at once (set $abyssal_max in nginx to change)
  local SHOWN = 40             -- of those near, a player is told of this many at most, the nearest
  local NEAR = 170             -- metres: how far a player is told of another
  local TICK, SNAP = 0.1, 0.05 -- seconds between the packets of neighbours, and between a worker's readings of the sea
  local IDLE = 30              -- seconds without a word: the connection is dropped
  local RATE, BURST = 30, 60   -- messages a second from one connection, and how many may come at once
  local QMAX = 32              -- messages that may wait for one player
  -- A fight of crabs (the same numbers as in the game, source/src/bots.js): what a strike takes of the other's
  -- health, with both claws and with one; what part of it gets through claws held up; how much a beaten crab is to
  -- eat. Flags of a state: 1 gurgling (a crab: claws up, blocking), 2 snapping, 4 and 8 the claws a crab has lost,
  -- 16 beaten.
  -- REACH: how far apart two crabs may be for a strike (0.53 m in the game, and what a crab walks while the
  -- network is behind). FRONT: the struck one has to be ahead of the striker, where the claws are (the cosine of
  -- how far off its heading; 0.64 in the game, looser here for the same reason).
  local STRIKE, STRIKE1, BLOCK, MEAL, REACH, FRONT = 0.14, 0.085, 0.3, 0.45, 1, 0.3

  local REAL, GSCALE, CRAB, WHALE = { 0.2, 0.06, 0.09, 0.45, 1.3, 1.8, 2.0, 2.8, 4.6, 16.5 }, 8.4 / 4.5, 0, 9
  local function len(s) return REAL[s + 1] * GSCALE end
  local function eats(a, b) return a ~= b and a ~= WHALE and REAL[b + 1] <= REAL[a + 1] * 0.6 end
  local function clamp(x, a, b) return x < a and a or x > b and b or x end
  local function round3(x) return floor(x * 1000 + 0.5) / 1000 end
  local fbuf = ffi.new('float[6]')

  S = { conns = 0, snap = {}, live = {}, n = 0, ver = 0, timer = false, statAt = 0, stat = 0 }
  package.loaded.abyssal_sea = S

  -- a name: what can be seen of it, at most 16 characters, and nothing that is not UTF-8
  local function clean(s)
    local out, n, i, l = {}, 0, 1, #s
    while i <= l and n < 16 do
      local c, w, cp = byte(s, i)
      if c < 0x80 then w, cp = 1, c elseif c >= 0xC2 and c <= 0xDF then w = 2 elseif c >= 0xE0 and c <= 0xEF then w = 3 elseif c >= 0xF0 and c <= 0xF4 then w = 4 else break end
      if i + w - 1 > l then break end
      if w > 1 then
        cp = bit.band(c, w == 2 and 0x1F or w == 3 and 0x0F or 0x07)
        for k = 1, w - 1 do local d = byte(s, i + k); if d < 0x80 or d > 0xBF then cp = nil; break end; cp = cp * 64 + d - 0x80 end
        if not cp or (w == 3 and cp < 0x800) or (w == 4 and (cp < 0x10000 or cp > 0x10FFFF)) or (cp >= 0xD800 and cp <= 0xDFFF) then break end
      end
      if not (cp < 0x20 or cp == 0x7F or (cp >= 0x80 and cp < 0xA0) or cp == 60 or cp == 62 or cp == 38 or cp == 34 or cp == 39) then n = n + 1; out[n] = sub(s, i, i + w - 1) end
      i = i + w
    end
    return (concat(out):gsub('^%s+', ''):gsub('%s+$', ''))
  end

  -- a worker's reading of the sea: every player with its name, and those in the water as they are relayed
  local function snapshot(premature)
    if premature or S.conns == 0 then return end
    local keys, snap, live, n, m = dict:get_keys(0), {}, {}, 0, 0
    for i = 1, #keys do
      local k = keys[i]
      if byte(k, 1) == 112 and byte(k, 2) == 58 then -- "p:"
        local v, id = dict:get(k), tonumber(sub(k, 3))
        if v and id then
          local nl = byte(v, 1); local e = { id = id, name = sub(v, 2, 1 + nl) }
          if nl > 0 and #v == 1 + nl + 27 then
            local o = 2 + nl; local raw = sub(v, o + 3)
            e.s, e.fl, e.talk = byte(v, o, o + 2)
            ffi.copy(fbuf, raw, 24); e.x, e.y, e.z = fbuf[0], fbuf[1], fbuf[2]
            -- as it goes into a packet: [id (u16), species, flags, talk, 0, six floats]
            e.ent = char(bit.band(id, 255), bit.rshift(id, 8), e.s, e.fl, e.talk, 0) .. raw
            m = m + 1; live[m] = e
          end
          snap[id] = e; n = n + 1
        end
      end
    end
    -- who is in, by name: connections tell their players of comings and goings when this number has moved on
    local changed = n ~= S.n
    if not changed then for id, e in pairs(snap) do local o = S.snap[id]; if not o or o.name ~= e.name then changed = true; break end end end
    if changed then S.ver = S.ver + 1 end
    S.snap, S.live, S.n = snap, live, n
  end

  local function count()
    local keys, n = dict:get_keys(0), 0
    for i = 1, #keys do if byte(keys[i], 1) == 112 and dict:get(keys[i]) then n = n + 1 end end
    return n
  end

  -- a message for another player, which a connection in any worker may hold: it waits in the dictionary
  local function post(id, m)
    local k = 'q:' .. id
    local n = dict:rpush(k, cjson.encode(m))
    if n and n > QMAX then dict:lpop(k) end
    if dict.expire then dict:expire(k, 10) end
  end

  local function store(me)
    dict:set('p:' .. me.id, char(#me.name) .. me.name .. (me.raw and char(me.s, me.fl, me.talk) .. me.raw or ''), IDLE + 5)
  end
  local function say(me, m) me.out[#me.out + 1] = type(m) == 'string' and m or cjson.encode(m); me.sem:post(1) end

  -- a state: [1, species (255: only watching), flags, talk, x, y, z, yaw, pitch, speed]
  local function state(me, data)
    if #data ~= 28 or byte(data, 1) ~= 1 then return end
    local s = byte(data, 2); if s > 9 and s ~= 255 then return end
    local raw = sub(data, 5); ffi.copy(fbuf, raw, 24)
    for i = 0, 5 do local f = fbuf[i]; if f ~= f or f == math.huge or f == -math.huge then return end end
    me.s, me.fl, me.talk, me.raw, me.x, me.y, me.z, me.yaw = s, byte(data, 3), byte(data, 4), raw, fbuf[0], fbuf[1], fbuf[2], fbuf[3]
    store(me)
  end

  local function text(me, data)
    if #data > 300 then return end
    local m = cjson.decode(data); if type(m) ~= 'table' then return end
    local t = m.t
    if t == 'hi' then
      local name, first = clean(type(m.name) == 'string' and m.name or ''), me.name == ''
      if name == '' then name = 'Diver ' .. me.id end
      me.name = name; store(me)
      if first then
        snapshot()
        local list, n = {}, 0
        for id, e in pairs(S.snap) do if id ~= me.id and e.name ~= '' then n = n + 1; list[n] = { id, e.name }; me.known[id] = e.name end end
        say(me, { t = 'hi', id = me.id, tick = TICK * 1000, near = NEAR, max = MAXP, shown = SHOWN })
        say(me, { t = 'who', list = n > 0 and list or cjson.empty_array })
        me.ver = -1
      end
    elseif t == 'bite' then
      -- only what it could eat (or crab against crab), only within reach, and not too often
      local b, now = S.snap[tonumber(m.to) or 0], ngx.now()
      if not b or b.id == me.id or not me.raw or not b.ent or me.s > 9 or b.s > 9 or now - me.bit < 0.4 then return end
      local crabs = me.s == CRAB and b.s == CRAB; if not crabs and not eats(me.s, b.s) then return end
      local dx, dy, dz = me.x - b.x, me.y - b.y, me.z - b.z
      local d = sqrt(dx * dx + dy * dy + dz * dz)
      if d > (crabs and REACH or len(me.s) * 0.6 + len(b.s) * 0.5 + 3) then return end -- (three metres for what the network is behind by)
      if crabs then
        -- crab against crab. A beaten one, on its back, is eaten (once); otherwise a strike: none from a crab that
        -- is beaten itself, has its claws up or has no claws; weaker with one claw; mostly stopped by claws held up
        local af, bf = me.fl, b.fl
        local down, aclaws, bclaws = bit.band(bf, 16) ~= 0, bit.band(af, 12) ~= 12, bit.band(bf, 12) ~= 12
        if bit.band(af, 16) ~= 0 or (not down and (bit.band(af, 1) ~= 0 or not aclaws)) then return end
        if not down and d > 0.05 and (math.cos(me.yaw) * -dx + math.sin(me.yaw) * -dz) / d < FRONT then return end
        me.bit = now
        if down then
          if not dict:add('e:' .. b.id, 1, 3) then return end
          post(b.id, { t = 'eaten', from = me.id }); say(me, { t = 'fed', id = b.id, gain = MEAL })
          return
        end
        local blk = bit.band(bf, 1) ~= 0 and bclaws
        post(b.id, { t = 'bit', from = me.id, s = me.s, dmg = round3((bit.band(af, 12) ~= 0 and STRIKE1 or STRIKE) * (blk and BLOCK or 1)), blk = blk and 1 or 0 })
        return
      end
      me.bit = now; dict:set('by:' .. b.id, me.id, 4)
      post(b.id, { t = 'bit', from = me.id, s = me.s, dmg = round3(clamp(0.16 + 0.07 * len(me.s) / len(b.s), 0.2, 0.55)) })
    elseif t == 'ate' then
      -- the last bite killed it: the one who bit is fed
      local k = 'by:' .. me.id; local a = S.snap[dict:get(k) or 0]; dict:delete(k)
      if not a or not a.s or a.s > 9 or not me.raw or me.s > 9 then return end
      post(a.id, { t = 'fed', id = me.id, gain = a.s == CRAB and MEAL or round3(clamp(0.1 + 0.6 * len(me.s) / len(a.s), 0.1, 0.5)) })
    end
  end

  local function nearer(a, b) return a[1] < b[1] end
  -- ten times a second, to one player: what waits for it, who has come or gone, and the others near it
  local function tick(wb, me)
    for _ = 1, QMAX do local m = dict:lpop('q:' .. me.id); if not m then break end; if not wb:send_text(m) then return false end end
    if me.name == '' then return true end
    if me.ver ~= S.ver then
      me.ver = S.ver
      local snap, known = S.snap, me.known
      for id, e in pairs(snap) do if id ~= me.id and e.name ~= '' and known[id] ~= e.name then known[id] = e.name; if not wb:send_text(cjson.encode({ t = 'in', id = id, name = e.name })) then return false end end end
      for id in pairs(known) do local e = snap[id]; if not e or e.name == '' then known[id] = nil; if not wb:send_text(cjson.encode({ t = 'out', id = id })) then return false end end end
    end
    if not me.raw then return true end
    local live, x, y, z, near, n = S.live, me.x, me.y, me.z, {}, 0
    for i = 1, #live do
      local q = live[i]
      if q.id ~= me.id and q.s <= 9 then
        local dx, dy, dz = q.x - x, q.y - y, q.z - z; local d2 = dx * dx + dy * dy + dz * dz
        if d2 <= NEAR * NEAR then n = n + 1; near[n] = { d2, q.ent } end
      end
    end
    if n > SHOWN then table.sort(near, nearer); n = SHOWN end -- a crowd: only the nearest
    local parts = { char(2, 0, bit.band(n, 255), bit.rshift(n, 8)) }
    for i = 1, n do parts[i + 1] = near[i][2] end
    return wb:send_binary(concat(parts)) and true or false
  end

  -- everything that goes to the player is sent from here: a socket may be written to by one thread at a time
  local function sender(wb, me)
    local at = ngx.now() + TICK
    while me.alive do
      -- (always a wait, however short: it is what lets the worker do anything else, and what moves ngx.now() on)
      local wait = at - ngx.now(); me.sem:wait(wait > 0.001 and wait or 0.001)
      if ngx.worker.exiting() then wb:send_close(1001, 'restarting'); break end -- (nginx reloads: the game connects again by itself)
      local out = me.out
      if #out > 0 then
        me.out = {}
        for i = 1, #out do local m = out[i]; local ok = type(m) == 'table' and wb:send_pong(m[1]) or type(m) == 'string' and wb:send_text(m); if not ok then me.alive = false end end
      end
      local now = ngx.now()
      if me.alive and now >= at then at = at + TICK; if at < now then at = now + TICK end; if not tick(wb, me) then me.alive = false end end
    end
    me.alive = false
  end

  function S.ws()
    -- a page of another site may not use this sea (a program that is not a browser sends no Origin)
    local origin, host = ngx.var.http_origin, ngx.var.host
    if origin and origin ~= '' and origin ~= 'https://' .. host and origin ~= 'http://' .. host then return ngx.exit(403) end
    -- (the library's limit is one for both directions, and the list of who is in can be long: what comes in is
    -- measured below)
    local wb = wsserver:new({ timeout = 5000, max_payload_len = 65535 })
    if not wb then return ngx.exit(400) end
    if count() >= MAXP then
      -- told so, and then heard out for a moment: closing on what the game has already sent would reset the
      -- connection, and the message would be lost with it
      wb:send_text('{"t":"full"}'); wb:send_close(1013, 'full'); wb:set_timeout(1000)
      for _ = 1, 8 do local d, typ = wb:recv_frame(); if not d or typ == 'close' then break end end
      return
    end
    local id
    for _ = 1, 64 do local c = dict:incr('seq', 1, 0) % 65000 + 1; if dict:add('p:' .. c, '\0', IDLE + 5) then id = c; break end end
    if not id then wb:send_close(1013, 'full'); return end
    local me = { id = id, name = '', s = -1, fl = 0, talk = 0, raw = nil, x = 0, y = 0, z = 0, yaw = 0, bit = 0, seen = ngx.now(), alive = true, out = {}, known = {}, ver = -1, sem = semaphore.new(), tokens = BURST, at = ngx.now() }
    S.conns = S.conns + 1
    if not S.timer then S.timer = true; ngx.timer.every(SNAP, snapshot) end
    local th = ngx.thread.spawn(sender, wb, me)
    pcall(function()
      while me.alive do
        local data, typ, err = wb:recv_frame()
        local now = ngx.now()
        if not data then
          -- nothing came within the five seconds: go on waiting, unless it has been silent for too long
          if not (err and find(err, 'timeout', 1, true)) or now - me.seen > IDLE then break end
        elseif typ == 'close' then break
        elseif typ == 'ping' then me.out[#me.out + 1] = { data }; me.sem:post(1)
        elseif #data > 1024 or err == 'again' then break -- (nothing the game sends is that long, or comes in pieces)
        elseif typ == 'binary' or typ == 'text' then
          me.tokens = math.min(BURST, me.tokens + (now - me.at) * RATE) - 1; me.at = now
          if me.tokens < 0 then break end
          me.seen = now
          if typ == 'binary' then state(me, data) else text(me, data) end
        end
      end
    end)
    me.alive = false; me.sem:post(1); ngx.thread.wait(th)
    S.conns = S.conns - 1
    dict:delete('p:' .. id); dict:delete('q:' .. id); dict:delete('by:' .. id); dict:delete('e:' .. id)
    pcall(wb.send_close, wb)
  end

  -- how many are in (those who have said who they are), counted once a second at most
  function S.status()
    local now = ngx.now()
    if now - S.statAt >= 1 then
      local keys, n = dict:get_keys(0), 0
      for i = 1, #keys do if byte(keys[i], 1) == 112 then local v = dict:get(keys[i]); if v and byte(v, 1) > 0 then n = n + 1 end end end
      S.stat, S.statAt = n, now
    end
    ngx.header['Content-Type'] = 'application/json'; ngx.header['Access-Control-Allow-Origin'] = '*'; ngx.header['Cache-Control'] = 'no-store'
    ngx.say('{"players":', S.stat, ',"max":', MAXP, '}')
  end
end

if ngx.var.uri == '/status' then return S.status() end
return S.ws()
