(() => {
  const RELEASE_META = document.querySelector('meta[name="gcfr-release"]');
  const THIS_RELEASE = RELEASE_META?.content || "unknown";
  const rootUrl = new URL("../../", location.href);
  const releaseUrl = new URL("release.json", rootUrl);
  const channel = new URLSearchParams(location.search).get("channel") || "current";

  let releaseState = null;
  let bootConfirmed = false;
  let forcedRestartStarted = false;

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

      if (state.current && state.current !== THIS_RELEASE && !forcedRestartStarted) {
        forcedRestartStarted = true;

        // Give the active release one synchronous chance to cache only this
        // signed-in user's unfinished work before moving to the new release.
        if (typeof CustomEvent === "function") {
          window.dispatchEvent(new CustomEvent("gcfr:before-forced-update", {
            detail: {
              from: THIS_RELEASE,
              to: state.current,
              bootConfirmed,
            },
          }));
        }

        await askWorkerToCache(state.current);

        const target = new URL(rootUrl.href);
        target.searchParams.set("updated", state.current);
        setTimeout(() => location.replace(target.href), 80);
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

  // Slow/offline auth and data restoration must never trigger a rollback.

  // Do not run release navigation checks on window focus/visibility changes.
  // Mobile browsers can emit these during pull/scroll UI transitions, which
  // must never reset the app. Release checks stay on online + periodic polling.
  window.addEventListener("online", checkForReleaseChange);

  setInterval(checkForReleaseChange, 120000);

  getState().catch(() => {});
})();
