// Камера через getUserMedia. Кадры снимаются с видеопотока одним и тем же размером:
// для фотограмметрии важно, чтобы у всех снимков были одинаковые параметры камеры.

export class CameraError extends Error {}

export class Camera {
  constructor() {
    this.stream = null;
    this.video = null;
    this.track = null;
    this.torchOn = false;
    this.small = document.createElement("canvas");
    this.small.width = 160;
    this.big = document.createElement("canvas");
    this.frameSize = null;
  }

  async start(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new CameraError("Камера недоступна в этом приложении.");
    }
    const tries = [
      { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: "environment" }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr;
    for (const c of tries) {
      try { this.stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { lastErr = e; if (e.name === "NotAllowedError") break; }
    }
    if (!this.stream) {
      if (lastErr && (lastErr.name === "NotAllowedError" || lastErr.name === "SecurityError")) {
        throw new CameraError("Нет доступа к камере. Разрешите камеру для Scan3D в настройках телефона.");
      }
      if (lastErr && lastErr.name === "NotFoundError") throw new CameraError("Камера не найдена.");
      throw new CameraError("Не удалось включить камеру" + (lastErr ? `: ${lastErr.message || lastErr.name}` : "."));
    }
    this.video = video;
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.srcObject = this.stream;
    this.track = this.stream.getVideoTracks()[0];
    await video.play().catch(() => {});
    await new Promise((resolve) => {
      if (video.videoWidth) return resolve();
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      setTimeout(resolve, 3000);
    });
    // непрерывная автофокусировка, если поддерживается
    try {
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      this.hasTorch = !!caps.torch;
      if (caps.focusMode && caps.focusMode.includes("continuous")) {
        await this.track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      }
    } catch { /* не критично */ }
    this.frameSize = { w: video.videoWidth, h: video.videoHeight };
  }

  async setTorch(on) {
    if (!this.track || !this.hasTorch) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      this.torchOn = !!on;
      return true;
    } catch { return false; }
  }

  stop() {
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch { /* ничего */ }
    if (this.video) this.video.srcObject = null;
    this.stream = null;
  }

  // Резкость: дисперсия лапласиана уменьшенного кадра. Чем больше, тем резче.
  sharpness() {
    const v = this.video;
    if (!v || !v.videoWidth) return 0;
    const w = 160, h = Math.max(32, Math.round((160 * v.videoHeight) / v.videoWidth));
    this.small.width = w; this.small.height = h;
    const ctx = this.small.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        sum += lap; sum2 += lap * lap; n++;
      }
    }
    const mean = sum / n;
    return sum2 / n - mean * mean;
  }

  // Возвращает { blob, thumb } или null, если размер кадра изменился (повернули телефон).
  async grab({ maxSide = 1600, quality = 0.88 } = {}) {
    const v = this.video;
    if (!v || !v.videoWidth) return null;
    if (this.frameSize && (v.videoWidth !== this.frameSize.w || v.videoHeight !== this.frameSize.h)) return { resized: true };
    const s = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
    this.big.width = w; this.big.height = h;
    this.big.getContext("2d").drawImage(v, 0, 0, w, h);
    const blob = await new Promise((r) => this.big.toBlob(r, "image/jpeg", quality));
    if (!blob) return null;
    const tw = 120, th = Math.round((120 * h) / w);
    this.small.width = tw; this.small.height = th;
    this.small.getContext("2d").drawImage(this.big, 0, 0, tw, th);
    const thumb = this.small.toDataURL("image/jpeg", 0.6);
    return { blob, thumb, w, h };
  }
}
