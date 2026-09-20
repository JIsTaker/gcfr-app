import { createBarcodeScanner } from "./barcode-scanner.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://ihplydsxgrwuzgiydylg.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_s-rXvXKUGMqUy__1-JP9Cw_DlBVXr0l";
const AUTH_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/gcfr-auth`;
const ADMIN_USER_ID = "139c07f7-a826-4513-86af-25afdbe44d8f";

const REMEMBER_LOGIN_KEY = "gcfr_remember_login";
const REMEMBER_USERNAME_KEY = "gcfr_remember_username";
const SESSION_LOGIN_KEY = "gcfr_session_login";


const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let selectedChecklistDate = localDateString(new Date());
let draft = loadDraft();
let scanner = null;
let pendingUnknownBarcode = "";
let barcodeLinkSearchTimer = null;
let installPrompt = null;
let realtimeChannels = [];


function showToast(message, ms = 2600) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.add("hidden"), ms);
}

function setAuthStatus(message = "") {
  $("authStatus").textContent = message;
}

function displayNameFrom(first, last) {
  const initial = Array.from((last || "").trim())[0]?.toUpperCase() || "";
  return first.trim() && initial ? `${first.trim()} ${initial}` : "-";
}

function rememberLoginPreference() {
  const value = localStorage.getItem(REMEMBER_LOGIN_KEY);
  return value === null ? true : value === "1";
}

function hydrateLoginMemory() {
  const checkbox = $("rememberLogin");
  const usernameInput = $("loginUsername");
  if (!checkbox || !usernameInput) return;

  checkbox.checked = rememberLoginPreference();

  const rememberedUsername = localStorage.getItem(REMEMBER_USERNAME_KEY);
  if (checkbox.checked && rememberedUsername && !usernameInput.value) {
    usernameInput.value = rememberedUsername;
  }
}

function saveLoginMemory(username) {
  const remember = $("rememberLogin")?.checked ?? true;

  localStorage.setItem(REMEMBER_LOGIN_KEY, remember ? "1" : "0");

  if (remember) {
    localStorage.setItem(REMEMBER_USERNAME_KEY, username);
    sessionStorage.removeItem(SESSION_LOGIN_KEY);
  } else {
    localStorage.removeItem(REMEMBER_USERNAME_KEY);
    sessionStorage.setItem(SESSION_LOGIN_KEY, "1");
  }
}

function rememberSignupSession(username) {
  localStorage.setItem(REMEMBER_LOGIN_KEY, "1");
  localStorage.setItem(REMEMBER_USERNAME_KEY, username);
  sessionStorage.removeItem(SESSION_LOGIN_KEY);
}

function clearSessionOnlyLoginMarker() {
  sessionStorage.removeItem(SESSION_LOGIN_KEY);
}

function authView(name) {
  ["loginForm", "signupForm", "forgotForm", "recoveryForm"].forEach((id) => {
    $(id).classList.toggle("hidden", id !== name);
  });
  $("authTabs").classList.toggle("hidden", !["loginForm", "signupForm"].includes(name));
  $("loginTab").classList.toggle("active", name === "loginForm");
  $("signupTab").classList.toggle("active", name === "signupForm");

  if (name === "loginForm") {
    hydrateLoginMemory();
  }

  setAuthStatus("");
}

async function callAuthFunction(action, payload = {}, useSession = false) {
  const headers = { "Content-Type": "text/plain" };

  if (useSession) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Session expired. Log in again.");
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(AUTH_FUNCTION_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...payload }),
  });

  let data = {};
  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

async function applyReturnedSession(data) {
  const { error } = await supabase.auth.setSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  });
  if (error) throw error;
}

async function loadProfile(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, first_name, last_name, display_name, role")
    .eq("id", userId)
    .single();

  if (error) throw error;
  return data;
}

async function enterApp() {
  const { data } = await supabase.auth.getUser();
  if (!data.user) return;

  currentUser = data.user;
  currentProfile = await loadProfile(currentUser.id);

  if (rememberLoginPreference() && currentProfile?.username) {
    localStorage.setItem(REMEMBER_USERNAME_KEY, currentProfile.username);
  }

  $("authShell").classList.add("hidden");
  $("appShell").classList.remove("hidden");

  // Always enter the real app on the Scan screen after login.
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  $("screen-scan").classList.add("active");
  document.querySelectorAll(".bottom-nav button[data-screen]").forEach((b) => b.classList.remove("active"));
  document.querySelector('.bottom-nav button[data-screen="scan"]')?.classList.add("active");
  $("screenTitle").textContent = "Scan";

  $("userDisplay").textContent = currentProfile.display_name || currentProfile.username;
  $("accountName").textContent = currentProfile.display_name || "-";
  $("accountUsername").textContent = currentProfile.username || "-";
  $("accountRole").textContent = currentUser.id === ADMIN_USER_ID ? "admin" : "user";

  const isAdmin = currentUser.id === ADMIN_USER_ID;
  $("adminNavBtn").classList.toggle("hidden", !isAdmin);

  renderDraft();
  await refreshRuns();
  await refreshHistory();
  await refreshChecklist();
  if (isAdmin) await refreshAdminRequests();

  subscribeRealtime();
}

async function leaveApp() {
  stopScanner();
  realtimeChannels.forEach((channel) => supabase.removeChannel(channel));
  realtimeChannels = [];
  currentUser = null;
  currentProfile = null;
  $("appShell").classList.add("hidden");
  $("authShell").classList.remove("hidden");
  authView("loginForm");
}

function subscribeRealtime() {
  realtimeChannels.forEach((channel) => supabase.removeChannel(channel));
  realtimeChannels = [];

  const runChannel = supabase
    .channel("gcfr-runs")
    .on("postgres_changes", { event: "*", schema: "public", table: "run_lists" }, () => {
      refreshRuns();
      refreshHistory();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "run_items" }, () => {
      refreshRuns();
      refreshHistory();
    })
    .subscribe();

  const checklistChannel = supabase
    .channel("gcfr-checklist")
    .on("postgres_changes", { event: "*", schema: "public", table: "checklist_tasks" }, () => {
      refreshChecklistPreservingScroll();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "checklist_comments" }, () => {
      refreshChecklistPreservingScroll();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "checklist_shift_closures" }, () => {
      refreshChecklistPreservingScroll();
    })
    .subscribe();

  realtimeChannels.push(runChannel, checklistChannel);
}

// ---------- AUTH ----------
document.addEventListener(
  "pointerdown",
  () => {
    if (!notificationSettings.enabled) return;

    if (notificationSettings.sound) {
      unlockNotificationAudio();
    }

    if (
      currentUser
      && "Notification" in window
      && Notification.permission === "default"
      && !webPushPermissionAttempted
    ) {
      enableWebPush({
        requestPermission: true,
        quiet: true,
      });
    } else if (
      currentUser
      && "Notification" in window
      && Notification.permission === "granted"
      && !webPushSubscription
    ) {
      enableWebPush({
        requestPermission: false,
        quiet: true,
      });
    }
  },
  { passive: true },
);

document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible"
    && notificationSettings.enabled
    && notificationSettings.sound
  ) {
    unlockNotificationAudio();
  }
});

$("notificationEnabled").onchange = async () => {
  notificationSettings.enabled = $("notificationEnabled").checked;
  saveNotificationSettings();

  if (notificationSettings.enabled) {
    await unlockNotificationAudio();
    await enableWebPush({
      requestPermission: true,
      quiet: false,
    });
  } else {
    await disableWebPush();
  }

  renderNotificationSettings();
};

$("notificationSound").onchange = async () => {
  notificationSettings.sound = $("notificationSound").checked;
  saveNotificationSettings();

  if (notificationSettings.sound) {
    await unlockNotificationAudio();
  }

  renderNotificationSettings();

  if (notificationSettings.enabled) {
    syncWebPushSubscription().catch(() => {});
  }
};

$("notificationVibration").onchange = () => {
  notificationSettings.vibration = $("notificationVibration").checked;
  saveNotificationSettings();
  renderNotificationSettings();

  if (notificationSettings.enabled) {
    syncWebPushSubscription().catch(() => {});
  }
};

$("notificationVolume").oninput = async () => {
  notificationSettings.volume = Number($("notificationVolume").value);
  saveNotificationSettings();
  $("notificationVolumeValue").textContent = `${notificationSettings.volume}%`;

  if (notificationSettings.sound) {
    await unlockNotificationAudio();
  }

  if (notificationSettings.enabled) {
    syncWebPushSubscription().catch(() => {});
  }
};

$("testNotificationBtn").onclick = async () => {
  await unlockNotificationAudio();

  if (!notificationSettings.enabled) {
    showToast("Notifications are OFF.");
    return;
  }

  const ready = await enableWebPush({
    requestPermission: true,
    quiet: false,
  });

  if (!ready) return;

  try {
    const result = await callPushFunction("test_self");
    showToast(
      result.sent > 0
        ? "Push test sent."
        : "No active push subscription was found."
    );
  } catch (error) {
    showToast(error.message || "Push test failed.");
  }
};

// ---------- AUTH ----------
$("loginTab").onclick = () => authView("loginForm");
$("signupTab").onclick = () => authView("signupForm");
$("forgotPasswordBtn").onclick = () => authView("forgotForm");
$("forgotBackBtn").onclick = () => authView("loginForm");

$("signupFirstName").addEventListener("input", updateNamePreview);
$("signupLastName").addEventListener("input", updateNamePreview);

function updateNamePreview() {
  $("displayNamePreview").textContent = displayNameFrom(
    $("signupFirstName").value,
    $("signupLastName").value,
  );
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    setAuthStatus("Logging in...");
    const username = $("loginUsername").value.trim();

    const data = await callAuthFunction("login", {
      username,
      password: $("loginPassword").value,
    });

    await applyReturnedSession(data);
    saveLoginMemory(username);

    setAuthStatus("");
    await enterApp();
  } catch (error) {
    setAuthStatus(error.message);
  }
});

$("signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const password = $("signupPassword").value;
  const confirmPassword = $("signupConfirmPassword").value;
  if (password !== confirmPassword) {
    setAuthStatus("Passwords do not match.");
    return;
  }

  try {
    setAuthStatus("Creating account...");
    const data = await callAuthFunction("signup", {
      username: $("signupUsername").value.trim(),
      firstName: $("signupFirstName").value.trim(),
      lastName: $("signupLastName").value.trim(),
      email: $("signupEmail").value.trim(),
      password,
      confirmPassword,
    });

    await applyReturnedSession(data);
    rememberSignupSession($("signupUsername").value.trim());

    setAuthStatus("");
    await enterApp();
  } catch (error) {
    setAuthStatus(error.message);
  }
});

$("forgotForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    setAuthStatus("Sending request...");
    const data = await callAuthFunction("request_password_reset", {
      username: $("forgotUsername").value.trim(),
    });
    setAuthStatus(data.message || "Request sent.");
  } catch (error) {
    setAuthStatus(error.message);
  }
});

$("recoveryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("recoveryPassword").value;
  const confirmPassword = $("recoveryConfirmPassword").value;

  if (password !== confirmPassword) {
    setAuthStatus("Passwords do not match.");
    return;
  }

  try {
    setAuthStatus("Saving new password...");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;

    try {
      await callAuthFunction("complete_password_reset", {}, true);
    } catch (completeError) {
      console.warn("Could not mark reset request complete:", completeError);
    }

    clearSessionOnlyLoginMarker();
    await supabase.auth.signOut();
    history.replaceState({}, document.title, location.pathname);
    authView("loginForm");
    setAuthStatus("Password changed. Reset request completed. Log in with your new password.");
  } catch (error) {
    setAuthStatus(error.message);
  }
});

$("logoutBtn").onclick = async () => {
  clearSessionOnlyLoginMarker();
  await supabase.auth.signOut();
  await leaveApp();
};

supabase.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    $("appShell").classList.add("hidden");
    $("authShell").classList.remove("hidden");
    authView("recoveryForm");
    setAuthStatus("Enter a new password.");
  }
});

// ---------- NAV ----------
const titles = {
  scan: "Scan",
  runs: "Run Lists",
  history: "Run History",
  checklist: "Checklist",
  admin: "Admin",
  account: "Account",
};


document.querySelectorAll(".bottom-nav button[data-screen]").forEach((button) => {
  button.addEventListener("click", async () => {
    const screen = button.dataset.screen;

    document.querySelectorAll(".bottom-nav button[data-screen]").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");

    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
    $(`screen-${screen}`).classList.add("active");
    $("screenTitle").textContent = titles[screen];

    if (screen !== "scan") stopScanner();
    if (screen === "runs") await refreshRuns();
    if (screen === "history") await refreshHistory();
    if (screen === "checklist") await refreshChecklist();
    if (screen === "admin") await refreshAdminRequests();
  });
});

// ---------- DRAFT RUN LIST ----------
function loadDraft() {
  let items = [];

  try {
    items = JSON.parse(localStorage.getItem("gcfr_draft_run") || "[]");
    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }

  // Migrate any V1.6 separate Manual Draft into the same Draft once.
  try {
    const oldManual = JSON.parse(localStorage.getItem("gcfr_manual_draft") || "[]");
    if (Array.isArray(oldManual) && oldManual.length) {
      for (const name of oldManual) {
        const clean = String(name || "").trim();
        if (clean) {
          items.push({
            manual_name: clean,
            name: clean,
          });
        }
      }
      localStorage.removeItem("gcfr_manual_draft");
      localStorage.setItem("gcfr_draft_run", JSON.stringify(items));
    }
  } catch {}

  return items;
}

function saveDraft() {
  localStorage.setItem("gcfr_draft_run", JSON.stringify(draft));
}

function renderDraft() {
  $("draftCount").textContent = String(draft.length);
  $("submitRunBtn").disabled = draft.length === 0;

  const container = $("draftList");
  container.innerHTML = "";

  if (!draft.length) {
    container.className = "list empty-state";
    container.textContent = "No items yet.";
    return;
  }

  container.className = "list";

  draft.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "list-row draft-run-row";

    const isManual = !!item.manual_name;
    const title = item.name || item.manual_name || item.code || "Item";
    const sub = isManual ? "Manual item" : item.code;

    const text = document.createElement("div");
    text.className = "draft-item-main";
    text.innerHTML = `
      <div class="item-title">${escapeHtml(title)}</div>
      <div class="item-sub">${escapeHtml(sub)}</div>
      ${isManual ? '<div class="manual-tag">No ticket / no barcode</div>' : ''}
    `;

    const gapLabel = document.createElement("label");
    gapLabel.className = "gap-check-toggle";
    const gapBox = document.createElement("input");
    gapBox.type = "checkbox";
    gapBox.checked = !!item.gap_check_required;
    gapBox.onchange = () => {
      draft[index].gap_check_required = gapBox.checked;
      saveDraft();
    };

    const gapText = document.createElement("span");
    gapText.textContent = "Gap Check required";
    gapLabel.append(gapBox, gapText);

    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.type = "button";
    remove.textContent = "×";
    remove.onclick = () => {
      draft.splice(index, 1);
      saveDraft();
      renderDraft();
    };

    const controls = document.createElement("div");
    controls.className = "draft-item-controls";
    controls.append(gapLabel, remove);

    row.append(text, controls);
    container.appendChild(row);
  });
}

async function addCodeToDraft(code) {
  const clean = String(code || "").trim();
  if (!clean) return;

  if (draft.some((x) => x.code && x.code === clean)) {
    showToast("Already in the draft.");
    return;
  }

  const { data, error } = await supabase
    .from("products")
    .select("code, name")
    .eq("code", clean)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    showToast(`Product ${clean} was not found.`);
    return;
  }

  draft.push(data);
  saveDraft();
  renderDraft();
  showToast(`${data.name} added.`);
}

$("manualCodeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await addCodeToDraft($("manualCode").value);
    $("manualCode").value = "";
  } catch (error) {
    showToast(error.message);
  }
});


// ---------- PRODUCT SEARCH ----------
let productSearchTimer = null;
let productSearchRequestId = 0;

$("productSearch").addEventListener("input", () => {
  clearTimeout(productSearchTimer);
  const query = $("productSearch").value.trim();

  if (!query) {
    hideProductSearchResults();
    return;
  }

  productSearchTimer = setTimeout(() => searchProducts(query), 180);
});

$("productSearch").addEventListener("focus", () => {
  const query = $("productSearch").value.trim();
  if (query) searchProducts(query);
});

document.addEventListener("click", (event) => {
  const block = document.querySelector(".product-search-block");
  if (block && !block.contains(event.target)) {
    hideProductSearchResults();
  }
});

async function searchProducts(query) {
  const requestId = ++productSearchRequestId;
  const results = $("productSearchResults");

  results.classList.remove("hidden");
  results.innerHTML = `<div class="search-result-empty">Searching...</div>`;

  // Search both product name and product code.
  // Supabase .or() uses PostgREST filter syntax.
  const safe = query.replaceAll(",", "").replaceAll("%", "");
  const { data, error } = await supabase
    .from("products")
    .select("code, name")
    .or(`name.ilike.%${safe}%,code.ilike.%${safe}%`)
    .order("name", { ascending: true })
    .limit(25);

  if (requestId !== productSearchRequestId) return;

  if (error) {
    results.innerHTML = `<div class="search-result-empty">${escapeHtml(error.message)}</div>`;
    return;
  }

  renderProductSearchResults(data || []);
}

function renderProductSearchResults(products) {
  const results = $("productSearchResults");
  results.innerHTML = "";

  if (!products.length) {
    results.classList.remove("hidden");
    results.innerHTML = `<div class="search-result-empty">No matching products.</div>`;
    return;
  }

  results.classList.remove("hidden");

  for (const product of products) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result-item";

    const alreadyAdded = draft.some((x) => x.code && x.code === product.code);

    button.innerHTML = `
      <div class="search-result-name">${escapeHtml(product.name)}</div>
      <div class="search-result-code">
        ${escapeHtml(product.code)}${alreadyAdded ? " · Already in draft" : ""}
      </div>
    `;

    button.onclick = async () => {
      if (alreadyAdded) {
        showToast("Already in the draft.");
        return;
      }

      draft.push({
        code: product.code,
        name: product.name,
        gap_check_required: false,
      });
      saveDraft();
      renderDraft();

      $("productSearch").value = "";
      hideProductSearchResults();
      showToast(`${product.name} added.`);
    };

    results.appendChild(button);
  }
}

function hideProductSearchResults() {
  $("productSearchResults").classList.add("hidden");
  $("productSearchResults").innerHTML = "";
}

$("clearDraftBtn").onclick = () => {
  draft = [];
  saveDraft();
  renderDraft();
};

$("submitRunBtn").onclick = async () => {
  if (!draft.length) return;

  try {
    $("submitRunBtn").disabled = true;
    $("submitRunBtn").textContent = "Submitting...";

    const items = draft.map((item) =>
      item.manual_name
        ? {
            manual_name: item.manual_name,
            gap_check_required: !!item.gap_check_required,
          }
        : {
            code: item.code,
            gap_check_required: !!item.gap_check_required,
          }
    );

    const { data, error } = await supabase.rpc("submit_mixed_run_list", {
      _items: items,
    });

    if (error) throw error;

    draft = [];
    saveDraft();
    renderDraft();

    showToast(`Run List #${data} submitted.`);

    await refreshRuns();
  } catch (error) {
    showToast(error.message);
  } finally {
    $("submitRunBtn").textContent = "Submit Run List";
    $("submitRunBtn").disabled = draft.length === 0;
  }
};


// ---------- INLINE MANUAL ITEM ----------
$("manualItemForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const name = $("manualItemName").value.trim();
  if (!name) return;

  draft.push({
    manual_name: name,
    name,
    gap_check_required: false,
  });

  saveDraft();
  renderDraft();
  $("manualItemName").value = "";
  showToast(`${name} added to Draft.`);
});

// ---------- CAMERA ----------
$("scanBtn").onclick = startScanner;
$("stopScannerBtn").onclick = stopScanner;
$("barcodeLinkCloseBtn").onclick = closeBarcodeLinkPanel;

$("barcodeLinkSearch").addEventListener("input", () => {
  clearTimeout(barcodeLinkSearchTimer);

  const query = $("barcodeLinkSearch").value.trim();

  if (!query) {
    $("barcodeLinkResults").classList.add("hidden");
    $("barcodeLinkResults").innerHTML = "";
    return;
  }

  barcodeLinkSearchTimer = setTimeout(
    () => searchProductsForBarcodeLink(query),
    180,
  );
});

function setScanStatus(message) {
  const el = $("scanStatus");
  if (el) el.textContent = message;
}

function normalizeScannedBarcode(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  // Most retail barcodes are numeric. Remove visual separators while
  // preserving alphanumeric Code 128 / Code 39 values.
  if (/^[\d\s-]+$/.test(raw)) {
    return raw.replace(/[\s-]+/g, "");
  }

  return raw;
}

function getBarcodeScanner() {
  if (!scanner) scanner = createBarcodeScanner({
    reader: $("reader"), overlay: $("scannerWrap"), status: $("scanStatus"),
    closeButton: $("stopScannerBtn"), scanButton: $("scanBtn"),
    onResult: async (raw) => {
      const value = normalizeScannedBarcode(raw);
      if (value) await handleScannedBarcode(value);
    },
    onError: (error) => {
      console.error("Barcode scanner:", error);
      showToast(error.message || "Barcode scanner failed.", 6000);
    },
  });
  return scanner;
}
function startScanner() {
  closeBarcodeLinkPanel();
  return getBarcodeScanner().start();
}
function stopScanner() { scanner?.stop(); }

async function resolveScannedBarcode(barcode) {
  // Preferred server-side resolver: physical barcode mapping first,
  // while still accepting an existing 6/7 digit GCFR product code.
  const { data, error } = await supabase.rpc(
    "resolve_product_barcode",
    { _barcode: barcode },
  );

  if (!error && Array.isArray(data) && data.length) {
    return data[0];
  }

  // Backward-compatible fallback if the new migration has not landed yet.
  if (error && !/resolve_product_barcode/i.test(error.message || "")) {
    throw error;
  }

  const { data: direct, error: directError } = await supabase
    .from("products")
    .select("code, name")
    .eq("code", barcode)
    .maybeSingle();

  if (directError) throw directError;
  return direct || null;
}

async function handleScannedBarcode(barcode) {
  const product = await resolveScannedBarcode(barcode);

  if (product) {
    await addResolvedProductToDraft(product);
    return;
  }

  showUnknownBarcode(barcode);
}

async function addResolvedProductToDraft(product) {
  if (!product?.code) return;

  if (draft.some((item) => item.code === product.code)) {
    showToast("Already in the draft.");
    return;
  }

  draft.push({
    code: product.code,
    name: product.name,
    gap_check_required: false,
  });

  saveDraft();
  renderDraft();
  showToast(`${product.name} added.`);
}

function showUnknownBarcode(barcode) {
  pendingUnknownBarcode = barcode;

  $("unknownBarcodeValue").textContent = barcode;
  $("barcodeLinkPanel").classList.remove("hidden");

  const isAdmin = currentUser?.id === ADMIN_USER_ID;

  $("barcodeAdminLinkTools").classList.toggle("hidden", !isAdmin);

  $("barcodeLinkMessage").textContent = isAdmin
    ? "Not linked yet. Search the product below and link it once."
    : "Not linked yet. Search the product manually and ask Joey to link this barcode.";

  if (isAdmin) {
    $("barcodeLinkSearch").value = "";
    $("barcodeLinkResults").innerHTML = "";
    $("barcodeLinkResults").classList.add("hidden");
    $("barcodeLinkSearch").focus();
  }

  showToast(`Barcode ${barcode} detected but not linked.`);
}

function closeBarcodeLinkPanel() {
  pendingUnknownBarcode = "";

  if ($("barcodeLinkPanel")) {
    $("barcodeLinkPanel").classList.add("hidden");
  }

  if ($("barcodeLinkSearch")) {
    $("barcodeLinkSearch").value = "";
  }

  if ($("barcodeLinkResults")) {
    $("barcodeLinkResults").innerHTML = "";
    $("barcodeLinkResults").classList.add("hidden");
  }
}

async function searchProductsForBarcodeLink(query) {
  if (!pendingUnknownBarcode || currentUser?.id !== ADMIN_USER_ID) return;

  const safe = query
    .replaceAll("%", "")
    .replaceAll(",", " ")
    .trim();

  if (!safe) return;

  const { data, error } = await supabase
    .from("products")
    .select("code, name")
    .or(`name.ilike.%${safe}%,code.ilike.%${safe}%`)
    .order("name", { ascending: true })
    .limit(20);

  const results = $("barcodeLinkResults");
  results.innerHTML = "";
  results.classList.remove("hidden");

  if (error) {
    results.innerHTML = `<div class="search-result-empty">${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!data?.length) {
    results.innerHTML = '<div class="search-result-empty">No matching products.</div>';
    return;
  }

  for (const product of data) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result-item barcode-link-result";
    button.innerHTML = `
      <div>
        <div class="search-result-name">${escapeHtml(product.name)}</div>
        <div class="search-result-code">${escapeHtml(product.code)}</div>
      </div>
      <strong>Link</strong>
    `;

    button.onclick = async () => {
      await linkPendingBarcodeToProduct(product, button);
    };

    results.appendChild(button);
  }
}

async function linkPendingBarcodeToProduct(product, button) {
  if (!pendingUnknownBarcode || currentUser?.id !== ADMIN_USER_ID) return;

  const barcode = pendingUnknownBarcode;

  button.disabled = true;

  const { error } = await supabase.rpc(
    "admin_link_product_barcode",
    {
      _barcode: barcode,
      _product_code: product.code,
    },
  );

  if (error) {
    button.disabled = false;

    if (/admin_link_product_barcode/i.test(error.message || "")) {
      showToast("Barcode mapping database update has not been applied yet.");
    } else {
      showToast(error.message);
    }

    return;
  }

  closeBarcodeLinkPanel();
  await addResolvedProductToDraft(product);
  showToast(`Barcode linked to ${product.name}. Future scans will add it automatically.`);
}

// ---------- RUNS ----------
$("refreshRunsBtn").onclick = refreshRuns;

async function refreshRuns() {
  if (!currentUser) return;

  const { data: runs, error } = await supabase
    .from("run_lists")
    .select("id, created_at, created_by, status, deleted_at, deleted_by")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    $("runsList").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!runs?.length) {
    $("runsList").innerHTML = `<div class="empty-state">No run lists yet.</div>`;
    return;
  }

  const runIds = runs.map((r) => r.id);
  const { data: items, error: itemsError } = await supabase
    .from("run_items")
    .select("id, run_list_id, product_code, manual_name, note, gap_check_required, status, processing_by, started_at, completed_by, completed_at, deleted_at, deleted_by, products(name)")
    .in("run_list_id", runIds)
    .is("deleted_at", null)
    .order("id", { ascending: true });

  if (itemsError) {
    $("runsList").innerHTML = `<div class="empty-state">${escapeHtml(itemsError.message)}</div>`;
    return;
  }

  const profileIds = [...new Set(
    (items || [])
      .flatMap((i) => [i.processing_by, i.completed_by])
      .filter(Boolean)
  )];

  let nameMap = new Map();
  if (profileIds.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, display_name")
      .in("id", profileIds);
    nameMap = new Map((profiles || []).map((p) => [p.id, p.display_name]));
  }

  const grouped = new Map();
  for (const item of items || []) {
    if (!grouped.has(item.run_list_id)) grouped.set(item.run_list_id, []);
    grouped.get(item.run_list_id).push(item);
  }

  const container = $("runsList");
  container.innerHTML = "";

  for (const run of runs) {
    const card = document.createElement("section");
    card.className = "run-card";

    const head = document.createElement("div");
    head.className = "run-head";

    const headInfo = document.createElement("div");
    headInfo.innerHTML = `
      <strong>Run #${run.id}</strong>
      <div class="item-sub">${formatDateTime(run.created_at)}</div>
    `;

    const headRight = document.createElement("div");
    headRight.className = "run-admin-actions";

    const statusText = document.createElement("span");
    statusText.className = "item-sub";
    statusText.textContent = run.status;
    headRight.appendChild(statusText);

    if (currentUser?.id === ADMIN_USER_ID) {
      const deleteRun = document.createElement("button");
      deleteRun.className = "admin-danger";
      deleteRun.textContent = "Delete Run";
      deleteRun.onclick = async () => {
        if (!confirm(`Delete Run #${run.id}?`)) return;

        const { data, error } = await supabase.rpc("admin_delete_run_list", {
          _run_id: run.id,
        });

        if (error) return showToast(error.message);
        if (!data) return showToast("Run could not be deleted.");

        showToast(`Run #${run.id} moved to History.`);
        await refreshRuns();
        await refreshHistory();
      };
      headRight.appendChild(deleteRun);
    }

    head.append(headInfo, headRight);

    const body = document.createElement("div");
    body.className = "run-items";

    const runItems = grouped.get(run.id) || [];
    if (!runItems.length) {
      body.innerHTML = `<div class="empty-state">No items.</div>`;
    }

    for (const item of runItems) {
      body.appendChild(renderRunItem(item, nameMap));
    }

    card.append(head, body);
    container.appendChild(card);
  }
}

function renderRunItem(item, nameMap) {
  const row = document.createElement("div");
  row.className = "run-item";

  const productName = item.products?.name || item.manual_name || item.product_code || "Manual item";
  const itemSub = item.product_code || "Manual item";
  const worker = item.processing_by ? (nameMap.get(item.processing_by) || "User") : "";
  const completedBy = item.completed_by ? (nameMap.get(item.completed_by) || "User") : "";

  let statusText = "Pending";
  if (item.status === "processing") statusText = `Processing by ${worker}`;
  if (item.status === "done") statusText = `Done${completedBy ? ` by ${completedBy}` : ""}`;
  if (item.status === "out_of_stock") statusText = `Out of stock${completedBy ? ` by ${completedBy}` : ""}`;
  if (item.status === "cancelled") statusText = `Cancelled${completedBy ? ` by ${completedBy}` : ""}`;
  if (item.status === "cancelled") statusText = `Cancelled${completedBy ? ` by ${completedBy}` : ""}`;

  row.innerHTML = `
    <div class="item-title">${escapeHtml(productName)}</div>
    <div class="item-sub">${escapeHtml(itemSub)}</div>
    ${item.manual_name ? '<div class="manual-tag">Manual item</div>' : ''}
    <div class="status-line status-${escapeHtml(item.status)}">${escapeHtml(statusText)}</div>
  `;

  const gapLabel = document.createElement("label");
  gapLabel.className = "gap-check-toggle run-gap-check";
  const gapBox = document.createElement("input");
  gapBox.type = "checkbox";
  gapBox.checked = !!item.gap_check_required;

  const terminal = ["done", "out_of_stock", "cancelled"].includes(item.status);
  gapBox.disabled = terminal;

  gapBox.onchange = async () => {
    const wanted = gapBox.checked;
    gapBox.disabled = true;

    const { data, error } = await supabase.rpc("set_run_item_gap_check", {
      _item_id: item.id,
      _required: wanted,
    });

    if (error || !data) {
      gapBox.checked = !wanted;
      showToast(error?.message || "Gap Check flag could not be updated.");
    } else {
      showToast(wanted ? "Gap Check required." : "Gap Check flag removed.");
    }

    gapBox.disabled = terminal;
  };

  const gapText = document.createElement("span");
  gapText.textContent = item.gap_check_required ? "Gap Check required" : "Gap Check";
  gapLabel.append(gapBox, gapText);
  row.appendChild(gapLabel);

  const actions = document.createElement("div");
  actions.className = "action-row";

  if (item.status === "pending") {
    const start = document.createElement("button");
    start.textContent = "Start";
    start.onclick = async () => {
      const { data, error } = await supabase.rpc("claim_run_item", { _item_id: item.id });
      if (error) return showToast(error.message);
      if (!data) showToast("Someone else already started this item.");
      await refreshRuns();
    };
    actions.appendChild(start);
  }

  if (item.status === "processing" && item.processing_by === currentUser.id) {
    const done = document.createElement("button");
    done.className = "done";
    done.textContent = "Done";
    done.onclick = () => finishItem(item.id, "done");

    const oos = document.createElement("button");
    oos.className = "oos";
    oos.textContent = "Out of stock";
    oos.onclick = () => finishItem(item.id, "out_of_stock");

    const pending = document.createElement("button");
    pending.textContent = "Return to Pending";
    pending.onclick = async () => {
      const { data, error } = await supabase.rpc("release_run_item", {
        _item_id: item.id,
      });

      if (error) return showToast(error.message);
      if (!data) return showToast("Item could not be returned to Pending.");

      showToast("Returned to Pending.");
      await refreshRuns();
    };

    const cancel = document.createElement("button");
    cancel.className = "cancel-action";
    cancel.textContent = "Cancel";
    cancel.onclick = async () => {
      if (!confirm(`Cancel ${productName}?`)) return;

      const { data, error } = await supabase.rpc("cancel_run_item", {
        _item_id: item.id,
      });

      if (error) return showToast(error.message);
      if (!data) return showToast("Item could not be cancelled.");

      showToast("Item cancelled.");
      await refreshRuns();
      await refreshHistory();
    };

    actions.append(done, oos, pending, cancel);
  }

  if (currentUser?.id === ADMIN_USER_ID) {
    if (item.status !== "pending") {
      const reset = document.createElement("button");
      reset.className = "admin-reset";
      reset.textContent = "Reset";
      reset.onclick = async () => {
        const { data, error } = await supabase.rpc("admin_reset_run_item", {
          _item_id: item.id,
        });
        if (error) return showToast(error.message);
        if (!data) return showToast("Item could not be reset.");
        showToast("Item reset to Pending.");
        await refreshRuns();
      };
      actions.appendChild(reset);
    }

    const del = document.createElement("button");
    del.className = "admin-danger";
    del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete ${productName}?`)) return;

      const { data, error } = await supabase.rpc("admin_delete_run_item", {
        _item_id: item.id,
      });
      if (error) return showToast(error.message);
      if (!data) return showToast("Item could not be deleted.");

      showToast("Run item moved to History.");
      await refreshRuns();
      await refreshHistory();
    };
    actions.appendChild(del);
  }

  if (actions.children.length) row.appendChild(actions);
  return row;
}

async function finishItem(id, status) {
  const { data, error } = await supabase.rpc("finish_run_item", {
    _item_id: id,
    _new_status: status,
  });

  if (error) return showToast(error.message);
  if (!data) {
    showToast("This item could not be updated.");
    return;
  }

  await refreshRuns();
}


// ---------- RUN HISTORY ----------
let historyFilter = "all";

$("refreshHistoryBtn").onclick = refreshHistory;

document.querySelectorAll(".history-filter").forEach((button) => {
  button.addEventListener("click", async () => {
    historyFilter = button.dataset.historyFilter || "all";
    document.querySelectorAll(".history-filter").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    await refreshHistory();
  });
});

async function refreshHistory() {
  if (!currentUser) return;

  const container = $("historyList");
  if (!container) return;
  container.innerHTML = `<div class="empty-state">Loading...</div>`;

  const { data: runs, error } = await supabase
    .from("run_lists")
    .select("id, created_at, created_by, status, deleted_at, deleted_by")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!runs?.length) {
    container.innerHTML = `<div class="empty-state">No run history yet.</div>`;
    return;
  }

  const runIds = runs.map((r) => r.id);
  const { data: items, error: itemsError } = await supabase
    .from("run_items")
    .select("id, run_list_id, product_code, manual_name, note, gap_check_required, status, processing_by, started_at, completed_by, completed_at, deleted_at, deleted_by, products(name)")
    .in("run_list_id", runIds)
    .order("id", { ascending: true });

  if (itemsError) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(itemsError.message)}</div>`;
    return;
  }

  const profileIds = [...new Set(
    (items || [])
      .flatMap((i) => [i.processing_by, i.completed_by, i.deleted_by])
      .concat((runs || []).flatMap((r) => [r.deleted_by]))
      .filter(Boolean)
  )];

  let nameMap = new Map();
  if (profileIds.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, display_name")
      .in("id", profileIds);
    nameMap = new Map((profiles || []).map((p) => [p.id, p.display_name]));
  }

  const grouped = new Map();
  for (const item of items || []) {
    if (!grouped.has(item.run_list_id)) grouped.set(item.run_list_id, []);
    grouped.get(item.run_list_id).push(item);
  }

  let historyRuns = runs.filter((run) => {
    const runItems = grouped.get(run.id) || [];
    const hasDeletedItem = runItems.some((item) => item.deleted_at);
    return run.status === "completed" || !!run.deleted_at || hasDeletedItem;
  });

  if (historyFilter === "completed") {
    historyRuns = historyRuns.filter((run) => run.status === "completed" && !run.deleted_at);
  }

  if (historyFilter === "deleted") {
    historyRuns = historyRuns.filter((run) => {
      const runItems = grouped.get(run.id) || [];
      return !!run.deleted_at || runItems.some((item) => item.deleted_at);
    });
  }

  container.innerHTML = "";

  if (!historyRuns.length) {
    container.innerHTML = `<div class="empty-state">No matching history.</div>`;
    return;
  }

  for (const run of historyRuns) {
    const runItems = grouped.get(run.id) || [];
    const card = document.createElement("section");
    card.className = `run-card ${run.deleted_at ? "deleted-card" : ""}`;

    const head = document.createElement("div");
    head.className = "run-head";

    const headInfo = document.createElement("div");
    headInfo.innerHTML = `
      <strong>Run #${run.id}</strong>
      <div class="item-sub">${formatDateTime(run.created_at)}</div>
      ${run.deleted_at ? '<span class="deleted-label">Deleted</span>' : ''}
    `;

    const headActions = document.createElement("div");
    headActions.className = "run-admin-actions";

    const status = document.createElement("span");
    status.className = "item-sub";
    status.textContent = run.status;
    headActions.appendChild(status);

    if (currentUser?.id === ADMIN_USER_ID) {
      if (run.deleted_at) {
        const restoreRun = document.createElement("button");
        restoreRun.className = "admin-reset";
        restoreRun.textContent = "Restore Run";
        restoreRun.onclick = async () => {
          const { data, error } = await supabase.rpc("admin_restore_run_list", {
            _run_id: run.id,
          });
          if (error) return showToast(error.message);
          if (!data) return showToast("Run could not be restored.");
          showToast(`Run #${run.id} restored.`);
          await refreshRuns();
          await refreshHistory();
        };
        headActions.appendChild(restoreRun);
      }

      const purgeRun = document.createElement("button");
      purgeRun.className = "admin-danger";
      purgeRun.textContent = "Delete History";
      purgeRun.onclick = async () => {
        if (!confirm(`Permanently delete Run #${run.id} from History? This cannot be restored.`)) return;

        const { data, error } = await supabase.rpc("admin_purge_run_list", {
          _run_id: run.id,
        });

        if (error) return showToast(error.message);
        if (!data) return showToast("History could not be deleted.");

        showToast(`Run #${run.id} history deleted.`);
        await refreshRuns();
        await refreshHistory();
      };
      headActions.appendChild(purgeRun);
    }

    head.append(headInfo, headActions);

    const body = document.createElement("div");
    body.className = "run-items";

    if (!runItems.length) {
      body.innerHTML = `<div class="empty-state">No items.</div>`;
    }

    for (const item of runItems) {
      body.appendChild(renderHistoryItem(item, nameMap, run));
    }

    card.append(head, body);
    container.appendChild(card);
  }
}

function renderHistoryItem(item, nameMap, run) {
  const row = document.createElement("div");
  row.className = `run-item ${item.deleted_at ? "deleted-item" : ""}`;

  const productName = item.products?.name || item.manual_name || item.product_code || "Manual item";
  const itemSub = item.product_code || "Manual item";
  const worker = item.processing_by ? (nameMap.get(item.processing_by) || "User") : "";
  const completedBy = item.completed_by ? (nameMap.get(item.completed_by) || "User") : "";

  let statusText = "Pending";
  if (item.status === "processing") statusText = `Processing by ${worker}`;
  if (item.status === "done") statusText = `Done${completedBy ? ` by ${completedBy}` : ""}`;
  if (item.status === "out_of_stock") statusText = `Out of stock${completedBy ? ` by ${completedBy}` : ""}`;

  row.innerHTML = `
    <div class="item-title">${escapeHtml(productName)}</div>
    <div class="item-sub">${escapeHtml(itemSub)}</div>
    ${item.manual_name ? '<div class="manual-tag">Manual item</div>' : ''}
    ${item.gap_check_required ? '<div class="gap-check-badge">Gap Check required</div>' : ''}
    ${item.deleted_at ? '<span class="deleted-label">Deleted item</span>' : ''}
    <div class="status-line status-${escapeHtml(item.status)}">${escapeHtml(statusText)}</div>
  `;

  if (currentUser?.id === ADMIN_USER_ID) {
    const actions = document.createElement("div");
    actions.className = "action-row";

    if (item.deleted_at) {
      const restore = document.createElement("button");
      restore.className = "admin-reset";
      restore.textContent = "Restore";
      restore.onclick = async () => {
        const { data, error } = await supabase.rpc("admin_restore_run_item", {
          _item_id: item.id,
        });
        if (error) return showToast(error.message);
        if (!data) return showToast("Item could not be restored.");
        showToast("Item restored.");
        await refreshRuns();
        await refreshHistory();
      };
      actions.appendChild(restore);
    }

    const purge = document.createElement("button");
    purge.className = "admin-danger";
    purge.textContent = "Delete History";
    purge.onclick = async () => {
      if (!confirm(`Permanently delete "${productName}" from History? This cannot be restored.`)) return;

      const { data, error } = await supabase.rpc("admin_purge_run_item", {
        _item_id: item.id,
      });

      if (error) return showToast(error.message);
      if (!data) return showToast("History item could not be deleted.");

      showToast("History item deleted.");
      await refreshHistory();
    };
    actions.appendChild(purge);

    row.appendChild(actions);
  }

  return row;
}


// ---------- CHECKLIST ----------
const QUICK_CHECKLIST_TEMPLATES = [
  "Quality Check",
  "Waste",
  "Gap Check",
  "Old Stock Running",
  "Stock Running",
  "Markdown",
  "First In First Out (FIFO)",
];

const CHECKLIST_PERIODS = [
  { key: "morning", label: "Morning" },
  { key: "afternoon", label: "Afternoon" },
  { key: "evening", label: "Evening" },
];

let editRequestSelection = null;
let checklistBulkDeleteMode = false;
let checklistBulkDeleteIds = new Set();
let checklistTaskCount = 0;
let checklistScrollHold = null;
let checklistScrollHoldTimer = null;


function resetChecklistBulkDelete() {
  checklistBulkDeleteMode = false;
  checklistBulkDeleteIds.clear();
  updateChecklistBulkDeleteControls();
}

function updateChecklistBulkDeleteControls() {
  const tools = $("checklistDeleteTools");
  const start = $("checklistBulkDeleteStartBtn");
  const actions = $("checklistBulkDeleteActions");
  const count = $("checklistBulkDeleteCount");
  const confirmBtn = $("checklistBulkDeleteConfirmBtn");
  if (!tools || !start || !actions || !count || !confirmBtn) return;

  const isAdmin = currentUser?.id === ADMIN_USER_ID;
  const hasTasks = checklistTaskCount > 0;
  const showTools = isAdmin && hasTasks;

  tools.classList.toggle("hidden", !showTools);

  if (!showTools) {
    start.classList.add("hidden");
    actions.classList.add("hidden");
    confirmBtn.disabled = true;
    count.textContent = "0 selected";
    return;
  }

  start.classList.toggle("hidden", checklistBulkDeleteMode);
  actions.classList.toggle("hidden", !checklistBulkDeleteMode);
  count.textContent = `${checklistBulkDeleteIds.size} selected`;
  confirmBtn.disabled = checklistBulkDeleteIds.size === 0;
}

function holdChecklistScroll(ms = 2200) {
  const position = {
    x: window.scrollX,
    y: window.scrollY,
  };

  checklistScrollHold = position;
  clearTimeout(checklistScrollHoldTimer);
  checklistScrollHoldTimer = setTimeout(() => {
    checklistScrollHold = null;
    checklistScrollHoldTimer = null;
  }, ms);

  return position;
}

async function refreshChecklistPreservingScroll(position = null) {
  const saved = position || checklistScrollHold || {
    x: window.scrollX,
    y: window.scrollY,
  };

  await refreshChecklist();

  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  window.scrollTo(saved.x, saved.y);
}

$("checklistBulkDeleteStartBtn").onclick = async () => {
  const scrollPosition = holdChecklistScroll();
  checklistBulkDeleteMode = true;
  checklistBulkDeleteIds.clear();
  updateChecklistBulkDeleteControls();
  await refreshChecklistPreservingScroll(scrollPosition);
};

$("checklistBulkDeleteCancelBtn").onclick = async () => {
  const scrollPosition = holdChecklistScroll();
  resetChecklistBulkDelete();
  await refreshChecklistPreservingScroll(scrollPosition);
};

$("checklistBulkDeleteConfirmBtn").onclick = async () => {
  if (currentUser?.id !== ADMIN_USER_ID || !checklistBulkDeleteIds.size) return;

  const scrollPosition = holdChecklistScroll(5000);
  const ids = [...checklistBulkDeleteIds];
  if (!confirm(`Delete ${ids.length} selected checklist item${ids.length === 1 ? "" : "s"}?`)) return;

  $("checklistBulkDeleteConfirmBtn").disabled = true;

  let deletedCount = 0;
  for (const taskId of ids) {
    const { data: deleted, error } = await supabase.rpc(
      "delete_checklist_task",
      { _task_id: taskId },
    );

    if (error) {
      showToast(error.message);
      updateChecklistBulkDeleteControls();
      return;
    }

    if (deleted) deletedCount += 1;
  }

  resetChecklistBulkDelete();
  showToast(`${deletedCount} checklist item${deletedCount === 1 ? "" : "s"} deleted.`);
  await refreshChecklistPreservingScroll(scrollPosition);
};

function syncChecklistDateControls() {
  const picker = $("checklistDatePicker");
  const display = $("checklistDateDisplay");

  if (picker) picker.value = selectedChecklistDate;
  if (display) {
    display.textContent = new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(dateFromLocalString(selectedChecklistDate));
  }
}

syncChecklistDateControls();

$("checklistDatePicker").addEventListener("change", async () => {
  const value = $("checklistDatePicker").value;
  if (!value) return;
  selectedChecklistDate = value;
  editRequestSelection = null;
  resetChecklistBulkDelete();
  syncChecklistDateControls();
  await refreshChecklist();
});

$("checklistPrevDayBtn").onclick = async () => {
  selectedChecklistDate = shiftDate(selectedChecklistDate, -1);
  editRequestSelection = null;
  resetChecklistBulkDelete();
  syncChecklistDateControls();
  await refreshChecklist();
};

$("checklistNextDayBtn").onclick = async () => {
  selectedChecklistDate = shiftDate(selectedChecklistDate, 1);
  editRequestSelection = null;
  resetChecklistBulkDelete();
  syncChecklistDateControls();
  await refreshChecklist();
};

$("checklistTodayBtn").onclick = async () => {
  selectedChecklistDate = localDateString(new Date());
  editRequestSelection = null;
  resetChecklistBulkDelete();
  syncChecklistDateControls();
  await refreshChecklist();
};

function renderQuickTemplates() {
  const box = $("quickTemplateList");
  box.innerHTML = "";

  for (const title of QUICK_CHECKLIST_TEMPLATES) {
    const row = document.createElement("div");
    row.className = "quick-template-row";

    const name = document.createElement("div");
    name.className = "quick-template-name";
    name.textContent = title;
    row.appendChild(name);

    for (const period of CHECKLIST_PERIODS) {
      const cell = document.createElement("label");
      cell.className = "quick-template-cell";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.title = title;
      checkbox.dataset.period = period.key;
      checkbox.setAttribute(
        "aria-label",
        `${title} - ${period.label}`
      );

      cell.appendChild(checkbox);
      row.appendChild(cell);
    }

    box.appendChild(row);
  }
}

renderQuickTemplates();

$("openQuickAddBtn").onclick = () => {
  $("quickAddPanel").classList.remove("hidden");
};

$("quickAddCancelBtn").onclick = () => {
  $("quickAddPanel").classList.add("hidden");
  $("quickTemplateList")
    .querySelectorAll('input[type="checkbox"]')
    .forEach((el) => (el.checked = false));
};

$("quickAddSelectedBtn").onclick = async () => {
  if (!currentUser) return;

  if (currentUser.id !== ADMIN_USER_ID) {
    showToast("Only Joey Jo can add checklist items.");
    return;
  }

  const selected = [
    ...$("quickTemplateList").querySelectorAll('input[type="checkbox"]:checked')
  ];

  if (!selected.length) {
    showToast("Select at least one checklist item.");
    return;
  }

  const rows = selected.map((checkbox) => ({
    task_date: selectedChecklistDate,
    title: checkbox.dataset.title,
    time_period: checkbox.dataset.period,
    created_by: currentUser.id,
  }));

  const { error } = await supabase
    .from("checklist_tasks")
    .insert(rows);

  if (error) {
    showToast(error.message);
    return;
  }

  $("quickTemplateList")
    .querySelectorAll('input[type="checkbox"]')
    .forEach((el) => (el.checked = false));

  $("quickAddPanel").classList.add("hidden");

  const morningCount = rows.filter((row) => row.time_period === "morning").length;
  const afternoonCount = rows.filter((row) => row.time_period === "afternoon").length;
  const eveningCount = rows.filter((row) => row.time_period === "evening").length;

  showToast(
    `${rows.length} added — Morning ${morningCount}, Afternoon ${afternoonCount}, Evening ${eveningCount}.`
  );

  await refreshChecklist();
};

$("addTaskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) return;

  if (currentUser.id !== ADMIN_USER_ID) {
    showToast("Only Joey Jo can add checklist items.");
    return;
  }

  const title = $("newTaskTitle").value.trim();
  const period = $("manualTaskPeriod").value;

  if (!title) return;

  const { error } = await supabase.from("checklist_tasks").insert({
    task_date: selectedChecklistDate,
    title,
    time_period: period,
    created_by: currentUser.id,
  });

  if (error) {
    showToast(error.message);
    return;
  }

  $("newTaskTitle").value = "";

  showToast(`${title} added to ${periodLabel(period)}.`);

  await refreshChecklist();
});

async function refreshChecklist() {
  if (!currentUser) return;

  checklistTaskCount = 0;
  updateChecklistBulkDeleteControls();
  syncChecklistDateControls();

  const canAddChecklistItems = currentUser.id === ADMIN_USER_ID;
  $("openQuickAddBtn").classList.toggle("hidden", !canAddChecklistItems);
  $("manualAddCard").classList.toggle("hidden", !canAddChecklistItems);

  if (!canAddChecklistItems) {
    $("quickAddPanel").classList.add("hidden");
  }

  const today = localDateString(new Date());
  const tomorrow = shiftDate(today, 1);
  const yesterday = shiftDate(today, -1);

  let relative = "";
  if (selectedChecklistDate === today) relative = "Today";
  else if (selectedChecklistDate === tomorrow) relative = "Tomorrow";
  else if (selectedChecklistDate === yesterday) relative = "Yesterday";

  const formatted = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(dateFromLocalString(selectedChecklistDate));

  $("checklistDateLabel").innerHTML = relative
    ? `${escapeHtml(formatted)} <span class="checklist-day-badge">${escapeHtml(relative)}</span>`
    : escapeHtml(formatted);

  const { data, error } = await supabase
    .from("checklist_tasks")
    .select("id, task_date, title, note, status, time_period, created_by, completed_by, completed_at, carried_from, carried_from_date, carried_from_period, carried_to, carried_to_period, completion_request_status, completion_requested_by, completion_requested_at, completion_request_resolved_by, completion_request_resolved_at, created_at")
    .eq("task_date", selectedChecklistDate)
    .order("created_at", { ascending: true });

  const container = $("checklistSections");
  container.innerHTML = "";

  if (error) {
    checklistTaskCount = 0;
    updateChecklistBulkDeleteControls();
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  checklistTaskCount = (data || []).length;
  if (checklistTaskCount === 0 && checklistBulkDeleteMode) {
    checklistBulkDeleteMode = false;
    checklistBulkDeleteIds.clear();
  }
  updateChecklistBulkDeleteControls();

  const { data: closures, error: closuresError } = await supabase
    .from("checklist_shift_closures")
    .select("shift_date, time_period, status, finished_by, finished_at, edit_requested_by, edit_requested_at, edit_resolved_by, edit_resolved_at, edit_task_ids")
    .eq("shift_date", selectedChecklistDate);

  if (closuresError) {
    showToast(closuresError.message);
  }

  const closureByPeriod = new Map(
    (closures || []).map((closure) => [closure.time_period, closure])
  );

  const taskIds = (data || []).map((task) => task.id);
  const commentsByTask = new Map();
  let commentAuthorNames = new Map();

  if (taskIds.length) {
    const { data: comments, error: commentsError } = await supabase
      .from("checklist_comments")
      .select("id, task_id, author_id, body, created_at, updated_at")
      .in("task_id", taskIds)
      .order("created_at", { ascending: true });

    if (commentsError) {
      showToast(commentsError.message);
    } else {
      for (const comment of comments || []) {
        if (!commentsByTask.has(comment.task_id)) {
          commentsByTask.set(comment.task_id, []);
        }
        commentsByTask.get(comment.task_id).push(comment);
      }

      const authorIds = [
        ...new Set((comments || []).map((comment) => comment.author_id).filter(Boolean))
      ];

      if (authorIds.length) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", authorIds);

        commentAuthorNames = new Map(
          (profiles || []).map((profile) => [profile.id, profile.display_name])
        );
      }
    }
  }

  const grouped = new Map(CHECKLIST_PERIODS.map((p) => [p.key, []]));
  for (const task of data || []) {
    const period = grouped.has(task.time_period) ? task.time_period : "morning";
    grouped.get(period).push(task);
  }

  for (const period of CHECKLIST_PERIODS) {
    const tasks = grouped.get(period.key) || [];

    const section = document.createElement("section");
    section.className = "checklist-period-section";

    const head = document.createElement("div");
    head.className = "checklist-period-header";

    const headTitle = document.createElement("div");
    headTitle.className = "checklist-period-heading";
    headTitle.innerHTML = `
      <h3 class="checklist-period-title">${escapeHtml(period.label)}</h3>
      <span class="checklist-period-count">${tasks.length}</span>
    `;

    const pendingCount = tasks.filter((task) => task.status === "pending").length;
    const doneCount = tasks.filter((task) => task.status === "done").length;
    const closure = closureByPeriod.get(period.key) || null;

    const shiftActions = document.createElement("div");
    shiftActions.className = "shift-action-group";

    if (!closure) {
      const finishShift = document.createElement("button");
      finishShift.type = "button";
      finishShift.className = "next-shift-btn";
      finishShift.textContent = `Finish ${period.label}`;
      finishShift.disabled = (pendingCount + doneCount) === 0;

      finishShift.onclick = async () => {
        await finishChecklistShift(period.key, finishShift);
      };

      shiftActions.appendChild(finishShift);
    }

    if (closure?.status === "closed") {
      const finished = document.createElement("span");
      finished.className = "shift-status-badge closed";
      finished.textContent = "Finished";

      const requestEdit = document.createElement("button");
      requestEdit.type = "button";
      requestEdit.className = "request-edit-btn";
      requestEdit.textContent = "Request Correction";
      requestEdit.onclick = () => {
        beginShiftCorrectionSelection(period.key);
      };

      shiftActions.append(finished, requestEdit);

      if (
        editRequestSelection
        && editRequestSelection.date === selectedChecklistDate
        && editRequestSelection.period === period.key
      ) {
        const selectionCount = document.createElement("span");
        selectionCount.className = "edit-selection-count";
        selectionCount.textContent = `${editRequestSelection.ids.size} selected`;

        const submitEdit = document.createElement("button");
        submitEdit.type = "button";
        submitEdit.className = "approve-request-btn";
        submitEdit.textContent = "Submit Request";
        submitEdit.disabled = editRequestSelection.ids.size === 0;
        submitEdit.onclick = async () => {
          await submitShiftCorrectionRequest(period.key);
        };

        const cancelSelection = document.createElement("button");
        cancelSelection.type = "button";
        cancelSelection.className = "cancel-request-btn";
        cancelSelection.textContent = "Cancel";
        cancelSelection.onclick = async () => {
          editRequestSelection = null;
          await refreshChecklist();
        };

        shiftActions.append(selectionCount, submitEdit, cancelSelection);
      }
    }

    if (closure?.status === "edit_requested") {
      const requested = document.createElement("span");
      requested.className = "shift-status-badge requested";
      const requestedCount = Array.isArray(closure.edit_task_ids)
        ? closure.edit_task_ids.length
        : 0;
      requested.textContent = `Correction requested • ${requestedCount} item${requestedCount === 1 ? "" : "s"}`;
      shiftActions.appendChild(requested);

      if (
        closure.edit_requested_by === currentUser?.id
        || currentUser?.id === ADMIN_USER_ID
      ) {
        const cancelEdit = document.createElement("button");
        cancelEdit.type = "button";
        cancelEdit.className = "cancel-request-btn";
        cancelEdit.textContent = "Cancel Request";
        cancelEdit.onclick = async () => {
          await cancelShiftEditRequest(period.key);
        };
        shiftActions.appendChild(cancelEdit);
      }

      if (currentUser?.id === ADMIN_USER_ID) {
        const approveEdit = document.createElement("button");
        approveEdit.type = "button";
        approveEdit.className = "approve-request-btn";
        approveEdit.textContent = "Approve Request";
        approveEdit.onclick = async () => {
          await resolveShiftEditRequest(period.key, true);
        };

        const rejectEdit = document.createElement("button");
        rejectEdit.type = "button";
        rejectEdit.className = "reject-request-btn";
        rejectEdit.textContent = "Reject";
        rejectEdit.onclick = async () => {
          await resolveShiftEditRequest(period.key, false);
        };

        shiftActions.append(approveEdit, rejectEdit);
      }
    }

    head.append(headTitle, shiftActions);

    const list = document.createElement("div");
    list.className = "checklist-period-list";

    if (!tasks.length) {
      list.innerHTML = `<div class="empty-state">No ${escapeHtml(period.label.toLowerCase())} tasks.</div>`;
    } else {
      for (const task of tasks) {
        list.appendChild(renderChecklistTask(task, commentsByTask.get(task.id) || [], commentAuthorNames, closure));
      }
    }

    section.append(head, list);
    container.appendChild(section);
  }
}

function renderChecklistTask(task, comments = [], commentAuthorNames = new Map(), closure = null) {
  const isCarriedOut = task.status === "carried";
  const requestedIds = Array.isArray(closure?.edit_task_ids)
    ? closure.edit_task_ids.map((id) => String(id))
    : [];
  const taskIdKey = String(task.id);
  const isRequestedItem = closure?.status === "edit_requested" && requestedIds.includes(taskIdKey);
  const isSelectingForEdit = !!(
    editRequestSelection
    && editRequestSelection.date === selectedChecklistDate
    && editRequestSelection.period === task.time_period
  );

  const correctionSelected = isSelectingForEdit && editRequestSelection.ids.has(task.id);

  // Correction mode keeps the REAL checklist checkbox semantics:
  // Done    = checked. Uncheck it to request moving it forward.
  // Carried = unchecked. Check it to request cancelling the carry.
  const previewDone = isSelectingForEdit
    ? (
        task.status === "done"
          ? !correctionSelected
          : (task.status === "carried" ? correctionSelected : task.status === "done")
      )
    : task.status === "done";

  const previewCarried = isSelectingForEdit
    ? (task.status === "carried" && !correctionSelected)
    : isCarriedOut;

  const row = document.createElement("div");
  row.className = `list-row check-row ${previewDone ? "done" : ""} ${previewCarried ? "carried-row" : ""} ${isRequestedItem ? "edit-request-item" : ""}`;

  let stateControl;

  if (isSelectingForEdit && (task.status === "done" || task.status === "carried")) {
    const correctionBox = document.createElement("input");
    correctionBox.type = "checkbox";
    correctionBox.className = "checklist-correction-checkbox";
    correctionBox.checked = previewDone;
    correctionBox.disabled = checklistBulkDeleteMode;

    if (task.status === "done") {
      correctionBox.title = "Uncheck to request moving this item to the next shift";
    } else {
      correctionBox.title = "Check to request cancelling the carry-over and restoring Done";
    }

    correctionBox.onchange = async () => {
      const scrollPosition = holdChecklistScroll();
      correctionBox.blur();

      if (task.status === "done") {
        // Done -> unchecked means this is the requested correction.
        if (!correctionBox.checked) {
          editRequestSelection.ids.add(task.id);
        } else {
          editRequestSelection.ids.delete(task.id);
        }
      } else {
        // Carried -> checked means cancel the carry and restore Done.
        if (correctionBox.checked) {
          editRequestSelection.ids.add(task.id);
        } else {
          editRequestSelection.ids.delete(task.id);
        }
      }

      await refreshChecklistPreservingScroll(scrollPosition);
    };

    stateControl = correctionBox;
  } else if (isSelectingForEdit) {
    const lockedBox = document.createElement("input");
    lockedBox.type = "checkbox";
    lockedBox.checked = task.status === "done";
    lockedBox.disabled = true;
    stateControl = lockedBox;
  } else if (isCarriedOut) {
    stateControl = document.createElement("div");
    stateControl.className = "carried-x";
    stateControl.textContent = "×";
    stateControl.title = "Unfinished item moved to the next shift";
  } else {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.status === "done";

    const shiftLocked =
      closure?.status === "closed"
      || closure?.status === "edit_requested"
      || closure?.status === "edit_open";

    checkbox.disabled = shiftLocked || checklistBulkDeleteMode;

    checkbox.onchange = async () => {
      const scrollPosition = holdChecklistScroll();
      checkbox.blur();

      const done = checkbox.checked;

      const { data: changed, error: updateError } = await supabase.rpc(
        "set_checklist_task_done",
        {
          _task_id: task.id,
          _done: done,
        },
      );

      if (updateError || !changed) {
        showToast(updateError?.message || "Checklist item could not be changed.");
        checkbox.checked = !done;
        return;
      }

      await refreshChecklistPreservingScroll(scrollPosition);
    };

    stateControl = checkbox;
  }

  const text = document.createElement("div");

  let extra = "";
  if (isCarriedOut) {
    const targetDate = task.carried_to || task.task_date;
    const targetPeriod = task.carried_to_period || nextChecklistPeriod(task.time_period).period;
    extra = `<div class="carried-next-label">Moved to ${escapeHtml(periodLabel(targetPeriod))} • ${escapeHtml(formatChecklistDate(targetDate))}</div>`;
  } else if (task.carried_from || task.carried_from_date) {
    const sourceDate = task.carried_from_date || task.task_date;
    const sourcePeriod = task.carried_from_period || previousChecklistPeriod(task.time_period);
    extra = `<div class="carried-from-label">Carried from ${escapeHtml(periodLabel(sourcePeriod))} • ${escapeHtml(formatChecklistDate(sourceDate))}</div>`;
  }

  let editMarker = "";

  if (isRequestedItem) {
    if (task.status === "done") {
      const target = nextChecklistPeriod(task.time_period);
      const targetDate = target.nextDay ? shiftDate(task.task_date, 1) : task.task_date;
      editMarker = `<div class="edit-request-item-label">Requested: move to ${escapeHtml(periodLabel(target.period))} • ${escapeHtml(formatChecklistDate(targetDate))}</div>`;
    } else if (task.status === "carried") {
      editMarker = '<div class="edit-request-item-label cancel-carry">Requested: cancel carry-over and restore as Done</div>';
    }
  }

  const selectionHelp = isSelectingForEdit
    ? (
        task.status === "done"
          ? (
              correctionSelected
                ? '<div class="move-request-selectable">Unchecked → will request move to next shift</div>'
                : '<div class="move-request-selectable">Uncheck this completed item to move it to the next shift</div>'
            )
          : (
              task.status === "carried"
                ? (
                    correctionSelected
                      ? '<div class="cancel-carry-selectable">Checked → will request cancel carry-over and restore Done</div>'
                      : '<div class="cancel-carry-selectable">Check this item to cancel the carry-over and restore Done</div>'
                  )
                : '<div class="move-request-unavailable">This item cannot be corrected</div>'
            )
      )
    : '';

  text.innerHTML = `
    <div class="item-title">${escapeHtml(task.title)}</div>
    ${extra}
    ${editMarker}
    ${selectionHelp}
  `;

  row.append(stateControl, text);

  if (currentUser?.id === ADMIN_USER_ID && checklistBulkDeleteMode) {
    const bulkLabel = document.createElement("label");
    bulkLabel.className = "checklist-bulk-select";

    const bulkBox = document.createElement("input");
    bulkBox.type = "checkbox";
    bulkBox.checked = checklistBulkDeleteIds.has(task.id);
    bulkBox.setAttribute("aria-label", `Select ${task.title} for deletion`);

    bulkBox.onchange = () => {
      if (bulkBox.checked) checklistBulkDeleteIds.add(task.id);
      else checklistBulkDeleteIds.delete(task.id);
      row.classList.toggle("bulk-delete-selected", bulkBox.checked);
      updateChecklistBulkDeleteControls();
    };

    const bulkText = document.createElement("span");
    bulkText.textContent = "Select";
    bulkLabel.append(bulkBox, bulkText);
    row.classList.toggle("bulk-delete-selected", bulkBox.checked);
    row.appendChild(bulkLabel);
  }

  // Daily Checklist removal is Joey Jo only.
  if (currentUser?.id === ADMIN_USER_ID && !checklistBulkDeleteMode) {
    const del = document.createElement("button");
    del.className = "checklist-delete-btn";
    del.type = "button";
    del.textContent = "Delete";

    del.onclick = async () => {
      if (!confirm(`Delete "${task.title}" from this checklist?`)) return;

      const scrollPosition = holdChecklistScroll();
      del.blur();

      const { data: deleted, error: deleteError } = await supabase.rpc(
        "delete_checklist_task",
        { _task_id: task.id },
      );

      if (deleteError) {
        showToast(deleteError.message);
        return;
      }

      if (!deleted) {
        showToast("Checklist item could not be deleted.");
        return;
      }

      showToast("Checklist item deleted.");
      await refreshChecklistPreservingScroll(scrollPosition);
    };

    row.appendChild(del);
  }


  const commentsSection = document.createElement("div");
  commentsSection.className = "checklist-comments";

  const commentsTitle = document.createElement("div");
  commentsTitle.className = "checklist-comments-title";
  commentsTitle.textContent = `Comments (${comments.length})`;
  commentsSection.appendChild(commentsTitle);

  const thread = document.createElement("div");
  thread.className = "checklist-comment-thread";

  if (!comments.length) {
    const empty = document.createElement("div");
    empty.className = "checklist-comment-empty";
    empty.textContent = "No comments yet.";
    thread.appendChild(empty);
  } else {
    for (const comment of comments) {
      const commentRow = document.createElement("div");
      commentRow.className = "checklist-comment";

      const author = commentAuthorNames.get(comment.author_id) || "Team member";

      const meta = document.createElement("div");
      meta.className = "checklist-comment-meta";

      const authorName = document.createElement("strong");
      authorName.textContent = author;

      const metaRight = document.createElement("div");
      metaRight.className = "checklist-comment-meta-right";

      const time = document.createElement("span");
      time.textContent = formatDateTime(comment.updated_at || comment.created_at);

      metaRight.appendChild(time);

      if (comment.updated_at) {
        const edited = document.createElement("span");
        edited.className = "comment-edited-label";
        edited.textContent = "Edited";
        metaRight.appendChild(edited);
      }

      meta.append(authorName, metaRight);

      const body = document.createElement("div");
      body.className = "checklist-comment-body";
      body.textContent = comment.body;

      commentRow.append(meta, body);

      const isOwnComment = comment.author_id === currentUser?.id;
      const canDeleteComment =
        isOwnComment || currentUser?.id === ADMIN_USER_ID;

      if (isOwnComment || canDeleteComment) {
        const actions = document.createElement("div");
        actions.className = "checklist-comment-actions";

        if (isOwnComment) {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "comment-edit-btn";
          edit.textContent = "Edit";

          edit.onclick = () => {
            if (commentRow.querySelector(".checklist-comment-edit-form")) return;

            body.classList.add("hidden");
            actions.classList.add("hidden");

            const editForm = document.createElement("form");
            editForm.className = "checklist-comment-edit-form";

            const editInput = document.createElement("input");
            editInput.type = "text";
            editInput.maxLength = 500;
            editInput.value = comment.body;
            editInput.required = true;

            const save = document.createElement("button");
            save.type = "submit";
            save.className = "secondary";
            save.textContent = "Save";

            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.className = "comment-edit-cancel-btn";
            cancel.textContent = "Cancel";

            cancel.onclick = () => {
              editForm.remove();
              body.classList.remove("hidden");
              actions.classList.remove("hidden");
            };

            editForm.addEventListener("submit", async (event) => {
              event.preventDefault();

              const newBody = editInput.value.trim();
              if (!newBody) return;

              save.disabled = true;
              save.textContent = "Saving...";

              const { error } = await supabase
                .from("checklist_comments")
                .update({
                  body: newBody,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", comment.id)
                .eq("author_id", currentUser.id);

              if (error) {
                showToast(error.message);
                save.disabled = false;
                save.textContent = "Save";
                return;
              }

              showToast("Comment updated.");
              await refreshChecklist();
            });

            editForm.append(editInput, save, cancel);
            commentRow.appendChild(editForm);
            editInput.focus();
          };

          actions.appendChild(edit);
        }

        if (canDeleteComment) {
          const del = document.createElement("button");
          del.type = "button";
          del.className = "comment-delete-btn";
          del.textContent = "Delete";

          del.onclick = async () => {
            const message = isOwnComment
              ? "Delete your comment?"
              : `Delete ${author}'s comment?`;

            if (!confirm(message)) return;

            let query = supabase
              .from("checklist_comments")
              .delete()
              .eq("id", comment.id);

            if (isOwnComment) {
              query = query.eq("author_id", currentUser.id);
            }

            const { error } = await query;

            if (error) {
              showToast(error.message);
              return;
            }

            showToast("Comment deleted.");
            await refreshChecklist();
          };

          actions.appendChild(del);
        }

        if (actions.children.length) {
          commentRow.appendChild(actions);
        }
      }

      thread.appendChild(commentRow);
    }
  }

  commentsSection.appendChild(thread);

  const commentForm = document.createElement("form");
  commentForm.className = "checklist-comment-form";

  const commentInput = document.createElement("input");
  commentInput.type = "text";
  commentInput.maxLength = 500;
  commentInput.placeholder = "Write a comment";
  commentInput.required = true;

  const commentSend = document.createElement("button");
  commentSend.type = "submit";
  commentSend.className = "secondary";
  commentSend.textContent = "Send";

  commentForm.append(commentInput, commentSend);

  commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!currentUser) return;

    const body = commentInput.value.trim();
    if (!body) return;

    commentSend.disabled = true;
    commentSend.textContent = "Sending...";

    const { error } = await supabase
      .from("checklist_comments")
      .insert({
        task_id: task.id,
        author_id: currentUser.id,
        body,
      });

    if (error) {
      showToast(error.message);
      commentSend.disabled = false;
      commentSend.textContent = "Send";
      return;
    }

    commentInput.value = "";
    await refreshChecklist();
  });

  commentsSection.appendChild(commentForm);
  row.appendChild(commentsSection);

  return row;
}



function beginShiftCorrectionSelection(period) {
  editRequestSelection = {
    date: selectedChecklistDate,
    period,
    ids: new Set(),
  };
  refreshChecklist();
}

async function submitShiftCorrectionRequest(period) {
  if (
    !editRequestSelection
    || editRequestSelection.date !== selectedChecklistDate
    || editRequestSelection.period !== period
  ) {
    showToast("Start a Correction Request first.");
    return;
  }

  const taskIds = [...editRequestSelection.ids];

  if (!taskIds.length) {
    showToast("Select at least one checklist item.");
    return;
  }

  const { data, error } = await supabase.rpc("request_checklist_shift_edit", {
    _shift_date: selectedChecklistDate,
    _time_period: period,
    _task_ids: taskIds,
  });

  if (error) return showToast(error.message);
  if (!data) return showToast("Correction request could not be sent.");

  editRequestSelection = null;
  showToast(`Correction request sent for ${taskIds.length} item${taskIds.length === 1 ? "" : "s"}.`);
  await refreshChecklist();
}


async function cancelShiftEditRequest(period) {
  const { data, error } = await supabase.rpc("cancel_checklist_shift_edit_request", {
    _shift_date: selectedChecklistDate,
    _time_period: period,
  });

  if (error) return showToast(error.message);
  if (!data) return showToast("Correction request could not be cancelled.");

  showToast("Correction request cancelled.");
  await refreshChecklist();
}

async function resolveShiftEditRequest(period, approve) {
  const rpcName = approve
    ? "admin_approve_checklist_shift_edit"
    : "admin_reject_checklist_shift_edit";

  const { data, error } = await supabase.rpc(rpcName, {
    _shift_date: selectedChecklistDate,
    _time_period: period,
  });

  if (error) return showToast(error.message);
  if (!data) return showToast("Correction request could not be updated.");

  showToast(approve ? "Correction approved." : "Correction request rejected.");
  await refreshChecklist();
}

async function finishChecklistShift(fromPeriod, button) {
  if (!currentUser) return;

  const sourceDate = selectedChecklistDate;
  const target = nextChecklistPeriod(fromPeriod);
  const targetDatePreview = target.nextDay ? shiftDate(sourceDate, 1) : sourceDate;

  const confirmed = confirm(
    `Finish ${periodLabel(fromPeriod)}?\n\n` +
    `Completed items will stay Done.\n` +
    `Unfinished items will move to ${periodLabel(target.period)} • ${formatChecklistDate(targetDatePreview)}.`
  );

  if (!confirmed) return;

  try {
    button.disabled = true;
    button.textContent = "Finishing...";

    const { data, error } = await supabase.rpc("carry_checklist_shift", {
      _from_date: sourceDate,
      _from_period: fromPeriod,
    });

    if (error) throw error;

    const moved = Number(data?.moved_count ?? data?.count ?? 0);
    const completed = Number(data?.completed_count ?? 0);
    const targetDate = data?.target_date || targetDatePreview;
    const targetPeriod = data?.target_period || target.period;

    // Evening finishes into the next calendar day.
    // Show that new day's Morning list immediately.
    if (fromPeriod === "evening" && moved > 0) {
      selectedChecklistDate = targetDate;
      syncChecklistDateControls();
    }

    await refreshChecklist();

    if (moved > 0) {
      showToast(
        `${periodLabel(fromPeriod)} finished: ${completed} completed, ${moved} unfinished moved to ${periodLabel(targetPeriod)}.`
      );
    } else {
      showToast(
        `${periodLabel(fromPeriod)} finished: ${completed} completed, no unfinished items to move.`
      );
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    button.textContent = `Finish ${periodLabel(fromPeriod)}`;
    button.disabled = false;
  }
}


function nextChecklistPeriod(period) {
  if (period === "morning") {
    return { period: "afternoon", nextDay: false };
  }

  if (period === "afternoon") {
    return { period: "evening", nextDay: false };
  }

  return { period: "morning", nextDay: true };
}

function previousChecklistPeriod(period) {
  if (period === "morning") return "evening";
  if (period === "afternoon") return "morning";
  return "afternoon";
}

function periodLabel(period) {
  return CHECKLIST_PERIODS.find((p) => p.key === period)?.label || "Morning";
}

function dateFromLocalString(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shiftDate(value, days) {
  const date = dateFromLocalString(value);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function formatChecklistDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(dateFromLocalString(value));
}

// ---------- ADMIN ----------
$("refreshAdminBtn").onclick = refreshAdminRequests;

async function refreshAdminRequests() {
  if (currentUser?.id !== ADMIN_USER_ID) return;

  const pendingBox = $("adminPendingList");
  const sentBox = $("adminSentList");
  const completedBox = $("adminCompletedList");

  pendingBox.innerHTML = `<div class="empty-state">Loading...</div>`;
  sentBox.innerHTML = "";
  completedBox.innerHTML = "";

  try {
    const data = await callAuthFunction("list_password_reset_requests", {}, true);
    const requests = data.requests || [];

    const pending = requests.filter((r) => r.status === "pending");
    const sent = requests.filter((r) => r.status === "sent");
    const completed = requests.filter((r) => r.status === "completed");

    $("adminBadge").textContent = String(pending.length);
    $("adminBadge").classList.toggle("hidden", pending.length === 0);

    renderResetRequestGroup(pendingBox, pending, "pending");
    renderResetRequestGroup(sentBox, sent, "sent");
    renderResetRequestGroup(completedBox, completed, "completed");
  } catch (error) {
    pendingBox.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderResetRequestGroup(container, requests, status) {
  container.innerHTML = "";

  if (!requests.length) {
    container.innerHTML = `<div class="empty-state">None.</div>`;
    return;
  }

  for (const request of requests) {
    const card = document.createElement("div");
    card.className = "request-card";

    let statusLabel = "Pending";
    let statusDate = request.requested_at;

    if (status === "sent") {
      statusLabel = "Reset email sent";
      statusDate = request.resolved_at || request.requested_at;
    }

    if (status === "completed") {
      statusLabel = "Completed";
      statusDate = request.completed_at || request.resolved_at || request.requested_at;
    }

    const info = document.createElement("div");
    info.innerHTML = `
      <div class="item-title">${escapeHtml(request.display_name || request.username_snapshot)}</div>
      <div class="item-sub">User ID: ${escapeHtml(request.username_snapshot)}</div>
      <span class="request-status ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
      <div class="request-meta">${formatDateTime(statusDate)}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "request-actions";

    if (status === "pending") {
      const approve = document.createElement("button");
      approve.className = "primary";
      approve.textContent = "Approve & Send Email";
      approve.onclick = async () => {
        approve.disabled = true;
        approve.textContent = "Sending...";
        try {
          const result = await callAuthFunction(
            "approve_password_reset",
            { requestId: request.id },
            true,
          );
          showToast(result.message || "Reset email sent.");
          await refreshAdminRequests();
        } catch (error) {
          showToast(error.message);
          approve.disabled = false;
          approve.textContent = "Approve & Send Email";
        }
      };
      actions.appendChild(approve);
    }

    const del = document.createElement("button");
    del.className = "admin-danger";
    del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete this password reset request for ${request.username_snapshot}?`)) return;

      try {
        await callAuthFunction(
          "delete_password_reset_request",
          { requestId: request.id },
          true,
        );
        showToast("Reset request deleted.");
        await refreshAdminRequests();
      } catch (error) {
        showToast(error.message);
      }
    };
    actions.appendChild(del);

    card.append(info, actions);
    container.appendChild(card);
  }
}

// ---------- INSTALL ----------
const isIosDevice =
  /iphone|ipad|ipod/i.test(navigator.userAgent)
  && !window.MSStream;

const isStandaloneMode =
  window.matchMedia?.("(display-mode: standalone)")?.matches
  || window.navigator.standalone === true;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("installBtn").classList.remove("hidden");
});

if (isIosDevice && !isStandaloneMode) {
  $("installBtn").classList.remove("hidden");
}

$("installBtn").onclick = async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("installBtn").classList.add("hidden");
    return;
  }

  if (isIosDevice && !isStandaloneMode) {
    alert("On iPhone/iPad: open the Share menu in Safari, then choose Add to Home Screen.");
  }
};

// ---------- HELPERS ----------
function localDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value || "";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- BOOT ----------
async function boot() {
  renderDraft();

  if ("serviceWorker" in navigator) {
    const isLocalDev =
      location.hostname === "127.0.0.1" ||
      location.hostname === "localhost";

    if (isLocalDev) {
      // Development mode: never let an old PWA cache hide new UI changes.
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    } else {
      navigator.serviceWorker
        .register("../../sw.js", {
          scope: "../../",
          updateViaCache: "none",
        })
        .then((registration) => registration.update())
        .catch((error) => {
          console.warn("Service Worker registration failed:", error);
        });
    }
  }

  hydrateLoginMemory();

  const { data } = await supabase.auth.getSession();

  // Recovery sessions are handled by onAuthStateChange / URL detection.
  if (data.session && !location.hash.includes("type=recovery")) {
    const storedPreference = localStorage.getItem(REMEMBER_LOGIN_KEY);

    // Existing logged-in users upgrading from an older release keep
    // their valid session by default.
    if (storedPreference === null) {
      localStorage.setItem(REMEMBER_LOGIN_KEY, "1");
    }

    const remembered = localStorage.getItem(REMEMBER_LOGIN_KEY) !== "0";
    const currentSessionOnly = sessionStorage.getItem(SESSION_LOGIN_KEY) === "1";

    // Remember login OFF = valid only for this browser/app session.
    if (!remembered && !currentSessionOnly) {
      await supabase.auth.signOut();
      authView("loginForm");
      return;
    }

    try {
      await enterApp();
    } catch (error) {
      console.error(error);
      clearSessionOnlyLoginMarker();
      await supabase.auth.signOut();
      await leaveApp();
      setAuthStatus("Session could not be restored. Log in again.");
    }
  } else {
    authView("loginForm");
  }
}

boot()
  .then(() => {
    window.dispatchEvent(new CustomEvent("gcfr:boot-ok"));
  })
  .catch((error) => {
    console.error("GCFR boot failed:", error);
  });


