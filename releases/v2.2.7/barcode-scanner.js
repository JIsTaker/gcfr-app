// GCFR v1.51 barcode scanner
// Optimized for small, short shelf-label barcodes such as EAN-8.
let decoderPromise;
let nativeDetectorPromise;

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

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", {
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

  function capture(source, profile, perspective = 0) {
    const width = source.videoWidth;
    const height = source.videoHeight;

    const bounds = source.getBoundingClientRect();
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
            widthRatio: 0.94,
            heightRatio: 0.58,
            maxScale: 2.4,
            maxOutput: 2500,
          },
          {
            widthRatio: 0.84,
            heightRatio: 0.34,
            maxScale: 3.2,
            maxOutput: 2800,
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
        (height - sh) / 2,
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

    if (mode === "thinBars1" || mode === "thinBars2") {
      const width = imageData.width;
      const height = imageData.height;
      const radius = mode === "thinBars2" ? 2 : 1;
      const source = new Uint8ClampedArray(data);

      // First binarize conservatively, then restore narrow white gaps that
      // thermal ink spread has partially closed. A black output pixel survives
      // only when its horizontal neighbours are also black.
      let total = 0;
      let samples = 0;
      for (let i = 0; i < source.length; i += 16) {
        total += source[i] * 0.299 + source[i + 1] * 0.587 + source[i + 2] * 0.114;
        samples += 1;
      }
      const threshold = Math.max(82, Math.min(198, total / Math.max(1, samples) - 10));
      const black = new Uint8Array(width * height);

      for (let p = 0; p < width * height; p += 1) {
        const i = p * 4;
        const y = source[i] * 0.299 + source[i + 1] * 0.587 + source[i + 2] * 0.114;
        black[p] = y < threshold ? 1 : 0;
      }

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          let keepBlack = black[y * width + x] === 1;
          if (keepBlack) {
            for (let dx = -radius; dx <= radius; dx += 1) {
              const nx = x + dx;
              if (nx < 0 || nx >= width || black[y * width + nx] === 0) {
                keepBlack = false;
                break;
              }
            }
          }
          const value = keepBlack ? 0 : 255;
          const i = (y * width + x) * 4;
          data[i] = value;
          data[i + 1] = value;
          data[i + 2] = value;
          data[i + 3] = 255;
        }
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

    document.body.appendChild(overlay);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Scan barcode");
    overlay.classList.remove("hidden");
    document.body.classList.add("scanner-open");
    scanButton.classList.add("hidden");
    closeButton.focus();

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

      nativeDetector = await nativeDetectorTask;
      decoder = null;
      decoderLoadError = null;

      const decoderTask = loadDecoder()
        .then((loaded) => {
          if (id === session && active) decoder = loaded;
          return loaded;
        })
        .catch((error) => {
          decoderLoadError = error;
          return null;
        });

      if (!nativeDetector) {
        status.textContent = "Loading barcode scanner…";
        await decoderTask;

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
        "Fill the guide with the barcode and keep every bar sharp.";

      let frames = 0;
      let failures = 0;
      const started = Date.now();

      async function scanFrame() {
        if (id !== session || !active) return;

        try {
          if (
            preview.readyState >= 2
            && preview.videoWidth
            && preview.videoHeight
          ) {
            // Keep Android autofocus awake while the user moves between shelf
            // labels and distances. Some devices settle once and stop hunting.
            await applyScanFocus();
            // Android Chrome/PWA can use the native detector directly
            // from the live video frame. This is much lighter than decoding a
            // large ImageData buffer through WASM on every pass.
            let foundText = "";

            if (nativeDetector) {
              try {
                // Native detection gets the live frame first. ZXing below also
                // receives enlarged centre crops for small thermal tickets.
                const nativeResults = await nativeDetector.detect(preview);
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

                // Ink-spread recovery: shrink vertical black bars only in the
                // horizontal direction to reopen narrow white barcode gaps.
                { profile: 2, preprocess: "thinBars1" },
                { profile: 4, preprocess: "thinBars1" },
                { profile: 2, preprocess: "thinBars2" },
                { profile: 4, preprocess: "thinBars2" },
                { profile: 1, preprocess: null },
                { profile: 3, preprocess: "contrast" },
                { profile: 0, preprocess: null },
              ];
              const pass = isAndroid
                ? androidPasses[frames++ % androidPasses.length]
                : { profile: frames++ % 3, preprocess: null };

              let frame = capture(preview, pass.profile, 0);
              if (pass.preprocess) {
                frame = preprocessBarcode(frame, pass.preprocess);
              }

              const results = await decoder.readBarcodes(
                frame,
                options,
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
                "Move closer. Keep only the barcode inside the guide with white space at both ends.";
            }

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
          timer = setTimeout(scanFrame, isAndroid ? 45 : 70);
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
      opening = false;
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && active) {
      stop();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && active) {
      stop();
    }
  });

  window.addEventListener("pagehide", stop);

  return {
    start,
    stop,
  };
}
