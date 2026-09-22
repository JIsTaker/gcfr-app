// GCFR v1.51 barcode scanner
// Optimized for small, short shelf-label barcodes such as EAN-8.
let decoderPromise;

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

  function capture(source, profile) {
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

    const profiles = [
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

    return context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    );
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

    status.textContent = "Loading barcode scanner…";

    try {
      const decoder = await loadDecoder();
      if (id !== session) return;

      status.textContent = "Requesting camera permission…";

      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: {
            ideal: "environment",
          },
          width: {
            ideal: 2560,
          },
          height: {
            ideal: 1440,
          },
          frameRate: {
            ideal: 30,
          },
        },
      });

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

      const track = media.getVideoTracks()[0];

      try {
        const capabilities = track.getCapabilities?.() || {};

        if (capabilities.focusMode?.includes("continuous")) {
          await track.applyConstraints({
            advanced: [
              {
                focusMode: "continuous",
              },
            ],
          });
        }
      } catch {
        // Optional focus control is unavailable on some phones.
      }

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
            // Rotate full / wide / tight crops.
            // Tight crop enlarges very short shelf-label EAN-8 barcodes.
            const profile = frames++ % 3;

            const results = await decoder.readBarcodes(
              capture(preview, profile),
              options,
            );

            if (id !== session) return;

            failures = 0;

            const found = results.find(
              (result) =>
                result.isValid
                && result.text?.trim(),
            );

            if (found) {
              processing = true;
              stop();

              try {
                await onResult(found.text.trim());
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
          timer = setTimeout(scanFrame, 90);
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
