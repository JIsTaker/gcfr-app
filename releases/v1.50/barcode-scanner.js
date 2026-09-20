// ZXing-C++ reads native camera pixels, independently of the preview CSS size.
let decoderPromise;
async function loadDecoder() {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      if (!window.ZXingWASM) await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        const timeout = setTimeout(() => { script.remove(); reject(new Error("Scanner loading timed out. Please retry.")); }, 20000);
        script.src = new URL("./vendor/zxing-reader.js", import.meta.url).href;
        script.onload = () => { clearTimeout(timeout); resolve(); };
        script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error("Scanner could not load. Please retry.")); };
        document.head.appendChild(script);
      });
      const decoder = window.ZXingWASM;
      await decoder.prepareZXingModule({
        overrides: { locateFile: (path) => new URL(`./vendor/${path}`, import.meta.url).href },
        fireImmediately: true,
      });
      return decoder;
    })().catch(error => { decoderPromise = null; throw error; });
  }
  return decoderPromise;
}

export function createBarcodeScanner({ reader, overlay, status, closeButton, scanButton, onResult, onError }) {
  let session = 0;
  let stream = null;
  let video = null;
  let opening = false;
  let active = false;
  let processing = false;
  let timer;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const formats = ["EAN13", "EAN8", "UPCA", "UPCE", "Code128", "Code39", "ITF", "Codabar", "DataBar"];
  const options = { formats, tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1 };
  const release = (media) => media?.getTracks().forEach(track => track.stop());

  function stop() {
    ++session;
    active = false;
    clearTimeout(timer);
    release(stream);
    stream = null;
    if (video) { video.pause(); video.srcObject = null; }
    video = null;
    reader.replaceChildren();
    overlay.classList.add("hidden");
    document.body.classList.remove("scanner-open");
    scanButton.classList.remove("hidden");
  }

  function capture(source, enlargedCenter) {
    const width = source.videoWidth, height = source.videoHeight;
    // Match object-fit: cover, excluding camera pixels outside the preview.
    const bounds = source.getBoundingClientRect();
    const cover = Math.max(bounds.width / width, bounds.height / height);
    const visibleWidth = Math.min(width, bounds.width / cover);
    const visibleHeight = Math.min(height, bounds.height / cover);
    const sw = enlargedCenter ? Math.round(visibleWidth * .95) : Math.round(visibleWidth);
    const sh = enlargedCenter ? Math.round(visibleHeight * .5) : Math.round(visibleHeight);
    const scale = enlargedCenter ? Math.min(2, 2400 / Math.max(sw, sh)) : Math.min(1, 1920 / Math.max(sw, sh));
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, (width - sw) / 2, (height - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  }

  async function start() {
    if (opening || active || processing) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      onError(new Error("Camera requires HTTPS and a supported browser.")); return;
    }
    const id = ++session;
    opening = true;
    active = true;
    document.body.appendChild(overlay);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Scan barcode");
    overlay.classList.remove("hidden");
    document.body.classList.add("scanner-open");
    scanButton.classList.add("hidden");
    closeButton.focus();
    status.textContent = "Loading barcode scanner…";
    try {
      const decoder = await loadDecoder();
      if (id !== session) return;
      status.textContent = "Requesting camera permission…";
      // One permission request per explicit start. No preliminary camera probe.
      const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 },
      } });
      if (id !== session) { release(media); return; }
      stream = media;
      const preview = document.createElement("video");
      preview.muted = true;
      preview.autoplay = true;
      preview.playsInline = true;
      preview.setAttribute("playsinline", "");
      preview.srcObject = media;
      video = preview;
      reader.replaceChildren(preview);
      await preview.play();
      if (id !== session) return;
      const track = media.getVideoTracks()[0];
      try {
        if (track.getCapabilities?.().focusMode?.includes("continuous")) {
          await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        }
      } catch { /* Optional focus control is unavailable on some phones. */ }
      if (id !== session) return;
      status.textContent = "Align the barcode with the line and keep it in focus.";
      let frames = 0;
      let failures = 0;
      const started = Date.now();
      async function scanFrame() {
        if (id !== session || !active) return;
        try {
          if (preview.readyState >= 2 && preview.videoWidth && preview.videoHeight) {
            // Alternate the entire frame with an enlarged central area. The
            // guide does not restrict detection to a narrow strip.
            const results = await decoder.readBarcodes(capture(preview, frames++ % 2 === 1), options);
            if (id !== session) return;
            failures = 0;
            const found = results.find(result => result.isValid && result.text?.trim());
            if (found) {
              processing = true;
              stop();
              try { await onResult(found.text); }
              catch (error) { onError(error); }
              finally { processing = false; }
              return;
            }
            if (Date.now() - started > 8000) status.textContent = "Scanning… keep all bars sharp, with white space at both ends.";
          } else if (Date.now() - started > 8000) {
            status.textContent = "Camera image is not ready. Close the camera and retry.";
          }
        } catch (error) {
          if (id !== session) return;
          // Ordinary no-match results are empty arrays, not exceptions.
          if (++failures >= 3) { stop(); onError(new Error(`Barcode reader failed: ${error.message || error}`)); return; }
        }
        if (id === session && active) timer = setTimeout(scanFrame, 120);
      }
      timer = setTimeout(scanFrame, 0);
    } catch (error) {
      if (id !== session) return;
      stop();
      onError(error.name === "NotAllowedError"
        ? new Error("Camera permission is blocked. Allow Camera for this site in browser settings.") : error);
    } finally { opening = false; }
  }

  document.addEventListener("keydown", event => { if (event.key === "Escape" && active) stop(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && active) stop(); });
  window.addEventListener("pagehide", stop);
  return { start, stop };
}
