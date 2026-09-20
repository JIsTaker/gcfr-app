(() => {
  const RELEASE_META = document.querySelector('meta[name="gcfr-release"]');
  const THIS_RELEASE = RELEASE_META?.content || "unknown";
  const rootUrl = new URL("../../", location.href);
  const releaseUrl = new URL("release.json", rootUrl);
  const channel = new URLSearchParams(location.search).get("channel") || "current";

  let releaseState = null;
  let bootConfirmed = false;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? "-";
  };

  function paintState(state) {
    if (!state) return;
    setText("releasePrevious", state.previous || "-");
    setText("releaseCurrent", state.current || "-");
    setText("releasePatching", state.patching || "-");
    setText("releaseStatus", state.status || "-");
  }

  async function getState() {
    const response = await fetch(`${releaseUrl.href}?ts=${Date.now()}`, {
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`release.json ${response.status}`);
    const state = await response.json();
    releaseState = state;
    localStorage.setItem("gcfr_release_state", JSON.stringify(state));
    paintState(state);
    return state;
  }

  async function askWorkerToCache(version) {
    if (!("serviceWorker" in navigator) || !version) return;
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    const worker =
      navigator.serviceWorker.controller
      || registration?.active
      || registration?.waiting
      || registration?.installing;
    worker?.postMessage({ type: "CACHE_RELEASE", version });
  }

  async function checkForReleaseChange() {
    if (channel === "patching" || channel === "manual") return;

    try {
      const state = await getState();

      const failed = localStorage.getItem("gcfr_failed_release");
      if (failed && state.current !== failed) {
        localStorage.removeItem("gcfr_failed_release");
        localStorage.removeItem("gcfr_recovery_release");
      }

      if (channel === "recovery" && failed === state.current) {
        return;
      }

      if (state.current && state.current !== THIS_RELEASE) {
        await askWorkerToCache(state.current);
        location.replace(rootUrl.href);
      }
    } catch (error) {
      console.warn("Release check failed:", error);
    }
  }

  window.addEventListener("gcfr:boot-ok", async () => {
    bootConfirmed = true;

    try {
      const state = releaseState || await getState();

      if (THIS_RELEASE === state.current) {
        localStorage.setItem("gcfr_last_good_release", THIS_RELEASE);
        localStorage.removeItem("gcfr_failed_release");
        localStorage.removeItem("gcfr_recovery_release");
      }
    } catch {
      localStorage.setItem("gcfr_last_good_release", THIS_RELEASE);
    }
  }, { once: true });

  // If a newly promoted current release cannot finish booting, keep the
  // previous known-good release available on this device automatically.
  setTimeout(async () => {
    if (bootConfirmed || channel === "patching" || channel === "manual" || channel === "recovery") return;

    try {
      const state = releaseState || await getState();

      if (THIS_RELEASE === state.current && state.previous) {
        localStorage.setItem("gcfr_failed_release", THIS_RELEASE);
        localStorage.setItem("gcfr_recovery_release", state.previous);

        const fallback = new URL(rootUrl.href);
        fallback.searchParams.set("release", state.previous);
        fallback.searchParams.set("recovery", "1");
        location.replace(fallback.href);
      }
    } catch (error) {
      console.warn("Automatic client recovery check failed:", error);
    }
  }, 12000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForReleaseChange();
  });

  window.addEventListener("online", checkForReleaseChange);
  window.addEventListener("focus", checkForReleaseChange);

  setInterval(checkForReleaseChange, 120000);

  getState().catch(() => {});
})();