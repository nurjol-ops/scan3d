// Просмотрщик 3D-моделей на чистом WebGL (без внешних библиотек).
// Читает GLB, который создаёт наш сервер: позиции, нормали, цвета вершин, индексы.

const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const CTYPE = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

export function parseGLB(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("Это не GLB-файл");
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error("Повреждённый GLB");
  const prim = json.meshes[0].primitives[0];
  const read = (idx) => {
    const acc = json.accessors[idx];
    const view = json.bufferViews[acc.bufferView];
    const n = acc.count * TYPE_SIZE[acc.type];
    const T = CTYPE[acc.componentType];
    const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
    return { data: new T(bin.slice(start, start + n * T.BYTES_PER_ELEMENT)), acc };
  };
  const pos = read(prim.attributes.POSITION);
  const mesh = { positions: pos.data, min: pos.acc.min, max: pos.acc.max };
  const idx = read(prim.indices).data;
  mesh.indices = idx instanceof Uint32Array ? idx : Uint32Array.from(idx);
  mesh.normals = prim.attributes.NORMAL != null ? read(prim.attributes.NORMAL).data : computeNormals(mesh.positions, mesh.indices);
  const n = mesh.positions.length / 3;
  mesh.colors = null;
  if (prim.attributes.COLOR_0 != null) {
    const c = read(prim.attributes.COLOR_0);
    const comps = TYPE_SIZE[c.acc.type];
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = c.data[i * comps + k];
        out[i * 4 + k] = c.data instanceof Uint8Array ? v : c.data instanceof Uint16Array ? v >> 8 : Math.round(v * 255);
      }
      out[i * 4 + 3] = 255;
    }
    mesh.colors = out;
  }
  if (!mesh.min || !mesh.max) {
    mesh.min = [Infinity, Infinity, Infinity]; mesh.max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) {
      mesh.min[k] = Math.min(mesh.min[k], mesh.positions[i + k]); mesh.max[k] = Math.max(mesh.max[k], mesh.positions[i + k]);
    }
  }
  return mesh;
}

function computeNormals(p, idx) {
  const n = new Float32Array(p.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const j of [a, b, c]) { n[j] += nx; n[j + 1] += ny; n[j + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

// ------------------------------------------------------------------ матрицы (column-major)
const mat = {
  ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  persp(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = (2 * far * near) / (near - far);
    return o;
  },
  trans(x, y, z) { const o = mat.ident(); o[12] = x; o[13] = y; o[14] = z; return o; },
  rotX(a) { const o = mat.ident(), c = Math.cos(a), s = Math.sin(a); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o; },
  rotY(a) { const o = mat.ident(), c = Math.cos(a), s = Math.sin(a); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o; },
};

const VS = `
attribute vec3 aPos; attribute vec3 aNor; attribute vec4 aCol;
uniform mat4 uMVP; uniform mat4 uMV;
varying vec3 vN; varying vec3 vCol;
void main(){ vN = mat3(uMV) * aNor; vCol = aCol.rgb; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const FS = `
precision mediump float;
varying vec3 vN; varying vec3 vCol;
uniform vec3 uBase; uniform float uUseCol; uniform float uFlat; uniform float uAmbient;
void main(){
  vec3 base = mix(uBase, vCol, uUseCol);
  if (uFlat > 0.5) { gl_FragColor = vec4(base, 1.0); return; }
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  float d1 = max(dot(n, normalize(vec3(-0.45, 0.65, 0.62))), 0.0);
  float d2 = max(dot(n, normalize(vec3(0.7, -0.15, 0.45))), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 c = base * (uAmbient + 0.22 * hemi + 0.5 * d1 + 0.16 * d2);
  gl_FragColor = vec4(min(c, vec3(1.0)), 1.0);
}`;

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true };
    const gl = canvas.getContext("webgl2", opts) || canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts);
    if (!gl) throw new Error("WebGL недоступен на этом устройстве");
    this.gl = gl;
    if (!(typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext)) {
      if (!gl.getExtension("OES_element_index_uint")) throw new Error("Устройство не поддерживает большие модели (OES_element_index_uint)");
    }
    this.prog = this._program(VS, FS);
    this.loc = {
      aPos: gl.getAttribLocation(this.prog, "aPos"), aNor: gl.getAttribLocation(this.prog, "aNor"), aCol: gl.getAttribLocation(this.prog, "aCol"),
      uMVP: gl.getUniformLocation(this.prog, "uMVP"), uMV: gl.getUniformLocation(this.prog, "uMV"),
      uBase: gl.getUniformLocation(this.prog, "uBase"), uUseCol: gl.getUniformLocation(this.prog, "uUseCol"),
      uFlat: gl.getUniformLocation(this.prog, "uFlat"), uAmbient: gl.getUniformLocation(this.prog, "uAmbient"),
    };
    // WebGL1 для gl_FrontFacing не требует расширений; нормали переворачиваем в шейдере.
    this.mode = "color";
    this.autoRotate = false;
    this.dirty = true;
    this.mesh = null;
    this.buf = {};
    this.reset();
    this._bind();
    this._raf = 0;
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
    this._ro = new ResizeObserver(() => { this.dirty = true; });
    this._ro.observe(canvas);
  }

  _program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Шейдер: " + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Шейдер: " + gl.getProgramInfoLog(p));
    return p;
  }

  setMesh(mesh) {
    const gl = this.gl;
    this.mesh = mesh;
    const mk = (target, data) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
    for (const b of Object.values(this.buf)) gl.deleteBuffer(b);
    const n = mesh.positions.length / 3;
    this.buf = {
      pos: mk(gl.ARRAY_BUFFER, mesh.positions),
      nor: mk(gl.ARRAY_BUFFER, mesh.normals),
      col: mk(gl.ARRAY_BUFFER, mesh.colors || new Uint8Array(n * 4).fill(190)),
      idx: mk(gl.ELEMENT_ARRAY_BUFFER, mesh.indices),
    };
    this.hasColors = !!mesh.colors;
    this.triCount = mesh.indices.length;
    this.lineBuf = null;
    const lo = mesh.min, hi = mesh.max;
    this.center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    this.radius = Math.max(0.05, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    this.reset();
  }

  _ensureLines() {
    if (this.lineBuf) return;
    const gl = this.gl, idx = this.mesh.indices;
    const lines = new Uint32Array((idx.length / 3) * 6);
    for (let i = 0, j = 0; i < idx.length; i += 3) {
      lines[j++] = idx[i]; lines[j++] = idx[i + 1];
      lines[j++] = idx[i + 1]; lines[j++] = idx[i + 2];
      lines[j++] = idx[i + 2]; lines[j++] = idx[i];
    }
    this.lineBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines, gl.STATIC_DRAW);
    this.lineCount = lines.length;
  }

  reset() {
    this.yaw = 0.7; this.pitch = 0.3;
    this.dist = (this.radius || 0.9) * 2.7;
    this.target = [0, 0, 0];
    this.dirty = true;
  }

  setMode(m) { this.mode = m; this.dirty = true; }
  setAutoRotate(v) { this.autoRotate = !!v; this.dirty = true; }

  _bind() {
    const c = this.canvas;
    const ptrs = new Map();
    let lastTap = 0;
    c.style.touchAction = "none";
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = performance.now();
      if (ptrs.size === 1) { if (now - lastTap < 300) this.reset(); lastTap = now; }
    });
    c.addEventListener("pointermove", (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (ptrs.size === 1) {
        this.yaw += dx * 0.0085;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.0085));
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        p.x = e.clientX; p.y = e.clientY;
        const [a2, b2] = [...ptrs.values()];
        const after = Math.hypot(a2.x - b2.x, a2.y - b2.y);
        if (before > 0 && after > 0) this.dist = Math.max(this.radius * 0.6, Math.min(this.radius * 9, (this.dist * before) / after));
        this._pan(dx / 2, dy / 2);
        this.dirty = true;
        return;
      }
      p.x = e.clientX; p.y = e.clientY;
      this.dirty = true;
    });
    const up = (e) => ptrs.delete(e.pointerId);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.dist = Math.max(this.radius * 0.6, Math.min(this.radius * 9, this.dist * Math.exp(e.deltaY * 0.0012)));
      this.dirty = true;
    }, { passive: false });
  }

  _pan(dx, dy) {
    const k = (this.dist * Math.tan(0.35)) / (this.canvas.clientHeight || 400) * 2;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const right = [cy, 0, -sy];
    const upv = [sy * sp, cp, cy * sp];
    for (let i = 0; i < 3; i++) this.target[i] -= (right[i] * dx - upv[i] * dy) * k;
  }

  _loop(t) {
    this._raf = requestAnimationFrame(this._loop);
    if (this.autoRotate) { this.yaw += 0.006; this.dirty = true; }
    if (this.dirty) { this.dirty = false; this.render(); }
  }

  render() {
    const gl = this.gl, c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(2, Math.round(c.clientWidth * dpr)), h = Math.max(2, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.mesh) return;
    gl.enable(gl.DEPTH_TEST);

    const proj = mat.persp(0.7, w / h, this.radius * 0.05, this.radius * 40);
    let mv = mat.trans(-this.center[0] - this.target[0], -this.center[1] - this.target[1], -this.center[2] - this.target[2]);
    mv = mat.mul(mat.rotY(this.yaw), mv);
    mv = mat.mul(mat.rotX(this.pitch), mv);
    mv = mat.mul(mat.trans(0, 0, -this.dist), mv);
    const mvp = mat.mul(proj, mv);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMVP, false, mvp);
    gl.uniformMatrix4fv(this.loc.uMV, false, mv);
    const L = this.loc;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.pos); gl.enableVertexAttribArray(L.aPos); gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.nor); gl.enableVertexAttribArray(L.aNor); gl.vertexAttribPointer(L.aNor, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.col); gl.enableVertexAttribArray(L.aCol); gl.vertexAttribPointer(L.aCol, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    const colored = this.mode === "color" && this.hasColors;
    gl.uniform1f(L.uFlat, 0);
    gl.uniform1f(L.uUseCol, colored ? 1 : 0);
    gl.uniform1f(L.uAmbient, colored ? 0.55 : 0.2);
    gl.uniform3f(L.uBase, 0.78, 0.8, 0.82);
    if (this.mode === "wire") { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); gl.uniform3f(L.uBase, 0.2, 0.25, 0.3); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
    gl.drawElements(gl.TRIANGLES, this.triCount, gl.UNSIGNED_INT, 0);
    if (this.mode === "wire") {
      gl.disable(gl.POLYGON_OFFSET_FILL);
      this._ensureLines();
      gl.uniform1f(L.uFlat, 1); gl.uniform1f(L.uUseCol, 0); gl.uniform3f(L.uBase, 0.35, 0.85, 0.9);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineBuf);
      gl.drawElements(gl.LINES, this.lineCount, gl.UNSIGNED_INT, 0);
    }
  }

  // Квадратная картинка для превью в библиотеке.
  async snapshot(size = 320, bg = "#e6eaee") {
    this.reset();
    this.render();
    const src = this.canvas, s = Math.min(src.width, src.height);
    const out = document.createElement("canvas");
    out.width = out.height = size;
    const ctx = out.getContext("2d");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, size, size);
    return new Promise((r) => out.toBlob(r, "image/jpeg", 0.85));
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._ro && this._ro.disconnect();
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext && ext.loseContext();
  }
}
