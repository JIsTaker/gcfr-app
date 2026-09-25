const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const shortTime = (value) => String(value || "").slice(0, 5);
const handoffLabel = (status) => ({
  new: "New", seen: "Seen", in_progress: "In Progress", done: "Done",
}[status] || status || "New");

export function createMyShiftController(options) {
  const { supabase, $, showToast, getCurrentUser, getCurrentProfile, isOwnerUser,
    navigateToScreen, localDateString, formatDateTime, getRosterSelectedDate } = options;

  let channels = [];
  let started = false;
  let bound = false;
  let refreshEpoch = 0;
  let handoffs = [];
  let receivedHandoffIds = new Set();
  let notifications = [];
  let profileMap = new Map();
  let offRows = [];

  const user = () => getCurrentUser?.() || null;
  const today = () => localDateString(new Date());
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };

  function displayName(id) {
    if (id === user()?.id) {
      const p = getCurrentProfile?.();
      return p?.display_name || p?.username || "You";
    }
    return profileMap.get(id) || "Team member";
  }

  async function ensureProfiles(ids) {
    const missing = [...new Set((ids || []).filter(Boolean))].filter((id) => !profileMap.has(id));
    if (!missing.length) return;
    const result = await supabase.from("profiles").select("id, display_name, username").in("id", missing);
    for (const row of result.data || []) {
      profileMap.set(row.id, row.display_name || row.username || "User");
    }
  }

  async function loadShift(date) {
    const current = user();
    if (!current) return { shifts: [], off: false };
    const results = await Promise.all([
      supabase.from("gcfr_roster_shifts")
        .select("id, shift_date, start_time, end_time, assignment, notes")
        .eq("user_id", current.id).eq("shift_date", date).order("start_time"),
      supabase.from("gcfr_roster_off_days")
        .select("id").eq("user_id", current.id).eq("off_date", date).maybeSingle(),
    ]);
    if (results[0].error) throw results[0].error;
    if (results[1].error) throw results[1].error;
    return { shifts: results[0].data || [], off: !!results[1].data };
  }

  function renderShift(value, date) {
    const state = $("myShiftRosterStatus");
    const detail = $("myShiftRosterDetails");
    if (!state || !detail) return;
    if (value.off) {
      state.textContent = "OFF";
      state.className = "my-shift-state off";
      detail.textContent = "Roster work alerts are paused for this date.";
      return;
    }
    if (!value.shifts.length) {
      state.textContent = "Not rostered";
      state.className = "my-shift-state";
      detail.textContent = "No shift is assigned today.";
      return;
    }
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const working = date === today() && value.shifts.some((shift) => {
      const startParts = shortTime(shift.start_time).split(":").map(Number);
      const endParts = shortTime(shift.end_time).split(":").map(Number);
      const start = (startParts[0] || 0) * 60 + (startParts[1] || 0);
      let end = (endParts[0] || 0) * 60 + (endParts[1] || 0);
      let current = nowMinutes;
      if (end <= start) {
        end += 1440;
        if (current < start) current += 1440;
      }
      return current >= start && current < end;
    });
    state.textContent = working ? "Working now" : "Rostered";
    state.className = working ? "my-shift-state working" : "my-shift-state rostered";
    detail.innerHTML = value.shifts.map((shift) => {
      const assignment = shift.assignment ? " · " + esc(shift.assignment) : "";
      return "<div><strong>" + esc(shortTime(shift.start_time)) + "-" +
        esc(shortTime(shift.end_time)) + "</strong>" + assignment + "</div>";
    }).join("");
  }

  async function loadRuns() {
    const runResult = await supabase.from("run_lists")
      .select("id").eq("status", "active").is("deleted_at", null);
    if (runResult.error) throw runResult.error;
    const ids = (runResult.data || []).map((row) => row.id);
    if (!ids.length) return { runs: 0, remaining: 0 };
    const itemResult = await supabase.from("run_items")
      .select("id, status, deleted_at").in("run_list_id", ids);
    if (itemResult.error) throw itemResult.error;
    return {
      runs: ids.length,
      remaining: (itemResult.data || []).filter((row) => !row.deleted_at && row.status !== "completed").length,
    };
  }

  async function loadChecklist(date) {
    const result = await supabase.from("checklist_tasks").select("id, status").eq("task_date", date);
    if (result.error) throw result.error;
    const rows = result.data || [];
    return { total: rows.length, remaining: rows.filter((row) => row.status !== "completed").length };
  }

  async function loadStock(date) {
    const current = user();
    if (!current) return 0;
    const result = await supabase.from("gcfr_stock_counts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", current.id).eq("count_date", date);
    if (result.error) throw result.error;
    return Number(result.count || 0);
  }

  async function loadHandoffs() {
    const current = user();
    if (!current) return;

    const recipientResult = await supabase.from("gcfr_handoff_recipients")
      .select("handoff_id").eq("user_id", current.id);
    if (recipientResult.error) throw recipientResult.error;

    receivedHandoffIds = new Set((recipientResult.data || []).map((row) => row.handoff_id));

    const columns = "id, created_by, priority, title, note, related_type, related_id, status, seen_at, in_progress_at, completed_at, created_at, updated_at";
    const ownResult = await supabase.from("gcfr_shift_handoffs")
      .select(columns).eq("created_by", current.id)
      .order("created_at", { ascending: false }).limit(100);
    if (ownResult.error) throw ownResult.error;

    let received = [];
    const ids = [...receivedHandoffIds];
    if (ids.length) {
      const receivedResult = await supabase.from("gcfr_shift_handoffs")
        .select(columns).in("id", ids)
        .order("created_at", { ascending: false }).limit(100);
      if (receivedResult.error) throw receivedResult.error;
      received = receivedResult.data || [];
    }

    const merged = new Map();
    for (const row of [...(ownResult.data || []), ...received]) merged.set(row.id, row);
    handoffs = [...merged.values()].sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
    );

    await ensureProfiles(handoffs.map((row) => row.created_by));
    renderHandoffs();
  }

  function renderHandoffs() {
    const host = $("myShiftHandoffList");
    const badge = $("myShiftHandoffCount");
    if (!host || !badge) return;
    const active = handoffs.filter((row) => row.status !== "done");
    badge.textContent = String(active.length);
    badge.classList.toggle("hidden", active.length === 0);
    if (!handoffs.length) {
      host.innerHTML = '<div class="empty-state">No handoffs.</div>';
      return;
    }

    const rows = active.concat(handoffs.filter((row) => row.status === "done"));
    host.innerHTML = rows.map((row) => {
      const important = row.priority === "important";
      const mine = row.created_by === user()?.id;
      let buttons = "";
      if (row.status === "in_progress") {
        buttons = '<button type="button" class="primary" data-handoff-status="done" data-handoff-id="' +
          esc(row.id) + '">Done</button>';
      } else if (row.status !== "done") {
        buttons = '<button type="button" class="secondary" data-handoff-status="in_progress" data-handoff-id="' +
          esc(row.id) + '">Start</button>' +
          '<button type="button" class="primary" data-handoff-status="done" data-handoff-id="' +
          esc(row.id) + '">Done</button>';
      }
      const note = row.note ? "<p>" + esc(row.note) + "</p>" : "";
      const related = row.related_type
        ? '<div class="handoff-related">' + esc(row.related_type) +
          (row.related_id ? " · " + esc(row.related_id) : "") + "</div>"
        : "";
      return '<details class="handoff-card ' + (important ? "important " : "") +
        (row.status === "done" ? "done" : "") + '" data-handoff-open="' + esc(row.id) + '">' +
        "<summary><span class=\"handoff-summary-copy\"><strong>" +
        (important ? "Important · " : "") + esc(row.title) + "</strong><small>" +
        esc(displayName(row.created_by)) + " · " + esc(handoffLabel(row.status)) + " · " +
        esc(formatDateTime(row.created_at)) + '</small></span><span class="handoff-status-pill">' +
        esc(handoffLabel(row.status)) + "</span></summary>" +
        '<div class="handoff-body">' + note + related + '<div class="handoff-actions">' + buttons +
        (mine ? '<span class="handoff-mine">Created by you</span>' : "") + "</div></div></details>";
    }).join("");

    host.querySelectorAll("details[data-handoff-open]").forEach((details) => {
      details.addEventListener("toggle", () => {
        if (details.open) void markSeen(details.dataset.handoffOpen);
      });
    });
    host.querySelectorAll("[data-handoff-status]").forEach((button) => {
      button.addEventListener("click", () =>
        void updateHandoff(button.dataset.handoffId, button.dataset.handoffStatus)
      );
    });
  }

  async function markSeen(id) {
    const row = handoffs.find((item) => item.id === id);
    if (!row || row.status !== "new" || !receivedHandoffIds.has(id)) return;
    const now = new Date().toISOString();
    const result = await supabase.from("gcfr_shift_handoffs")
      .update({ status: "seen", seen_at: now, updated_at: now }).eq("id", id);
    if (result.error) return;
    await supabase.from("gcfr_handoff_recipients")
      .update({ seen_at: now }).eq("handoff_id", id).eq("user_id", user().id);
    row.status = "seen";
    row.seen_at = now;
    renderHandoffs();
  }

  async function updateHandoff(id, status) {
    const now = new Date().toISOString();
    const patch = { status, updated_at: now };
    if (status === "in_progress") patch.in_progress_at = now;
    if (status === "done") patch.completed_at = now;
    const result = await supabase.from("gcfr_shift_handoffs").update(patch).eq("id", id);
    if (result.error) return showToast(result.error.message);
    showToast(status === "done" ? "Handoff completed." : "Handoff started.");
    await loadHandoffs();
  }

  async function submitHandoff(event) {
    event.preventDefault();
    const current = user();
    if (!current) return;
    const title = $("handoffTitle")?.value.trim();
    if (!title) return;
    const button = $("handoffSubmitBtn");
    if (button) button.disabled = true;
    const result = await supabase.from("gcfr_shift_handoffs").insert({
      created_by: current.id,
      priority: $("handoffPriority")?.value || "normal",
      title,
      note: $("handoffNote")?.value.trim() || null,
    });
    if (button) button.disabled = false;
    if (result.error) return showToast(result.error.message);
    $("handoffForm")?.reset();
    showToast("Handoff sent to current and next shift.");
    await Promise.all([loadHandoffs(), loadNotifications()]);
  }

  async function loadNotifications() {
    const current = user();
    if (!current) return;
    const result = await supabase.from("gcfr_notifications")
      .select("id, event_type, title, body, related_type, related_id, important, read_at, created_at")
      .eq("user_id", current.id).order("created_at", { ascending: false }).limit(60);
    if (result.error) return;
    notifications = result.data || [];
    renderNotifications();
  }

  function renderNotifications() {
    const host = $("myShiftNotifications");
    if (!host) return;
    const unread = notifications.filter((row) => !row.read_at).length;
    ["myShiftNavBadge", "myShiftNotificationCount"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.textContent = unread > 99 ? "99+" : String(unread);
      el.classList.toggle("hidden", unread === 0);
    });
    if (!notifications.length) {
      host.innerHTML = '<div class="empty-state">No notifications.</div>';
      return;
    }
    host.innerHTML = notifications.map((row) => {
      return '<button type="button" class="notification-row ' + (row.read_at ? "read " : "unread ") +
        (row.important ? "important" : "") + '" data-notification-id="' + esc(row.id) + '">' +
        "<span><strong>" + esc(row.title) + "</strong><small>" + esc(row.body || "") +
        "</small></span><time>" + esc(formatDateTime(row.created_at)) + "</time></button>";
    }).join("");
    host.querySelectorAll("[data-notification-id]").forEach((button) => {
      button.onclick = () => void markNotification(button.dataset.notificationId);
    });
  }

  async function markNotification(id) {
    const now = new Date().toISOString();
    const result = await supabase.from("gcfr_notifications")
      .update({ read_at: now }).eq("id", id).eq("user_id", user().id);
    if (result.error) return;
    const row = notifications.find((item) => item.id === id);
    if (row) row.read_at = now;
    renderNotifications();
  }

  async function markAllNotifications() {
    if (!user()) return;
    const now = new Date().toISOString();
    const result = await supabase.from("gcfr_notifications")
      .update({ read_at: now }).eq("user_id", user().id).is("read_at", null);
    if (result.error) return showToast(result.error.message);
    notifications.forEach((row) => { if (!row.read_at) row.read_at = now; });
    renderNotifications();
  }

  function renderPermission() {
    const button = $("enableShiftNotificationsBtn");
    if (!button) return;
    const supported = "Notification" in window;
    button.classList.toggle("hidden", !supported || Notification.permission === "granted");
  }

  async function requestPermission() {
    if (!("Notification" in window)) {
      showToast("System notifications are not supported on this device.");
      return;
    }
    const permission = await Notification.requestPermission();
    renderPermission();
    showToast(permission === "granted" ? "Notifications enabled." : "Notification permission not enabled.");
  }

  async function showSystemNotification(row) {
    if (!row || row.user_id !== user()?.id) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(row.title || "GCFR", {
          body: row.body || "",
          tag: "gcfr-" + row.id,
          data: { relatedType: row.related_type || null, relatedId: row.related_id || null },
        });
      } else {
        new Notification(row.title || "GCFR", { body: row.body || "" });
      }
      navigator.vibrate?.(row.important ? [150, 80, 150] : 120);
    } catch (error) {
      console.warn("Notification display failed:", error);
    }
  }

  async function refreshAttention() {
    const panel = $("myShiftAttentionPanel");
    if (!panel) return;
    if (!isOwnerUser()) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    const results = await Promise.all([
      supabase.from("gcfr_process_pending").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("gcfr_shift_handoffs").select("id", { count: "exact", head: true })
        .eq("priority", "important").neq("status", "done"),
    ]);
    setText("myShiftAttentionPending", String(Number(results[0].count || 0)));
    setText("myShiftAttentionImportant", String(Number(results[1].count || 0)));
  }

  async function refresh() {
    if (!user()) return;
    const epoch = ++refreshEpoch;
    const date = today();
    setText("myShiftDate", new Intl.DateTimeFormat(undefined, {
      weekday: "long", day: "numeric", month: "long",
    }).format(new Date()));
    const results = await Promise.allSettled([
      loadShift(date), loadRuns(), loadChecklist(date), loadStock(date),
      loadHandoffs(), loadNotifications(), refreshAttention(),
    ]);
    if (epoch !== refreshEpoch) return;

    if (results[0].status === "fulfilled") renderShift(results[0].value, date);
    else {
      setText("myShiftRosterStatus", "Unavailable");
      setText("myShiftRosterDetails", results[0].reason?.message || "Could not load roster.");
    }
    if (results[1].status === "fulfilled") {
      setText("myShiftRunCount", String(results[1].value.runs));
      setText("myShiftRunRemaining", String(results[1].value.remaining) + " remaining");
    } else {
      setText("myShiftRunCount", "-"); setText("myShiftRunRemaining", "Unavailable");
    }
    if (results[2].status === "fulfilled") {
      setText("myShiftChecklistCount", String(results[2].value.remaining));
      setText("myShiftChecklistMeta", String(results[2].value.total) + " total");
    } else {
      setText("myShiftChecklistCount", "-"); setText("myShiftChecklistMeta", "Unavailable");
    }
    if (results[3].status === "fulfilled") {
      setText("myShiftStockCount", String(results[3].value));
      setText("myShiftStockMeta", "records today");
    } else {
      setText("myShiftStockCount", "-"); setText("myShiftStockMeta", "Unavailable");
    }
  }

  async function loadOff(date) {
    if (!isOwnerUser()) return;
    if (!profileMap.size) {
      const profileResult = await supabase.from("profiles")
        .select("id, display_name, username").order("display_name");
      for (const row of profileResult.data || []) {
        profileMap.set(row.id, row.display_name || row.username || "User");
      }
    }
    const result = await supabase.from("gcfr_roster_off_days")
      .select("id, user_id, off_date, created_at").eq("off_date", date).order("created_at");
    if (result.error) throw result.error;
    offRows = result.data || [];
  }

  function renderOff(date) {
    const panel = $("rosterOffManager");
    const list = $("rosterOffList");
    const select = $("rosterOffUser");
    if (!panel || !list || !select) return;
    if (!isOwnerUser()) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    setText("rosterOffDateLabel", date);
    const previous = select.value;
    const entries = [...profileMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    select.innerHTML = entries.map((entry) =>
      '<option value="' + esc(entry[0]) + '">' + esc(entry[1]) + "</option>"
    ).join("");
    if (entries.some((entry) => entry[0] === previous)) select.value = previous;
    list.innerHTML = offRows.length ? offRows.map((row) =>
      '<div class="roster-off-row"><strong>' + esc(displayName(row.user_id)) +
      '</strong><button type="button" class="secondary" data-clear-off="' +
      esc(row.user_id) + '">Clear OFF</button></div>'
    ).join("") : '<div class="empty-state">No one marked OFF.</div>';
    list.querySelectorAll("[data-clear-off]").forEach((button) => {
      button.onclick = () => void clearOff(button.dataset.clearOff, date);
    });
  }

  async function refreshRosterOff(date) {
    const chosen = date || getRosterSelectedDate?.() || today();
    const panel = $("rosterOffManager");
    if (!panel || !isOwnerUser()) {
      panel?.classList.add("hidden");
      return;
    }
    try {
      await loadOff(chosen);
      renderOff(chosen);
    } catch (error) {
      panel.classList.remove("hidden");
      const list = $("rosterOffList");
      if (list) list.innerHTML = '<div class="empty-state">' + esc(error.message) + "</div>";
    }
  }

  async function setOff() {
    if (!isOwnerUser()) return;
    const userId = $("rosterOffUser")?.value;
    const date = getRosterSelectedDate?.() || today();
    if (!userId) return;
    const result = await supabase.from("gcfr_roster_off_days").upsert({
      user_id: userId, off_date: date, created_by: user().id,
    }, { onConflict: "user_id,off_date" });
    if (result.error) return showToast(result.error.message);
    showToast(displayName(userId) + " marked OFF.");
    await Promise.all([refreshRosterOff(date), refresh()]);
  }

  async function clearOff(userId, date) {
    if (!isOwnerUser()) return;
    const chosen = date || getRosterSelectedDate?.() || today();
    const result = await supabase.from("gcfr_roster_off_days")
      .delete().eq("user_id", userId).eq("off_date", chosen);
    if (result.error) return showToast(result.error.message);
    showToast(displayName(userId) + " OFF cleared.");
    await Promise.all([refreshRosterOff(chosen), refresh()]);
  }

  function subscribe() {
    const current = user();
    if (!current) return;
    channels.push(
      supabase.channel("gcfr-notifications-" + current.id)
        .on("postgres_changes", {
          event: "INSERT", schema: "public", table: "gcfr_notifications",
          filter: "user_id=eq." + current.id,
        }, async (payload) => {
          await showSystemNotification(payload.new);
          await loadNotifications();
          if ($("screen-myshift")?.classList.contains("active")) await refresh();
        }).subscribe(),
      supabase.channel("gcfr-handoffs-" + current.id)
        .on("postgres_changes", { event: "*", schema: "public", table: "gcfr_shift_handoffs" },
          () => void loadHandoffs())
        .on("postgres_changes", { event: "*", schema: "public", table: "gcfr_handoff_recipients" },
          () => void loadHandoffs())
        .subscribe(),
      supabase.channel("gcfr-off-" + current.id)
        .on("postgres_changes", { event: "*", schema: "public", table: "gcfr_roster_off_days" }, () => {
          void refresh();
          if ($("screen-roster")?.classList.contains("active")) void refreshRosterOff();
        }).subscribe(),
    );
  }

  function bind() {
    $("handoffForm")?.addEventListener("submit", submitHandoff);
    $("markAllShiftNotificationsReadBtn")?.addEventListener("click", markAllNotifications);
    $("enableShiftNotificationsBtn")?.addEventListener("click", requestPermission);
    $("rosterSetOffBtn")?.addEventListener("click", setOff);
    $("myShiftRefreshBtn")?.addEventListener("click", () => void refresh());
    document.querySelectorAll("[data-my-shift-screen]").forEach((button) => {
      button.addEventListener("click", () => navigateToScreen(button.dataset.myShiftScreen));
    });
  }

  async function start() {
    if (started) return;
    started = true;
    if (!bound) {
      bind();
      bound = true;
    }
    renderPermission();
    await Promise.all([refresh(), refreshRosterOff()]);
    subscribe();
  }

  function reset() {
    refreshEpoch += 1;
    channels.forEach((channel) => supabase.removeChannel(channel));
    channels = [];
    started = false;
    handoffs = [];
    receivedHandoffIds = new Set();
    notifications = [];
    profileMap = new Map();
    offRows = [];
  }

  return { start, reset, refresh, refreshRosterOff, loadNotifications, loadHandoffs };
}
