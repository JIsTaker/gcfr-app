// GCFR v1.51 barcode scanner
// Optimized for small, short shelf-label barcodes such as EAN-8.
let decoderPromise;
let nativeDetectorPromise;
let ocrWorkerPromise;

async function loadOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      if (!window.Tesseract) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          const timeout = setTimeout(() => {
            script.remove();
            reject(new Error("Ticket text reader loading timed out."));
          }, 20000);

          script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
          script.onload = () => {
            clearTimeout(timeout);
            resolve();
          };
          script.onerror = () => {
            clearTimeout(timeout);
            script.remove();
            reject(new Error("Ticket text reader could not load."));
          };
          document.head.appendChild(script);
        });
      }

      const worker = await window.Tesseract.createWorker("eng", 1, {
        logger: () => {},
        workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
        corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
      });

      await worker.setParameters({
        tessedit_char_whitelist: "0123456789",
        tessedit_pageseg_mode: "11",
        preserve_interword_spaces: "1",
      });

      return worker;
    })().catch((error) => {
      ocrWorkerPromise = null;
      throw error;
    });
  }

  return ocrWorkerPromise;
}

function extractTicketNumberCandidates(text) {
  // Never truncate a longer barcode or join digits across separate lines.
  const matches = String(text || "").match(/\d+(?:[ \t]+\d+)?/g) || [];
  return [...new Set(
    matches
      .map((value) => value.replace(/\D/g, ""))
      .filter((value) => /^\d{6,8}$/.test(value))
  )];
}

function createScanConfirmation() {
  let candidate = "", hits = 0, lastFrame = -1, lastAt = 0;
  return (value, frameTime, now) => {
    if (!value) return "";
    if (value !== candidate || now - lastAt > 1800) {
      candidate = value; hits = 0; lastFrame = -1;
    }
    if (frameTime !== lastFrame) { hits++; lastFrame = frameTime; }
    lastAt = now;
    return hits >= 2 ? candidate : "";
  };
}

async function loadNativeDetector() {
  if (!("BarcodeDetector" in window)) return null;

  if (!nativeDetectorPromise) {
    nativeDetectorPromise = (async () => {
      try {
        const wanted = [
          "ean_8",
          "ean_13",
          "upc_a",
          "upc_e",
          "code_128",
          "code_39",
          "itf",
          "codabar",
        ];

        const supported =
          typeof window.BarcodeDetector.getSupportedFormats === "function"
            ? await window.BarcodeDetector.getSupportedFormats()
            : wanted;

        const formats = wanted.filter((format) => supported.includes(format));
        if (!formats.length) return null;

        return new window.BarcodeDetector({ formats });
      } catch {
        return null;
      }
    })();
  }

  return nativeDetectorPromise;
}

async function loadDecoder() {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      if (!window.ZXingWASM) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          const timeout = setTimeout(() => {
            script.remove();
            reject(new Error("Scanner loading timed out. Please retry."));
          }, 20000);

          script.src = new URL("./vendor/zxing-reader.js", import.meta.url).href;
          script.onload = () => {
            clearTimeout(timeout);
            resolve();
          };
          script.onerror = () => {
            clearTimeout(timeout);
            script.remove();
            reject(new Error("Scanner could not load. Please retry."));
          };

          document.head.appendChild(script);
        });
      }

      const decoder = window.ZXingWASM;

      await decoder.prepareZXingModule({
        overrides: {
          locateFile: (path) =>
            new URL(`./vendor/${path}`, import.meta.url).href,
        },
        fireImmediately: true,
      });

      return decoder;
    })().catch((error) => {
      decoderPromise = null;
      throw error;
    });
  }

  return decoderPromise;
}

export function createBarcodeScanner({
  reader,
  overlay,
  status,
  closeButton,
  scanButton,
  onResult,
  onError,
  onTextCandidates = null,
  shouldUseTextRecognition = null,
}) {
  let session = 0;
  let stream = null;
  let video = null;
  let opening = false;
  let active = false;
  let processing = false;
  let timer;
  let nativeDetector = null;
  let nativeFailures = 0;
  let decoder = null;
  let decoderLoadError = null;
  let resumeOnPageShow = false;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", {
    willReadFrequently: true,
  });
  const ocrCanvas = document.createElement("canvas");
  const ocrContext = ocrCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  const formats = [
    "EAN8",
    "EAN13",
    "UPCA",
    "UPCE",
    "Code128",
    "Code39",
    "ITF",
    "Codabar",
    "DataBar",
  ];

  const fastOptions = {
    formats,
    tryHarder: false,
    tryRotate: false,
    tryInvert: false,
    maxNumberOfSymbols: 1,
  };

  const options = {
    formats,
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    maxNumberOfSymbols: 1,
  };

  const release = (media) =>
    media?.getTracks().forEach((track) => track.stop());

  function stop() {
    ++session;
    opening = false;
    resumeOnPageShow = false;
    active = false;
    clearTimeout(timer);
    release(stream);
    stream = null;

    if (video) {
      video.pause();
      video.srcObject = null;
    }

    video = null;
    reader.replaceChildren();
    overlay.classList.add("hidden");
    document.body.classList.remove("scanner-open");
    scanButton.classList.remove("hidden");
  }

  const isAndroid = /Android/i.test(navigator.userAgent);

  function capture(source, profile, perspective = 0, verticalOffset = 0) {
    const width = source.videoWidth || source.width;
    const height = source.videoHeight || source.height;

    const bounds = source === video
      ? source.getBoundingClientRect()
      : { width, height };
    const cover = Math.max(
      bounds.width / width,
      bounds.height / height,
    );

    const visibleWidth = Math.min(
      width,
      bounds.width / cover,
    );

    const visibleHeight = Math.min(
      height,
      bounds.height / cover,
    );

    const profiles = isAndroid
      ? [
          // Full visible frame: useful while the user is still aligning.
          {
            widthRatio: 1,
            heightRatio: 1,
            maxScale: 1,
            maxOutput: 1800,
          },
          // Wide centre band: primary shelf-ticket profile.
          {
            widthRatio: 0.96,
            heightRatio: 0.48,
            maxScale: 2.1,
            maxOutput: 2200,
          },
          // Tight centre band: short EAN-8 and small printed labels.
          {
            widthRatio: 0.90,
            heightRatio: 0.25,
            maxScale: 3,
            maxOutput: 2400,
          },
          // Slightly taller tight crop for angled handheld scans.
          {
            widthRatio: 0.82,
            heightRatio: 0.38,
            maxScale: 2.5,
            maxOutput: 2300,
          },
          // Short thermal supplier/store tickets (for example an 8-digit
          // Code128/ITF ticket) need the bars to fill much more of the decode
          // buffer than a normal EAN retail barcode.
          {
            widthRatio: 0.72,
            heightRatio: 0.18,
            maxScale: 4,
            maxOutput: 2800,
          },
        ]
      : [
          {
            widthRatio: 1,
            heightRatio: 1,
            maxScale: 1.15,
            maxOutput: 2200,
          },
          {
            widthRatio: 0.96,
            heightRatio: 0.58,
            maxScale: 2.4,
            maxOutput: 2500,
          },
          {
            widthRatio: 0.90,
            heightRatio: 0.34,
            maxScale: 3.2,
            maxOutput: 2800,
          },
          // Wide, shallow carton/supplier label profile. Code39 factory
          // labels often span almost the whole camera width and are much
          // shorter than retail EAN labels.
          {
            widthRatio: 0.99,
            heightRatio: 0.24,
            maxScale: 3.4,
            maxOutput: 3000,
          },
          {
            widthRatio: 0.99,
            heightRatio: 0.38,
            maxScale: 2.8,
            maxOutput: 2900,
          },
        ];

    const selected = profiles[profile % profiles.length];

    const sw = Math.max(
      1,
      Math.round(visibleWidth * selected.widthRatio),
    );

    const sh = Math.max(
      1,
      Math.round(visibleHeight * selected.heightRatio),
    );

    const scale = Math.min(
      selected.maxScale,
      selected.maxOutput / Math.max(sw, sh),
    );

    canvas.width = Math.max(
      1,
      Math.round(sw * scale),
    );

    canvas.height = Math.max(
      1,
      Math.round(sh * scale),
    );

    // Preserve hard bar edges. Smoothing can blur short EAN-8 labels.
    context.imageSmoothingEnabled = false;

    context.save();

    if (!perspective) {
      context.drawImage(
        source,
        (width - sw) / 2,
        Math.max((height - visibleHeight) / 2,
          Math.min((height + visibleHeight) / 2 - sh, (height - sh) / 2 + verticalOffset * visibleHeight)),
        sw,
        sh,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    } else {
      // Approximate the user's successful tilted-ticket view in software.
      // Split the crop into narrow columns and vertically compress/offset them
      // progressively. This creates a mild perspective/skew pass while keeping
      // barcode bars sharp.
      const slices = 48;
      const srcX = (width - sw) / 2;
      const srcY = (height - sh) / 2;

      for (let i = 0; i < slices; i += 1) {
        const t = i / Math.max(1, slices - 1);
        const sx = srcX + (sw * i) / slices;
        const sWidth = sw / slices + 1;
        const dx = (canvas.width * i) / slices;
        const dWidth = canvas.width / slices + 1;
        const edge = perspective > 0 ? t : 1 - t;
        const compression = 1 - Math.abs(perspective) * edge;
        const dHeight = canvas.height * compression;
        const dy = (canvas.height - dHeight) / 2;

        context.drawImage(
          source,
          sx,
          srcY,
          sWidth,
          sh,
          dx,
          dy,
          dWidth,
          dHeight,
        );
      }
    }

    context.restore();

    return context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }

  function preprocessBarcode(imageData, mode) {
    const data = imageData.data;

    if (mode === "contrast" || mode === "contrastStrong") {
      // Stretch local barcode contrast and lightly sharpen dark/light edges.
      // Thermal labels often have grey paper, faded gaps and ink spread.
      let min = 255;
      let max = 0;

      for (let i = 0; i < data.length; i += 16) {
        const y = Math.round(
          data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114,
        );
        min = Math.min(min, y);
        max = Math.max(max, y);
      }

      const span = Math.max(32, max - min);

      for (let i = 0; i < data.length; i += 4) {
        const y = Math.round(
          data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114,
        );
        let stretched = Math.max(
          0,
          Math.min(255, Math.round(((y - min) * 255) / span)),
        );
        if (mode === "contrastStrong") {
          stretched = stretched < 128
            ? Math.max(0, Math.round((stretched - 128) * 1.28 + 128))
            : Math.min(255, Math.round((stretched - 128) * 1.18 + 128));
        }
        data[i] = stretched;
        data[i + 1] = stretched;
        data[i + 2] = stretched;
      }

      return imageData;
    }

    if (
      mode === "binary" ||
      mode === "binaryDark" ||
      mode === "binaryLight" ||
      mode.startsWith("binary:")
    ) {
      // Adaptive-by-frame threshold for faded/dirty thermal printing.
      let total = 0;
      let samples = 0;

      for (let i = 0; i < data.length; i += 16) {
        total +=
          data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        samples += 1;
      }

      const mean = total / Math.max(1, samples);
      const requestedBias = mode.startsWith("binary:")
        ? Number(mode.slice("binary:".length))
        : NaN;
      const bias = Number.isFinite(requestedBias)
        ? requestedBias
        : mode === "binaryDark"
          ? -24
          : mode === "binaryLight"
            ? 2
            : -12;
      const threshold = Math.max(82, Math.min(198, mean + bias));

      for (let i = 0; i < data.length; i += 4) {
        const y =
          data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const value = y < threshold ? 0 : 255;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
      }
    }


    return imageData;
  }

  async function start() {
    if (opening || active || processing) return;

    if (
      !window.isSecureContext
      || !navigator.mediaDevices?.getUserMedia
    ) {
      onError(
        new Error(
          "Camera requires HTTPS and a supported browser.",
        ),
      );
      return;
    }

    const id = ++session;
    opening = true;
    active = true;

    // Open the camera request first, directly from the user's tap. Do not move
    // the existing scanner DOM or shift focus before getUserMedia(): mobile
    // browsers can treat that as leaving the user-activation path.
    // Scanner overlays are nested inside screen/card containers. Move the
    // active overlay to <body> so iOS renders the fixed camera layer in the
    // viewport instead of inside an ancestor stacking/containing context.
    if (overlay.parentElement !== document.body) {
      document.body.appendChild(overlay);
    }
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Scan barcode");
    overlay.classList.remove("hidden");
    document.body.classList.add("scanner-open");
    scanButton.classList.add("hidden");

    status.textContent = "Requesting camera permission…";

    try {
      const nativeDetectorTask = loadNativeDetector();

      let media;
      try {
        media = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: {
              exact: "environment",
            },
            width: {
              ideal: isAndroid ? 2560 : 2560,
            },
            height: {
              ideal: isAndroid ? 1440 : 1440,
            },
            frameRate: {
              ideal: 30,
            },
          },
        });
      } catch (cameraError) {
        if (id !== session) return;
        // A denied/busy camera must not trigger a second permission request.
        if (!["OverconstrainedError", "NotFoundError"].includes(cameraError.name)) throw cameraError;
        // Some Android devices reject exact rear-camera constraints.
        media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: {
            ideal: "environment",
          },
          width: {
            ideal: isAndroid ? 1920 : 2560,
          },
          height: {
            ideal: isAndroid ? 1080 : 1440,
          },
          frameRate: {
            ideal: 30,
          },
        },
      });
      }

      if (id !== session) {
        release(media);
        return;
      }

      stream = media;
      closeButton.focus({ preventScroll: true });

      video = document.createElement("video");
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.srcObject = media;
      reader.replaceChildren(video);

      await video.play();
      if (id !== session) return;

      nativeDetector = await nativeDetectorTask;
      if (id !== session) return;
      nativeFailures = 0;
      decoder = null;
      decoderLoadError = null;

      const decoderTask = loadDecoder()
        .then((loaded) => {
          if (id === session && active) decoder = loaded;
          return loaded;
        })
        .catch((error) => {
          if (id === session) decoderLoadError = error;
          return null;
        });

      if (!nativeDetector) {
        status.textContent = "Loading barcode scanner…";
        await decoderTask;
        if (id !== session) return;

        if (!decoder) {
          throw decoderLoadError || new Error("Barcode scanner could not load.");
        }
      }

      const track = media.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() || {};
      let focusRefreshAt = 0;

      async function applyScanFocus(force = false) {
        if (!isAndroid || id !== session || !active) return;

        const now = Date.now();
        if (!force && now - focusRefreshAt < 1600) return;
        focusRefreshAt = now;

        try {
          const advanced = [];

          if (capabilities.focusMode?.includes("continuous")) {
            advanced.push({ focusMode: "continuous" });
          } else if (capabilities.focusMode?.includes("single-shot")) {
            // Re-trigger single-shot AF periodically on Android devices that
            // do not expose continuous focus to the browser.
            advanced.push({ focusMode: "single-shot" });
          }

          // Avoid aggressive zoom: on multi-camera Android phones it can push
          // the device onto a lens with a worse minimum focus distance.
          if (capabilities.zoom) {
            const minZoom = Number(capabilities.zoom.min || 1);
            const maxZoom = Number(capabilities.zoom.max || minZoom);
            const targetZoom = Math.min(maxZoom, Math.max(minZoom, 1.15));
            advanced.push({ zoom: targetZoom });
          }

          if (advanced.length) {
            await track.applyConstraints({ advanced });
          }
        } catch {
          // Focus/zoom controls are optional and vary by Android camera stack.
        }
      }

      await applyScanFocus(true);

      if (id !== session) return;

      status.textContent =
        "Fill the guide with the barcode and hold it steady.";

      let frames = 0;
      let failures = 0;
      const confirmScan = createScanConfirmation();
      let ocrRunning = false;
      let lastOcrAt = 0;
      let lastOcrFrame = -1;
      const ocrCandidateCounts = Object.create(null);
      const started = Date.now();

      async function tryTicketTextRecognition() {
        if (
          !onTextCandidates
          || (typeof shouldUseTextRecognition === "function" && !shouldUseTextRecognition())
          || ocrRunning
          || id !== session
          || !active
        ) return;

        const now = Date.now();
        if (now - started < 2500 || now - lastOcrAt < 1800) return;
        if (video.currentTime === lastOcrFrame) return;
        lastOcrFrame = video.currentTime;
        lastOcrAt = now;
        ocrRunning = true;

        try {
          capture(video, 0);
          const width = canvas.width;
          const height = canvas.height;
          if (!width || !height) return;

          const maxWidth = 1400;
          const scale = Math.min(1, maxWidth / width);
          ocrCanvas.width = Math.max(1, Math.round(width * scale));
          ocrCanvas.height = Math.max(1, Math.round(height * scale));

          ocrContext.save();
          ocrContext.filter = "grayscale(1) contrast(1.8)";
          ocrContext.drawImage(canvas, 0, 0, ocrCanvas.width, ocrCanvas.height);
          ocrContext.restore();

          const previousStatus = status.textContent;
          status.textContent = "Reading printed ticket number…";

          const worker = await loadOcrWorker();
          if (id !== session || !active) return;

          const seenInFrame = new Set();
          const recordCandidates = async (text) => {
            const candidates = extractTicketNumberCandidates(text);
            if (!candidates.length) return "";

            for (const value of new Set(candidates)) {
              if (!seenInFrame.has(value)) {
                ocrCandidateCounts[value] = (ocrCandidateCounts[value] || 0) + 1;
                seenInFrame.add(value);
              }
            }

            const confirmed = candidates.filter(value => ocrCandidateCounts[value] >= 2);
            if (!confirmed.length) return "";
            const accepted = await onTextCandidates(confirmed, {
              counts: { ...ocrCandidateCounts },
            });
            if (id !== session || !active) return "";

            const acceptedValue =
              accepted && typeof accepted === "object"
                ? accepted.value
                : accepted;

            return String(acceptedValue || "").trim();
          };

          const full = await worker.recognize(ocrCanvas);
          if (id !== session || !active) return;

          let acceptedText = await recordCandidates(full?.data?.text || "");

          // Ticket layouts vary, so verify the number in overlapping bands.
          // Matching the same digits in two independent OCR passes greatly
          // reduces single-digit substitutions on damaged labels.
          if (!acceptedText) {
            const bands = [
              { top: 0.00, height: 0.48 },
              { top: 0.26, height: 0.48 },
              { top: 0.52, height: 0.48 },
            ];

            for (const band of bands) {
              const top = Math.round(ocrCanvas.height * band.top);
              const heightPx = Math.min(
                ocrCanvas.height - top,
                Math.round(ocrCanvas.height * band.height),
              );
              if (heightPx <= 0) continue;

              const bandResult = await worker.recognize(ocrCanvas, {
                rectangle: {
                  left: 0,
                  top,
                  width: ocrCanvas.width,
                  height: heightPx,
                },
              });
              if (id !== session || !active) return;

              acceptedText = await recordCandidates(bandResult?.data?.text || "");
              if (acceptedText) break;
            }
          }

          if (!acceptedText) {
            status.textContent = previousStatus;
            return;
          }

          processing = true;
          stop();
          try {
            await onResult(acceptedText);
          } catch (error) {
            onError(error);
          } finally {
            processing = false;
          }
        } catch (error) {
          console.warn("Ticket text recognition:", error);
        } finally {
          ocrRunning = false;
        }
      }

      async function scanFrame() {
        if (id !== session || !active) return;

        try {
          if (
            video.readyState >= 2
            && video.videoWidth
            && video.videoHeight
          ) {
            // Leave focus alone after camera startup. Re-applying focus from
            // every scan iteration makes some Android cameras hunt continuously,
            // blurring narrow thermal-barcode gaps between decode attempts.
            // Android Chrome/PWA can use the native detector directly
            // from the live video frame. This is much lighter than decoding a
            // large ImageData buffer through WASM on every pass.
            let foundText = "";
            const frameTime = video.currentTime;
            const passIndex = frames++;
            const sweepOffsets = [0, 0, -0.18, 0, 0.18, 0, -0.32, 0, 0.32];
            const verticalOffset = sweepOffsets[passIndex % sweepOffsets.length];

            if (nativeDetector) {
              try {
                // Use a small centre/sweep crop for native detection so nearby
                // shelf labels do not win over the barcode inside the guide.
                // The tighter crop is also faster than scanning the whole frame.
                capture(video, passIndex % 6 === 5 ? 1 : 2, 0, verticalOffset);
                const nativeResults = await nativeDetector.detect(canvas);
                const foundNative = nativeResults.find(
                  (result) => result.rawValue?.trim(),
                );

                if (foundNative) {
                  foundText = foundNative.rawValue.trim();
                }

                nativeFailures = 0;
              } catch {
                if (++nativeFailures >= 3) {
                  nativeDetector = null;
                }
              }
            }

            // Do not wait for the native Android detector to fail before
            // trying ZXing. Chrome's detector is fast but misses some small
            // shelf-label EAN codes that ZXing can recover from a centre crop.
            if (!foundText && decoder) {
              // Rotate full / wide / tight crops.
              // Android uses smaller buffers so the scan loop stays responsive.
              const androidPasses = [
                // Fast path for normal labels and the preprocessing that already
                // proved effective on faded thermal tickets.
                { profile: 2, preprocess: null },
                { profile: 4, preprocess: null },
                { profile: 2, preprocess: "contrast" },
                { profile: 4, preprocess: "contrast" },
                { profile: 2, preprocess: "binary:-12" },
                { profile: 4, preprocess: "binary:-12" },

                // Thermal printers vary heavily in darkness and ink spread.
                // Sweep several mean-relative thresholds instead of betting on
                // one global threshold. Tight profiles stay first for speed.
                { profile: 2, preprocess: "binary:-32" },
                { profile: 4, preprocess: "binary:-32" },
                { profile: 2, preprocess: "binary:-24" },
                { profile: 4, preprocess: "binary:-24" },
                { profile: 2, preprocess: "binary:-16" },
                { profile: 4, preprocess: "binary:-16" },
                { profile: 2, preprocess: "binary:-8" },
                { profile: 4, preprocess: "binary:-8" },
                { profile: 2, preprocess: "binary:0" },
                { profile: 4, preprocess: "binary:0" },
                { profile: 2, preprocess: "binary:8" },
                { profile: 4, preprocess: "binary:8" },
                { profile: 2, preprocess: "contrastStrong" },
                { profile: 4, preprocess: "contrastStrong" },

                { profile: 1, preprocess: null },
                { profile: 3, preprocess: "contrast" },
                { profile: 0, preprocess: null },
              ];
              const iosPasses = [
                { profile: 3, preprocess: null },
                { profile: 3, preprocess: "contrast" },
                { profile: 4, preprocess: null },
                { profile: 3, preprocess: "binary:-24" },
                { profile: 3, preprocess: "binary:-12" },
                { profile: 4, preprocess: "contrast" },
                { profile: 2, preprocess: null },
                { profile: 2, preprocess: "contrast" },
                { profile: 1, preprocess: null },
                { profile: 0, preprocess: null },
                { profile: 3, preprocess: "contrastStrong" },
                { profile: 4, preprocess: "binary:-12" },
              ];

              const pass = isAndroid
                ? androidPasses[passIndex % androidPasses.length]
                : iosPasses[passIndex % iosPasses.length];

              let frame = capture(video, pass.profile, 0, verticalOffset);
              if (pass.preprocess) {
                frame = preprocessBarcode(frame, pass.preprocess);
              }

              const decodeOptions =
                passIndex < 8 || passIndex % 4 !== 3
                  ? fastOptions
                  : options;
              const results = await decoder.readBarcodes(
                frame,
                decodeOptions,
              );

              const foundFallback = results.find(
                (result) =>
                  result.isValid
                  && result.text?.trim(),
              );

              if (foundFallback) {
                foundText = foundFallback.text.trim();
              }
            }

            if (id !== session) return;

            failures = 0;
            foundText = confirmScan(foundText, frameTime, Date.now());

            if (foundText) {
              processing = true;
              stop();

              try {
                await onResult(foundText.trim());
              } catch (error) {
                onError(error);
              } finally {
                processing = false;
              }

              return;
            }

            if (Date.now() - started > 5500) {
              status.textContent =
                "Move closer. Barcode scan is active; damaged tickets also use printed-number recognition.";
            }

            void tryTicketTextRecognition();

            // If native detection is available, ZXing finishes loading in the
            // background and automatically becomes the fallback on hard labels.
            if (!decoder && decoderLoadError && !nativeDetector) {
              throw decoderLoadError;
            }
          } else if (Date.now() - started > 5500) {
            status.textContent =
              "Camera image is not ready. Close the camera and retry.";
          }
        } catch (error) {
          if (id !== session) return;

          if (++failures >= 3) {
            stop();

            onError(
              new Error(
                `Barcode reader failed: ${
                  error.message || error
                }`,
              ),
            );

            return;
          }
        }

        if (id === session && active) {
          timer = setTimeout(scanFrame, isAndroid ? 20 : 28);
        }
      }

      timer = setTimeout(scanFrame, 0);
    } catch (error) {
      if (id !== session) return;

      stop();

      onError(
        error.name === "NotAllowedError"
          ? new Error(
              "Camera permission is blocked. Allow Camera for this site in browser settings.",
            )
          : error.name === "NotReadableError"
            ? new Error(
                "Camera is busy. Close any other app using the camera and retry.",
              )
            : error,
      );
    } finally {
      if (id === session) opening = false;
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && active) {
      stop();
    }
  });

  // Mobile browser/PWA chrome can transiently hide the document while the
  // user is still in the scanner. Do not destroy the camera session here.
  window.addEventListener("pagehide", () => {
    const wasActive = active;
    stop();
    resumeOnPageShow = wasActive;
  });
  window.addEventListener("pageshow", () => {
    if (!resumeOnPageShow) return;
    resumeOnPageShow = false;
    void start();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !active || opening) return;
    if (stream?.getVideoTracks().some((track) => track.readyState === "ended")) {
      stop();
      void start();
    } else {
      video?.play().catch(() => {});
    }
  });

  return {
    start,
    stop,
  };
}
