import { createBarcodeScanner } from "./barcode-scanner.js";
import { initGcfrV2Stock } from "./stock.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://ihplydsxgrwuzgiydylg.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_s-rXvXKUGMqUy__1-JP9Cw_DlBVXr0l";
const AUTH_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/gcfr-auth`;
const ADMIN_USER_ID = "139c07f7-a826-4513-86af-25afdbe44d8f";

const STOCK_RUNNER_USERS = new Map([
  ["7059cdf3-6c20-40d7-98d6-99d8401cceaf", "Troy J"],
  ["c2074c9e-492a-4913-8725-771306d1c918", "Alex S"],
]);

function isOwnerUser() {
  return currentUser?.id === ADMIN_USER_ID;
}

function isStockRunner() {
  return STOCK_RUNNER_USERS.has(currentUser?.id);
}

function canManageDailyOperations() {
  return isOwnerUser() || isStockRunner();
}

function canManageProductData() {
  return isOwnerUser() || isStockRunner();
}

function knownUserDisplayName(userId, nameMap = null) {
  if (!userId) return "User";
  if (userId === ADMIN_USER_ID) return nameMap?.get(userId) || "Joey";
  return STOCK_RUNNER_USERS.get(userId) || nameMap?.get(userId) || "User";
}

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
let selectedHistoryDate = localDateString(new Date());
let draft = [];
let scanner = null;
let adminBarcodeScanner = null;
let pendingUnknownBarcode = "";
let barcodeLinkSearchTimer = null;
let installPrompt = null;
let realtimeChannels = [];
let stockController = null;
let limitedStockSetupEntry = false;

let productSearchCatalog = null;
let productSearchCatalogPromise = null;

let adminPricingSelectedProduct = null;
let adminPricingSearchTimer = null;

let productCodeLookupTimer = null;
let productCodeLookupRequestId = 0;

let runBulkDeleteMode = false;
let runBulkDeleteIds = new Set();
let currentVisibleRunIds = [];

let adminBarcodeMappings = [];
let checklistPendingRemovalMap = new Map();

let chatMessages = [];
let chatProfileMap = new Map();

let rosterSelectedDate = localDateString(new Date());
let rosterViewMode = "all";
let rosterDayShifts = [];
let rosterProfiles = [];
let rosterProfileMap = new Map();
let rosterInitialScrollDone = false;

let rosterCalendarMonth = firstDayOfMonthString(rosterSelectedDate);
let rosterMyShiftDates = new Set();
let rosterCalendarOpen = false;
let rosterShiftEntryMode = "daily";
let rosterWeekOverviewOpen = false;
let rosterWeekShifts = [];

function chatLastSeenKey() {
  return currentUser?.id
    ? `gcfr_chat_last_seen_${currentUser.id}`
    : "gcfr_chat_last_seen";
}


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
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error("Session unavailable. Reconnect and retry.");

  currentUser = data.user;
  currentProfile = await loadProfile(currentUser.id);
  $("sessionRestoreRetry")?.remove();

  resetAppTransientUiForAccountChange();
  draft = loadDraft(currentUser.id);

  if (rememberLoginPreference() && currentProfile?.username) {
    localStorage.setItem(REMEMBER_USERNAME_KEY, currentProfile.username);
  }

  $("authShell").classList.add("hidden");
  $("appShell").classList.remove("hidden");
  $("appShell").classList.remove("chat-mode");
  document.documentElement.classList.remove("chat-screen-lock");
  document.body.classList.remove("chat-screen-lock");

  // Always enter the real app on the Scan screen after login.
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  $("screen-scan").classList.add("active");
  document.querySelectorAll(".bottom-nav button[data-screen]").forEach((b) => b.classList.remove("active"));
  document.querySelector('.bottom-nav button[data-screen="scan"]')?.classList.add("active");
  $("screenTitle").textContent = "Scan";

  $("userDisplay").textContent = currentProfile.display_name || currentProfile.username;
  $("accountName").textContent = currentProfile.display_name || "-";
  $("accountUsername").textContent = currentProfile.username || "-";
  $("accountRole").textContent =
    currentUser.id === ADMIN_USER_ID
      ? "admin"
      : (STOCK_RUNNER_USERS.has(currentUser.id) ? "stock runner" : "user");

  const isAdmin = currentUser.id === ADMIN_USER_ID;
  const canManageProducts = canManageProductData();

  $("adminNavBtn").classList.toggle("hidden", !isAdmin);

  // Building a Run List is available to every authenticated user.
  // Product/barcode registration inside this area remains permission-gated.
  $("managerProductAddTools").classList.remove("hidden");

  renderDraft();
  syncHistoryDateControls();
  await refreshRuns();
  await refreshHistory();
  await refreshChecklist();
  await refreshFreshPromoAlert();
  if (isAdmin) {
    showAdminHomeView();
    await refreshAdminRequests();
    await refreshProcessPendingCount();
  }

  await initializeChatUnreadState();
  subscribeRealtime();
  const savedScreen = localStorage.getItem(`gcfr_last_screen_${currentUser.id}`);
  if (savedScreen && savedScreen !== "scan" && (savedScreen !== "admin" || isAdmin)) {
    await navigateToScreen(savedScreen);
  }
}

async function leaveApp() {
  stockController?.reset();
  closeFreshPromoModal();
  $("freshPromoAlertBtn")?.classList.add("hidden");
  resetAppTransientUiForAccountChange();

  realtimeChannels.forEach((channel) => supabase.removeChannel(channel));
  realtimeChannels = [];

  currentUser = null;
  currentProfile = null;
  draft = [];
  chatMessages = [];
  chatProfileMap = new Map();
  rosterDayShifts = [];
  rosterProfiles = [];
  rosterProfileMap = new Map();
  rosterInitialScrollDone = false;

  renderDraft();

  if ($("chatNavBadge")) {
    $("chatNavBadge").classList.add("hidden");
    $("chatNavBadge").textContent = "0";
  }

  $("appShell").classList.remove("chat-mode");
  document.documentElement.classList.remove("chat-screen-lock");
  document.body.classList.remove("chat-screen-lock");
  $("appShell").classList.add("hidden");
  $("authShell").classList.remove("hidden");

  resetAuthFormsForCleanEntry();
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

  const processPendingChannel = supabase
    .channel("gcfr-process-pending")
    .on("postgres_changes", { event: "*", schema: "public", table: "gcfr_process_pending" }, async () => {
      await refreshChecklistPreservingScroll();

      if (isOwnerUser()) {
        await refreshProcessPendingCount();

        if (!$("adminProcessPendingView")?.classList.contains("hidden")) {
          await refreshProcessPending();
        }
      }
    })
    .subscribe();

  const rosterChannel = supabase
    .channel("gcfr-roster")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "gcfr_roster_shifts" },
      async () => {
        if ($("screen-roster")?.classList.contains("active")) {
          await refreshRoster();
          await refreshRosterCalendarShiftDates();

          if (rosterWeekOverviewOpen) {
            await refreshRosterWeekOverview();
          }
        }
      },
    )
    .subscribe();

  const chatChannel = supabase
    .channel("gcfr-team-chat")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "gcfr_chat_messages" },
      async () => {
        if ($("screen-chat")?.classList.contains("active")) {
          await refreshChat({ scrollToBottom: true });
        } else {
          await refreshChatUnreadCount();
        }
      },
    )
    .subscribe();

  realtimeChannels.push(
    runChannel,
    checklistChannel,
    processPendingChannel,
    rosterChannel,
    chatChannel,
  );
}


function resetSignupForm() {
  $("signupForm")?.reset();

  if ($("displayNamePreview")) {
    $("displayNamePreview").textContent = "-";
  }
}

function resetAuthFormsForCleanEntry() {
  $("loginForm")?.reset();
  resetSignupForm();
  $("forgotForm")?.reset();
  $("recoveryForm")?.reset();

  if ($("loginPassword")) $("loginPassword").value = "";
  if ($("recoveryPassword")) $("recoveryPassword").value = "";
  if ($("recoveryConfirmPassword")) $("recoveryConfirmPassword").value = "";

  setAuthStatus("");
  hydrateLoginMemory();
}

function resetScannerUiState() {
  clearTimeout(barcodeLinkSearchTimer);
  barcodeLinkSearchTimer = null;

  try {
    scanner?.stop();
  } catch {}

  scanner = null;

  $("scannerWrap")?.classList.add("hidden");

  if ($("reader")) {
    $("reader").innerHTML = "";
  }

  if ($("scanStatus")) {
    $("scanStatus").textContent = "Starting camera…";
  }

  closeBarcodeLinkPanel();

  if ($("unknownBarcodeValue")) {
    $("unknownBarcodeValue").textContent = "";
  }
}

function resetAdminScannerUiState() {
  try {
    adminBarcodeScanner?.stop();
  } catch {}

  adminBarcodeScanner = null;

  $("adminScannerWrap")?.classList.add("hidden");

  if ($("adminReader")) {
    $("adminReader").innerHTML = "";
  }

  if ($("adminScanStatus")) {
    $("adminScanStatus").textContent = "Starting camera…";
  }
}

function clearElementValue(id) {
  const element = $(id);
  if (element && "value" in element) {
    element.value = "";
  }
}

function clearElementHtml(id, placeholder = "") {
  const element = $(id);
  if (element) {
    element.innerHTML = placeholder;
  }
}

function resetAppTransientUiForAccountChange() {
  resetScannerUiState();
  resetAdminScannerUiState();

  document
    .querySelectorAll("#appShell form")
    .forEach((form) => form.reset());

  [
    "productSearch",
    "manualCode",
    "barcodeLinkSearch",
    "barcodeManualProductCode",
    "barcodeManualProductName",
    "adminBarcodeDataSearch",
    "chatInput",
    "newTaskTitle",
  ].forEach(clearElementValue);

  hideProductSearchResults();
  closeProductCodeLookup();
  closeManualProductRegistration();
  $("managerProductAddTools")?.classList.add("hidden");
  $("barcodeManualRegisterLaunchBtn")?.classList.add("hidden");
  $("barcodeManualRegisterPanel")?.classList.add("hidden");

  if ($("quickTemplateList")) {
    $("quickTemplateList")
      .querySelectorAll('input[type="checkbox"]')
      .forEach((checkbox) => {
        checkbox.checked = false;
      });
  }

  $("quickAddPanel")?.classList.add("hidden");

  resetRunBulkDelete();
  resetChecklistBulkDelete();

  runBulkDeleteIds.clear();
  currentVisibleRunIds = [];
  checklistPendingRemovalMap = new Map();

  if ($("runBulkSelectAll")) {
    $("runBulkSelectAll").checked = false;
    $("runBulkSelectAll").indeterminate = false;
  }

  selectedChecklistDate = localDateString(new Date());
  selectedHistoryDate = localDateString(new Date());
  rosterSelectedDate = localDateString(new Date());
  rosterCalendarMonth = firstDayOfMonthString(rosterSelectedDate);
  rosterViewMode = "all";
  rosterCalendarOpen = false;
  rosterWeekOverviewOpen = false;
  rosterShiftEntryMode = "daily";
  rosterDayShifts = [];
  rosterWeekShifts = [];
  rosterMyShiftDates = new Set();
  rosterProfiles = [];
  rosterProfileMap = new Map();
  rosterInitialScrollDone = false;

  $("rosterCalendarPanel")?.classList.add("hidden");
  $("rosterWeekOverview")?.classList.add("hidden");
  $("rosterScheduler")?.classList.remove("hidden");
  $("rosterShiftFormWrap")?.classList.add("hidden");

  $("rosterAllBtn")?.classList.add("active");
  $("rosterMineBtn")?.classList.remove("active");
  $("rosterDailyViewBtn")?.classList.add("active");
  $("rosterThisWeekBtn")?.classList.remove("active");

  if ($("chatInput")) {
    $("chatInput").style.height = "auto";
  }

  resetAdminMappingForm();

  if ($("adminBarcodeDataSearch")) {
    $("adminBarcodeDataSearch").value = "";
  }

  if ($("adminHomeView")) $("adminHomeView").classList.remove("hidden");
  if ($("adminBarcodeDetailView")) $("adminBarcodeDetailView").classList.add("hidden");
  if ($("adminProcessPendingView")) $("adminProcessPendingView").classList.add("hidden");
  if ($("adminStockSetupView")) $("adminStockSetupView").classList.add("hidden");
  if ($("adminPricingView")) $("adminPricingView").classList.add("hidden");
  if ($("adminPricingSelected")) $("adminPricingSelected").classList.add("hidden");
  limitedStockSetupEntry = false;
  adminPricingSelectedProduct = null;

  const emptyState = `<div class="empty-state">Loading...</div>`;

  clearElementHtml("runsList", emptyState);
  clearElementHtml("historyList", emptyState);
  clearElementHtml("checklistSections", emptyState);
  clearElementHtml("chatMessages", `<div class="empty-state">No messages yet.</div>`);
  clearElementHtml("rosterScheduler", `<div class="empty-state">No shifts for this date.</div>`);
  clearElementHtml("rosterWeekOverviewGrid", "");
  clearElementHtml("adminBarcodeDataList", "");
  clearElementHtml("processPendingList", "");

  adminBarcodeMappings = [];
  chatMessages = [];
  chatProfileMap = new Map();

  if ($("chatNavBadge")) {
    $("chatNavBadge").classList.add("hidden");
    $("chatNavBadge").textContent = "0";
  }

  if ($("adminBadge")) {
    $("adminBadge").classList.add("hidden");
    $("adminBadge").textContent = "0";
  }

  if ($("processPendingBadge")) {
    $("processPendingBadge").classList.add("hidden");
    $("processPendingBadge").textContent = "0";
  }

  if ($("userDisplay")) $("userDisplay").textContent = "";
  if ($("accountName")) $("accountName").textContent = "-";
  if ($("accountUsername")) $("accountUsername").textContent = "-";
  if ($("accountRole")) $("accountRole").textContent = "-";

  $("toast")?.classList.add("hidden");
  clearTimeout(showToast.timer);
}

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

    $("loginPassword").value = "";
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

    const createdUsername = $("signupUsername").value.trim();

    await applyReturnedSession(data);
    rememberSignupSession(createdUsername);

    resetSignupForm();
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

    $("forgotForm").reset();
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
    $("recoveryForm").reset();

    await supabase.auth.signOut();
    history.replaceState({}, document.title, location.pathname);

    resetAuthFormsForCleanEntry();
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
stockController = initGcfrV2Stock({
  supabase,
  $,
  showToast,
  getCurrentUser: () => currentUser,
  canManageProductData,
  normalizeScannedBarcode,
  openAdminStockSetup: openStockSetupFromOperations,
  renderBarcode: createCode128BarcodeSvg,
  openStock: () => navigateToScreen('stock'),
});

const titles = {
  scan: "Scan",
  stock: "Stock",
  runs: "Run Lists",
  history: "Run History",
  checklist: "Checklist",
  roster: "Roster",
  chat: "Team Chat",
  admin: "Admin",
  account: "Account",
  more: "More",
};

const moreScreens = new Set(["history", "roster", "admin", "account"]);

async function navigateToScreen(screen) {
  const target = $(`screen-${screen}`);
  if (!target) return;
  if (screen === "admin" && !isOwnerUser() && !limitedStockSetupEntry) return;
  if (currentUser) localStorage.setItem(`gcfr_last_screen_${currentUser.id}`, screen);

  const navScreen = moreScreens.has(screen) ? "more" : screen;

  document
    .querySelectorAll(".bottom-nav button[data-screen]")
    .forEach((button) => button.classList.remove("active"));

  document
    .querySelector(`.bottom-nav button[data-screen="${navScreen}"]`)
    ?.classList.add("active");

  document.querySelectorAll(".screen").forEach((element) => {
    element.classList.remove("active");
  });

  target.classList.add("active");
  $("screenTitle").textContent = titles[screen] || "GCFR";

  const chatActive = screen === "chat";

  $("appShell").classList.toggle("chat-mode", chatActive);
  document.documentElement.classList.toggle("chat-screen-lock", chatActive);
  document.body.classList.toggle("chat-screen-lock", chatActive);

  if (screen !== "scan") stopScanner();
  stockController?.onScreenChange(screen);

  if (screen === "runs") await refreshRuns();
  if (screen === "history") await refreshHistory();
  if (screen === "checklist") await refreshChecklist();

  if (screen === "roster") {
    syncRosterDateControls();
    await refreshRoster();
    await refreshRosterCalendarShiftDates();
  }

  if (screen === "chat") {
    await refreshChat({ scrollToBottom: true });
  }

  if (screen === "admin") {
    showAdminHomeView();
    await refreshAdminRequests();
    await refreshProcessPendingCount();
  }
}

document.querySelectorAll(".bottom-nav button[data-screen]").forEach((button) => {
  button.addEventListener("click", () => navigateToScreen(button.dataset.screen));
});

document.querySelectorAll("[data-more-screen]").forEach((button) => {
  button.addEventListener("click", () => navigateToScreen(button.dataset.moreScreen));
});

// ---------- ROSTER SCHEDULER ----------
$("refreshRosterBtn").onclick = refreshRoster;

$("rosterDailyViewBtn").onclick = () => {
  closeRosterWeekOverview();
};

$("rosterThisWeekBtn").onclick = async () => {
  rosterWeekOverviewOpen = true;
  $("rosterWeekOverview").classList.remove("hidden");
  $("rosterScheduler").classList.add("hidden");
  $("rosterShiftFormWrap").classList.add("hidden");

  $("rosterDailyViewBtn").classList.remove("active");
  $("rosterThisWeekBtn").classList.add("active");

  await refreshRosterWeekOverview();
};


$("rosterPrevDayBtn").onclick = async () => {
  closeRosterWeekOverview();
  rosterSelectedDate = shiftDate(rosterSelectedDate, -1);
  rosterCalendarMonth = firstDayOfMonthString(rosterSelectedDate);
  rosterInitialScrollDone = false;
  syncRosterDateControls();
  closeRosterShiftForm();
  await refreshRoster();
};

$("rosterNextDayBtn").onclick = async () => {
  closeRosterWeekOverview();
  rosterSelectedDate = shiftDate(rosterSelectedDate, 1);
  rosterCalendarMonth = firstDayOfMonthString(rosterSelectedDate);
  rosterInitialScrollDone = false;
  syncRosterDateControls();
  closeRosterShiftForm();
  await refreshRoster();
};

$("rosterTodayBtn").onclick = async () => {
  closeRosterWeekOverview();
  rosterSelectedDate = localDateString(new Date());
  rosterCalendarMonth = firstDayOfMonthString(rosterSelectedDate);
  rosterInitialScrollDone = false;
  syncRosterDateControls();
  closeRosterShiftForm();
  await refreshRoster();
};

$("rosterDateButton").onclick = async (event) => {
  event.stopPropagation();

  if (rosterCalendarOpen) {
    closeRosterCalendar();
    return;
  }

  rosterCalendarMonth = firstDayOfMonthString(rosterSelectedDate);
  openRosterCalendar();
  await refreshRosterCalendarShiftDates();
};

$("rosterCalendarPrevMonthBtn").onclick = async (event) => {
  event.stopPropagation();
  rosterCalendarMonth = shiftMonth(rosterCalendarMonth, -1);
  await refreshRosterCalendarShiftDates();
};

$("rosterCalendarNextMonthBtn").onclick = async (event) => {
  event.stopPropagation();
  rosterCalendarMonth = shiftMonth(rosterCalendarMonth, 1);
  await refreshRosterCalendarShiftDates();
};

$("rosterCalendarPanel").onclick = (event) => {
  event.stopPropagation();
};

document.addEventListener("click", () => {
  if (rosterCalendarOpen) closeRosterCalendar();
});

$("rosterAllBtn").onclick = () => {
  rosterViewMode = "all";
  $("rosterAllBtn").classList.add("active");
  $("rosterMineBtn").classList.remove("active");

  if (rosterWeekOverviewOpen) {
    renderRosterWeekOverview();
  } else {
    renderRosterScheduler();
  }
};

$("rosterMineBtn").onclick = () => {
  rosterViewMode = "mine";
  $("rosterMineBtn").classList.add("active");
  $("rosterAllBtn").classList.remove("active");

  if (rosterWeekOverviewOpen) {
    renderRosterWeekOverview();
  } else {
    renderRosterScheduler();
  }
};

$("rosterAddShiftBtn").onclick = () => {
  openRosterShiftForm();
};

$("rosterShiftCancelBtn").onclick = closeRosterShiftForm;

$("rosterDailyModeBtn").onclick = () => {
  setRosterShiftEntryMode("daily");
};

$("rosterWeeklyModeBtn").onclick = () => {
  setRosterShiftEntryMode("weekly");
};

function setRosterShiftEntryMode(mode) {
  rosterShiftEntryMode = mode === "weekly" ? "weekly" : "daily";

  $("rosterDailyModeBtn").classList.toggle(
    "active",
    rosterShiftEntryMode === "daily",
  );

  $("rosterWeeklyModeBtn").classList.toggle(
    "active",
    rosterShiftEntryMode === "weekly",
  );

  $("rosterDailyFields").classList.toggle(
    "hidden",
    rosterShiftEntryMode !== "daily",
  );

  $("rosterWeeklyFields").classList.toggle(
    "hidden",
    rosterShiftEntryMode !== "weekly",
  );

  $("rosterShiftSaveBtn").textContent =
    rosterShiftEntryMode === "weekly"
      ? "Add Weekly Shifts"
      : ($("rosterShiftId").value ? "Save Shift" : "Add Shift");
}

$("rosterShiftForm").onsubmit = async (event) => {
  event.preventDefault();

  if (!isOwnerUser()) return;

  const shiftId = Number($("rosterShiftId").value || 0);
  const userId = $("rosterShiftUser").value;
  const assignment = $("rosterShiftRole").value.trim() || "Fresh Produce";
  const notes = $("rosterShiftNotes").value.trim();

  if (!userId) {
    showToast("Team Member is required.");
    return;
  }

  const button = $("rosterShiftSaveBtn");
  button.disabled = true;

  if (shiftId || rosterShiftEntryMode === "daily") {
    const startTime = $("rosterShiftStart").value;
    const endTime = $("rosterShiftEnd").value;

    if (!startTime || !endTime) {
      button.disabled = false;
      showToast("Start and Finish are required.");
      return;
    }

    button.textContent = "Saving...";

    let result;

    if (shiftId) {
      result = await supabase
        .from("gcfr_roster_shifts")
        .update({
          user_id: userId,
          shift_date: rosterSelectedDate,
          start_time: startTime,
          end_time: endTime,
          assignment,
          notes: notes || null,
        })
        .eq("id", shiftId);
    } else {
      result = await supabase
        .from("gcfr_roster_shifts")
        .insert({
          user_id: userId,
          shift_date: rosterSelectedDate,
          start_time: startTime,
          end_time: endTime,
          assignment,
          notes: notes || null,
          created_by: currentUser.id,
        });
    }

    button.disabled = false;
    button.textContent = shiftId ? "Save Shift" : "Add Shift";

    if (result.error) {
      showToast(result.error.message);
      return;
    }

    closeRosterShiftForm();
    showToast(shiftId ? "Shift updated." : "Daily shift added.");
    await refreshRoster();
    await refreshRosterCalendarShiftDates();
    return;
  }

  const weeklyEntries = getWeeklyRosterEntries();

  if (!weeklyEntries.length) {
    button.disabled = false;
    showToast("Select at least one day for the weekly shift.");
    return;
  }

  const invalid = weeklyEntries.find(
    (entry) => !entry.start_time || !entry.end_time,
  );

  if (invalid) {
    button.disabled = false;
    showToast(`Enter Start and Finish for ${invalid.label}.`);
    return;
  }

  button.textContent = "Adding...";

  const payload = weeklyEntries.map((entry) => ({
    user_id: userId,
    shift_date: entry.shift_date,
    start_time: entry.start_time,
    end_time: entry.end_time,
    assignment,
    notes: notes || null,
    created_by: currentUser.id,
  }));

  const { error } = await supabase
    .from("gcfr_roster_shifts")
    .insert(payload);

  button.disabled = false;
  button.textContent = "Add Weekly Shifts";

  if (error) {
    showToast(error.message);
    return;
  }

  closeRosterShiftForm();
  showToast(`${payload.length} weekly shift${payload.length === 1 ? "" : "s"} added.`);
  await refreshRoster();
  await refreshRosterCalendarShiftDates();
};

$("rosterShiftDeleteBtn").onclick = async () => {
  if (!isOwnerUser()) return;

  const shiftId = Number($("rosterShiftId").value || 0);
  if (!shiftId) return;

  if (!confirm("Delete this roster shift?")) return;

  const { error } = await supabase
    .from("gcfr_roster_shifts")
    .delete()
    .eq("id", shiftId);

  if (error) {
    showToast(error.message);
    return;
  }

  closeRosterShiftForm();
  showToast("Shift deleted.");
  await refreshRoster();
  await refreshRosterCalendarShiftDates();
};

function syncRosterDateControls() {
  const display = $("rosterDateDisplay");

  if (display) {
    const date = dateFromLocalString(rosterSelectedDate);
    display.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);
  }

  $("rosterAddShiftBtn")?.classList.toggle(
    "hidden",
    !isOwnerUser(),
  );

  if (rosterCalendarOpen) {
    renderRosterCalendar();
  }
}

function openRosterCalendar() {
  rosterCalendarOpen = true;
  $("rosterCalendarPanel").classList.remove("hidden");
  $("rosterDateButton").setAttribute("aria-expanded", "true");
  renderRosterCalendar();
}

function closeRosterCalendar() {
  rosterCalendarOpen = false;
  $("rosterCalendarPanel")?.classList.add("hidden");
  $("rosterDateButton")?.setAttribute("aria-expanded", "false");
}

function firstDayOfMonthString(dateString) {
  const date = dateFromLocalString(dateString);
  date.setDate(1);
  return localDateString(date);
}

function shiftMonth(dateString, amount) {
  const date = dateFromLocalString(dateString);
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  return localDateString(date);
}

function rosterCalendarBounds(monthString) {
  const first = dateFromLocalString(monthString);
  first.setDate(1);

  const gridStart = new Date(first);
  const mondayOffset = (gridStart.getDay() + 6) % 7;
  gridStart.setDate(gridStart.getDate() - mondayOffset);

  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridEnd.getDate() + 41);

  return {
    start: localDateString(gridStart),
    end: localDateString(gridEnd),
  };
}

function currentWeekBounds() {
  const today = new Date();
  const monday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );

  const offset = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - offset);

  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  return {
    monday: localDateString(monday),
    sunday: localDateString(sunday),
  };
}

async function refreshRosterCalendarShiftDates() {
  if (!currentUser) return;

  const { start, end } = rosterCalendarBounds(rosterCalendarMonth);

  const { data, error } = await supabase
    .from("gcfr_roster_shifts")
    .select("shift_date")
    .eq("user_id", currentUser.id)
    .gte("shift_date", start)
    .lte("shift_date", end)
    .order("shift_date", { ascending: true });

  if (error) {
    showToast(error.message);
    return;
  }

  rosterMyShiftDates = new Set(
    (data || []).map((row) => row.shift_date),
  );

  renderRosterCalendar();
}

function renderRosterCalendar() {
  const grid = $("rosterCalendarGrid");
  const monthLabel = $("rosterCalendarMonthLabel");

  if (!grid || !monthLabel) return;

  const monthDate = dateFromLocalString(rosterCalendarMonth);
  const monthNumber = monthDate.getMonth();

  monthLabel.textContent = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(monthDate);

  const { start } = rosterCalendarBounds(rosterCalendarMonth);
  const cursor = dateFromLocalString(start);
  const today = localDateString(new Date());
  const { monday, sunday } = currentWeekBounds();

  grid.innerHTML = "";

  for (let index = 0; index < 42; index += 1) {
    const dateString = localDateString(cursor);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "roster-calendar-day";
    button.dataset.date = dateString;

    if (cursor.getMonth() !== monthNumber) {
      button.classList.add("outside-month");
    }

    if (dateString >= monday && dateString <= sunday) {
      button.classList.add("current-week");
    }

    if (dateString === today) {
      button.classList.add("today");
    }

    if (dateString === rosterSelectedDate) {
      button.classList.add("selected");
      button.setAttribute("aria-current", "date");
    }

    const number = document.createElement("span");
    number.className = "roster-calendar-day-number";
    number.textContent = String(cursor.getDate());
    button.appendChild(number);

    if (rosterMyShiftDates.has(dateString)) {
      const dot = document.createElement("i");
      dot.className = "roster-calendar-shift-dot";
      dot.setAttribute("aria-hidden", "true");
      button.appendChild(dot);

      button.setAttribute(
        "aria-label",
        `${formatRosterDate(dateString)}, my shift assigned`,
      );
    } else {
      button.setAttribute(
        "aria-label",
        formatRosterDate(dateString),
      );
    }

    button.onclick = async () => {
      closeRosterWeekOverview();
      rosterSelectedDate = dateString;
      rosterCalendarMonth = firstDayOfMonthString(dateString);
      rosterInitialScrollDone = false;

      syncRosterDateControls();
      closeRosterShiftForm();
      closeRosterCalendar();
      await refreshRoster();
    };

    grid.appendChild(button);
    cursor.setDate(cursor.getDate() + 1);
  }
}

async function loadRosterProfiles() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, username")
    .order("display_name", { ascending: true });

  if (error) throw error;

  rosterProfiles = data || [];
  rosterProfileMap = new Map(
    rosterProfiles.map((profile) => [
      profile.id,
      profile.display_name || profile.username || "User",
    ]),
  );

  const select = $("rosterShiftUser");
  const current = select.value;
  select.innerHTML = "";

  for (const profile of rosterProfiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent =
      profile.display_name || profile.username || "User";
    select.appendChild(option);
  }

  if (
    current
    && rosterProfiles.some((profile) => profile.id === current)
  ) {
    select.value = current;
  }
}

async function refreshRoster() {
  if (!currentUser) return;

  syncRosterDateControls();

  const scheduler = $("rosterScheduler");
  scheduler.innerHTML = `<div class="empty-state">Loading roster...</div>`;

  try {
    if (!rosterProfiles.length) {
      await loadRosterProfiles();
    }

    const { data, error } = await supabase
      .from("gcfr_roster_shifts")
      .select("id, user_id, shift_date, start_time, end_time, assignment, notes, created_by, created_at, updated_at")
      .eq("shift_date", rosterSelectedDate)
      .order("start_time", { ascending: true });

    if (error) throw error;

    rosterDayShifts = data || [];
    renderRosterScheduler();
  } catch (error) {
    scheduler.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderRosterScheduler() {
  const scheduler = $("rosterScheduler");
  if (!scheduler) return;

  const shifts =
    rosterViewMode === "mine"
      ? rosterDayShifts.filter((shift) => shift.user_id === currentUser?.id)
      : rosterDayShifts;

  const grouped = new Map();

  for (const shift of shifts) {
    if (!grouped.has(shift.user_id)) {
      grouped.set(shift.user_id, []);
    }
    grouped.get(shift.user_id).push(shift);
  }

  const memberIds = [...grouped.keys()].sort((a, b) => {
    const nameA = rosterProfileMap.get(a) || "User";
    const nameB = rosterProfileMap.get(b) || "User";
    return nameA.localeCompare(nameB);
  });

  scheduler.innerHTML = "";

  if (!memberIds.length) {
    scheduler.innerHTML = `
      <div class="empty-state">
        ${rosterViewMode === "mine"
          ? "You have no rostered shift for this date."
          : "No shifts for this date."}
      </div>
    `;
    return;
  }

  const scroll = document.createElement("div");
  scroll.className = "roster-scheduler-scroll";

  const grid = document.createElement("div");
  grid.className = "roster-scheduler-grid";

  const corner = document.createElement("div");
  corner.className = "roster-scheduler-corner";
  corner.textContent = "Name";
  grid.appendChild(corner);

  const timeHeader = document.createElement("div");
  timeHeader.className = "roster-time-header";

  for (let hour = 0; hour <= 24; hour += 4) {
    const label = document.createElement("span");
    label.className = "roster-time-label";
    label.style.left = `${(hour / 24) * 100}%`;
    label.textContent = hour === 24
      ? "24:00"
      : `${String(hour).padStart(2, "0")}:00`;
    timeHeader.appendChild(label);
  }

  grid.appendChild(timeHeader);

  for (const userId of memberIds) {
    const userShifts = grouped.get(userId) || [];

    const name = document.createElement("div");
    name.className = "roster-member-name";

    const memberName = document.createElement("strong");
    memberName.textContent = rosterProfileMap.get(userId) || "User";

    const memberTime = document.createElement("span");
    memberTime.className = "roster-member-time";
    memberTime.textContent = userShifts
      .map((shift) => `${formatRosterTime(shift.start_time)}–${formatRosterTime(shift.end_time)}`)
      .join(" / ");

    name.append(memberName, memberTime);
    grid.appendChild(name);

    const track = document.createElement("div");
    track.className = "roster-time-track";

    for (let hour = 0; hour <= 24; hour += 4) {
      const line = document.createElement("span");
      line.className = "roster-hour-line";
      line.style.left = `${(hour / 24) * 100}%`;
      track.appendChild(line);
    }

    for (const shift of userShifts) {
      const start = rosterTimeToMinutes(shift.start_time);
      let end = rosterTimeToMinutes(shift.end_time);
      const overnight = end <= start;

      if (overnight) end = 24 * 60;

      const block = document.createElement("button");
      block.type = "button";
      block.className = "roster-shift-block";
      block.style.left = `${(start / 1440) * 100}%`;
      block.style.width = `${Math.max(1.5, ((end - start) / 1440) * 100)}%`;

      const timeText =
        `${formatRosterTime(shift.start_time)}–${formatRosterTime(shift.end_time)}${overnight ? " +1" : ""}`;

      block.innerHTML = `
        <strong>${escapeHtml(shift.assignment || "Fresh Produce")}</strong>
        <span>${escapeHtml(timeText)}</span>
      `;

      const details = [
        rosterProfileMap.get(userId) || "User",
        timeText,
        shift.assignment || "Fresh Produce",
        shift.notes || "",
      ].filter(Boolean).join(" • ");

      block.title = details;

      if (isOwnerUser()) {
        block.onclick = () => openRosterShiftForm(shift);
      } else {
        block.disabled = true;
      }

      track.appendChild(block);
    }

    grid.appendChild(track);
  }

  scroll.appendChild(grid);
  scheduler.appendChild(scroll);

  rosterInitialScrollDone = true;
}

function closeRosterWeekOverview() {
  rosterWeekOverviewOpen = false;
  $("rosterWeekOverview")?.classList.add("hidden");
  $("rosterScheduler")?.classList.remove("hidden");

  $("rosterDailyViewBtn")?.classList.add("active");
  $("rosterThisWeekBtn")?.classList.remove("active");
}

async function refreshRosterWeekOverview() {
  if (!currentUser) return;

  if (!rosterProfiles.length) {
    await loadRosterProfiles();
  }

  const days = rosterWeekDates(localDateString(new Date()));
  const start = days[0].dateString;
  const end = days[6].dateString;

  $("rosterWeekOverviewRange").textContent =
    `${formatRosterDate(start)} – ${formatRosterDate(end)}`;

  const { data, error } = await supabase
    .from("gcfr_roster_shifts")
    .select("id, user_id, shift_date, start_time, end_time, assignment, notes")
    .gte("shift_date", start)
    .lte("shift_date", end)
    .order("shift_date", { ascending: true })
    .order("start_time", { ascending: true });

  if (error) {
    $("rosterWeekOverviewGrid").innerHTML =
      `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  rosterWeekShifts = data || [];
  renderRosterWeekOverview();
}

function renderRosterWeekOverview() {
  const container = $("rosterWeekOverviewGrid");
  if (!container) return;

  const days = rosterWeekDates(localDateString(new Date()));
  const shifts =
    rosterViewMode === "mine"
      ? rosterWeekShifts.filter((shift) => shift.user_id === currentUser?.id)
      : rosterWeekShifts;

  const byDate = new Map();

  for (const day of days) {
    byDate.set(day.dateString, []);
  }

  for (const shift of shifts) {
    if (byDate.has(shift.shift_date)) {
      byDate.get(shift.shift_date).push(shift);
    }
  }

  container.innerHTML = "";

  for (const day of days) {
    const row = document.createElement("section");
    row.className = "roster-week-day-row";

    const isToday = day.dateString === localDateString(new Date());
    if (isToday) row.classList.add("today");

    const date = dateFromLocalString(day.dateString);

    const head = document.createElement("div");
    head.className = "roster-week-day-head";
    head.innerHTML = `
      <strong>${escapeHtml(new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date))}</strong>
      <span>${escapeHtml(new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date))}</span>
    `;

    const list = document.createElement("div");
    list.className = "roster-week-day-shifts";

    const dayShifts = byDate.get(day.dateString) || [];

    if (!dayShifts.length) {
      list.innerHTML = `<div class="roster-week-empty">No shifts</div>`;
    } else {
      for (const shift of dayShifts) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "roster-week-shift-row";

        if (!isOwnerUser()) {
          item.disabled = true;
        }

        const name = rosterProfileMap.get(shift.user_id) || "User";
        const time = `${formatRosterTime(shift.start_time)}–${formatRosterTime(shift.end_time)}`;

        item.innerHTML = `
          <div class="roster-week-shift-main">
            <strong>${escapeHtml(name)}</strong>
            <span class="roster-week-shift-time">${escapeHtml(time)}</span>
          </div>
          <small>${escapeHtml(shift.assignment || "Fresh Produce")}</small>
        `;

        if (isOwnerUser()) {
          item.onclick = () => {
            closeRosterWeekOverview();
            rosterSelectedDate = shift.shift_date;
            syncRosterDateControls();
            renderRosterScheduler();
            openRosterShiftForm(shift);
          };
        }

        list.appendChild(item);
      }
    }

    row.append(head, list);
    container.appendChild(row);
  }
}

function openRosterShiftForm(shift = null) {
  if (!isOwnerUser()) return;

  const wrap = $("rosterShiftFormWrap");
  wrap.classList.remove("hidden");

  if (shift) {
    setRosterShiftEntryMode("daily");
    $("rosterShiftModeToggle").classList.add("hidden");
    $("rosterFormTitle").textContent = "Edit Shift";
    $("rosterShiftId").value = String(shift.id);
    $("rosterShiftUser").value = shift.user_id;
    $("rosterShiftStart").value = String(shift.start_time || "").slice(0, 5);
    $("rosterShiftEnd").value = String(shift.end_time || "").slice(0, 5);
    $("rosterShiftRole").value = shift.assignment || "Fresh Produce";
    $("rosterShiftNotes").value = shift.notes || "";
    $("rosterShiftDeleteBtn").classList.remove("hidden");
    $("rosterShiftSaveBtn").textContent = "Save Shift";
  } else {
    $("rosterShiftModeToggle").classList.remove("hidden");
    setRosterShiftEntryMode("daily");

    $("rosterFormTitle").textContent = `Add Shift • ${formatRosterDate(rosterSelectedDate)}`;
    $("rosterShiftId").value = "";

    if (
      currentUser
      && rosterProfiles.some((profile) => profile.id === currentUser.id)
    ) {
      $("rosterShiftUser").value = currentUser.id;
    }

    $("rosterShiftStart").value = "07:00";
    $("rosterShiftEnd").value = "16:00";
    $("rosterShiftRole").value = "Fresh Produce";
    $("rosterShiftNotes").value = "";
    $("rosterShiftDeleteBtn").classList.add("hidden");

    renderWeeklyRosterEditor();
  }

  wrap.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
  });
}

function closeRosterShiftForm() {
  $("rosterShiftFormWrap")?.classList.add("hidden");
  $("rosterShiftId").value = "";
  $("rosterShiftDeleteBtn")?.classList.add("hidden");
  $("rosterShiftModeToggle")?.classList.remove("hidden");
  setRosterShiftEntryMode("daily");
}

function rosterWeekDates(anchorDateString) {
  const anchor = dateFromLocalString(anchorDateString);
  const monday = new Date(anchor);
  const offset = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - offset);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);

    return {
      dateString: localDateString(date),
      label: new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(date),
    };
  });
}

function renderWeeklyRosterEditor() {
  const container = $("rosterWeeklyDays");
  if (!container) return;

  const days = rosterWeekDates(rosterSelectedDate);
  const first = days[0];
  const last = days[6];

  $("rosterWeeklyRange").textContent =
    `${formatRosterDate(first.dateString)} – ${formatRosterDate(last.dateString)}`;

  container.innerHTML = "";

  for (const [index, day] of days.entries()) {
    const row = document.createElement("div");
    row.className = "roster-weekly-day-row";
    row.dataset.date = day.dateString;

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "roster-weekly-day-toggle";

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "roster-weekly-enabled";
    enabled.checked = index < 5;

    const dayText = document.createElement("span");
    dayText.innerHTML = `
      <strong>${escapeHtml(day.label.split(" ")[0])}</strong>
      <small>${escapeHtml(day.label.replace(/^[^ ]+ /, ""))}</small>
    `;

    enabledLabel.append(enabled, dayText);

    const startLabel = document.createElement("label");
    startLabel.className = "roster-weekly-time";
    startLabel.innerHTML = `<span>Start</span>`;
    const startInput = document.createElement("input");
    startInput.type = "time";
    startInput.className = "roster-weekly-start";
    startInput.value = "07:00";
    startLabel.appendChild(startInput);

    const endLabel = document.createElement("label");
    endLabel.className = "roster-weekly-time";
    endLabel.innerHTML = `<span>Finish</span>`;
    const endInput = document.createElement("input");
    endInput.type = "time";
    endInput.className = "roster-weekly-end";
    endInput.value = "16:00";
    endLabel.appendChild(endInput);

    function syncEnabledState() {
      startInput.disabled = !enabled.checked;
      endInput.disabled = !enabled.checked;
      row.classList.toggle("disabled", !enabled.checked);
    }

    enabled.onchange = syncEnabledState;
    syncEnabledState();

    row.append(enabledLabel, startLabel, endLabel);
    container.appendChild(row);
  }
}

function getWeeklyRosterEntries() {
  return [...document.querySelectorAll(".roster-weekly-day-row")]
    .map((row) => {
      const enabled = row.querySelector(".roster-weekly-enabled");
      const start = row.querySelector(".roster-weekly-start");
      const end = row.querySelector(".roster-weekly-end");

      return {
        enabled: !!enabled?.checked,
        shift_date: row.dataset.date,
        label:
          row.querySelector(".roster-weekly-day-toggle strong")?.textContent
          || row.dataset.date,
        start_time: start?.value || "",
        end_time: end?.value || "",
      };
    })
    .filter((entry) => entry.enabled);
}

function rosterTimeToMinutes(value) {
  const [hours, minutes] = String(value || "00:00")
    .slice(0, 5)
    .split(":")
    .map(Number);

  return Math.max(
    0,
    Math.min(
      1439,
      (Number.isFinite(hours) ? hours : 0) * 60
        + (Number.isFinite(minutes) ? minutes : 0),
    ),
  );
}

function formatRosterTime(value) {
  return String(value || "").slice(0, 5);
}

function formatRosterDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(dateFromLocalString(value));
}

// ---------- TEAM CHAT ----------
$("refreshChatBtn").onclick = async () => {
  await refreshChat({ scrollToBottom: false });
};

$("chatForm").onsubmit = async (event) => {
  event.preventDefault();

  if (!currentUser) return;

  const input = $("chatInput");
  const message = input.value.trim();

  if (!message) return;

  const button = $("chatSendBtn");
  button.disabled = true;

  const { error } = await supabase
    .from("gcfr_chat_messages")
    .insert({
      sender_id: currentUser.id,
      message,
    });

  button.disabled = false;

  if (error) {
    showToast(error.message);
    return;
  }

  input.value = "";
  resizeChatInput();
  await refreshChat({ scrollToBottom: true });
};

$("chatInput").addEventListener("input", resizeChatInput);

$("chatInput").addEventListener("keydown", (event) => {
  if (
    event.key === "Enter"
    && !event.shiftKey
    && !event.isComposing
  ) {
    event.preventDefault();
    $("chatForm").requestSubmit();
  }
});

function resizeChatInput() {
  const input = $("chatInput");
  if (!input) return;

  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

function getChatLastSeenId() {
  const raw = localStorage.getItem(chatLastSeenKey());
  const value = Number(raw || "0");
  return Number.isFinite(value) ? value : 0;
}

function setChatLastSeenId(id) {
  if (!currentUser || !id) return;

  localStorage.setItem(
    chatLastSeenKey(),
    String(id),
  );
}

async function initializeChatUnreadState() {
  if (!currentUser) return;

  const key = chatLastSeenKey();
  const existing = localStorage.getItem(key);

  if (existing === null) {
    const { data, error } = await supabase
      .from("gcfr_chat_messages")
      .select("id")
      .order("id", { ascending: false })
      .limit(1);

    if (!error && data?.length) {
      localStorage.setItem(key, String(data[0].id));
    } else {
      localStorage.setItem(key, "0");
    }
  }

  await refreshChatUnreadCount();
}

async function refreshChatUnreadCount() {
  if (!currentUser) return;

  const badge = $("chatNavBadge");
  if (!badge) return;

  if ($("screen-chat")?.classList.contains("active")) {
    badge.classList.add("hidden");
    badge.textContent = "0";
    return;
  }

  const lastSeenId = getChatLastSeenId();

  const { count, error } = await supabase
    .from("gcfr_chat_messages")
    .select("id", { count: "exact", head: true })
    .gt("id", lastSeenId)
    .neq("sender_id", currentUser.id);

  if (error) return;

  const unread = Number(count || 0);
  badge.textContent = unread > 99 ? "99+" : String(unread);
  badge.classList.toggle("hidden", unread === 0);
}

async function refreshChat({ scrollToBottom = false } = {}) {
  if (!currentUser) return;

  const container = $("chatMessages");
  if (!container) return;

  const wasNearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 100;

  container.setAttribute("aria-busy", "true");

  const { data, error } = await supabase
    .from("gcfr_chat_messages")
    .select("id, sender_id, message, created_at, edited_at")
    .order("id", { ascending: false })
    .limit(150);

  container.removeAttribute("aria-busy");

  if (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  chatMessages = [...(data || [])].reverse();

  const senderIds = [...new Set(
    chatMessages
      .map((message) => message.sender_id)
      .filter(Boolean)
  )];

  chatProfileMap = new Map();

  if (senderIds.length) {
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, display_name, username")
      .in("id", senderIds);

    if (!profilesError) {
      chatProfileMap = new Map(
        (profiles || []).map((profile) => [
          profile.id,
          profile.display_name || profile.username || "User",
        ]),
      );
    }
  }

  renderChatMessages();

  const newestId = chatMessages.at(-1)?.id;

  if ($("screen-chat")?.classList.contains("active") && newestId) {
    setChatLastSeenId(newestId);
    $("chatNavBadge").classList.add("hidden");
    $("chatNavBadge").textContent = "0";
  }

  if (scrollToBottom || wasNearBottom) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function renderChatMessages() {
  const container = $("chatMessages");
  container.innerHTML = "";

  if (!chatMessages.length) {
    container.innerHTML = `<div class="empty-state">No messages yet.</div>`;
    return;
  }

  let previousDate = "";

  for (const message of chatMessages) {
    const dateKey = localDateString(new Date(message.created_at));

    if (dateKey !== previousDate) {
      const separator = document.createElement("div");
      separator.className = "chat-date-separator";
      separator.textContent = formatChatDate(message.created_at);
      container.appendChild(separator);
      previousDate = dateKey;
    }

    const own = message.sender_id === currentUser?.id;
    const sender =
      chatProfileMap.get(message.sender_id)
      || knownUserDisplayName(message.sender_id, chatProfileMap)
      || "User";

    const row = document.createElement("article");
    row.className = `chat-message ${own ? "own" : "other"}`;

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    meta.innerHTML = `
      <strong>${escapeHtml(sender)}</strong>
      <span>${escapeHtml(formatChatTime(message.created_at))}${message.edited_at ? " · edited" : ""}</span>
    `;

    const body = document.createElement("div");
    body.className = "chat-message-body";
    body.textContent = message.message;

    bubble.append(meta, body);

    const canEdit = own;
    const canDelete = own || isOwnerUser();

    if (canEdit || canDelete) {
      const actions = document.createElement("div");
      actions.className = "chat-message-actions";

      if (canEdit) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "text-button";
        edit.textContent = "Edit";
        edit.onclick = async () => {
          await editChatMessage(message);
        };
        actions.appendChild(edit);
      }

      if (canDelete) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "text-button chat-delete-button";
        del.textContent = "Delete";
        del.onclick = async () => {
          await deleteChatMessage(message);
        };
        actions.appendChild(del);
      }

      bubble.appendChild(actions);
    }

    row.appendChild(bubble);
    container.appendChild(row);
  }
}

async function editChatMessage(message) {
  if (message.sender_id !== currentUser?.id) return;

  const updated = prompt(
    "Edit message",
    message.message,
  );

  if (updated === null) return;

  const clean = updated.trim();

  if (!clean) {
    showToast("Message cannot be empty.");
    return;
  }

  if (clean === message.message) return;

  const { error } = await supabase
    .from("gcfr_chat_messages")
    .update({
      message: clean,
    })
    .eq("id", message.id)
    .eq("sender_id", currentUser.id);

  if (error) {
    showToast(error.message);
    return;
  }

  await refreshChat({ scrollToBottom: false });
}

async function deleteChatMessage(message) {
  const own = message.sender_id === currentUser?.id;

  if (!own && !isOwnerUser()) return;

  if (!confirm("Delete this message?")) return;

  let query = supabase
    .from("gcfr_chat_messages")
    .delete()
    .eq("id", message.id);

  if (!isOwnerUser()) {
    query = query.eq("sender_id", currentUser.id);
  }

  const { error } = await query;

  if (error) {
    showToast(error.message);
    return;
  }

  await refreshChat({ scrollToBottom: false });
}

function formatChatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatChatDate(value) {
  const date = new Date(value);
  const today = localDateString(new Date());
  const target = localDateString(date);

  if (target === today) return "Today";

  const yesterday = shiftDate(today, -1);
  if (target === yesterday) return "Yesterday";

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

// ---------- FRESH PROMOTION ALERT ----------
function freshPromoSeenKey() {
  return currentUser?.id
    ? `gcfr_fresh_promo_seen_${currentUser.id}`
    : "gcfr_fresh_promo_seen";
}

async function refreshFreshPromoAlert() {
  const button = $("freshPromoAlertBtn");
  if (!button || !currentUser) return;

  button.classList.add("hidden");

  try {
    const { data, error } = await supabase.functions.invoke(
      "gcfr-coles-pricing",
      {
        body: { action: "promo_status" },
      },
    );

    if (error || !data?.week_start) {
      console.warn("Fresh promo status unavailable:", error || data);
      return;
    }

    const seenWeek = localStorage.getItem(freshPromoSeenKey());
    const hasUpdate = seenWeek !== data.week_start;

    button.dataset.weekStart = data.week_start;
    button.dataset.specialsUrl = data.fresh_specials_url || "";

    if ($("freshPromoWeekStart")) {
      $("freshPromoWeekStart").textContent = new Intl.DateTimeFormat(
        undefined,
        { day: "numeric", month: "short", year: "numeric" },
      ).format(dateFromLocalString(data.week_start));
    }

    if ($("freshPromoWeekLabel")) {
      $("freshPromoWeekLabel").textContent =
        `Week starting ${data.week_start} · Coles Griffith`;
    }

    if ($("freshPromoColesLink") && data.fresh_specials_url) {
      $("freshPromoColesLink").href = data.fresh_specials_url;
    }

    button.classList.toggle("hidden", !hasUpdate);
  } catch (error) {
    console.warn("Fresh promo alert failed:", error);
  }
}

function openFreshPromoModal() {
  const button = $("freshPromoAlertBtn");
  const weekStart = button?.dataset?.weekStart || "";

  if (weekStart) {
    localStorage.setItem(freshPromoSeenKey(), weekStart);
  }

  button?.classList.add("hidden");
  $("freshPromoModal")?.classList.remove("hidden");
  document.documentElement.classList.add("lookup-modal-open");
  document.body.classList.add("lookup-modal-open");
}

function closeFreshPromoModal() {
  $("freshPromoModal")?.classList.add("hidden");

  if ($("productCodeLookupModal")?.classList.contains("hidden")) {
    document.documentElement.classList.remove("lookup-modal-open");
    document.body.classList.remove("lookup-modal-open");
  }
}

$("freshPromoAlertBtn")?.addEventListener("click", openFreshPromoModal);
$("freshPromoCloseBtn")?.addEventListener("click", closeFreshPromoModal);

$("freshPromoModal")?.addEventListener("click", (event) => {
  if (event.target?.dataset?.promoClose === "true") {
    closeFreshPromoModal();
  }
});

$("freshPromoOpenLookupBtn")?.addEventListener("click", () => {
  closeFreshPromoModal();
  openProductCodeLookup();
});

function formatAud(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";

  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(amount);
}


function parsePerKgPrice(comparable) {
  const text = String(comparable || "").trim();
  if (!text) return null;

  // Coles commonly returns values such as "$3.90/ 1kg".
  // Normalize whitespace first so the shelf-price parser is not format-fragile.
  const compact = text.toLowerCase().replace(/\s+/g, "");
  const match = compact.match(
    /\$?([0-9]+(?:\.[0-9]+)?)(?:\/|per)(?:1)?kg\b/,
  );

  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isApproxPriceProduct(row, product) {
  const name = `${row?.name || ""} ${product?.name || ""}`;
  const comparable = String(product?.comparable || "");

  return /\bapprox\.?\b/i.test(name)
    || /(?:\/|per\s*)(?:1\s*)?kg\b/i.test(comparable);
}

function formatLookupPrice(value, { perKg = false } = {}) {
  const formatted = formatAud(value);
  if (!formatted) return "";

  return perKg ? `${formatted} per 1kg` : formatted;
}


function getApproxSizeLabel(row, product) {
  const candidates = [
    String(product?.size || "").trim(),
    String(row?.name || "").trim(),
    String(product?.name || "").trim(),
  ];

  for (const value of candidates) {
    const match = value.match(/approx\.?\s*([0-9.]+\s*(?:g|kg))\b/i);
    if (match?.[1]) {
      return `approx. ${match[1].replace(/\s+/g, "")}`;
    }
  }

  return "approx.";
}

async function loadProductLookupPrice(row) {
  const panel = $("lookupDetailPrice");
  if (!panel) return;

  panel.innerHTML =
    '<div class="lookup-price-loading">Checking Coles Griffith price…</div>';

  try {
    const { data, error } = await supabase.functions.invoke(
      "gcfr-coles-pricing",
      {
        body: {
          action: "lookup",
          productCode: row.code || "",
          productName: row.name || "",
          storeId: "0838",
        },
      },
    );

    if (error || !data?.product) {
      panel.innerHTML = `
        <div class="lookup-price-unavailable">
          <strong>Griffith price unavailable</strong>
          <span>No automatic or manual price is currently available.</span>
        </div>
      `;
      return;
    }

    const product = data.product;

    const toMoneyNumber = (value) => {
      const amount = Number(value);
      return Number.isFinite(amount) && amount > 0 ? amount : null;
    };

    const autoNow = toMoneyNumber(product.price_now);
    const autoWas = toMoneyNumber(product.price_was);
    const manualPrice = toMoneyNumber(product.manual_price);
    const manualPriceBasis = String(product.manual_price_basis || "").trim();
    const approxProduct = isApproxPriceProduct(row, product);
    const autoComparablePerKg = approxProduct
      ? parsePerKgPrice(product.comparable)
      : null;

    let displayBasis = approxProduct ? "per_kg" : "each";
    let displayNow = null;
    let displayWas = null;
    let priceSource = "AUTO";

    if (approxProduct) {
      if (autoComparablePerKg !== null) {
        displayNow = autoComparablePerKg;

        if (
          autoWas !== null
          && autoNow !== null
          && autoNow > 0
          && autoWas > autoNow
        ) {
          displayWas = Number(
            (autoComparablePerKg * (autoWas / autoNow)).toFixed(2),
          );
        }
      } else if (manualPrice !== null && manualPriceBasis === "per_kg") {
        displayNow = manualPrice;
        priceSource = "MANUAL";
      }
    } else if (autoNow !== null) {
      displayNow = autoNow;
      displayWas = autoWas;
    } else if (manualPrice !== null) {
      displayNow = manualPrice;
      displayBasis = manualPriceBasis === "per_kg" ? "per_kg" : "each";
      priceSource = "MANUAL";
    }

    const baseDisplayNow = displayNow;
    const manualPromo = product.manual_promo || null;
    const manualPromoActive =
      product.promo_source === "MANUAL"
      && manualPromo
      && toMoneyNumber(manualPromo.promo_price) !== null;

    let promo = false;
    let promoText = "";

    if (manualPromoActive) {
      promo = true;
      displayNow = toMoneyNumber(manualPromo.promo_price);
      displayWas = toMoneyNumber(manualPromo.regular_price) ?? baseDisplayNow;
      displayBasis = manualPromo.price_basis === "per_kg" ? "per_kg" : "each";
      priceSource = "MANUAL";
      promoText = `Manual promotion · ${manualPromo.starts_on} to ${manualPromo.ends_on}`;
    } else {
      const hasNow = Number.isFinite(displayNow);
      const hasWas = Number.isFinite(displayWas) && displayWas > 0;

      promo = Boolean(
        product.promo_source === "AUTO"
        || product.is_promo
        || (hasNow && hasWas && displayWas > displayNow)
      );

      promoText =
        product.save_statement
        || (product.promotion && product.promotion !== "EVERYDAY"
          ? product.promotion
          : "");
    }

    const hasNow = Number.isFinite(displayNow);
    const hasWas = Number.isFinite(displayWas) && displayWas > 0;
    const perKg = displayBasis === "per_kg";

    const priceHtml = promo && hasNow && hasWas && displayWas > displayNow
      ? `
          <span class="lookup-price-original">${formatLookupPrice(displayWas, { perKg })}</span>
          <strong class="lookup-price-current promo">${formatLookupPrice(displayNow, { perKg })}</strong>
        `
      : `
          <strong class="lookup-price-current">${hasNow
            ? formatLookupPrice(displayNow, { perKg })
            : "Price unavailable"}</strong>
        `;

    const unitText = perKg
      ? (approxProduct
        ? "Approx. product · price per 1kg"
        : "Price per 1kg")
      : String(product.comparable || "").trim();

    const estimatedItemText =
      approxProduct
      && priceSource === "AUTO"
      && autoNow !== null
        ? `Estimated product price · ${formatAud(autoNow)} (${getApproxSizeLabel(row, product)})`
        : "";

    const sourceLabel = hasNow ? priceSource : "";
    const storeName = String(product.store_name || "Coles Griffith").trim();

    panel.innerHTML = `
      <div class="lookup-price-head">
        <span>${escapeHtml(storeName)}</span>
        ${promo ? '<b class="lookup-promo-badge">PROMO</b>' : ""}
      </div>
      <div class="lookup-price-values ${perKg ? "lookup-price-values-perkg" : ""}">${priceHtml}</div>
      ${sourceLabel ? `<div class="lookup-price-source ${sourceLabel.toLowerCase()}">${sourceLabel}</div>` : ""}
      ${promoText ? `<div class="lookup-price-promo-text">${escapeHtml(promoText)}</div>` : ""}
      ${unitText ? `<div class="lookup-price-unit">${escapeHtml(unitText)}</div>` : ""}
      ${estimatedItemText ? `<div class="lookup-price-estimated-item">${escapeHtml(estimatedItemText)}</div>` : ""}
    `;
  } catch (error) {
    console.warn("Coles Griffith price lookup failed:", error);
    panel.innerHTML = `
      <div class="lookup-price-unavailable">
        <strong>Griffith price unavailable</strong>
        <span>No automatic or manual price is currently available.</span>
      </div>
    `;
  }
}

// ---------- PRODUCT CODE LOOKUP ----------
$("openProductCodeLookupBtn").onclick = () => {
  openProductCodeLookup();
};

$("closeProductCodeLookupBtn").onclick = () => {
  closeProductCodeLookup();
};

$("productCodeLookupBackBtn").onclick = () => {
  closeProductCodeLookupDetail();
};

$("productCodeLookupModal").addEventListener("click", (event) => {
  if (event.target?.dataset?.lookupClose === "true") {
    closeProductCodeLookup();
  }
});

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape"
    && !$("productCodeLookupModal")?.classList.contains("hidden")
  ) {
    closeProductCodeLookup();
  }
});

$("productCodeLookupSearch").addEventListener("input", () => {
  clearTimeout(productCodeLookupTimer);

  const query = $("productCodeLookupSearch").value.trim();

  if (!query) {
    loadProductCodeLookupDefault();
    return;
  }

  productCodeLookupTimer = setTimeout(
    () => searchProductCodeLookup(query),
    160,
  );
});

function openProductCodeLookup() {
  const modal = $("productCodeLookupModal");
  if (!modal) return;

  modal.classList.remove("hidden");
  document.documentElement.classList.add("lookup-modal-open");
  document.body.classList.add("lookup-modal-open");

  $("productCodeLookupSearch").value = "";
  closeProductCodeLookupDetail();
  loadProductCodeLookupDefault();
}

function closeProductCodeLookup() {
  clearTimeout(productCodeLookupTimer);
  productCodeLookupTimer = null;
  productCodeLookupRequestId += 1;

  $("productCodeLookupModal")?.classList.add("hidden");
  document.documentElement.classList.remove("lookup-modal-open");
  document.body.classList.remove("lookup-modal-open");

  if ($("productCodeLookupSearch")) {
    $("productCodeLookupSearch").value = "";
  }

  if ($("productCodeLookupResults")) {
    $("productCodeLookupResults").innerHTML = "";
  }

  closeProductCodeLookupDetail();
}

async function loadProductCodeLookupDefault() {
  const requestId = ++productCodeLookupRequestId;
  const results = $("productCodeLookupResults");

  results.classList.remove("hidden");
  results.innerHTML = '<div class="empty-state">Loading products A–Z…</div>';

  try {
    const catalog = await loadProductSearchCatalog();

    if (requestId !== productCodeLookupRequestId) return;

    const rows = [...catalog]
      .sort((a, b) =>
        String(a.name || "").localeCompare(
          String(b.name || ""),
          undefined,
          { sensitivity: "base", numeric: true },
        )
        || String(a.code || "").localeCompare(String(b.code || ""))
      )
      .map((product) => ({
        code: String(product.code || "").trim(),
        name: String(product.name || "").trim(),
        ticketBarcodes: [],
        exactBarcodeMatch: false,
      }));

    renderProductCodeLookupResults(rows, {
      label: "products · A–Z",
      defaultList: true,
    });
  } catch (error) {
    if (requestId !== productCodeLookupRequestId) return;

    results.innerHTML =
      `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function searchProductCodeLookup(rawQuery) {
  const requestId = ++productCodeLookupRequestId;
  const query = String(rawQuery || "").trim();
  const results = $("productCodeLookupResults");

  if (!query) return;

  results.innerHTML = `<div class="empty-state">Searching...</div>`;

  try {
    const catalog = await loadProductSearchCatalog();

    if (requestId !== productCodeLookupRequestId) return;

    const ranked = rankProductSearchResults(catalog, query);
    const resultMap = new Map();

    // Product name / Product Code matches.
    for (const product of ranked.slice(0, 60)) {
      resultMap.set(product.code, {
        code: product.code,
        name: product.name,
        ticketBarcodes: [],
        exactBarcodeMatch: false,
      });
    }

    const normalized = normalizeScannedBarcode(query);

    // Exact saved Ticket Barcode match goes first when the query is 7–8 digits.
    if (/^\d{7,8}$/.test(normalized)) {
      const { data: exactRows, error: exactError } = await supabase
        .from("product_barcodes")
        .select("barcode, product_code, products(name)")
        .eq("barcode_type", "ticket_barcode")
        .eq("barcode", normalized);

      if (exactError) throw exactError;

      for (const row of exactRows || []) {
        const name = Array.isArray(row.products)
          ? row.products[0]?.name
          : row.products?.name;

        const current = resultMap.get(row.product_code) || {
          code: row.product_code,
          name: name || "Unknown product",
          ticketBarcodes: [],
          exactBarcodeMatch: true,
        };

        current.exactBarcodeMatch = true;

        if (!current.ticketBarcodes.includes(row.barcode)) {
          current.ticketBarcodes.push(row.barcode);
        }

        resultMap.set(row.product_code, current);
      }
    }

    const codes = [...resultMap.keys()];

    if (codes.length) {
      const { data: barcodeRows, error: barcodeError } = await supabase
        .from("product_barcodes")
        .select("barcode, product_code")
        .eq("barcode_type", "ticket_barcode")
        .in("product_code", codes);

      if (barcodeError) throw barcodeError;

      for (const row of barcodeRows || []) {
        const barcode = String(row.barcode || "").trim();

        if (!/^\d{7,8}$/.test(barcode)) continue;

        const current = resultMap.get(row.product_code);
        if (!current) continue;

        if (!current.ticketBarcodes.includes(barcode)) {
          current.ticketBarcodes.push(barcode);
        }
      }
    }

    if (requestId !== productCodeLookupRequestId) return;

    const rows = [...resultMap.values()]
      .sort((a, b) => {
        if (a.exactBarcodeMatch !== b.exactBarcodeMatch) {
          return a.exactBarcodeMatch ? -1 : 1;
        }

        const aIndex = ranked.findIndex((item) => item.code === a.code);
        const bIndex = ranked.findIndex((item) => item.code === b.code);

        const ai = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
        const bi = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;

        return ai - bi || a.name.localeCompare(b.name);
      })
      .slice(0, 60);

    renderProductCodeLookupResults(rows, { label: "results", defaultList: false });
  } catch (error) {
    if (requestId !== productCodeLookupRequestId) return;

    results.innerHTML =
      `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderProductCodeLookupResults(
  rows,
  { label = "results", defaultList = false } = {},
) {
  const results = $("productCodeLookupResults");
  results.innerHTML = "";

  if (!rows.length) {
    results.innerHTML =
      '<div class="empty-state">No matching products.</div>';
    return;
  }

  const count = document.createElement("div");
  count.className = "lookup-result-count";
  count.textContent = `${rows.length} ${label}`;
  results.appendChild(count);

  for (const row of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lookup-result-card lookup-result-button";
    button.dataset.productCode = row.code || "";

    const barcodeBadge = row.exactBarcodeMatch
      ? '<span class="lookup-match-badge">Barcode match</span>'
      : "";

    button.innerHTML = `
      <span class="lookup-result-main">
        <span class="lookup-result-name">${escapeHtml(row.name || "Unknown product")}</span>
        <span class="lookup-result-meta">
          <span>Product Code</span>
          <strong>${escapeHtml(row.code || "-")}</strong>
          ${barcodeBadge}
        </span>
      </span>
      <span class="lookup-result-arrow" aria-hidden="true">›</span>
    `;

    button.onclick = () => {
      openProductCodeLookupDetail(row);
    };

    results.appendChild(button);
  }

  if (defaultList) {
    results.scrollTop = 0;
  }
}

async function fetchLookupTicketBarcodes(productCode) {
  const code = String(productCode || "").trim();
  if (!code) return [];

  const { data, error } = await supabase
    .from("product_barcodes")
    .select("barcode")
    .eq("product_code", code)
    .eq("barcode_type", "ticket_barcode")
    .order("barcode", { ascending: true });

  if (error) throw error;

  return [...new Set(
    (data || [])
      .map((row) => String(row.barcode || "").trim())
      .filter((barcode) => /^\d{7,8}$/.test(barcode))
  )];
}

async function openProductCodeLookupDetail(row) {
  $("productCodeLookupSearch").closest(".lookup-search-block")?.classList.add("hidden");
  $("productCodeLookupResults").classList.add("hidden");
  $("productCodeLookupDetail").classList.remove("hidden");

  $("lookupDetailName").textContent = row.name || "Unknown product";
  $("lookupDetailProductCode").textContent = row.code || "-";
  loadProductLookupPrice(row);

  const container = $("lookupDetailBarcodes");
  container.innerHTML = "";

  let barcodes = [];

  try {
    barcodes = await fetchLookupTicketBarcodes(row.code);
  } catch (error) {
    console.warn("Ticket Barcode lookup failed:", error);
    barcodes = (row.ticketBarcodes || [])
      .map((value) => String(value || "").trim())
      .filter((value) => /^\d{7,8}$/.test(value));
  }

  if (!barcodes.length) {
    container.innerHTML = `
      <div class="lookup-no-barcode">
        <strong>Ticket Barcode not registered</strong>
        <span>Ask Joey, Troy J or Alex S to register this product's ticket barcode.</span>
      </div>
    `;
    return;
  }

  for (const barcode of barcodes) {
    const card = document.createElement("div");
    card.className = "lookup-barcode-card";

    const label = document.createElement("div");
    label.className = "lookup-barcode-label";
    label.textContent = "Ticket Barcode";

    const visual = createCode128BarcodeSvg(barcode);
    visual.classList.add("lookup-barcode-svg");

    const value = document.createElement("div");
    value.className = "lookup-barcode-value";
    value.textContent = barcode;

    card.append(label, visual, value);
    container.appendChild(card);
  }
}

function closeProductCodeLookupDetail() {
  $("productCodeLookupDetail")?.classList.add("hidden");
  $("productCodeLookupSearch")
    ?.closest(".lookup-search-block")
    ?.classList.remove("hidden");
  $("productCodeLookupResults")?.classList.remove("hidden");
}

function createCode128BarcodeSvg(value) {
  // Code 128 Set B preserves the exact saved 7/8-digit Ticket Barcode.
  // No Product Code inference and no check digit is added to the displayed value.
  const patterns = [
    "212222","222122","222221","121223","121322","131222","122213","122312",
    "132212","221213","221312","231212","112232","122132","122231","113222",
    "123122","123221","223211","221132","221231","213212","223112","312131",
    "311222","321122","321221","312212","322112","322211","212123","212321",
    "232121","111323","131123","131321","112313","132113","132311","211313",
    "231113","231311","112133","112331","132131","113123","113321","133121",
    "313121","211331","231131","213113","213311","213131","311123","311321",
    "331121","312113","312311","332111","314111","221411","431111","111224",
    "111422","121124","121421","141122","141221","112214","112412","122114",
    "122411","142112","142211","241211","221114","413111","241112","134111",
    "111242","121142","121241","114212","124112","124211","411212","421112",
    "421211","212141","214121","412121","111143","111341","131141","114113",
    "114311","411113","411311","113141","114131","311141","411131","211412",
    "211214","211232","2331112"
  ];

  const startCode = 104; // Code Set B
  const codes = [startCode];

  for (const char of value) {
    const code = char.charCodeAt(0) - 32;
    codes.push(code);
  }

  let checksum = startCode;

  for (let index = 1; index < codes.length; index += 1) {
    checksum += codes[index] * index;
  }

  checksum %= 103;

  const sequence = [...codes, checksum, 106];
  const quietModules = 10;
  const moduleWidth = 2;
  const height = 88;

  let totalModules = quietModules * 2;

  for (const code of sequence) {
    totalModules += [...patterns[code]]
      .reduce((sum, width) => sum + Number(width), 0);
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${totalModules * moduleWidth} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Ticket barcode ${value}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", "0");
  background.setAttribute("y", "0");
  background.setAttribute("width", String(totalModules * moduleWidth));
  background.setAttribute("height", String(height));
  background.setAttribute("fill", "white");
  svg.appendChild(background);

  let x = quietModules * moduleWidth;

  for (const code of sequence) {
    const pattern = patterns[code];
    let black = true;

    for (const widthChar of pattern) {
      const width = Number(widthChar) * moduleWidth;

      if (black) {
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", String(x));
        rect.setAttribute("y", "4");
        rect.setAttribute("width", String(width));
        rect.setAttribute("height", String(height - 8));
        rect.setAttribute("fill", "black");
        svg.appendChild(rect);
      }

      x += width;
      black = !black;
    }
  }

  return svg;
}

// ---------- DRAFT RUN LIST ----------
function draftStorageKey(userId = currentUser?.id) {
  return userId ? `gcfr_draft_run_${userId}` : "";
}

function loadDraft(userId = currentUser?.id) {
  if (!userId) return [];

  const key = draftStorageKey(userId);
  let items = [];

  try {
    const saved = localStorage.getItem(key);

    // One-time migration from the old shared draft key.
    // The persisted session that first opens this version receives its own
    // legacy draft, then the shared key is removed so it cannot leak to another user.
    const legacy = localStorage.getItem("gcfr_draft_run");

    if (saved !== null) {
      items = JSON.parse(saved || "[]");
    } else if (legacy !== null) {
      items = JSON.parse(legacy || "[]");
      localStorage.setItem(key, JSON.stringify(Array.isArray(items) ? items : []));
      localStorage.removeItem("gcfr_draft_run");
    }

    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }

  // Migrate any very old Manual Draft into the current user's Draft once.
  try {
    const oldManual = JSON.parse(localStorage.getItem("gcfr_manual_draft") || "[]");

    if (Array.isArray(oldManual) && oldManual.length) {
      for (const name of oldManual) {
        const clean = String(name || "").trim();

        if (clean) {
          items.push({
            manual_name: clean,
            name: clean,
            gap_check_required: false,
          });
        }
      }

      localStorage.removeItem("gcfr_manual_draft");
      localStorage.setItem(key, JSON.stringify(items));
    }
  } catch {}

  return items;
}

function saveDraft() {
  const key = draftStorageKey();
  if (!key) return;

  localStorage.setItem(key, JSON.stringify(draft));
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
    if (canManageProductData()) {
      openManualProductRegistration(clean);
      return;
    }

    showToast(`Product ${clean} is not in the database. Ask Joey, Troy J or Alex S to register it.`);
    return;
  }

  closeManualProductRegistration();

  draft.push({
    code: data.code,
    name: data.name,
    gap_check_required: false,
  });

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


function openManualProductRegistration(productCode) {
  const panel = $("manualProductRegisterPanel");
  if (!panel) return;

  $("manualProductRegisterCode").value = String(productCode || "").trim();
  $("manualProductRegisterName").value = "";
  panel.classList.remove("hidden");

  requestAnimationFrame(() => {
    $("manualProductRegisterName")?.focus();
  });
}

function closeManualProductRegistration() {
  $("manualProductRegisterPanel")?.classList.add("hidden");

  if ($("manualProductRegisterCode")) {
    $("manualProductRegisterCode").value = "";
  }

  if ($("manualProductRegisterName")) {
    $("manualProductRegisterName").value = "";
  }
}

$("manualProductRegisterCloseBtn").onclick = closeManualProductRegistration;

$("manualProductRegisterForm").onsubmit = async (event) => {
  event.preventDefault();

  if (!canManageProductData()) {
    showToast("Product registration is available to Joey, Troy J and Alex S.");
    return;
  }

  const productCode = $("manualProductRegisterCode").value.trim();
  const productName = $("manualProductRegisterName").value.trim();

  if (!productCode || !productName) {
    showToast("Enter Product Code and Product Name.");
    return;
  }

  if (draft.some((item) => item.code === productCode)) {
    closeManualProductRegistration();
    showToast("Already in the draft.");
    return;
  }

  const button = $("manualProductRegisterBtn");
  button.disabled = true;
  button.textContent = "Registering...";

  const { data, error } = await supabase.rpc(
    "register_manual_product_for_run",
    {
      _product_code: productCode,
      _product_name: productName,
    },
  );

  button.disabled = false;
  button.textContent = "Register & Add";

  if (error) {
    showToast(error.message);
    return;
  }

  const product = Array.isArray(data) && data.length
    ? data[0]
    : { code: productCode, name: productName };

  productSearchCatalog = null;

  draft.push({
    code: product.code || productCode,
    name: product.name || productName,
    gap_check_required: false,
  });

  saveDraft();
  renderDraft();
  closeManualProductRegistration();

  showToast(`${product.name || productName} registered and added.`);
};


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

  productSearchTimer = setTimeout(() => searchProducts(query), 140);
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

function normalizeProductSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function loadProductSearchCatalog() {
  if (productSearchCatalog) return productSearchCatalog;
  if (productSearchCatalogPromise) return productSearchCatalogPromise;

  productSearchCatalogPromise = (async () => {
    const all = [];
    const pageSize = 1000;
    let from = 0;

    while (true) {
      const { data, error } = await supabase
        .from("products")
        .select("code, name")
        .order("name", { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) throw error;

      const page = data || [];
      all.push(...page);

      if (page.length < pageSize) break;
      from += pageSize;
    }

    productSearchCatalog = all;
    return all;
  })();

  try {
    return await productSearchCatalogPromise;
  } finally {
    productSearchCatalogPromise = null;
  }
}

function scoreProductSearchMatch(product, query) {
  const normalizedQuery = normalizeProductSearchText(query);
  if (!normalizedQuery) return null;

  const terms = normalizedQuery.split(" ").filter(Boolean);
  const name = normalizeProductSearchText(product.name);
  const code = normalizeProductSearchText(product.code);
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const compactName = name.replace(/\s+/g, "");
  const compactCode = code.replace(/\s+/g, "");

  const tokenHits = [];

  for (const term of terms) {
    const namePos = name.indexOf(term);
    const codePos = code.indexOf(term);

    if (namePos < 0 && codePos < 0) {
      return null;
    }

    tokenHits.push({
      namePos,
      codePos,
      bestPos:
        namePos >= 0 && codePos >= 0
          ? Math.min(namePos, codePos)
          : Math.max(namePos, codePos),
    });
  }

  const exactCode =
    code === normalizedQuery
    || compactCode === compactQuery;

  const exactName =
    name === normalizedQuery
    || compactName === compactQuery;

  const phraseNamePos = name.indexOf(normalizedQuery);
  const phraseCodePos = code.indexOf(normalizedQuery);

  let tier = 8;
  let primaryPos = Number.MAX_SAFE_INTEGER;

  if (exactCode) {
    tier = 0;
    primaryPos = 0;
  } else if (exactName) {
    tier = 1;
    primaryPos = 0;
  } else if (phraseNamePos === 0) {
    tier = 2;
    primaryPos = 0;
  } else if (phraseCodePos === 0) {
    tier = 3;
    primaryPos = 0;
  } else if (phraseNamePos >= 0) {
    tier = 4;
    primaryPos = phraseNamePos;
  } else if (phraseCodePos >= 0) {
    tier = 5;
    primaryPos = phraseCodePos;
  } else {
    const namePositions = tokenHits
      .map((hit) => hit.namePos)
      .filter((pos) => pos >= 0);

    if (namePositions.length === terms.length) {
      tier = 6;
      primaryPos = namePositions[0];
    } else {
      tier = 7;
      primaryPos = Math.min(...tokenHits.map((hit) => hit.bestPos));
    }
  }

  const orderedNamePositions = terms.map((term) => name.indexOf(term));
  let orderPenalty = 0;
  let previous = -1;

  for (const pos of orderedNamePositions) {
    if (pos < 0) {
      orderPenalty += 10000;
      continue;
    }

    if (previous > pos) orderPenalty += 5000;
    previous = pos;
  }

  const positionSum = tokenHits.reduce(
    (sum, hit) => sum + Math.max(0, hit.bestPos),
    0,
  );

  return {
    product,
    tier,
    primaryPos,
    orderPenalty,
    positionSum,
    nameLength: name.length,
    name,
    code,
  };
}

function rankProductSearchResults(products, query) {
  return products
    .map((product) => scoreProductSearchMatch(product, query))
    .filter(Boolean)
    .sort((a, b) => (
      a.tier - b.tier
      || a.primaryPos - b.primaryPos
      || a.orderPenalty - b.orderPenalty
      || a.positionSum - b.positionSum
      || a.nameLength - b.nameLength
      || a.name.localeCompare(b.name)
      || a.code.localeCompare(b.code)
    ))
    .map((entry) => entry.product);
}

async function searchProducts(query) {
  const requestId = ++productSearchRequestId;
  const results = $("productSearchResults");

  results.classList.remove("hidden");
  results.innerHTML = `<div class="search-result-empty">Searching...</div>`;

  try {
    const catalog = await loadProductSearchCatalog();
    if (requestId !== productSearchRequestId) return;

    const matches = rankProductSearchResults(catalog, query);
    renderProductSearchResults(matches);
  } catch (error) {
    if (requestId !== productSearchRequestId) return;

    results.innerHTML = `<div class="search-result-empty">${escapeHtml(error.message)}</div>`;
  }
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

  const count = document.createElement("div");
  count.className = "search-result-count";
  count.textContent = `${products.length} match${products.length === 1 ? "" : "es"}`;
  results.appendChild(count);

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
  if (!draft.length || !currentUser) return;

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

    const { data, error } = await supabase.rpc(
      "gcfr_submit_run_for_authenticated",
      {
        _items: items,
      },
    );

    if (error) throw error;

    const created = Boolean(data?.created);
    const skipped = Number(data?.skipped || 0);

    draft = [];
    saveDraft();
    renderDraft();

    $("manualCodeForm")?.reset();
    closeManualProductRegistration();
    resetScannerUiState();

    clearElementValue("productSearch");
    hideProductSearchResults();

    if (created) {
      showToast("New Run submitted.");
    } else {
      const suffix = skipped
        ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`
        : "";
      showToast(`Added to the current Run${suffix}.`);
    }

    await refreshRuns();
  } catch (error) {
    showToast(error.message);
  } finally {
    $("submitRunBtn").textContent = "Submit Run List";
    $("submitRunBtn").disabled = draft.length === 0;
  }
};

// ---------- CAMERA ----------
$("scanBtn").onclick = startScanner;
$("stopScannerBtn").onclick = resetScannerUiState;
$("barcodeLinkCloseBtn").onclick = closeBarcodeLinkPanel;

$("barcodeManualRegisterLaunchBtn").onclick = () => {
  if (!pendingUnknownBarcode || !canManageProductData()) return;

  $("barcodeManualRegisterPanel").classList.remove("hidden");
  $("barcodeManualRegisterLaunchBtn").classList.add("hidden");
  $("barcodeManualProductCode").focus();
};

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
  const { data, error } = await supabase.rpc(
    "gcfr_resolve_run_barcode",
    {
      _barcode: String(barcode || "").trim(),
    },
  );

  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new Error("Barcode lookup database update has not been applied yet.");
    }
    throw error;
  }

  return Array.isArray(data) && data.length ? data[0] : null;
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
  const canRegister = canManageProductData();

  $("barcodeAdminLinkTools").classList.toggle("hidden", !isAdmin);
  $("barcodeManualRegisterLaunchBtn").classList.toggle("hidden", !canRegister);
  $("barcodeManualRegisterPanel").classList.add("hidden");

  $("barcodeLinkMessage").textContent = isAdmin
    ? "This barcode is not linked. Search an existing product or use Manual Register."
    : "Product not registered. Please request Joey, Troy J or Alex S to register this item.";

  $("barcodeLinkSearch").value = "";
  $("barcodeLinkResults").innerHTML = "";
  $("barcodeLinkResults").classList.add("hidden");
  $("barcodeManualProductCode").value = "";
  $("barcodeManualProductName").value = "";

  if (isAdmin) {
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

  if ($("barcodeManualProductCode")) {
    $("barcodeManualProductCode").value = "";
  }

  if ($("barcodeManualProductName")) {
    $("barcodeManualProductName").value = "";
  }

  $("barcodeManualRegisterLaunchBtn")?.classList.add("hidden");
  $("barcodeManualRegisterPanel")?.classList.add("hidden");
}

async function searchProductsForBarcodeLink(query) {
  if (!pendingUnknownBarcode || currentUser?.id !== ADMIN_USER_ID) return;

  const results = $("barcodeLinkResults");
  results.innerHTML = "";
  results.classList.remove("hidden");
  results.innerHTML = '<div class="search-result-empty">Searching...</div>';

  try {
    const catalog = await loadProductSearchCatalog();
    const matches = rankProductSearchResults(catalog, query);

    results.innerHTML = "";

    if (!matches.length) {
      results.innerHTML = '<div class="search-result-empty">No matching products.</div>';
      return;
    }

    const count = document.createElement("div");
    count.className = "search-result-count";
    count.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
    results.appendChild(count);

    for (const product of matches) {
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
  } catch (error) {
    results.innerHTML = `<div class="search-result-empty">${escapeHtml(error.message)}</div>`;
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
      _barcode_type: "ticket_barcode",
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

  if (currentUser?.id === ADMIN_USER_ID) {
    await refreshBarcodeData();
  }

  showToast(`Barcode linked to ${product.name}. Future scans will add it automatically.`);
}

$("barcodeManualRegisterForm").onsubmit = async (event) => {
  event.preventDefault();

  if (!pendingUnknownBarcode || !canManageProductData()) {
    showToast("Product registration is available to Joey, Troy J and Alex S.");
    return;
  }

  const barcode = pendingUnknownBarcode.trim();
  const productCode = $("barcodeManualProductCode").value.trim();
  const productName = $("barcodeManualProductName").value.trim();

  if (!productCode || !productName) {
    showToast("Product Code and Product Name are both required.");
    return;
  }

  const button = $("barcodeManualRegisterBtn");
  button.disabled = true;
  button.textContent = "Registering...";

  const { data, error } = await supabase.rpc(
    "register_scanned_barcode_product",
    {
      _barcode: barcode,
      _product_code: productCode,
      _product_name: productName,
    },
  );

  button.disabled = false;
  button.textContent = "Register Product & Link Barcode";

  if (error) {
    showToast(error.message);
    return;
  }

  productSearchCatalog = null;

  const returned = Array.isArray(data) && data.length ? data[0] : null;

  const product = {
    code: returned?.code || productCode,
    name: returned?.name || productName,
  };

  closeBarcodeLinkPanel();
  await addResolvedProductToDraft(product);

  if (currentUser?.id === ADMIN_USER_ID) {
    await refreshBarcodeData();
  }

  showToast(`Registered ${product.name} and linked barcode ${barcode}.`);
};

// ---------- RUNS ----------
$("refreshRunsBtn").onclick = refreshRuns;

function resetRunBulkDelete() {
  runBulkDeleteMode = false;
  runBulkDeleteIds.clear();
}

function updateRunBulkDeleteControls() {
  const tools = $("runDeleteTools");
  const start = $("runBulkDeleteStartBtn");
  const actions = $("runBulkDeleteActions");
  const selectAll = $("runBulkSelectAll");
  const count = $("runBulkDeleteCount");
  const confirm = $("runBulkDeleteConfirmBtn");

  if (!tools || !start || !actions || !selectAll || !count || !confirm) return;

  const canRemoveRuns = canManageDailyOperations();
  const hasRuns = currentVisibleRunIds.length > 0;

  tools.classList.toggle("hidden", !canRemoveRuns || !hasRuns);
  start.classList.toggle("hidden", runBulkDeleteMode);
  actions.classList.toggle("hidden", !runBulkDeleteMode);

  const selectedCount = runBulkDeleteIds.size;
  count.textContent = `${selectedCount} selected`;
  confirm.disabled = selectedCount === 0;

  const allSelected =
    hasRuns
    && currentVisibleRunIds.every((id) => runBulkDeleteIds.has(id));

  selectAll.checked = allSelected;
  selectAll.indeterminate =
    selectedCount > 0 && !allSelected;
}

async function refreshRunsPreservingScroll() {
  const x = window.scrollX;
  const y = window.scrollY;

  await refreshRuns();

  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  window.scrollTo(x, y);
}

$("runBulkDeleteStartBtn").onclick = async () => {
  runBulkDeleteMode = true;
  runBulkDeleteIds.clear();
  await refreshRunsPreservingScroll();
};

$("runBulkDeleteCancelBtn").onclick = async () => {
  resetRunBulkDelete();
  await refreshRunsPreservingScroll();
};

$("runBulkSelectAll").onchange = () => {
  if ($("runBulkSelectAll").checked) {
    runBulkDeleteIds = new Set(currentVisibleRunIds);
  } else {
    runBulkDeleteIds.clear();
  }

  document
    .querySelectorAll("input[data-run-bulk-id]")
    .forEach((checkbox) => {
      checkbox.checked = runBulkDeleteIds.has(Number(checkbox.dataset.runBulkId));
    });

  updateRunBulkDeleteControls();
};

async function removeRunListByPermission(runId) {
  if (isOwnerUser()) {
    return await supabase.rpc("admin_delete_run_list", {
      _run_id: runId,
    });
  }

  if (isStockRunner()) {
    return await supabase.rpc("ops_remove_run_list", {
      _run_id: runId,
    });
  }

  return {
    data: false,
    error: new Error("You do not have permission to remove Run Lists."),
  };
}

$("runBulkDeleteConfirmBtn").onclick = async () => {
  if (!canManageDailyOperations() || !runBulkDeleteIds.size) return;

  const ids = [...runBulkDeleteIds];

  if (!confirm(`Delete ${ids.length} selected Run List${ids.length === 1 ? "" : "s"}?`)) {
    return;
  }

  let deletedCount = 0;
  let failedCount = 0;

  $("runBulkDeleteConfirmBtn").disabled = true;
  $("runBulkDeleteConfirmBtn").textContent = "Deleting...";

  for (const runId of ids) {
    const { data, error } = await removeRunListByPermission(runId);

    if (error || !data) {
      failedCount += 1;
    } else {
      deletedCount += 1;
    }
  }

  resetRunBulkDelete();

  if (failedCount) {
    showToast(`${deletedCount} removed, ${failedCount} failed.`);
  } else if (isStockRunner()) {
    showToast(`${deletedCount} Run List${deletedCount === 1 ? "" : "s"} moved to History and Process Pending.`);
  } else {
    showToast(`${deletedCount} Run List${deletedCount === 1 ? "" : "s"} moved to History.`);
  }

  $("runBulkDeleteConfirmBtn").textContent = "Delete Selected";

  await refreshRunsPreservingScroll();
  await refreshHistory();
};


function runItemDisplayName(item) {
  return String(
    item?.products?.name
    || item?.manual_name
    || item?.product_code
    || "Manual item"
  ).trim();
}

function sortRunItemsAZ(items = []) {
  return [...items].sort((a, b) =>
    runItemDisplayName(a).localeCompare(
      runItemDisplayName(b),
      undefined,
      { sensitivity: "base", numeric: true },
    )
  );
}

let currentRunCollapsed = false;
const expandedHistoryRunIds = new Set();

function createRunCollapseButton({
  expanded,
  label,
  onToggle,
  extraClass = "",
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `run-collapse-toggle ${extraClass}`.trim();
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  button.setAttribute("aria-label", label);
  button.innerHTML = `<span>${expanded ? "▴" : "▾"}</span>`;

  button.onclick = (event) => {
    event.stopPropagation();
    onToggle?.();
  };

  return button;
}

function createRunStartButton(runIds, items, nameMap, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `primary run-start-button ${extraClass}`.trim();

  const pendingItems = items.filter((item) => item.status === "pending");
  const runningItems = items.filter((item) => item.status === "processing");
  const otherRunning = runningItems.filter(
    (item) => item.processing_by && item.processing_by !== currentUser?.id,
  );
  const ownRunning = runningItems.filter(
    (item) => item.processing_by === currentUser?.id,
  );

  if (runBulkDeleteMode) {
    button.disabled = true;
    button.textContent = "Selection mode";
    return button;
  }

  if (otherRunning.length) {
    const names = [...new Set(
      otherRunning.map((item) =>
        nameMap.get(item.processing_by)
        || knownUserDisplayName(item.processing_by, nameMap)
      )
    )];

    button.disabled = true;
    button.textContent = names.length
      ? `Running by ${names.join(", ")}`
      : "Run already in progress";
    return button;
  }

  if (!pendingItems.length) {
    button.disabled = true;
    button.textContent = ownRunning.length ? "Run in progress" : "No pending items";
    return button;
  }

  button.textContent = ownRunning.length ? "Continue Run" : "Start Run";

  button.onclick = async () => {
    button.disabled = true;
    button.textContent = "Starting...";

    const { data, error } = await supabase.rpc("gcfr_start_run", {
      _run_ids: runIds,
    });

    if (error) {
      showToast(error.message);
      await refreshRuns();
      return;
    }

    if (!data?.ok) {
      showToast(
        data?.reason === "already_running"
          ? "Another team member is already running this list."
          : "Run could not be started."
      );
      await refreshRuns();
      return;
    }

    showToast(
      data.started
        ? `Run started · ${data.started} item${data.started === 1 ? "" : "s"}`
        : "Run already started."
    );

    await refreshRuns();
  };

  return button;
}

async function refreshRuns() {
  if (!currentUser) return;

  const { data: runs, error } = await supabase
    .from("run_lists")
    .select("id, created_at, created_by, status, deleted_at, deleted_by")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    $("runsList").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!runs?.length) {
    currentVisibleRunIds = [];
    resetRunBulkDelete();
    updateRunBulkDeleteControls();
    $("runsList").innerHTML = '<div class="empty-state">No current Run.</div>';
    return;
  }

  const runIds = runs.map((run) => run.id);

  const { data: items, error: itemsError } = await supabase
    .from("run_items")
    .select("id, run_list_id, product_code, manual_name, note, gap_check_required, status, processing_by, started_at, completed_by, completed_at, deleted_at, deleted_by, products(name)")
    .in("run_list_id", runIds)
    .is("deleted_at", null);

  if (itemsError) {
    $("runsList").innerHTML = `<div class="empty-state">${escapeHtml(itemsError.message)}</div>`;
    return;
  }

  const allItems = sortRunItemsAZ(items || []);

  if (!allItems.length) {
    currentVisibleRunIds = [];
    resetRunBulkDelete();
    updateRunBulkDeleteControls();
    $("runsList").innerHTML = '<div class="empty-state">No current Run items.</div>';
    return;
  }

  const profileIds = [...new Set(
    allItems
      .flatMap((item) => [item.processing_by, item.completed_by])
      .filter(Boolean)
  )];

  let nameMap = new Map();

  if (profileIds.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, display_name")
      .in("id", profileIds);

    nameMap = new Map((profiles || []).map((profile) => [
      profile.id,
      profile.display_name,
    ]));
  }

  const runProductCodes = [...new Set(
    allItems
      .map((item) => item.product_code)
      .filter(Boolean)
  )];

  const ticketBarcodeMap = new Map();

  if (runProductCodes.length) {
    const { data: barcodeRows, error: barcodeError } = await supabase
      .from("product_barcodes")
      .select("barcode, product_code, barcode_type")
      .in("product_code", runProductCodes)
      .eq("barcode_type", "ticket_barcode");

    if (!barcodeError) {
      for (const row of barcodeRows || []) {
        const barcode = String(row.barcode || "").trim();

        if (!/^\d{7,8}$/.test(barcode)) continue;

        if (!ticketBarcodeMap.has(row.product_code)) {
          ticketBarcodeMap.set(row.product_code, []);
        }

        const list = ticketBarcodeMap.get(row.product_code);
        if (!list.includes(barcode)) list.push(barcode);
      }
    }
  }

  currentVisibleRunIds = runIds;
  runBulkDeleteIds = new Set(
    [...runBulkDeleteIds].filter((id) => currentVisibleRunIds.includes(id))
  );
  updateRunBulkDeleteControls();

  const container = $("runsList");
  container.innerHTML = "";

  const card = document.createElement("section");
  card.className = "run-card current-run-card";

  const head = document.createElement("div");
  head.className = "run-head current-run-head";

  const headInfo = document.createElement("div");
  headInfo.className = "run-head-info";
  headInfo.innerHTML = `
    <strong>Current Run</strong>
    <div class="item-sub"><b>${allItems.length}</b> item${allItems.length === 1 ? "" : "s"} · A–Z</div>
  `;

  if (runBulkDeleteMode && canManageDailyOperations()) {
    const selectLabel = document.createElement("label");
    selectLabel.className = "run-bulk-select-box";

    const selectBox = document.createElement("input");
    selectBox.type = "checkbox";
    selectBox.checked = currentVisibleRunIds.every((id) => runBulkDeleteIds.has(id));

    selectBox.onchange = () => {
      if (selectBox.checked) {
        runBulkDeleteIds = new Set(currentVisibleRunIds);
      } else {
        runBulkDeleteIds.clear();
      }

      updateRunBulkDeleteControls();
    };

    const selectText = document.createElement("span");
    selectText.textContent = "Select Run";
    selectLabel.append(selectBox, selectText);
    headInfo.prepend(selectLabel);
  }

  const headActions = document.createElement("div");
  headActions.className = "run-admin-actions current-run-actions";

  const startTop = createRunStartButton(
    currentVisibleRunIds,
    allItems,
    nameMap,
    "run-start-top",
  );
  headActions.appendChild(startTop);

  let runToggle = null;
  runToggle = createRunCollapseButton({
    expanded: !currentRunCollapsed,
    label: currentRunCollapsed ? "Expand Current Run" : "Collapse Current Run",
    extraClass: "current-run-toggle",
    onToggle: () => {
      currentRunCollapsed = !currentRunCollapsed;

      body.classList.toggle("hidden", currentRunCollapsed);
      footer.classList.toggle("hidden", currentRunCollapsed);
      card.classList.toggle("collapsed", currentRunCollapsed);

      runToggle.setAttribute(
        "aria-expanded",
        currentRunCollapsed ? "false" : "true",
      );
      runToggle.setAttribute(
        "aria-label",
        currentRunCollapsed ? "Expand Current Run" : "Collapse Current Run",
      );
      runToggle.innerHTML = `<span>${currentRunCollapsed ? "▾" : "▴"}</span>`;
    },
  });
  headActions.appendChild(runToggle);

  if (canManageDailyOperations() && !runBulkDeleteMode) {
    const removeRun = document.createElement("button");
    removeRun.className = "admin-danger";
    removeRun.type = "button";
    removeRun.textContent = "Remove Run";

    removeRun.onclick = async () => {
      if (!confirm("Remove the current Run?")) return;

      removeRun.disabled = true;
      let failed = 0;

      for (const runId of currentVisibleRunIds) {
        const { data, error } = await removeRunListByPermission(runId);
        if (error || !data) failed += 1;
      }

      if (failed) {
        showToast(`${failed} Run record${failed === 1 ? "" : "s"} could not be removed.`);
      } else {
        showToast(
          isStockRunner()
            ? "Current Run moved to History. Final deletion is pending Joey approval."
            : "Current Run moved to History."
        );
      }

      await refreshRuns();
      await refreshHistory();
    };

    headActions.appendChild(removeRun);
  }

  head.append(headInfo, headActions);

  const body = document.createElement("div");
  body.className = "run-items run-items-scroll";

  for (const item of allItems) {
    body.appendChild(renderRunItem(item, nameMap, ticketBarcodeMap));
  }

  const footer = document.createElement("div");
  footer.className = "run-card-footer";
  footer.appendChild(
    createRunStartButton(
      currentVisibleRunIds,
      allItems,
      nameMap,
      "run-start-bottom",
    )
  );

  body.classList.toggle("hidden", currentRunCollapsed);
  footer.classList.toggle("hidden", currentRunCollapsed);
  card.classList.toggle("collapsed", currentRunCollapsed);

  card.append(head, body, footer);
  container.appendChild(card);
}

function renderRunItem(item, nameMap, ticketBarcodeMap = new Map()) {
  const row = document.createElement("div");
  row.className = "run-item";

  const productName = item.products?.name || item.manual_name || item.product_code || "Manual item";
  const itemSub = item.product_code || "Manual item";
  const ticketBarcodes = item.product_code
    ? (ticketBarcodeMap.get(item.product_code) || [])
    : [];
  const worker = item.processing_by ? (nameMap.get(item.processing_by) || "User") : "";
  const completedBy = item.completed_by ? (nameMap.get(item.completed_by) || "User") : "";

  let statusText = "Pending";
  if (item.status === "processing") statusText = `Processing by ${worker}`;
  if (item.status === "done") statusText = `Done${completedBy ? ` by ${completedBy}` : ""}`;
  if (item.status === "out_of_stock") statusText = `Out of stock${completedBy ? ` by ${completedBy}` : ""}`;
  if (item.status === "cancelled") statusText = `Cancelled${completedBy ? ` by ${completedBy}` : ""}`;

  const ticketBarcodeHtml = ticketBarcodes.length
    ? `<div class="run-ticket-barcode">
         <span>Ticket Barcode</span>
         <strong>${ticketBarcodes.map(escapeHtml).join(" / ")}</strong>
       </div>`
    : "";

  row.innerHTML = `
    <div class="item-title">${escapeHtml(productName)}</div>
    <div class="item-sub">${escapeHtml(itemSub)}</div>
    ${ticketBarcodeHtml}
    ${item.manual_name ? '<div class="manual-tag">Manual item</div>' : ''}
    <div class="status-line status-${escapeHtml(item.status)}">${escapeHtml(statusText)}</div>
  `;

  const gapLabel = document.createElement("label");
  gapLabel.className = "gap-check-toggle run-gap-check";
  const gapBox = document.createElement("input");
  gapBox.type = "checkbox";
  gapBox.checked = !!item.gap_check_required;

  const terminal = ["done", "out_of_stock", "cancelled"].includes(item.status);
  gapBox.disabled = terminal || runBulkDeleteMode;

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

    gapBox.disabled = terminal || runBulkDeleteMode;
  };

  const gapText = document.createElement("span");
  gapText.textContent = item.gap_check_required ? "Gap Check required" : "Gap Check";
  gapLabel.append(gapBox, gapText);
  row.appendChild(gapLabel);

  const actions = document.createElement("div");
  actions.className = "action-row";

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

  if (runBulkDeleteMode) {
    actions.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
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

$("historyPrevDayBtn").onclick = async () => {
  selectedHistoryDate = shiftDate(selectedHistoryDate, -1);
  syncHistoryDateControls();
  await refreshHistory();
};

$("historyNextDayBtn").onclick = async () => {
  selectedHistoryDate = shiftDate(selectedHistoryDate, 1);
  syncHistoryDateControls();
  await refreshHistory();
};

$("historyTodayBtn").onclick = async () => {
  selectedHistoryDate = localDateString(new Date());
  syncHistoryDateControls();
  await refreshHistory();
};

$("historyDatePicker").onchange = async () => {
  const value = $("historyDatePicker").value;
  if (!value) return;

  selectedHistoryDate = value;
  syncHistoryDateControls();
  await refreshHistory();
};

function syncHistoryDateControls() {
  const picker = $("historyDatePicker");
  const display = $("historyDateDisplay");

  if (picker) picker.value = selectedHistoryDate;

  if (display) {
    display.textContent = new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(dateFromLocalString(selectedHistoryDate));
  }
}

function localDayBounds(dateString) {
  const start = dateFromLocalString(dateString);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

async function buildDailyRunNumberMap(referenceRuns = []) {
  const result = new Map();

  if (!referenceRuns.length) return result;

  const dates = [...new Set(
    referenceRuns
      .map((run) => localDateString(new Date(run.created_at)))
      .filter(Boolean)
  )];

  for (const dateString of dates) {
    const { startIso, endIso } = localDayBounds(dateString);

    const { data: dayRuns, error: dayRunsError } = await supabase
      .from("run_lists")
      .select("id, created_at")
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

    if (dayRunsError || !dayRuns?.length) continue;

    const ids = dayRuns.map((run) => run.id);

    const { data: dayItems, error: dayItemsError } = await supabase
      .from("run_items")
      .select("run_list_id")
      .in("run_list_id", ids);

    if (dayItemsError) continue;

    const nonEmptyRunIds = new Set(
      (dayItems || []).map((item) => item.run_list_id)
    );

    let number = 0;

    for (const run of dayRuns) {
      if (!nonEmptyRunIds.has(run.id)) continue;
      number += 1;
      result.set(run.id, number);
    }
  }

  return result;
}

async function refreshHistory() {
  if (!currentUser) return;

  const container = $("historyList");
  if (!container) return;

  syncHistoryDateControls();
  container.innerHTML = `<div class="empty-state">Loading...</div>`;

  const { startIso, endIso } = localDayBounds(selectedHistoryDate);

  const { data: runs, error } = await supabase
    .from("run_lists")
    .select("id, created_at, created_by, status, deleted_at, deleted_by")
    .gte("created_at", startIso)
    .lt("created_at", endIso)
    .order("created_at", { ascending: false });

  if (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!runs?.length) {
    container.innerHTML = `<div class="empty-state">No history for ${escapeHtml(formatHistoryDate(selectedHistoryDate))}.</div>`;
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

  const dailyNumberMap = await buildDailyRunNumberMap(runs);

  let historyRuns = runs.filter((run) => {
    const runItems = grouped.get(run.id) || [];

    // Empty run shells are never shown anywhere.
    if (!runItems.length) return false;

    const hasDeletedItem = runItems.some((item) => item.deleted_at);

    return (
      run.status === "completed"
      || !!run.deleted_at
      || hasDeletedItem
    );
  });

  if (historyFilter === "completed") {
    historyRuns = historyRuns.filter(
      (run) => run.status === "completed" && !run.deleted_at
    );
  }

  if (historyFilter === "deleted") {
    historyRuns = historyRuns.filter((run) => {
      const runItems = grouped.get(run.id) || [];

      return (
        !!run.deleted_at
        || runItems.some((item) => item.deleted_at)
      );
    });
  }

  container.innerHTML = "";

  if (!historyRuns.length) {
    container.innerHTML = `<div class="empty-state">No matching history for ${escapeHtml(formatHistoryDate(selectedHistoryDate))}.</div>`;
    return;
  }

  for (const run of historyRuns) {
    const runNumber = dailyNumberMap.get(run.id) || 1;
    const runItems = sortRunItemsAZ(grouped.get(run.id) || []);
    const card = document.createElement("section");
    card.className = `run-card history-run-card ${run.deleted_at ? "deleted-card" : ""}`;

    const head = document.createElement("div");
    head.className = "run-head history-run-head";

    const headInfo = document.createElement("div");
    headInfo.className = "history-run-info";
    const removedByName = run.deleted_by
      ? knownUserDisplayName(run.deleted_by, nameMap)
      : "";

    headInfo.innerHTML = `
      <strong>Run #${runNumber}</strong>
      <div class="history-run-summary">
        <span>${formatDateTime(run.created_at)}</span>
        <b>${runItems.length} item${runItems.length === 1 ? "" : "s"}</b>
      </div>
      ${run.deleted_at ? '<span class="deleted-label">Removed</span>' : ''}
      ${run.deleted_at && removedByName
        ? `<div class="history-removed-by">Removed by ${escapeHtml(removedByName)}</div>`
        : ""}
    `;

    const headActions = document.createElement("div");
    headActions.className = "run-admin-actions history-run-actions";

    const status = document.createElement("span");
    status.className = "item-sub";
    status.textContent = run.status;
    headActions.appendChild(status);

    const historyExpanded = expandedHistoryRunIds.has(run.id);
    let historyToggle = null;

    historyToggle = createRunCollapseButton({
      expanded: historyExpanded,
      label: historyExpanded
        ? `Collapse Run #${runNumber}`
        : `Expand Run #${runNumber}`,
      extraClass: "history-run-toggle",
      onToggle: () => {
        const opening = !expandedHistoryRunIds.has(run.id);

        if (opening) expandedHistoryRunIds.add(run.id);
        else expandedHistoryRunIds.delete(run.id);

        body.classList.toggle("hidden", !opening);
        card.classList.toggle("collapsed", !opening);

        historyToggle.setAttribute(
          "aria-expanded",
          opening ? "true" : "false",
        );
        historyToggle.setAttribute(
          "aria-label",
          opening
            ? `Collapse Run #${runNumber}`
            : `Expand Run #${runNumber}`,
        );
        historyToggle.innerHTML = `<span>${opening ? "▴" : "▾"}</span>`;
      },
    });

    headActions.appendChild(historyToggle);

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

          showToast(`Run #${runNumber} restored.`);
          await refreshRuns();
          await refreshHistory();
        };

        headActions.appendChild(restoreRun);
      }

      const purgeRun = document.createElement("button");
      purgeRun.className = "admin-danger";
      purgeRun.textContent = "Delete History";
      purgeRun.onclick = async () => {
        if (!confirm(`Permanently delete Run #${runNumber} from History? This cannot be restored.`)) return;

        const { data, error } = await supabase.rpc("admin_purge_run_list", {
          _run_id: run.id,
        });

        if (error) return showToast(error.message);
        if (!data) return showToast("History could not be deleted.");

        showToast(`Run #${runNumber} history deleted.`);
        await refreshRuns();
        await refreshHistory();
      };

      headActions.appendChild(purgeRun);
    }

    head.append(headInfo, headActions);

    const body = document.createElement("div");
    body.className = "run-items history-run-items-scroll";

    for (const item of runItems) {
      body.appendChild(renderHistoryItem(item, nameMap, run));
    }

    body.classList.toggle("hidden", !historyExpanded);
    card.classList.toggle("collapsed", !historyExpanded);

    card.append(head, body);
    container.appendChild(card);
  }
}

function formatHistoryDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(dateFromLocalString(value));
}

function renderHistoryItem(item, nameMap, run) {
  const row = document.createElement("div");
  row.className = `run-item history-run-item ${item.deleted_at ? "deleted-item" : ""}`;

  const productName = item.products?.name || item.manual_name || item.product_code || "Manual item";
  const itemSub = item.product_code || "Manual item";
  const worker = item.processing_by ? (nameMap.get(item.processing_by) || "User") : "";
  const completedBy = item.completed_by ? (nameMap.get(item.completed_by) || "User") : "";

  let statusText = "Pending";
  if (item.status === "processing") statusText = `Processing by ${worker}`;
  if (item.status === "done") statusText = `Done${completedBy ? ` by ${completedBy}` : ""}`;
  if (item.status === "out_of_stock") statusText = `Out of stock${completedBy ? ` by ${completedBy}` : ""}`;

  row.innerHTML = `
    <div class="history-item-main">
      <div class="item-title">${escapeHtml(productName)}</div>
      <div class="item-sub">${escapeHtml(itemSub)}</div>
      <div class="history-item-meta">
        ${item.manual_name ? '<span class="manual-tag">Manual item</span>' : ''}
        ${item.gap_check_required ? '<span class="gap-check-badge">Gap Check required</span>' : ''}
        ${item.deleted_at ? '<span class="deleted-label">Deleted item</span>' : ''}
      </div>
      <div class="status-line status-${escapeHtml(item.status)}">${escapeHtml(statusText)}</div>
    </div>
  `;

  if (currentUser?.id === ADMIN_USER_ID) {
    const actions = document.createElement("div");
    actions.className = "action-row history-item-actions";

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
let currentChecklistTaskIds = [];
let checklistScrollHold = null;
let checklistScrollHoldTimer = null;
const collapsedChecklistPeriods = new Set();


function resetChecklistBulkDelete() {
  checklistBulkDeleteMode = false;
  checklistBulkDeleteIds.clear();
  updateChecklistBulkDeleteControls();
}

function updateChecklistBulkDeleteControls() {
  const tools = $("checklistDeleteTools");
  const start = $("checklistBulkDeleteStartBtn");
  const actions = $("checklistBulkDeleteActions");
  const selectAll = $("checklistBulkSelectAll");
  const count = $("checklistBulkDeleteCount");
  const confirmBtn = $("checklistBulkDeleteConfirmBtn");
  if (!tools || !start || !actions || !selectAll || !count || !confirmBtn) return;

  const canRemoveChecklist = canManageDailyOperations();
  const hasTasks = checklistTaskCount > 0;
  const showTools = canRemoveChecklist && hasTasks;

  tools.classList.toggle("hidden", !showTools);

  if (!showTools) {
    start.classList.add("hidden");
    actions.classList.add("hidden");
    confirmBtn.disabled = true;
    selectAll.checked = false;
    selectAll.indeterminate = false;
    count.textContent = "0 selected";
    return;
  }

  start.classList.toggle("hidden", checklistBulkDeleteMode);
  actions.classList.toggle("hidden", !checklistBulkDeleteMode);

  const selectedCount = checklistBulkDeleteIds.size;
  const allSelected =
    currentChecklistTaskIds.length > 0
    && currentChecklistTaskIds.every((id) => checklistBulkDeleteIds.has(id));

  selectAll.checked = allSelected;
  selectAll.indeterminate = selectedCount > 0 && !allSelected;
  count.textContent = `${selectedCount} selected`;
  confirmBtn.disabled = selectedCount === 0;
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

$("checklistBulkSelectAll").onchange = () => {
  if ($("checklistBulkSelectAll").checked) {
    checklistBulkDeleteIds = new Set(currentChecklistTaskIds);
  } else {
    checklistBulkDeleteIds.clear();
  }

  document
    .querySelectorAll("input[data-checklist-bulk-id]")
    .forEach((checkbox) => {
      const taskId = Number(checkbox.dataset.checklistBulkId);
      checkbox.checked = checklistBulkDeleteIds.has(taskId);
      checkbox.closest(".checklist-row")?.classList.toggle(
        "bulk-delete-selected",
        checkbox.checked,
      );
    });

  updateChecklistBulkDeleteControls();
};

$("checklistBulkDeleteConfirmBtn").onclick = async () => {
  if (!canManageDailyOperations() || !checklistBulkDeleteIds.size) return;

  const scrollPosition = holdChecklistScroll(5000);
  const ids = [...checklistBulkDeleteIds];
  if (!confirm(`Delete ${ids.length} selected checklist item${ids.length === 1 ? "" : "s"}?`)) return;

  $("checklistBulkDeleteConfirmBtn").disabled = true;

  let removedCount = 0;
  for (const taskId of ids) {
    const { data: removed, error } = await removeChecklistTaskByPermission(taskId);

    if (error) {
      showToast(error.message);
      updateChecklistBulkDeleteControls();
      return;
    }

    if (removed) removedCount += 1;
  }

  resetChecklistBulkDelete();

  showToast(
    isStockRunner()
      ? `${removedCount} checklist removal${removedCount === 1 ? "" : "s"} sent to Process Pending.`
      : `${removedCount} checklist item${removedCount === 1 ? "" : "s"} deleted.`
  );

  await refreshChecklistPreservingScroll(scrollPosition);
};

async function removeChecklistTaskByPermission(taskId) {
  const pending = checklistPendingRemovalMap.get(taskId);

  if (isOwnerUser()) {
    if (pending?.id) {
      return await supabase.rpc("admin_finalize_process_pending", {
        _pending_id: pending.id,
      });
    }

    return await supabase.rpc("delete_checklist_task", {
      _task_id: taskId,
    });
  }

  if (isStockRunner()) {
    if (pending?.id) {
      return { data: false, error: null };
    }

    return await supabase.rpc("ops_request_checklist_removal", {
      _task_id: taskId,
    });
  }

  return {
    data: false,
    error: new Error("You do not have permission to remove checklist items."),
  };
}

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

  if (!canManageDailyOperations()) {
    showToast("You do not have permission to add checklist items.");
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

  if (!canManageDailyOperations()) {
    showToast("You do not have permission to add checklist items.");
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

  $("addTaskForm").reset();

  showToast(`${title} added to ${periodLabel(period)}.`);

  await refreshChecklist();
});

async function refreshChecklist() {
  if (!currentUser) return;

  checklistTaskCount = 0;
  updateChecklistBulkDeleteControls();
  syncChecklistDateControls();

  const canAddChecklistItems = canManageDailyOperations();
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
    currentChecklistTaskIds = [];
    checklistTaskCount = 0;
    updateChecklistBulkDeleteControls();
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  const allChecklistTaskIds = (data || []).map((task) => task.id);
  checklistPendingRemovalMap = new Map();

  if (allChecklistTaskIds.length) {
    const { data: pendingRemovals, error: pendingRemovalError } = await supabase
      .from("gcfr_process_pending")
      .select("id, entity_id, requested_by, requested_at, snapshot")
      .eq("entity_type", "checklist_task")
      .eq("status", "pending")
      .in("entity_id", allChecklistTaskIds);

    if (pendingRemovalError) {
      showToast(pendingRemovalError.message);
    } else {
      for (const pending of pendingRemovals || []) {
        checklistPendingRemovalMap.set(Number(pending.entity_id), pending);
      }
    }
  }

  currentChecklistTaskIds = (data || [])
    .filter((task) => isOwnerUser() || !checklistPendingRemovalMap.has(task.id))
    .map((task) => task.id);

  checklistTaskCount = currentChecklistTaskIds.length;

  checklistBulkDeleteIds = new Set(
    [...checklistBulkDeleteIds].filter((id) => currentChecklistTaskIds.includes(id))
  );

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

    const periodCollapsed = collapsedChecklistPeriods.has(period.key);

    const headTitle = document.createElement("button");
    headTitle.type = "button";
    headTitle.className = "checklist-period-heading checklist-period-toggle";
    headTitle.setAttribute("aria-expanded", periodCollapsed ? "false" : "true");
    headTitle.setAttribute(
      "aria-label",
      periodCollapsed
        ? `Expand ${period.label} checklist`
        : `Collapse ${period.label} checklist`,
    );
    headTitle.innerHTML = `
      <span class="checklist-period-title">${escapeHtml(period.label)}</span>
      <span class="checklist-period-count">${tasks.length} item${tasks.length === 1 ? "" : "s"}</span>
      <span class="checklist-period-chevron" aria-hidden="true">${periodCollapsed ? "▾" : "▴"}</span>
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

    list.classList.toggle("hidden", periodCollapsed);
    section.classList.toggle("collapsed", periodCollapsed);

    headTitle.onclick = () => {
      const collapsing = !collapsedChecklistPeriods.has(period.key);

      if (collapsing) collapsedChecklistPeriods.add(period.key);
      else collapsedChecklistPeriods.delete(period.key);

      list.classList.toggle("hidden", collapsing);
      section.classList.toggle("collapsed", collapsing);

      headTitle.setAttribute("aria-expanded", collapsing ? "false" : "true");
      headTitle.setAttribute(
        "aria-label",
        collapsing
          ? `Expand ${period.label} checklist`
          : `Collapse ${period.label} checklist`,
      );

      const chevron = headTitle.querySelector(".checklist-period-chevron");
      if (chevron) chevron.textContent = collapsing ? "▾" : "▴";
    };

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
  text.className = "checklist-task-copy";

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

  const pendingRemoval = checklistPendingRemovalMap.get(task.id);
  const pendingRemovalName = pendingRemoval
    ? (
        pendingRemoval.snapshot?.requested_by_name
        || knownUserDisplayName(pendingRemoval.requested_by)
      )
    : "";

  const removalMarker = pendingRemoval
    ? `<div class="checklist-removal-pending">Removal pending • ${escapeHtml(pendingRemovalName)}</div>`
    : "";

  text.innerHTML = `
    <div class="item-title">${escapeHtml(task.title)}</div>
    ${removalMarker}
    ${extra}
    ${editMarker}
    ${selectionHelp}
  `;

  stateControl.classList.add("checklist-state-control");
  row.append(stateControl, text);

  if (
    canManageDailyOperations()
    && checklistBulkDeleteMode
    && (isOwnerUser() || !checklistPendingRemovalMap.has(task.id))
  ) {
    const bulkLabel = document.createElement("label");
    bulkLabel.className = "checklist-bulk-select";

    const bulkBox = document.createElement("input");
    bulkBox.type = "checkbox";
    bulkBox.dataset.checklistBulkId = String(task.id);
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

  // Joey deletes directly. Troy J / Alex S send removals to Process Pending.
  if (canManageDailyOperations() && !checklistBulkDeleteMode) {
    const pendingRemoval = checklistPendingRemovalMap.get(task.id);
    const del = document.createElement("button");
    del.className = "checklist-delete-btn";
    del.type = "button";

    if (pendingRemoval && isStockRunner()) {
      del.textContent = "Pending";
      del.disabled = true;
    } else if (pendingRemoval && isOwnerUser()) {
      del.textContent = "Final Delete";
    } else {
      del.textContent = isStockRunner() ? "Remove" : "Delete";
    }

    del.onclick = async () => {
      const actionText = isStockRunner()
        ? `Send "${task.title}" to Process Pending for removal?`
        : `Delete "${task.title}" from this checklist?`;

      if (!confirm(actionText)) return;

      const scrollPosition = holdChecklistScroll();
      del.blur();

      const { data: removed, error: removeError } =
        await removeChecklistTaskByPermission(task.id);

      if (removeError) {
        showToast(removeError.message);
        return;
      }

      if (!removed) {
        showToast(
          isStockRunner()
            ? "This checklist removal is already pending."
            : "Checklist item could not be deleted."
        );
        return;
      }

      showToast(
        isStockRunner()
          ? `Removal requested by ${knownUserDisplayName(currentUser.id)}. Joey will make the final deletion.`
          : "Checklist item deleted."
      );

      await refreshChecklistPreservingScroll(scrollPosition);
    };

    row.appendChild(del);
  }


  const commentsSection = document.createElement("div");
  commentsSection.className = "checklist-comments";

  const commentsTitle = document.createElement("button");
  commentsTitle.type = "button";
  commentsTitle.className = "checklist-comments-title checklist-comments-toggle";
  commentsTitle.textContent = `Comments (${comments.length})`;

  const commentsBody = document.createElement("div");
  commentsBody.className = "checklist-comments-body hidden";

  commentsTitle.onclick = () => {
    const opening = commentsBody.classList.contains("hidden");
    commentsBody.classList.toggle("hidden", !opening);
    commentsTitle.classList.toggle("open", opening);
  };

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

  commentsBody.appendChild(thread);

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

  commentsBody.appendChild(commentForm);
  commentsSection.appendChild(commentsBody);
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

// ---------- ADMIN PRICE / PROMOTION ----------
function adminPricingStoreId() {
  return String($("adminPricingStoreId")?.value || "0838").trim() || "0838";
}

function adminPricingStoreName() {
  return String($("adminPricingStoreName")?.value || "").trim()
    || (adminPricingStoreId() === "0838" ? "Coles Griffith" : `Store ${adminPricingStoreId()}`);
}

function setPriceSourcePill(id, label, state = "") {
  const pill = $(id);
  if (!pill) return;

  pill.textContent = label;
  pill.classList.remove("manual", "auto", "out");
  if (state) pill.classList.add(state);
}

function showAdminPricingView() {
  if (!isOwnerUser()) return;

  stopAdminBarcodeScanner();
  $("adminHomeView")?.classList.add("hidden");
  $("adminBarcodeDetailView")?.classList.add("hidden");
  $("adminProcessPendingView")?.classList.add("hidden");
  $("adminStockSetupView")?.classList.add("hidden");
  $("adminPricingView")?.classList.remove("hidden");
  $("screenTitle").textContent = "Price / Promotion";
}

$("openPricingManagerBtn")?.addEventListener("click", () => {
  adminPricingSelectedProduct = null;
  $("adminPricingSelected")?.classList.add("hidden");
  $("adminPricingSearchResults")?.classList.add("hidden");
  $("adminPricingSearchResults").innerHTML = "";
  $("adminPricingSearch").value = "";
  showAdminPricingView();
  $("adminPricingSearch")?.focus();
});

$("adminPricingBackBtn")?.addEventListener("click", () => {
  clearTimeout(adminPricingSearchTimer);
  adminPricingSelectedProduct = null;
  $("adminPricingSelected")?.classList.add("hidden");
  showAdminHomeView();
});

$("adminPricingSearch")?.addEventListener("input", () => {
  clearTimeout(adminPricingSearchTimer);
  const query = $("adminPricingSearch").value.trim();

  if (!query) {
    $("adminPricingSearchResults").classList.add("hidden");
    $("adminPricingSearchResults").innerHTML = "";
    return;
  }

  adminPricingSearchTimer = setTimeout(
    () => searchAdminPricingProducts(query),
    140,
  );
});

async function searchAdminPricingProducts(query) {
  if (!isOwnerUser()) return;

  const results = $("adminPricingSearchResults");
  results.classList.remove("hidden");
  results.innerHTML = '<div class="search-result-empty">Searching...</div>';

  try {
    const catalog = await loadProductSearchCatalog();
    const rows = rankProductSearchResults(catalog, query).slice(0, 30);

    results.innerHTML = "";

    if (!rows.length) {
      results.innerHTML =
        '<div class="search-result-empty">No matching products.</div>';
      return;
    }

    for (const product of rows) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stock-search-result";
      button.innerHTML = `
        <span>
          <strong>${escapeHtml(product.name || "Unknown product")}</strong>
          <small>Product Code ${escapeHtml(product.code || "-")}</small>
        </span>
        <b>Price</b>
      `;

      button.onclick = async () => {
        results.classList.add("hidden");
        results.innerHTML = "";
        $("adminPricingSearch").value = "";
        await selectAdminPricingProduct(product);
      };

      results.appendChild(button);
    }
  } catch (error) {
    results.innerHTML =
      `<div class="search-result-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function selectAdminPricingProduct(product) {
  adminPricingSelectedProduct = product;

  $("adminPricingSelectedName").textContent =
    product?.name || "Unknown product";
  $("adminPricingSelectedCode").textContent = product?.code || "-";
  $("adminPricingSelected")?.classList.remove("hidden");

  const today = localDateString(new Date());

  if (!$("adminManualPromoStart").value) {
    $("adminManualPromoStart").value = today;
  }

  if (!$("adminManualPromoEnd").value) {
    $("adminManualPromoEnd").value = shiftDate(today, 6);
  }

  await loadAdminPricingValues();
}

async function loadAdminPricingValues() {
  if (!isOwnerUser() || !adminPricingSelectedProduct?.code) return;

  const code = adminPricingSelectedProduct.code;
  const storeId = adminPricingStoreId();

  const [priceResult, promoResult] = await Promise.all([
    supabase
      .from("gcfr_manual_prices")
      .select("price,price_basis,store_name,updated_at")
      .eq("product_code", code)
      .eq("store_id", storeId)
      .maybeSingle(),
    supabase
      .from("gcfr_manual_promotions")
      .select("regular_price,promo_price,price_basis,starts_on,ends_on,status,store_name,updated_at")
      .eq("product_code", code)
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);

  if (priceResult.error) {
    showToast(priceResult.error.message);
    return;
  }

  if (promoResult.error) {
    showToast(promoResult.error.message);
    return;
  }

  const price = priceResult.data;
  const promo = promoResult.data;

  $("adminManualPriceValue").value =
    price?.price == null ? "" : String(price.price);
  $("adminManualPriceBasis").value = price?.price_basis || "per_kg";

  if (price) {
    setPriceSourcePill("adminManualPriceStatus", "MANUAL", "manual");
    if (price.store_name && !$("adminPricingStoreName").value.trim()) {
      $("adminPricingStoreName").value = price.store_name;
    }
  } else {
    setPriceSourcePill("adminManualPriceStatus", "NOT SET");
  }

  $("adminManualPromoRegular").value =
    promo?.regular_price == null ? "" : String(promo.regular_price);
  $("adminManualPromoPrice").value =
    promo?.promo_price == null ? "" : String(promo.promo_price);
  $("adminManualPromoBasis").value = promo?.price_basis || "each";

  const today = localDateString(new Date());
  $("adminManualPromoStart").value = promo?.starts_on || today;
  $("adminManualPromoEnd").value = promo?.ends_on || shiftDate(today, 6);

  if (promo?.status === "active" && promo.ends_on >= today) {
    setPriceSourcePill("adminManualPromoStatus", "MANUAL", "manual");
  } else if (promo) {
    setPriceSourcePill("adminManualPromoStatus", "OUT", "out");
  } else {
    setPriceSourcePill("adminManualPromoStatus", "NOT SET");
  }

  if (promo?.store_name && !$("adminPricingStoreName").value.trim()) {
    $("adminPricingStoreName").value = promo.store_name;
  }
}

$("adminPricingStoreId")?.addEventListener("change", async () => {
  if (adminPricingSelectedProduct) await loadAdminPricingValues();
});

$("adminManualPriceForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!isOwnerUser() || !adminPricingSelectedProduct?.code) return;

  const price = Number($("adminManualPriceValue").value);
  if (!Number.isFinite(price) || price <= 0) {
    showToast("Enter a valid manual price.");
    return;
  }

  const { error } = await supabase
    .from("gcfr_manual_prices")
    .upsert({
      product_code: adminPricingSelectedProduct.code,
      store_id: adminPricingStoreId(),
      store_name: adminPricingStoreName(),
      price,
      price_basis: $("adminManualPriceBasis").value,
      updated_by: currentUser.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "product_code,store_id" });

  if (error) {
    showToast(error.message);
    return;
  }

  setPriceSourcePill("adminManualPriceStatus", "MANUAL", "manual");
  showToast("Manual price saved.");
});

$("adminManualPriceDeleteBtn")?.addEventListener("click", async () => {
  if (!isOwnerUser() || !adminPricingSelectedProduct?.code) return;

  const { error } = await supabase
    .from("gcfr_manual_prices")
    .delete()
    .eq("product_code", adminPricingSelectedProduct.code)
    .eq("store_id", adminPricingStoreId());

  if (error) {
    showToast(error.message);
    return;
  }

  $("adminManualPriceValue").value = "";
  setPriceSourcePill("adminManualPriceStatus", "NOT SET");
  showToast("Manual price cleared.");
});

$("adminManualPromoForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!isOwnerUser() || !adminPricingSelectedProduct?.code) return;

  const promoPrice = Number($("adminManualPromoPrice").value);
  const regularRaw = $("adminManualPromoRegular").value.trim();
  const regularPrice = regularRaw ? Number(regularRaw) : null;
  const startsOn = $("adminManualPromoStart").value;
  const endsOn = $("adminManualPromoEnd").value;

  if (!Number.isFinite(promoPrice) || promoPrice <= 0) {
    showToast("Enter a valid promotion price.");
    return;
  }

  if (
    regularPrice !== null
    && (!Number.isFinite(regularPrice) || regularPrice <= 0)
  ) {
    showToast("Enter a valid regular price.");
    return;
  }

  if (!startsOn || !endsOn || endsOn < startsOn) {
    showToast("Check the promotion start and end dates.");
    return;
  }

  const { error } = await supabase
    .from("gcfr_manual_promotions")
    .upsert({
      product_code: adminPricingSelectedProduct.code,
      store_id: adminPricingStoreId(),
      store_name: adminPricingStoreName(),
      regular_price: regularPrice,
      promo_price: promoPrice,
      price_basis: $("adminManualPromoBasis").value,
      starts_on: startsOn,
      ends_on: endsOn,
      status: "active",
      updated_by: currentUser.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "product_code,store_id" });

  if (error) {
    showToast(error.message);
    return;
  }

  setPriceSourcePill("adminManualPromoStatus", "MANUAL", "manual");
  showToast("Manual promotion saved.");
});

$("adminManualPromoOutBtn")?.addEventListener("click", async () => {
  if (!isOwnerUser() || !adminPricingSelectedProduct?.code) return;

  const { error } = await supabase
    .from("gcfr_manual_promotions")
    .update({
      status: "out",
      updated_by: currentUser.id,
      updated_at: new Date().toISOString(),
    })
    .eq("product_code", adminPricingSelectedProduct.code)
    .eq("store_id", adminPricingStoreId());

  if (error) {
    showToast(error.message);
    return;
  }

  setPriceSourcePill("adminManualPromoStatus", "OUT", "out");
  showToast("Promotion marked OUT.");
});


// ---------- ADMIN BARCODE / PRODUCT DATA ----------
$("openProcessPendingBtn").onclick = async () => {
  if (!isOwnerUser()) return;

  showAdminProcessPendingView();
  await refreshProcessPending();
};

$("processPendingBackBtn").onclick = async () => {
  showAdminHomeView();
  await refreshProcessPendingCount();
};

$("refreshProcessPendingBtn").onclick = refreshProcessPending;

function showAdminProcessPendingView() {
  stopAdminBarcodeScanner();
  $("adminHomeView")?.classList.add("hidden");
  $("adminBarcodeDetailView")?.classList.add("hidden");
  $("adminStockSetupView")?.classList.add("hidden");
  $("adminPricingView")?.classList.add("hidden");
  $("adminProcessPendingView")?.classList.remove("hidden");
  $("screenTitle").textContent = "Process Pending";
}

async function refreshProcessPendingCount() {
  if (!isOwnerUser()) return;

  const { data, error } = await supabase
    .from("gcfr_process_pending")
    .select("id")
    .eq("status", "pending");

  if (error) return;

  const count = (data || []).length;
  const badge = $("processPendingBadge");

  if (badge) {
    badge.textContent = String(count);
    badge.classList.toggle("hidden", count === 0);
  }
}

async function refreshProcessPending() {
  if (!isOwnerUser()) return;

  const list = $("processPendingList");
  list.innerHTML = `<div class="empty-state">Loading...</div>`;

  const { data, error } = await supabase
    .from("gcfr_process_pending")
    .select("id, entity_type, entity_id, action, requested_by, requested_at, snapshot")
    .eq("status", "pending")
    .order("requested_at", { ascending: false });

  if (error) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  $("processPendingCount").textContent =
    `${rows.length} pending`;

  const badge = $("processPendingBadge");
  if (badge) {
    badge.textContent = String(rows.length);
    badge.classList.toggle("hidden", rows.length === 0);
  }

  list.innerHTML = "";

  if (!rows.length) {
    list.innerHTML = `<div class="empty-state">Nothing is waiting for final processing.</div>`;
    return;
  }

  for (const pending of rows) {
    const snapshot = pending.snapshot || {};
    const requester =
      snapshot.requested_by_name
      || knownUserDisplayName(pending.requested_by);

    const card = document.createElement("section");
    card.className = "process-pending-card";

    const typeLabel =
      pending.entity_type === "run_list"
        ? "Run List"
        : "Checklist";

    let details = "";

    if (pending.entity_type === "checklist_task") {
      details = `
        <div class="item-title">${escapeHtml(snapshot.title || "Checklist item")}</div>
        <div class="item-sub">
          ${escapeHtml(snapshot.task_date || "")}
          ${snapshot.time_period ? ` • ${escapeHtml(periodLabel(snapshot.time_period))}` : ""}
        </div>
      `;
    } else {
      details = `
        <div class="item-title">Run List removal</div>
        <div class="item-sub">
          ${snapshot.run_created_at ? escapeHtml(formatDateTime(snapshot.run_created_at)) : ""}
        </div>
      `;
    }

    const info = document.createElement("div");
    info.className = "process-pending-info";
    info.innerHTML = `
      <div class="process-pending-type">${escapeHtml(typeLabel)}</div>
      ${details}
      <div class="process-pending-requester">Removed by ${escapeHtml(requester)}</div>
      <div class="item-sub">Requested ${escapeHtml(formatDateTime(pending.requested_at))}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "process-pending-actions";

    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "secondary";
    restore.textContent =
      pending.entity_type === "run_list"
        ? "Restore"
        : "Keep";

    restore.onclick = async () => {
      if (!confirm(
        pending.entity_type === "run_list"
          ? "Restore this Run List?"
          : "Keep this checklist item and cancel the removal?"
      )) return;

      restore.disabled = true;

      const { data: restored, error: restoreError } = await supabase.rpc(
        "admin_restore_process_pending",
        { _pending_id: pending.id },
      );

      if (restoreError) {
        restore.disabled = false;
        showToast(restoreError.message);
        return;
      }

      if (!restored) {
        restore.disabled = false;
        showToast("Pending process could not be restored.");
        return;
      }

      showToast(
        pending.entity_type === "run_list"
          ? "Run List restored."
          : "Checklist removal cancelled."
      );

      await refreshRuns();
      await refreshHistory();
      await refreshChecklist();
      await refreshProcessPending();
    };

    const finalDelete = document.createElement("button");
    finalDelete.type = "button";
    finalDelete.className = "admin-danger";
    finalDelete.textContent = "Final Delete";

    finalDelete.onclick = async () => {
      if (!confirm("Final delete this item? This cannot be restored.")) return;

      finalDelete.disabled = true;

      const { data: finalized, error: finalizeError } = await supabase.rpc(
        "admin_finalize_process_pending",
        { _pending_id: pending.id },
      );

      if (finalizeError) {
        finalDelete.disabled = false;
        showToast(finalizeError.message);
        return;
      }

      if (!finalized) {
        finalDelete.disabled = false;
        showToast("Pending process could not be finalized.");
        return;
      }

      showToast("Final deletion completed.");

      await refreshRuns();
      await refreshHistory();
      await refreshChecklist();
      await refreshProcessPending();
    };

    actions.append(restore, finalDelete);
    card.append(info, actions);
    list.appendChild(card);
  }
}

function activateAdminStockSetupScreen() {
  document
    .querySelectorAll(".bottom-nav button[data-screen]")
    .forEach((button) => button.classList.remove("active"));

  document
    .querySelector('.bottom-nav button[data-screen="more"]')
    ?.classList.add("active");

  document.querySelectorAll(".screen").forEach((element) => {
    element.classList.remove("active");
  });

  $("screen-admin")?.classList.add("active");
  $("appShell").classList.remove("chat-mode");
  document.documentElement.classList.remove("chat-screen-lock");
  document.body.classList.remove("chat-screen-lock");
}

async function openStockSetupFromOperations({ barcode = "", mode = "factory", product = null } = {}) {
  if (!canManageProductData()) {
    showToast("Stock setup access is limited to Joey, Troy J and Alex S.");
    return;
  }

  limitedStockSetupEntry = !isOwnerUser();
  activateAdminStockSetupScreen();
  showAdminStockSetupView();

  if (product) await stockController?.selectForAdmin(product);

  if (barcode) {
    await stockController?.handleAdminBarcode(barcode);

    // For a brand-new barcode, preserve the type chosen on Stock.
    if (mode === "factory" && $("adminStockScanUnknownPanel") && !$("adminStockScanUnknownPanel").classList.contains("hidden")) {
      $("adminStockUnknownFactoryBtn")?.click();
    }
  }
}

let adminStockSearchTimer = null;

$("openStockSetupBtn").onclick = () => {
  if (!isOwnerUser()) return;

  limitedStockSetupEntry = false;
  stockController?.reset();
  showAdminStockSetupView();

  $("adminStockSearch").value = "";
  $("adminStockSearchResults").innerHTML = "";
  $("adminStockSearchResults").classList.add("hidden");
  $("adminStockSelected")?.classList.add("hidden");
  $("adminStockSearch").focus();
};

$("adminStockSetupBackBtn").onclick = async () => {
  clearTimeout(adminStockSearchTimer);
  stockController?.reset();

  if (limitedStockSetupEntry || !isOwnerUser()) {
    limitedStockSetupEntry = false;
    await navigateToScreen("stock");
    return;
  }

  showAdminHomeView();
};

$("adminStockSearch").addEventListener("input", () => {
  clearTimeout(adminStockSearchTimer);

  const query = $("adminStockSearch").value.trim();

  if (!query) {
    $("adminStockSearchResults").classList.add("hidden");
    $("adminStockSearchResults").innerHTML = "";
    return;
  }

  adminStockSearchTimer = setTimeout(
    () => searchAdminStockProducts(query),
    140,
  );
});

$("adminStockLinkSearch")?.addEventListener("input", () => {
  clearTimeout(adminStockSearchTimer);

  const query = $("adminStockLinkSearch").value.trim();
  const results = $("adminStockLinkSearchResults");

  if (!query) {
    results?.classList.add("hidden");
    if (results) results.innerHTML = "";
    return;
  }

  adminStockSearchTimer = setTimeout(
    () => searchAdminStockProducts(query, "adminStockLinkSearchResults"),
    140,
  );
});

async function searchAdminStockProducts(query, targetId = "adminStockSearchResults") {
  // Stock Runner users enter this screen after identifying an unknown
  // barcode as a Factory Code. They must be able to search the product
  // catalog so the scanned factory ticket can be linked to its product.
  if (!canManageProductData()) return;

  const results = $(targetId);
  if (!results) return;
  results.classList.remove("hidden");
  results.innerHTML = '<div class="search-result-empty">Searching...</div>';

  try {
    const rows = await stockController.searchForAdmin(query);

    results.innerHTML = "";

    if (!rows.length) {
      results.innerHTML = '<div class="search-result-empty">No matching products.</div>';
      return;
    }

    for (const product of rows) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stock-search-result";
      button.innerHTML = `
        <span>
          <strong>${escapeHtml(product.name)}</strong>
          <small>Product Code ${escapeHtml(product.code)}</small>
        </span>
        <b>Setup</b>
      `;

      button.onclick = async () => {
        results.classList.add("hidden");
        results.innerHTML = "";
        if ($("adminStockSearch")) $("adminStockSearch").value = "";
        if ($("adminStockLinkSearch")) $("adminStockLinkSearch").value = "";

        try {
          await stockController.selectForAdmin(product);
        } catch (error) {
          showToast(error.message);
        }
      };

      results.appendChild(button);
    }
  } catch (error) {
    results.innerHTML =
      `<div class="search-result-empty">${escapeHtml(error.message)}</div>`;
  }
}

function showAdminStockSetupView() {
  stopAdminBarcodeScanner();

  $("adminHomeView")?.classList.add("hidden");
  $("adminBarcodeDetailView")?.classList.add("hidden");
  $("adminProcessPendingView")?.classList.add("hidden");
  $("adminPricingView")?.classList.add("hidden");
  $("adminStockSetupView")?.classList.remove("hidden");

  $("screenTitle").textContent = "Stock Setup";
  void stockController?.refreshSetupData?.();
}

$("openBarcodeDataManagerBtn").onclick = async () => {
  showAdminBarcodeDetailView();
  await refreshBarcodeData();
};

$("adminBarcodeBackBtn").onclick = () => {
  stopAdminBarcodeScanner();
  resetAdminMappingForm();
  showAdminHomeView();
};

function showAdminHomeView() {
  if (!isOwnerUser()) {
    return;
  }

  limitedStockSetupEntry = false;
  stopAdminBarcodeScanner();

  $("adminHomeView")?.classList.remove("hidden");
  $("adminBarcodeDetailView")?.classList.add("hidden");
  $("adminProcessPendingView")?.classList.add("hidden");
  $("adminStockSetupView")?.classList.add("hidden");
  $("adminPricingView")?.classList.add("hidden");

  if ($("screen-admin")?.classList.contains("active")) {
    $("screenTitle").textContent = "Admin";
  }
}

function showAdminBarcodeDetailView() {
  $("adminHomeView")?.classList.add("hidden");
  $("adminProcessPendingView")?.classList.add("hidden");
  $("adminStockSetupView")?.classList.add("hidden");
  $("adminPricingView")?.classList.add("hidden");
  $("adminBarcodeDetailView")?.classList.remove("hidden");
  $("screenTitle").textContent = "Barcode Data";
}

$("adminScanBarcodeBtn").onclick = startAdminBarcodeScanner;
$("adminStopScannerBtn").onclick = resetAdminScannerUiState;

function getAdminBarcodeScanner() {
  if (!adminBarcodeScanner) {
    adminBarcodeScanner = createBarcodeScanner({
      reader: $("adminReader"),
      overlay: $("adminScannerWrap"),
      status: $("adminScanStatus"),
      closeButton: $("adminStopScannerBtn"),
      scanButton: $("adminScanBarcodeBtn"),
      onResult: async (raw) => {
        const value = normalizeScannedBarcode(raw);
        if (!value) return;

        await loadScannedBarcodeIntoAdminEditor(value);
      },
      onError: (error) => {
        console.error("Admin barcode scanner:", error);
        showToast(error.message || "Barcode scanner failed.", 6000);
      },
    });
  }

  return adminBarcodeScanner;
}

function startAdminBarcodeScanner() {
  if (currentUser?.id !== ADMIN_USER_ID) return;

  stopScanner();
  return getAdminBarcodeScanner().start();
}

function stopAdminBarcodeScanner() {
  adminBarcodeScanner?.stop();
}

async function loadScannedBarcodeIntoAdminEditor(barcode) {
  if (currentUser?.id !== ADMIN_USER_ID) return;

  if (!adminBarcodeMappings.length) {
    await refreshBarcodeData();
  }

  const existing = adminBarcodeMappings.find(
    (row) => String(row.barcode) === String(barcode),
  );

  $("adminMappingBarcode").value = barcode;

  if (existing) {
    const productName = Array.isArray(existing.products)
      ? existing.products[0]?.name
      : existing.products?.name;

    $("adminMappingOriginalBarcode").value = existing.barcode;
    $("adminMappingProductCode").value = existing.product_code || "";
    $("adminMappingProductName").value = productName || "";
    $("adminMappingSaveBtn").textContent = "Save Changes";
    $("adminMappingCancelBtn").classList.remove("hidden");
    $("adminMappingModeText").textContent = `Editing saved barcode ${barcode}`;

    showToast(`Loaded saved barcode ${barcode}.`);
  } else {
    $("adminMappingOriginalBarcode").value = "";
    $("adminMappingProductCode").value = "";
    $("adminMappingProductName").value = "";
    $("adminMappingSaveBtn").textContent = "Add Mapping";
    $("adminMappingCancelBtn").classList.add("hidden");
    $("adminMappingModeText").textContent = `New barcode ${barcode}`;

    showToast(`Barcode ${barcode} is not saved yet.`);
  }

  $("adminBarcodeMappingForm").scrollIntoView({
    behavior: "smooth",
    block: "start",
  });

  if (existing) {
    $("adminMappingProductCode").focus();
  } else {
    $("adminMappingProductCode").focus();
  }
}

$("refreshBarcodeDataBtn").onclick = refreshBarcodeData;

$("adminBarcodeDataSearch").addEventListener("input", () => {
  renderBarcodeData();
});

$("adminMappingCancelBtn").onclick = () => {
  resetAdminMappingForm();
};

$("adminBarcodeMappingForm").onsubmit = async (event) => {
  event.preventDefault();

  if (currentUser?.id !== ADMIN_USER_ID) return;

  const originalBarcode = $("adminMappingOriginalBarcode").value.trim();
  const barcode = $("adminMappingBarcode").value.trim();
  const productCode = $("adminMappingProductCode").value.trim();
  const productName = $("adminMappingProductName").value.trim();

  if (!barcode || !productCode || !productName) {
    showToast("Barcode, Product Code and Product Name are required.");
    return;
  }

  const saveButton = $("adminMappingSaveBtn");
  const previousText = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";

  const { error } = await supabase.rpc(
    "admin_save_product_barcode",
    {
      _original_barcode: originalBarcode,
      _barcode: barcode,
      _product_code: productCode,
      _product_name: productName,
      _barcode_type: $("adminMappingBarcodeType")?.value || "ticket_barcode",
    },
  );

  saveButton.disabled = false;
  saveButton.textContent = previousText;

  if (error) {
    showToast(error.message);
    return;
  }

  productSearchCatalog = null;
  resetAdminMappingForm();
  await refreshBarcodeData();
  showToast(originalBarcode ? "Barcode mapping updated." : "Barcode mapping added.");
};

function resetAdminMappingForm() {
  $("adminMappingOriginalBarcode").value = "";
  $("adminMappingBarcode").value = "";
  $("adminMappingProductCode").value = "";
  $("adminMappingProductName").value = "";
  $("adminMappingBarcodeType").value = "ticket_barcode";
  $("adminMappingSaveBtn").textContent = "Add Mapping";
  $("adminMappingCancelBtn").classList.add("hidden");

  if ($("adminMappingModeText")) {
    $("adminMappingModeText").textContent = "New barcode mapping";
  }
}

function loadBarcodeMappingIntoAdminEditor(row, productName = "") {
  $("adminMappingOriginalBarcode").value = row.barcode || "";
  $("adminMappingBarcode").value = row.barcode || "";
  $("adminMappingProductCode").value = row.product_code || "";
  $("adminMappingBarcodeType").value = row.barcode_type || "ticket_barcode";
  $("adminMappingProductName").value = productName || "";
  $("adminMappingSaveBtn").textContent = "Save Changes";
  $("adminMappingCancelBtn").classList.remove("hidden");
  $("adminMappingModeText").textContent = `Editing saved barcode ${row.barcode}`;

  $("adminBarcodeMappingForm").scrollIntoView({
    behavior: "smooth",
    block: "start",
  });

  $("adminMappingProductCode").focus();
}

async function refreshBarcodeData() {
  if (currentUser?.id !== ADMIN_USER_ID) return;

  const container = $("adminBarcodeDataList");
  container.innerHTML = `<div class="empty-state">Loading...</div>`;

  const all = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("product_barcodes")
      .select("barcode, product_code, barcode_type, updated_at, products(name)")
      .order("updated_at", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      $("adminBarcodeDataCount").textContent = "";
      return;
    }

    const page = data || [];
    all.push(...page);

    if (page.length < pageSize) break;
    from += pageSize;
  }

  adminBarcodeMappings = all;
  renderBarcodeData();
}

function renderBarcodeData() {
  const container = $("adminBarcodeDataList");
  if (!container) return;

  const query = normalizeProductSearchText(
    $("adminBarcodeDataSearch")?.value || "",
  );

  let rows = adminBarcodeMappings;

  if (query) {
    const terms = query.split(" ").filter(Boolean);

    rows = rows.filter((row) => {
      const productName = Array.isArray(row.products)
        ? row.products[0]?.name
        : row.products?.name;

      const haystack = normalizeProductSearchText(
        `${row.barcode} ${row.product_code} ${productName || ""}`,
      );

      return terms.every((term) => haystack.includes(term));
    });
  }

  $("adminBarcodeDataCount").textContent =
    `${rows.length} mapping${rows.length === 1 ? "" : "s"}`;

  container.innerHTML = "";

  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No matching barcode mappings.</div>`;
    return;
  }

  for (const row of rows) {
    const productName = Array.isArray(row.products)
      ? row.products[0]?.name
      : row.products?.name;

    const card = document.createElement("div");
    card.className = "admin-barcode-row";

    const info = document.createElement("div");
    info.className = "admin-barcode-row-info";
    info.innerHTML = `
      <div class="admin-barcode-value">${escapeHtml(row.barcode)}</div>
      <div class="item-title">${escapeHtml(productName || "Unknown product")}</div>
      <div class="item-sub">Product Code: ${escapeHtml(row.product_code)}</div>
      <div class="item-sub">Type: ${escapeHtml(row.barcode_type === "product_code" ? "Product Code" : "Ticket Barcode")}</div>
      <div class="item-sub">Updated: ${escapeHtml(formatDateTime(row.updated_at))}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "admin-barcode-row-actions";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary";
    open.textContent = "Open";
    open.onclick = (event) => {
      event.stopPropagation();
      loadBarcodeMappingIntoAdminEditor(row, productName);
    };

    const del = document.createElement("button");
    del.type = "button";
    del.className = "admin-danger";
    del.textContent = "Delete";
    del.onclick = async (event) => {
      event.stopPropagation();

      if (!confirm(`Delete barcode mapping ${row.barcode}? The product itself will remain in the catalog.`)) {
        return;
      }

      del.disabled = true;

      const { error } = await supabase.rpc(
        "admin_delete_product_barcode",
        {
          _barcode: row.barcode,
        },
      );

      if (error) {
        del.disabled = false;
        showToast(error.message);
        return;
      }

      if ($("adminMappingOriginalBarcode").value === row.barcode) {
        resetAdminMappingForm();
      }

      await refreshBarcodeData();
      showToast(`Barcode ${row.barcode} mapping deleted.`);
    };

    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Open barcode ${row.barcode}`);
    card.onclick = () => loadBarcodeMappingIntoAdminEditor(row, productName);
    card.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        loadBarcodeMappingIntoAdminEditor(row, productName);
      }
    };

    actions.append(open, del);
    card.append(info, actions);
    container.appendChild(card);
  }
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

  // v1.47: notifications/options were removed from GCFR.
  localStorage.removeItem("gcfr_notification_settings_v1");

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
      // Temporary API/network errors must not revoke the remembered session.
      await leaveApp();
      setAuthStatus("Connection interrupted. Your login is saved; reconnect and retry.");
      let retry = $("sessionRestoreRetry");
      if (!retry) {
        retry = document.createElement("button");
        retry.id = "sessionRestoreRetry";
        retry.type = "button";
        retry.textContent = "Retry saved login";
        $("loginForm").appendChild(retry);
      }
      retry.onclick = async () => {
        retry.disabled = true;
        await boot().finally(() => { retry.disabled = false; });
      };
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
