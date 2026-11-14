// Датчик ориентации и «купол покрытия»: показывает, с каких сторон и на какой высоте уже есть кадры.

const RAD = Math.PI / 180;
export const SEGMENTS = 24;
// Кольца: 0 — телефон смотрит почти горизонтально (низкий круг), 2 — почти вертикально вниз (высокий круг).
export const RINGS = [
  { name: "низкий", test: (el) => el > -25 },
  { name: "средний", test: (el) => el <= -25 && el > -50 },
  { name: "высокий", test: (el) => el <= -50 },
];
const RING_NEED = [0.7, 0.6, 0.4];

// Направление, куда смотрит задняя камера, в системе «восток, север, вверх».
export function lookVector(alphaDeg, betaDeg, gammaDeg) {
  const a = alphaDeg * RAD, b = betaDeg * RAD, g = gammaDeg * RAD;
  const x1 = -Math.sin(g);
  const y1 = Math.cos(g) * Math.sin(b);
  const z1 = -Math.cos(g) * Math.cos(b);
  return {
    x: x1 * Math.cos(a) - y1 * Math.sin(a),
    y: x1 * Math.sin(a) + y1 * Math.cos(a),
    z: z1,
  };
}

export function toAzEl(v) {
  return {
    az: ((Math.atan2(v.x, v.y) / RAD) + 360) % 360,
    el: Math.asin(Math.max(-1, Math.min(1, v.z))) / RAD,
  };
}

export function angleBetween(a, b) {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(Math.max(-1, Math.min(1, d))) / RAD;
}

export class Orientation {
  constructor() {
    this.available = false;
    this.vec = null;
    this.az = 0;
    this.el = -30;
    this.rate = 0; // градусов в секунду (сглаженная)
    this._src = null;
    this._last = null;
    this._lastT = 0;
    this._onAbs = (e) => this._handle(e, "abs");
    this._onRel = (e) => this._handle(e, "rel");
  }

  async start() {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        await DeviceOrientationEvent.requestPermission();
      }
    } catch { /* не нужно на Android */ }
    window.addEventListener("deviceorientationabsolute", this._onAbs, true);
    window.addEventListener("deviceorientation", this._onRel, true);
  }

  stop() {
    window.removeEventListener("deviceorientationabsolute", this._onAbs, true);
    window.removeEventListener("deviceorientation", this._onRel, true);
  }

  _handle(e, src) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    if (src === "abs") this._src = "abs";
    else if (this._src === "abs") return; // относительные значения игнорируем, если есть абсолютные
    const v = lookVector(e.alpha, e.beta, e.gamma);
    const now = performance.now();
    if (this._last && now > this._lastT) {
      const inst = angleBetween(this._last, v) / ((now - this._lastT) / 1000);
      this.rate = this.rate * 0.7 + Math.min(inst, 400) * 0.3;
    }
    this._last = v; this._lastT = now;
    this.vec = v;
    const { az, el } = toAzEl(v);
    this.az = az; this.el = el;
    this.available = true;
  }
}

export class Dome {
  constructor(canvas) {
    this.canvas = canvas;
    this.reset();
  }

  reset() {
    this.cells = RINGS.map(() => new Uint8Array(SEGMENTS));
    this.baseAz = null;
    this.total = 0;
  }

  // az — азимут направления взгляда; позиция камеры вокруг предмета — с противоположной стороны.
  _pos(az) {
    if (this.baseAz == null) this.baseAz = az;
    return (((az - this.baseAz) % 360) + 360) % 360;
  }

  mark(az, el) {
    const pos = this._pos(az + 180);
    const ring = RINGS.findIndex((r) => r.test(el));
    const cell = Math.floor(pos / (360 / SEGMENTS)) % SEGMENTS;
    this.cells[ring][cell] = 1;
    this.total++;
  }

  fraction(ring) {
    return this.cells[ring].reduce((s, v) => s + v, 0) / SEGMENTS;
  }

  hint(frameCount) {
    if (frameCount < 6) return "Держите предмет в центре кадра";
    for (let r = 0; r < RINGS.length; r++) {
      if (this.fraction(r) < RING_NEED[r]) {
        if (r === 0) return "Обойдите предмет по кругу, телефон держите ровнее";
        if (r === 1) return "Теперь поднимите телефон выше и пройдите ещё круг";
        return "Снимите предмет сверху, наклонив телефон вниз";
      }
    }
    return "Снято достаточно. Нажмите «Готово»";
  }

  complete() {
    return RINGS.every((_, r) => this.fraction(r) >= RING_NEED[r]);
  }

  draw(curAz, curEl, accent = "#2fd0db") {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const size = c.clientWidth || 132;
    if (c.width !== size * dpr) { c.width = size * dpr; c.height = size * dpr; }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2, R = size / 2 - 2;
    const bands = [[0.74, 1.0], [0.46, 0.7], [0.2, 0.42]];
    const step = (Math.PI * 2) / SEGMENTS;
    ctx.lineCap = "butt";
    for (let r = 0; r < 3; r++) {
      const [a, b] = bands[r];
      const mid = ((a + b) / 2) * R, width = (b - a) * R;
      ctx.lineWidth = width;
      for (let k = 0; k < SEGMENTS; k++) {
        const a0 = -Math.PI / 2 + k * step + 0.03, a1 = -Math.PI / 2 + (k + 1) * step - 0.03;
        ctx.beginPath();
        ctx.arc(cx, cy, mid, a0, a1);
        ctx.strokeStyle = this.cells[r][k] ? accent : "rgba(255,255,255,0.2)";
        ctx.stroke();
      }
    }
    // текущее положение камеры
    if (curAz != null && this.baseAz != null) {
      const pos = this._pos(curAz + 180) * RAD - Math.PI / 2;
      const t = Math.max(0, Math.min(1, (-curEl - 5) / 75)); // 0 = горизонтально, 1 = вертикально вниз
      const rr = (0.87 - 0.67 * t) * R;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(pos) * rr, cy + Math.sin(pos) * rr, 4.6, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.stroke();
    }
    // предмет в центре
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fill();
  }
}
