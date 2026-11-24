// The persistent life of the water and ice on the glass.
//
// Before this module the rain shader's only state was a single `wet` value
// chased towards the current frame's rain intensity and a set of scrolling
// offsets. Nothing knew about frost, nothing survived a restart, and every
// caller had to remember to feed a zero dt while paused.
//
// GlassState is the one source of truth for what is on the windscreen and
// windows. Accumulation, airflow-driven run-off, drying, freezing and thawing
// all mutate the same fields here; GlassRain only copies them into shader
// uniforms. It deliberately imports nothing from three or the DOM, so the
// whole lifecycle runs headless under `node test/glass-rain.mjs`.
//
// The icing input is `ice` (0..1), exactly `systems.ice` / `systems.ind.ice`
// from js/systems.js. This module never works out whether the aeroplane is in
// icing conditions itself: the existing systems module already models cloud
// water, the icing temperature band and the accretion/melt rates. Here that
// number only decides how fast liquid on the glass turns to frost.

// Cell sizes (m) of the bead layer and the three stream layers, the speed
// multiplier of each stream layer, and the cell period of the hash pattern.
// The shader includes these same constants, which is why they live here.
export const CELLS = [0.017, 0.022, 0.017, 0.013];
export const PACE = [0, 0.55, 1.0, 1.6];
export const PERIOD = 512;

// Timing and mapping constants (seconds, systems-ice units).
export const TIMING = {
  tauWet: 2.6,            // rain soaks dry glass to the rain intensity in ~3 tau
  dryTau0: 15,            // drying time constant in still air
  drySpeed: 16,           // ias (m/s) scale for airflow shortening the time constant
  iceOn: 0.03,            // systems.ice here starts to lock the water up
  iceFull: 0.3,           // ... here freezing runs at the full rate
  freezeTau: 2.0,         // liquid -> frost time constant at full freeze power
  rimeTau: 3.0,           // how quickly direct rime coverage tracks systems.ice
  coldDryMult: 6,         // sub-zero air evaporates the film that much more slowly
  meltOat: 0.5,           // above this outside air temperature (deg C) frost thaws
  meltOatFull: 8,         // ... at this temperature thawing runs at full speed
  meltRate: 0.09,         // coverage units of frost per second at full thaw
  meltRunoff: 0.35,       // fraction of thawed frost that lingers briefly as water
  lockStart: 0.05,        // frost coverage at which streams begin to seize
  lockFull: 0.55,         // frost coverage at which nothing flows any more
  eps: 0.002,             // below this the glass layer is considered gone
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
function smoothstep(x, a, b) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

export class GlassState {
  constructor() { this.reset(); }

  // Everything that should be blank after "Restart" or a new airport.
  reset() {
    this.water = 0;        // liquid film, beads and rivulets, 0..1
    this.frost = 0;        // frozen rime / ice coverage, 0..1
    this.rain = 0;         // last rain input, 0..1
    this.ias = 0;          // last indicated airspeed, m/s
    this.ice = 0;          // last systems.ice input, 0..1
    this.oat = null;       // last outside air temperature, deg C (may be null)
    this.push = 0;         // 0..1 how strong the airflow over the glass is
    this.freezePower = 0;  // 0..1 freezing rate multiplier from systems.ice
    this.meltRate = 0;     // frost coverage units removed per second
    this.mobility = 1;     // 1 liquid runs freely, 0 frozen solid
    this.visible = false;
    this.time = 0;         // accumulated un-paused simulation time, s
    this.dens = [0, 0, 0, 0];
    // Nine pane/layer combinations: kind k in {windscreen, side, roof}, layer l in 0..2.
    this.offX = new Float64Array(9);
    this.offY = new Float64Array(9);
    this.travelX = new Float64Array(9);   // unwrapped metres travelled, for tests
    this.travelY = new Float64Array(9);
    // Match the shader's uDir defaults: windscreen up, side windows across, roof up-plane.
    this.dirX = new Float64Array([0, 1, 0]);
    this.dirY = new Float64Array([1, 0, 1]);
    this.tail = new Float64Array(9);
    return this;
  }

  // dt 0 (or any non-positive/non-finite value) is the pause signal: the
  // snapshot is returned untouched so repeated paused frames are identical.
  //
  // input: { rain?:0..1, ias?:m/s, ice?:systems.ice 0..1, oat?:deg C|null }
  // Missing fields hold the previous value, which keeps a paused-then-resumed
  // caller honest and makes stepwise samples short to write.
  update(dt, input = {}) {
    if (!Number.isFinite(dt) || dt <= 0) return false;
    const T = TIMING;
    if (input.rain !== undefined) this.rain = clamp01(Number(input.rain) || 0);
    if (input.ias !== undefined) this.ias = Math.max(0, Number(input.ias) || 0);
    if (input.ice !== undefined) this.ice = clamp01(Number(input.ice) || 0);
    if (Object.prototype.hasOwnProperty.call(input, 'oat')) this.oat = Number.isFinite(input.oat) ? input.oat : null;

    const rain = this.rain, ias = this.ias;

    // Airflow strong enough to push a drop off its cell (same band as before).
    this.push = smoothstep(ias, 8, 22);

    // Freezing severity comes straight from the systems module's ice output.
    // Above freezing OAT the glass thaws even while that output is still
    // nonzero but decaying; with no OAT supplied, thaw once systems reports
    // the airframe clean again.
    const warming = this.oat !== null && this.oat > T.meltOat;
    this.freezePower = warming ? 0 : smoothstep(this.ice, T.iceOn, T.iceFull);
    if (warming) this.meltRate = T.meltRate * clamp01((this.oat - T.meltOat) / (T.meltOatFull - T.meltOat) * 0.85 + 0.15);
    else if (this.oat === null && this.ice <= 0.001) this.meltRate = T.meltRate * 0.5;
    else this.meltRate = 0;

    // 1) Rain lands and beads: quick soak towards the rainfall intensity.
    if (rain > this.water) this.water += (rain - this.water) * (1 - Math.exp(-dt / T.tauWet));

    // 2) Airframe ice means supercooled water on the glass freezes with it.
    //    Liquid is converted into frost one-for-one (coverage units).
    if (this.freezePower > 0 && this.water > 0) {
      const made = this.water * (1 - Math.exp(-dt * this.freezePower / T.freezeTau));
      this.water -= made;
      this.frost = Math.min(1, this.frost + made);
    }
    // In a real icing cloud supercooled droplets also rime a dry glass
    // directly. That coverage tracks the systems module's ice output itself;
    // no independent icing-condition judgement is made here.
    if (!warming && this.ice > 0.001 && this.ice > this.frost) {
      this.frost += (this.ice - this.frost) * (1 - Math.exp(-dt / T.rimeTau));
    }

    // 3) Warm air thaws the rime; a little of it lingers as water to dry off.
    if (this.meltRate > 0 && this.frost > 0) {
      const made = Math.min(this.frost, this.meltRate * dt);
      this.frost -= made;
      this.water = Math.min(1, this.water + made * T.meltRunoff);
    }

    // 4) Out of the rain the remaining film evaporates and is stripped by the
    //    airflow. Cold air and an actively freezing surface dry it far more slowly.
    if (this.water > rain) {
      const cold = this.oat !== null && this.oat <= T.meltOat ? T.coldDryMult : 1;
      const tau = T.dryTau0 / (1 + ias / T.drySpeed) * cold / (1 - 0.9 * this.freezePower);
      this.water += (rain - this.water) * (1 - Math.exp(-dt / tau));
    }

    // Snap asymptotic leftovers to exactly zero once nothing is building them.
    // Never do this while rain is arriving or frost is accreting: at 240 Hz a
    // single step's increment can itself be below eps and would be erased forever.
    if (this.water < T.eps && rain === 0) this.water = 0;
    if (this.frost < T.eps && this.meltRate > 0) this.frost = 0;
    this.water = clamp01(this.water);

    // Frost seizes the streams where it covers them. Fully frozen panes do
    // not move at all, which is what makes the frost layer read as static.
    this.mobility = 1 - smoothstep(this.frost, T.lockStart, T.lockFull);

    // Render densities: a thin film plus beads/rivulets. Fast airflow blows
    // most beads off and draws the remaining water into thin quick streams.
    const w = this.water, p = this.push;
    this.dens[0] = w * (0.5 - 0.42 * p);
    this.dens[1] = w * (0.1 - 0.03 * p);
    this.dens[2] = w * 0.08;
    this.dens[3] = w * (0.05 + 0.04 * p);

    // How the water moves on each kind of pane, in its own plane (m/s).
    const flow = 0.035 * ias * p * this.mobility;
    const fall = 0.05 * (1 - 0.8 * p) * this.mobility;
    const kinds = [[0, flow - fall], [flow, 0.12 * flow - fall], [0, flow]];
    for (let k = 0; k < 3; k++) {
      const [vx, vy] = kinds[k], v = Math.hypot(vx, vy);
      if (v > 1e-6) { this.dirX[k] = vx / v; this.dirY[k] = vy / v; }
      for (let l = 1; l <= 3; l++) {
        const idx = k * 3 + l - 1, m = PACE[l], span = CELLS[l] * PERIOD;
        this.travelX[idx] += vx * m * dt;
        this.travelY[idx] += vy * m * dt;
        this.offX[idx] = this.travelX[idx] % span;
        this.offY[idx] = this.travelY[idx] % span;
        this.tail[idx] = Math.min(1, (v * m * 0.06) / CELLS[l] + 0.15 * p * this.mobility);
      }
    }

    this.visible = this.water > T.eps || this.frost > T.eps;
    this.time += dt;
    return true;
  }

  // Plain snapshot used by the headless sample and pause checks.
  toJSON() {
    return {
      water: this.water, frost: this.frost, rain: this.rain, ias: this.ias, ice: this.ice, oat: this.oat,
      push: this.push, freezePower: this.freezePower, meltRate: this.meltRate, mobility: this.mobility,
      visible: this.visible, time: this.time, dens: [...this.dens],
      offX: [...this.offX], offY: [...this.offY], travelX: [...this.travelX], travelY: [...this.travelY],
      dirX: [...this.dirX], dirY: [...this.dirY], tail: [...this.tail],
    };
  }
}
