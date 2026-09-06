const FLOOR = 5;
const CEIL = 5000;
const ADD = 5;
const DECREASE = 0.8;
const EASE = 0.9;
const SYNC_MS = 1000;
const TTL_MS = 3600_000;

const KEY = dpi => `iiq:thr:${dpi}`;

// Recompute inside Redis: atomic, so no leader election. First worker in after
// the interval elapses does it, the rest read.
const SYNC_LUA = `
local now_t = redis.call('TIME')
local now = tonumber(now_t[1]) * 1000 + math.floor(tonumber(now_t[2]) / 1000)
local out = {}
for i, key in ipairs(KEYS) do
  local o = (i - 1) * 5
  redis.call('HINCRBY', key, 'd', tonumber(ARGV[o + 1]))
  redis.call('HINCRBY', key, 'b', tonumber(ARGV[o + 2]))
  redis.call('HINCRBY', key, 'o', tonumber(ARGV[o + 3]))
  redis.call('HINCRBY', key, 'q', tonumber(ARGV[o + 4]))
  redis.call('HINCRBY', key, 'e', tonumber(ARGV[o + 5]))

  local h = redis.call('HMGET', key, 'r', 'ss', 'at', 'd', 'b', 'o', 'q', 'e', 'ld')
  local r = tonumber(h[1]) or ${FLOOR}
  local ss = tonumber(h[2]); if ss == nil then ss = 1 end
  local at = tonumber(h[3]) or 0
  local ld = tonumber(h[9]) or 0

  if now - at >= ${SYNC_MS} then
    local wd = tonumber(h[4]) or 0
    local wb = tonumber(h[5]) or 0
    local wo = tonumber(h[6]) or 0
    local wq = tonumber(h[7]) or 0
    local we = tonumber(h[8]) or 0

    if wq > 0 then
      r = math.max(${FLOOR}, r * ${DECREASE})
      ss = 0
    elseif we > 0 and we > wo then
      r = math.max(${FLOOR}, r * ${EASE})
      ss = 0
    elseif wb > 0 then
      if ss == 1 then r = math.min(${CEIL}, r * 2) else r = math.min(${CEIL}, r + ${ADD}) end
    end

    ld = wd
    redis.call('HMSET', key, 'r', tostring(r), 'ss', ss, 'at', now, 'ld', ld,
                             'd', 0, 'b', 0, 'o', 0, 'q', 0, 'e', 0)
  end

  redis.call('PEXPIRE', key, ${TTL_MS})
  out[i] = tostring(r) .. ':' .. tostring(ld)
end
return out
`;

function newState(t) {
  return { rate: FLOOR, tokens: FLOOR, refilled: t, demand: 0, blocked: 0, ok: 0, qps: 0, err: 0 };
}

export function createThrottle({ redis = () => null, now = () => Date.now() } = {}) {
  const states = new Map();
  let lastSync = 0;
  let syncing = false;

  const stateOf = dpi => {
    let st = states.get(dpi);
    if (!st) { st = newState(now()); states.set(dpi, st); }
    return st;
  };

  // Demand is counted before the decision. Counting granted fetches instead
  // would deadlock a worker that starts with no share.
  function admit(dpi) {
    const st = stateOf(dpi);
    st.demand++;

    const t = now();
    st.tokens = Math.min(st.rate, st.tokens + (Math.max(0, t - st.refilled) / 1000) * st.rate);
    st.refilled = t;

    const allowed = st.tokens >= 1;
    if (allowed) st.tokens -= 1;
    else st.blocked++;

    if (t - lastSync >= SYNC_MS && !syncing) {
      lastSync = t;
      void sync();
    }
    return allowed;
  }

  function record(dpi, outcome) {
    const st = stateOf(dpi);
    if (outcome === 'qps') st.qps++;
    else if (outcome === 'error') st.err++;
    else st.ok++;
  }

  async function sync() {
    if (!states.size) return;
    syncing = true;
    try {
      const client = await redis();

      const dpis = [...states.keys()];
      const args = [];
      const mine = [];
      for (const dpi of dpis) {
        const st = states.get(dpi);
        args.push(st.demand, st.blocked, st.ok, st.qps, st.err);
        mine.push(st.demand);
        st.demand = 0; st.blocked = 0; st.ok = 0; st.qps = 0; st.err = 0;
      }

      // Fail closed, unlike the rest of the feature: without coordination we
      // cannot know the fleet total, and an outage must not become a flood.
      if (!client) {
        for (const dpi of dpis) stateOf(dpi).rate = FLOOR;
        return;
      }

      let res;
      try {
        res = await client.eval(SYNC_LUA, { keys: dpis.map(KEY), arguments: args.map(String) });
      } catch {
        for (const dpi of dpis) stateOf(dpi).rate = FLOOR;
        return;
      }

      dpis.forEach((dpi, i) => {
        const [r, ld] = String(res?.[i] ?? '').split(':').map(Number);
        if (!Number.isFinite(r)) return;
        const total = Number.isFinite(ld) ? ld : 0;
        const share = total > 0 && mine[i] > 0 ? r * (mine[i] / total) : FLOOR;
        stateOf(dpi).rate = Math.max(FLOOR, Math.min(r, share));
      });
    } finally {
      syncing = false;
    }
  }

  return { admit, record, sync, _states: states, FLOOR, CEIL };
}
