const LANG_KEY_PREFIX = "gcfr_owner_admin_language_";

const TEXT = {
  ko: {
    documentsTitle: "Documents",
    documentsSubtitle: "사내 문서 · 본인 계정에서만 열람 가능",
    confidential: "사내 전용 · 외부 배포 금지",
    loading: "문서를 불러오는 중...",
    noDocuments: "등록된 문서가 없습니다.",
    view: "보기",
    openFull: "전체 화면",
    closePreview: "문서 닫기",
    documentLoadError: "문서를 불러오지 못했습니다.",
    resetTitle: "Fresh Produce Reset",
    resetSubtitle: "점장 실행 체크리스트 · 완료 상태는 본인 계정에만 저장됩니다.",
    overall: "전체 진행률",
    completed: "완료",
    notes: "메모 / 다음 단계",
    saveNote: "메모 저장",
    noteSaved: "메모가 저장되었습니다.",
    loadingProgress: "진행 상태를 불러오는 중...",
    progressError: "진행 상태를 불러오지 못했습니다.",
    days: ["월","화","수","목","금","토","일"],
    expand: "세부 실행 단계",
  },
  en: {
    documentsTitle: "Documents",
    documentsSubtitle: "Internal documents · available only to your account",
    confidential: "INTERNAL ONLY · DO NOT DISTRIBUTE",
    loading: "Loading documents...",
    noDocuments: "No documents available.",
    view: "View",
    openFull: "Full screen",
    closePreview: "Close document",
    documentLoadError: "Could not load the document.",
    resetTitle: "Fresh Produce Reset",
    resetSubtitle: "Store Manager execution checklist · progress is saved only to your account.",
    overall: "Overall progress",
    completed: "complete",
    notes: "Notes / Next steps",
    saveNote: "Save note",
    noteSaved: "Note saved.",
    loadingProgress: "Loading progress...",
    progressError: "Could not load progress.",
    days: ["MON","TUE","WED","THU","FRI","SAT","SUN"],
    expand: "Execution details",
  },
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function base64ToBytes(base64) {
  const clean = String(base64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createFreshResetController({
  supabase,
  $,
  showToast,
  getCurrentUser,
  isOwnerUser,
}) {
  let language = "ko";
  let documents = [];
  let progress = new Map();
  let currentDocumentId = "";
  let documentObjectUrl = "";
  let ownerDocumentAccess = null;
  let resetSections = [];
  let initialized = false;

  const t = () => TEXT[language];

  function loadLanguage() {
    language = "ko";
  }

  function updateLanguageButtons() {
    const nextLabel = language === "ko" ? "English" : "한국어";
    ["ownerDocumentsLanguageBtn", "freshResetLanguageBtn"].forEach((id) => {
      const button = $(id);
      if (button) button.textContent = nextLabel;
    });
  }

  async function toggleLanguage() {
    language = language === "ko" ? "en" : "ko";
    updateLanguageButtons();
    renderDocumentShell();
    renderDocumentList();
    renderReset();
    if (currentDocumentId) await openDocument(currentDocumentId);
  }

  function renderDocumentShell() {
    const copy = t();
    if ($("ownerDocumentsTitle")) $("ownerDocumentsTitle").textContent = copy.documentsTitle;
    if ($("ownerDocumentsSubtitle")) $("ownerDocumentsSubtitle").textContent = copy.documentsSubtitle;
    if ($("ownerDocumentsConfidential")) $("ownerDocumentsConfidential").textContent = copy.confidential;
    if ($("ownerDocumentOpenFullBtn")) $("ownerDocumentOpenFullBtn").textContent = copy.openFull;
    if ($("ownerDocumentCloseBtn")) $("ownerDocumentCloseBtn").textContent = copy.closePreview;
  }

  function renderDocumentList() {
    const list = $("ownerDocumentsList");
    if (!list) return;
    const copy = t();

    if (!documents.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(copy.noDocuments)}</div>`;
      return;
    }

    list.innerHTML = documents.map((doc) => {
      const title = language === "ko" ? doc.title_ko : doc.title_en;
      const description = language === "ko" ? doc.description_ko : doc.description_en;
      return `
        <button class="owner-document-row" type="button" data-owner-doc="${escapeHtml(doc.document_id)}">
          <span>
            <strong>${escapeHtml(title)}</strong>
            <small>${escapeHtml(description)}</small>
            <em>${escapeHtml(String(doc.page_count || 0))} pages · PDF</em>
          </span>
          <b>${escapeHtml(copy.view)}</b>
        </button>
      `;
    }).join("");

    list.querySelectorAll("[data-owner-doc]").forEach((button) => {
      button.onclick = () => openDocument(button.dataset.ownerDoc);
    });
  }

  async function ensureOwnerAccess(force = false) {
    if (!isOwnerUser()) throw new Error("Owner access required.");
    if (ownerDocumentAccess && !force) return ownerDocumentAccess;

    const { data, error } = await supabase.functions.invoke("gcfr-owner-documents", {
      body: { action: "access" },
    });

    if (error || !data?.ok || !data?.documents || !data?.key_b64) {
      ownerDocumentAccess = null;
      documents = [];
      resetSections = [];
      throw new Error(error?.message || "Owner document access denied.");
    }

    ownerDocumentAccess = data;
    resetSections = Array.isArray(data.reset_sections) ? data.reset_sections : [];
    documents = Object.entries(data.documents).map(([documentId, document]) => ({
      document_id: documentId,
      title_ko: document.ko?.title || documentId,
      title_en: document.en?.title || documentId,
      description_ko: document.ko?.description || "",
      description_en: document.en?.description || "",
      mime_type: document.mime_type || "application/pdf",
      page_count: Number(document.page_count || 0),
      secure: document,
    }));

    return data;
  }

  async function loadDocuments() {
    if (!isOwnerUser()) return;
    renderDocumentShell();
    updateLanguageButtons();

    const list = $("ownerDocumentsList");
    if (list) list.innerHTML = `<div class="empty-state">${escapeHtml(t().loading)}</div>`;

    try {
      await ensureOwnerAccess(true);
      renderDocumentList();
    } catch (error) {
      if (list) {
        list.innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Owner document access denied.")}</div>`;
      }
    }
  }

  function closeDocumentPreview() {
    currentDocumentId = "";
    if (documentObjectUrl) URL.revokeObjectURL(documentObjectUrl);
    documentObjectUrl = "";
    const shell = $("ownerDocumentPreview");
    const frame = $("ownerDocumentFrame");
    if (frame) frame.removeAttribute("src");
    shell?.classList.add("hidden");
  }

  async function openDocument(documentId) {
    if (!isOwnerUser()) return;
    const document = documents.find((item) => item.document_id === documentId);
    if (!document) return;

    currentDocumentId = documentId;
    const shell = $("ownerDocumentPreview");
    const frame = $("ownerDocumentFrame");
    const status = $("ownerDocumentStatus");
    const title = $("ownerDocumentPreviewTitle");

    shell?.classList.remove("hidden");
    if (title) title.textContent = language === "ko" ? document.title_ko : document.title_en;
    if (status) status.textContent = t().loading;
    if (frame) frame.removeAttribute("src");

    try {
      if (!ownerDocumentAccess?.key_b64) {
        await loadDocuments();
      }
      if (!ownerDocumentAccess?.key_b64) {
        throw new Error("Owner document access denied.");
      }

      const meta = document.secure?.[language];
      if (!meta) throw new Error(t().documentLoadError);

      const assetName = language === "ko"
        ? "./private-documents/fresh-reset-ko.enc.b64"
        : "./private-documents/fresh-reset-en.enc.b64";
      const response = await fetch(assetName, { cache: "force-cache" });
      if (!response.ok) throw new Error(t().documentLoadError);

      const payload = base64ToBytes(await response.text());
      if (payload.length <= 28) throw new Error(t().documentLoadError);

      const keyBytes = base64ToBytes(ownerDocumentAccess.key_b64);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM" },
        false,
        ["decrypt"],
      );

      const nonce = payload.slice(0, 12);
      const ciphertext = payload.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: new TextEncoder().encode(meta.aad),
        },
        cryptoKey,
        ciphertext,
      );

      if (meta.sha256) {
        const digest = await crypto.subtle.digest("SHA-256", decrypted);
        if (bytesToHex(new Uint8Array(digest)) !== String(meta.sha256).toLowerCase()) {
          throw new Error("Document integrity check failed.");
        }
      }

      const blob = new Blob([decrypted], {
        type: document.mime_type || "application/pdf",
      });

      if (documentObjectUrl) URL.revokeObjectURL(documentObjectUrl);
      documentObjectUrl = URL.createObjectURL(blob);
      if (frame) frame.src = `${documentObjectUrl}#view=FitH`;
      if ($("ownerDocumentOpenFullBtn")) {
        $("ownerDocumentOpenFullBtn").onclick = () =>
          window.open(documentObjectUrl, "_blank", "noopener");
      }
      if (status) status.textContent = "";
    } catch (decodeError) {
      console.error("Owner document:", decodeError);
      if (status) status.textContent = decodeError.message || t().documentLoadError;
    }
  }

  function progressKey(itemKey, dayKey = "") {
    return `${itemKey}::${dayKey}`;
  }

  function itemState(itemKey, dayKey = "") {
    return progress.get(progressKey(itemKey, dayKey)) || {
      completed: false,
      note: "",
    };
  }

  function renderProgressSummary() {
    let done = 0;
    let total = 0;

    for (const section of resetSections) {
      for (const item of section.items) {
        if (section.mode === "daily") {
          for (const day of ["mon","tue","wed","thu","fri","sat","sun"]) {
            total += 1;
            if (itemState(item.key, day).completed) done += 1;
          }
        } else {
          total += 1;
          if (itemState(item.key).completed) done += 1;
        }
      }
    }

    const percentage = total ? Math.round((done / total) * 100) : 0;
    if ($("freshResetProgressValue")) $("freshResetProgressValue").textContent = `${percentage}%`;
    if ($("freshResetProgressCount")) $("freshResetProgressCount").textContent = `${done} / ${total} ${t().completed}`;
    if ($("freshResetProgressBar")) $("freshResetProgressBar").style.width = `${percentage}%`;
  }

  function renderReset() {
    const container = $("freshResetSections");
    if (!container) return;
    const copy = t();

    if ($("freshResetTitle")) $("freshResetTitle").textContent = copy.resetTitle;
    if ($("freshResetSubtitle")) $("freshResetSubtitle").textContent = copy.resetSubtitle;
    if ($("freshResetOverallLabel")) $("freshResetOverallLabel").textContent = copy.overall;
    updateLanguageButtons();

    container.innerHTML = resetSections.map((section, sectionIndex) => {
      const sectionCopy = section[language];
      const noteState = itemState(`note:${section.key}`);

      return `
        <details class="fresh-reset-section" ${sectionIndex === 0 ? "open" : ""}>
          <summary>
            <span>
              <strong>${escapeHtml(sectionCopy.title)}</strong>
              <small>${escapeHtml(sectionCopy.subtitle)}</small>
            </span>
            <b class="fresh-reset-section-progress" data-reset-section-progress="${escapeHtml(section.key)}"></b>
          </summary>
          <div class="fresh-reset-items">
            ${section.items.map((item) => {
              const itemCopy = item[language];
              const details = `
                <details class="fresh-reset-item-details">
                  <summary>${escapeHtml(copy.expand)}</summary>
                  <ul>${itemCopy.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>
                  <div class="fresh-reset-good"><b>${language === "ko" ? "좋은 실행 기준" : "What good looks like"}</b><span>${escapeHtml(itemCopy.good)}</span></div>
                </details>
              `;

              if (section.mode === "daily") {
                return `
                  <article class="fresh-reset-item">
                    <div class="fresh-reset-item-copy">
                      <strong>${escapeHtml(itemCopy.title)}</strong>
                      ${details}
                    </div>
                    <div class="fresh-reset-days">
                      ${copy.days.map((dayLabel, index) => {
                        const dayKey = ["mon","tue","wed","thu","fri","sat","sun"][index];
                        const checked = itemState(item.key, dayKey).completed ? "checked" : "";
                        return `
                          <label>
                            <span>${escapeHtml(dayLabel)}</span>
                            <input type="checkbox" data-reset-item="${escapeHtml(item.key)}" data-reset-day="${dayKey}" ${checked}>
                          </label>
                        `;
                      }).join("")}
                    </div>
                  </article>
                `;
              }

              const checked = itemState(item.key).completed ? "checked" : "";
              return `
                <article class="fresh-reset-item fresh-reset-single-item">
                  <label class="fresh-reset-single-check">
                    <input type="checkbox" data-reset-item="${escapeHtml(item.key)}" data-reset-day="" ${checked}>
                    <span>
                      <strong>${escapeHtml(itemCopy.title)}</strong>
                    </span>
                  </label>
                  ${details}
                </article>
              `;
            }).join("")}
            <div class="fresh-reset-notes">
              <label>
                <span>${escapeHtml(copy.notes)}</span>
                <textarea rows="3" data-reset-note="${escapeHtml(section.key)}" maxlength="2000">${escapeHtml(noteState.note || "")}</textarea>
              </label>
              <button type="button" class="secondary" data-reset-note-save="${escapeHtml(section.key)}">${escapeHtml(copy.saveNote)}</button>
            </div>
          </div>
        </details>
      `;
    }).join("");

    container.querySelectorAll("input[data-reset-item]").forEach((input) => {
      input.onchange = () => saveCompletion(
        input.dataset.resetItem,
        input.dataset.resetDay || "",
        input.checked,
      );
    });

    container.querySelectorAll("[data-reset-note-save]").forEach((button) => {
      button.onclick = () => {
        const sectionKey = button.dataset.resetNoteSave;
        const textarea = container.querySelector(`[data-reset-note="${sectionKey}"]`);
        void saveNote(sectionKey, textarea?.value || "");
      };
    });

    renderProgressSummary();
    renderSectionProgress();
  }

  function renderSectionProgress() {
    document.querySelectorAll("[data-reset-section-progress]").forEach((node) => {
      const section = resetSections.find((item) => item.key === node.dataset.resetSectionProgress);
      if (!section) return;
      let done = 0;
      let total = 0;

      for (const item of section.items) {
        if (section.mode === "daily") {
          for (const day of ["mon","tue","wed","thu","fri","sat","sun"]) {
            total += 1;
            if (itemState(item.key, day).completed) done += 1;
          }
        } else {
          total += 1;
          if (itemState(item.key).completed) done += 1;
        }
      }

      node.textContent = `${done}/${total}`;
    });
  }

  async function loadProgress() {
    if (!isOwnerUser()) return;
    const status = $("freshResetStatus");
    if (status) status.textContent = t().loadingProgress;

    try {
      await ensureOwnerAccess();
    } catch (error) {
      if (status) status.textContent = `${t().progressError} ${error.message || ""}`.trim();
      return;
    }

    const userId = getCurrentUser()?.id;
    const { data, error } = await supabase
      .from("gcfr_fresh_reset_progress")
      .select("item_key,day_key,completed,note,updated_at")
      .eq("user_id", userId);

    if (error) {
      if (status) status.textContent = `${t().progressError} ${error.message}`;
      return;
    }

    progress = new Map();
    for (const row of data || []) {
      progress.set(progressKey(row.item_key, row.day_key || ""), {
        completed: !!row.completed,
        note: row.note || "",
      });
    }

    if (status) status.textContent = "";
    renderReset();
  }

  async function saveCompletion(itemKey, dayKey, completed) {
    if (!isOwnerUser()) return;
    const userId = getCurrentUser()?.id;
    const key = progressKey(itemKey, dayKey);
    const previous = itemState(itemKey, dayKey);
    progress.set(key, { ...previous, completed: !!completed });
    renderProgressSummary();
    renderSectionProgress();

    const { error } = await supabase
      .from("gcfr_fresh_reset_progress")
      .upsert({
        user_id: userId,
        item_key: itemKey,
        day_key: dayKey,
        completed: !!completed,
        note: previous.note || "",
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,item_key,day_key" });

    if (error) {
      progress.set(key, previous);
      renderReset();
      showToast(error.message);
    }
  }

  async function saveNote(sectionKey, note) {
    if (!isOwnerUser()) return;
    const userId = getCurrentUser()?.id;
    const itemKey = `note:${sectionKey}`;
    const key = progressKey(itemKey);
    const previous = itemState(itemKey);
    progress.set(key, { completed: false, note });

    const { error } = await supabase
      .from("gcfr_fresh_reset_progress")
      .upsert({
        user_id: userId,
        item_key: itemKey,
        day_key: "",
        completed: false,
        note,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,item_key,day_key" });

    if (error) {
      progress.set(key, previous);
      showToast(error.message);
      return;
    }

    showToast(t().noteSaved);
  }

  function init() {
    loadLanguage();
    updateLanguageButtons();

    if (initialized) {
      renderDocumentShell();
      renderReset();
      return;
    }

    initialized = true;
    $("ownerDocumentsLanguageBtn")?.addEventListener("click", toggleLanguage);
    $("freshResetLanguageBtn")?.addEventListener("click", toggleLanguage);
    $("ownerDocumentCloseBtn")?.addEventListener("click", closeDocumentPreview);
  }

  function reset() {
    closeDocumentPreview();
    documents = [];
    progress = new Map();
    ownerDocumentAccess = null;
    resetSections = [];
    currentDocumentId = "";
  }

  return {
    init,
    reset,
    loadDocuments,
    loadProgress,
    renderReset,
    closeDocumentPreview,
    language: () => language,
  };
}
