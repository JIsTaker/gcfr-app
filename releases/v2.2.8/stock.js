import { createBarcodeScanner } from "./barcode-scanner.js";

export function initGcfrV2Stock({
  supabase,
  $,
  showToast,
  getCurrentUser,
  canManageProductData,
  normalizeScannedBarcode,
  openAdminStockSetup,
}) {
  const state = {
    scanner: null,
    adminScanner: null,
    catalog: null,
    catalogPromise: null,
    selectedProduct: null,
    profile: null,
    packages: [],
    barcodeLinks: [],
    selectedPackageId: "",
    pendingBarcode: "",
    pendingBarcodeMode: "",
    manualWeights: [],
    searchTimer: null,
    scanMode: "backstock",
    weightMode: "product",
  };

  const q = (id) => $(id);
  const cleanNumber = (value) => {
    const number = Number.parseFloat(String(value ?? "").replace(",", "."));
    return Number.isFinite(number) ? number : 0;
  };
  const cleanInt = (value) => Math.max(0, Math.floor(cleanNumber(value)));
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const normalizeText = (value) => String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  function currentUser() {
    return getCurrentUser?.() || null;
  }

  function canManage() {
    return !!canManageProductData?.();
  }

  async function loadCatalog() {
    if (state.catalog) return state.catalog;
    if (state.catalogPromise) return state.catalogPromise;

    state.catalogPromise = (async () => {
      const all = [];
      let from = 0;
      const pageSize = 1000;

      while (true) {
        const { data, error } = await supabase
          .from("products")
          .select("code,name")
          .order("name", { ascending: true })
          .range(from, from + pageSize - 1);

        if (error) throw error;
        const page = data || [];
        all.push(...page);
        if (page.length < pageSize) break;
        from += pageSize;
      }

      state.catalog = all.map((product) => ({
        code: String(product.code || "").trim(),
        name: String(product.name || "").trim(),
      }));
      return state.catalog;
    })();

    try {
      return await state.catalogPromise;
    } finally {
      state.catalogPromise = null;
    }
  }

  function inferProfileFromName(name) {
    const text = String(name || "");
    const approxMatch = text.match(/approx\.?\s*([0-9]+(?:\.[0-9]+)?)\s*g/i);

    if (approxMatch) {
      return {
        stock_type: "approx",
        default_unit_weight_g: cleanNumber(approxMatch[1]) || null,
      };
    }

    if (/\b1\s*each\b/i.test(text)) {
      return {
        stock_type: "each",
        default_unit_weight_g: null,
      };
    }

    return {
      stock_type: "",
      default_unit_weight_g: null,
    };
  }

  function rankProducts(catalog, rawQuery) {
    const query = normalizeText(rawQuery);
    if (!query) return [];

    const terms = query.split(" ").filter(Boolean);

    return catalog
      .map((product) => {
        const code = normalizeText(product.code);
        const name = normalizeText(product.name);
        const haystack = `${code} ${name}`;

        if (!terms.every((term) => haystack.includes(term))) return null;

        let score = 0;
        if (code === query) score += 1000;
        if (code.startsWith(query)) score += 500;
        if (name === query) score += 450;
        if (name.startsWith(query)) score += 320;
        if (name.includes(query)) score += 180;
        score -= name.length * 0.01;

        return { product, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name))
      .slice(0, 60)
      .map((entry) => entry.product);
  }

  function renderSearchResults(matches) {
    const box = q("stockProductSearchResults");
    if (!box) return;

    box.innerHTML = "";
    box.classList.remove("hidden");

    if (!matches.length) {
      box.innerHTML = '<div class="search-result-empty">No matching products.</div>';
      return;
    }

    for (const product of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stock-search-result";
      button.innerHTML = `
        <span>
          <strong>${escapeHtml(product.name)}</strong>
          <small>Product Code ${escapeHtml(product.code)}</small>
        </span>
        <b>Open</b>
      `;
      button.onclick = () => selectProduct(product);
      box.appendChild(button);
    }
  }

  function hideSearchResults() {
    const box = q("stockProductSearchResults");
    if (!box) return;
    box.classList.add("hidden");
    box.innerHTML = "";
  }

  async function searchProducts(rawQuery) {
    const query = String(rawQuery || "").trim();

    if (!query) {
      hideSearchResults();
      return;
    }

    const box = q("stockProductSearchResults");
    box.classList.remove("hidden");
    box.innerHTML = '<div class="search-result-empty">Searching...</div>';

    try {
      const catalog = await loadCatalog();
      renderSearchResults(rankProducts(catalog, query));
    } catch (error) {
      box.innerHTML = `<div class="search-result-empty">${escapeHtml(error.message)}</div>`;
    }
  }

  async function loadProfileAndPackages(renderOperational = true) {
    if (!state.selectedProduct) return;

    const selection = state.selectedProduct;
    const userId = currentUser()?.id;
    const code = state.selectedProduct.code;

    const [
      { data: profile, error: profileError },
      { data: packages, error: packageError },
      { data: barcodeLinks, error: barcodeError },
    ] = await Promise.all([
      supabase
        .from("gcfr_stock_profiles")
        .select("product_code,stock_type,default_unit_weight_g,updated_at")
        .eq("product_code", code)
        .maybeSingle(),
      supabase
        .from("gcfr_factory_packages")
        .select("id,factory_barcode,product_code,package_label,units_per_package,approx_weight_mode,fixed_package_weight_kg,updated_at")
        .eq("product_code", code)
        .order("updated_at", { ascending: false }),
      supabase
        .from("product_barcodes")
        .select("barcode,barcode_type")
        .eq("product_code", code)
        .order("barcode_type", { ascending: true }),
    ]);

    if (state.selectedProduct !== selection || currentUser()?.id !== userId) return;
    if (profileError) throw profileError;
    if (packageError) throw packageError;
    if (barcodeError) throw barcodeError;

    state.profile = profile || null;
    state.packages = packages || [];
    state.barcodeLinks = barcodeLinks || [];

    if (!state.packages.some((row) => String(row.id) === String(state.selectedPackageId))) {
      state.selectedPackageId = state.packages[0]?.id || "";
    }

    if (renderOperational) renderSelectedProduct();
  }

  async function selectProduct(product) {
    const sameProduct = state.selectedProduct?.code === String(product.code || "").trim();
    state.selectedProduct = {
      code: String(product.code || "").trim(),
      name: String(product.name || "").trim(),
    };
    const selection = state.selectedProduct;
    state.profile = null;
    state.packages = [];
    state.barcodeLinks = [];
    state.selectedPackageId = "";
    if (!sameProduct) clearCalculator();

    q("stockProductSearch").value = "";
    hideSearchResults();

    q("stockSelectedProduct").classList.remove("hidden");
    q("stockSelectedName").textContent = state.selectedProduct.name;
    q("stockSelectedCode").textContent = state.selectedProduct.code;

    try {
      await loadProfileAndPackages();
      if (state.selectedProduct !== selection) return;

      if (["selling", "ticket"].includes(state.pendingBarcodeMode) && state.pendingBarcode) {
        await savePendingProductBarcode();
      } else if (state.pendingBarcodeMode === "factory" && state.pendingBarcode) {
        if (!state.profile) {
          openProfileSetup();
          showToast("Set 1 Each or Approx first, then save the Factory Code package.");
        } else {
          openPackageEditor({ factory_barcode: state.pendingBarcode });
        }
      }
    } catch (error) {
      renderDatabaseUnavailable(error);
    }
  }

  function renderDatabaseUnavailable(error) {
    const status = q("stockOperationalStatus");
    status?.classList.remove("hidden");

    if (status) {
      status.innerHTML =
        `<div class="stock-warning">${escapeHtml(error?.message || "Unable to load stock data.")}</div>`;
    }

    q("stockCalculator")?.classList.add("hidden");
  }

  function renderSelectedProduct() {
    if (!state.selectedProduct) return;

    const status = q("stockOperationalStatus");

    if (!state.profile) {
      status?.classList.remove("hidden");

      if (status) {
        status.innerHTML =
          '<div class="stock-warning"><strong>Stock setup required.</strong><span>Configure this product in Admin → Stock Setup.</span></div>';
      }

      q("stockCalculator").classList.add("hidden");
      return;
    }

    status?.classList.add("hidden");
    if (status) status.innerHTML = "";

    renderOperationalPackageOptions();
    renderCalculator();
  }

  function renderOperationalPackageOptions() {
    const select = q("stockPackageSelect");
    if (!select) return;

    select.innerHTML = '<option value="">Manual / loose stock</option>';

    state.packages.forEach((row, index) => {
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = String(row.package_label || "").trim() || `Package ${index + 1}`;
      select.appendChild(option);
    });

    select.value = state.selectedPackageId || "";
    q("stockPackageSelectWrap")?.classList.toggle("hidden", state.packages.length === 0);
  }

  async function searchForAdmin(rawQuery) {
    const catalog = await loadCatalog();
    return rankProducts(catalog, rawQuery);
  }

  async function selectForAdmin(product) {
    state.selectedProduct = {
      code: String(product.code || "").trim(),
      name: String(product.name || "").trim(),
    };
    state.profile = null;
    state.packages = [];
    state.barcodeLinks = [];
    state.selectedPackageId = "";

    await loadProfileAndPackages(false);

    if (q("adminStockSelectedName")) {
      q("adminStockSelectedName").textContent = state.selectedProduct.name;
    }

    if (q("adminStockSelectedCode")) {
      q("adminStockSelectedCode").textContent = state.selectedProduct.code;
    }

    q("adminStockSelected")?.classList.remove("hidden");
    q("stockSetupBtn")?.classList.remove("hidden");
    q("stockAddPackageBtn")?.classList.toggle("hidden", !state.profile);

    openProfileSetup(false);
    renderBarcodeLinks();
    renderPackages();

    if (["selling", "ticket"].includes(state.pendingBarcodeMode) && state.pendingBarcode) {
      await savePendingProductBarcode();
      q("adminStockScanUnknownPanel")?.classList.add("hidden");
    } else if (state.pendingBarcodeMode === "factory" && state.pendingBarcode) {
      // Persist the scanned Factory Code -> product relationship immediately.
      // Package details can still be completed afterwards.
      const barcode = state.pendingBarcode;
      const { error: linkError } = await supabase.rpc("gcfr_link_stock_barcode", {
        _barcode: barcode,
        _product_code: state.selectedProduct.code,
        _barcode_type: "factory_barcode",
      });

      if (linkError) {
        showToast(linkError.message);
        return;
      }

      if (state.profile) {
        openPackageEditor({ factory_barcode: barcode });
      } else {
        q("adminStockScanUnknownMessage") &&
          (q("adminStockScanUnknownMessage").textContent =
            "Factory Code linked. Save the product as 1 Each or Approx, then the package editor will open.");
      }
    }
  }

  function openProfileSetup(force = true) {
    if (!canManage() || !state.selectedProduct) return;

    const inferred = state.profile || inferProfileFromName(state.selectedProduct.name);
    const type = inferred.stock_type || "each";

    q("stockSetupPanel").classList.remove("hidden");
    q("stockTypeSelect").value = type;
    q("stockDefaultUnitWeight").value =
      inferred.default_unit_weight_g ? String(inferred.default_unit_weight_g) : "";

    syncProfileSetupFields();

    if (force) {
      q("stockSetupPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function syncProfileSetupFields() {
    const approx = q("stockTypeSelect").value === "approx";
    q("stockDefaultWeightField").classList.toggle("hidden", !approx);
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (!state.selectedProduct || !canManage()) return;

    const stockType = q("stockTypeSelect").value;
    const defaultWeight = stockType === "approx"
      ? (cleanNumber(q("stockDefaultUnitWeight").value) || null)
      : null;

    const button = q("stockSaveProfileBtn");
    button.disabled = true;
    button.textContent = "Saving...";

    const { error } = await supabase.rpc("gcfr_save_stock_profile", {
      _product_code: state.selectedProduct.code,
      _stock_type: stockType,
      _default_unit_weight_g: defaultWeight,
    });

    button.disabled = false;
    button.textContent = "Save Product Type";

    if (error) {
      showToast(error.message);
      return;
    }

    showToast("Product stock type saved.");
    await loadProfileAndPackages(false);
    q("stockAddPackageBtn")?.classList.remove("hidden");

    if (state.pendingBarcodeMode === "factory" && state.pendingBarcode) {
      openPackageEditor({ factory_barcode: state.pendingBarcode });
    }
  }

  function packageTitle(row) {
    if (!row) return "Manual / loose stock";
    if (row.package_label) return row.package_label;
    return `Factory ${row.factory_barcode}`;
  }

  function packageDetail(row) {
    if (!row) return "No saved package selected";

    if (state.profile?.stock_type === "each") {
      return `${cleanInt(row.units_per_package)} each per package`;
    }

    return row.approx_weight_mode === "fixed"
      ? `${cleanNumber(row.fixed_package_weight_kg).toFixed(2)} kg fixed package`
      : "Manual package weight";
  }

  function renderBarcodeLinks() {
    const list = q("stockBarcodeLinkList");
    if (!list) return;

    const labels = {
      product_code: "Selling Barcode",
      ticket_barcode: "Store Ticket",
      factory_barcode: "Factory Code",
    };

    const rows = [...state.barcodeLinks];

    // Factory packages created before barcode-link persistence should still
    // appear in the complete stock-ticket list.
    for (const pack of state.packages) {
      const barcode = String(pack.factory_barcode || "").trim();
      if (
        barcode
        && !rows.some((row) =>
          String(row.barcode || "").trim() === barcode
          && row.barcode_type === "factory_barcode")
      ) {
        rows.push({ barcode, barcode_type: "factory_barcode" });
      }
    }

    list.innerHTML = "";

    for (const row of rows) {
      const card = document.createElement("div");
      card.className = "stock-package-row";
      card.innerHTML = `
        <div>
          <strong>${escapeHtml(labels[row.barcode_type] || row.barcode_type || "Barcode")}</strong>
          <span>${escapeHtml(String(row.barcode || ""))}</span>
        </div>
      `;
      list.appendChild(card);
    }

    if (!rows.length) {
      list.innerHTML = '<div class="empty-state">No Selling Barcode, Store Ticket or Factory Code linked.</div>';
    }
  }

  function renderPackages() {
    const list = q("stockPackageList");
    const select = q("stockPackageSelect");

    list.innerHTML = "";
    select.innerHTML = '<option value="">Manual / loose stock</option>';

    for (const row of state.packages) {
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = row.package_label || `Package ${state.packages.indexOf(row) + 1}`;
      select.appendChild(option);

      const card = document.createElement("div");
      card.className = "stock-package-row";
      card.innerHTML = `
        <div>
          <strong>${escapeHtml(packageTitle(row))}</strong>
          <span>Factory Code ${escapeHtml(row.factory_barcode)}</span>
          <small>${escapeHtml(packageDetail(row))}</small>
        </div>
        <div class="stock-package-actions"></div>
      `;

      const actions = card.querySelector(".stock-package-actions");

      const useButton = document.createElement("button");
      useButton.type = "button";
      useButton.className = "secondary";
      useButton.textContent = "Use";
      useButton.onclick = () => {
        state.selectedPackageId = row.id;
        q("stockPackageSelect").value = row.id;
        renderCalculator();
        q("stockCalculator").scrollIntoView({ behavior: "smooth", block: "start" });
      };
      actions.appendChild(useButton);

      if (canManage()) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "text-button";
        edit.textContent = "Edit";
        edit.onclick = () => openPackageEditor(row);
        actions.appendChild(edit);

        if (currentUser()?.id === "139c07f7-a826-4513-86af-25afdbe44d8f") {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "text-button danger";
        del.textContent = "Delete";
        del.onclick = async () => {
          if (!confirm(`Delete Factory Code ${row.factory_barcode} package?`)) return;

          const { error } = await supabase.rpc("gcfr_delete_factory_package", {
            _id: row.id,
          });

          if (error) {
            showToast(error.message);
            return;
          }

          if (String(state.selectedPackageId) === String(row.id)) {
            state.selectedPackageId = "";
          }

          showToast("Factory package deleted.");
          await loadProfileAndPackages(false);
          renderPackages();
        };
        actions.appendChild(del);
        }
      }

      list.appendChild(card);
    }

    if (!state.packages.length) {
      list.innerHTML = '<div class="empty-state">No Factory Code packages saved yet.</div>';
    }

    select.value = state.selectedPackageId || "";
  }

  function openPackageEditor(row = null) {
    if (!canManage() || !state.profile || !state.selectedProduct) return;

    const source = row || {};

    q("stockPackagePanel").classList.remove("hidden");
    q("stockPackageEditId").value = source.id || "";
    q("stockFactoryBarcode").value =
      source.factory_barcode || state.pendingBarcode || "";
    q("stockPackageLabel").value = source.package_label || "";
    q("stockUnitsPerPackage").value = source.units_per_package || "";
    q("stockApproxWeightMode").value = source.approx_weight_mode || "fixed";
    q("stockFixedPackageWeight").value = source.fixed_package_weight_kg || "";
    q("stockPackageEditorTitle").textContent = source.id
      ? "Edit Package Specification"
      : "Add Package Specification";

    syncPackageEditorFields();
    q("stockPackagePanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closePackageEditor() {
    q("stockPackagePanel").classList.add("hidden");
    q("stockPackageForm").reset();
    q("stockPackageEditId").value = "";
  }

  function syncPackageEditorFields() {
    const each = state.profile?.stock_type === "each";
    q("stockEachPackageFields").classList.toggle("hidden", !each);
    q("stockApproxPackageFields").classList.toggle("hidden", each);

    const fixed = q("stockApproxWeightMode").value === "fixed";
    q("stockFixedWeightField").classList.toggle("hidden", each || !fixed);
  }

  async function savePackage(event) {
    event.preventDefault();
    if (!state.selectedProduct || !state.profile || !canManage()) return;

    const barcode = normalizeScannedBarcode(q("stockFactoryBarcode").value);
    if (!barcode) {
      showToast("Factory Code is required.");
      return;
    }

    const each = state.profile.stock_type === "each";
    const button = q("stockSavePackageBtn");
    button.disabled = true;
    button.textContent = "Saving...";

    const { error } = await supabase.rpc("gcfr_save_factory_package", {
      _factory_barcode: barcode,
      _product_code: state.selectedProduct.code,
      _package_label: q("stockPackageLabel").value.trim() || null,
      _units_per_package: each ? cleanInt(q("stockUnitsPerPackage").value) : null,
      _approx_weight_mode: each ? null : q("stockApproxWeightMode").value,
      _fixed_package_weight_kg:
        !each && q("stockApproxWeightMode").value === "fixed"
          ? cleanNumber(q("stockFixedPackageWeight").value)
          : null,
    });

    button.disabled = false;
    button.textContent = "Save Package";

    if (error) {
      showToast(error.message);
      return;
    }

    state.pendingBarcode = "";
    state.pendingBarcodeMode = "";
    closeUnknownBarcode();
    closePackageEditor();
    showToast("Factory Code package saved.");
    await loadProfileAndPackages(false);
    renderPackages();

    const saved = state.packages.find((row) => row.factory_barcode === barcode);
    if (saved) state.selectedPackageId = saved.id;
    renderCalculator();
  }

  function selectedPackage() {
    return state.packages.find((row) => String(row.id) === String(state.selectedPackageId)) || null;
  }

  function displayCount() {
    let total = 0;
    for (let layer = 1; layer <= 3; layer += 1) {
      const across = cleanInt(q(`stockLayer${layer}Across`).value);
      const deep = cleanInt(q(`stockLayer${layer}Deep`).value);
      total += across * deep;
      q(`stockLayer${layer}Total`).textContent = String(across * deep);
    }
    return total + cleanInt(q("stockShopfloorLooseQty")?.value);
  }

  function setScanMode(mode) {
    const nextMode = mode === "shopfloor" ? "shopfloor" : "backstock";
    if (state.scanMode === nextMode) return;

    stopScanner();
    q("stockScannerWrap")?.classList.add("hidden");
    state.scanMode = nextMode;

    const backstock = state.scanMode === "backstock";
    const backInput = q("stockBackstockModeInput");
    const shopInput = q("stockShopfloorModeInput");
    if (backInput) backInput.checked = backstock;
    if (shopInput) shopInput.checked = !backstock;
    backInput?.closest(".stock-mode-btn")?.classList.toggle("active", backstock);
    shopInput?.closest(".stock-mode-btn")?.classList.toggle("active", !backstock);

    if (q("stockScanBtn")) q("stockScanBtn").textContent =
      backstock ? "▣ Scan crate / carton" : "▣ Scan selling / product ticket";

    closeUnknownBarcode();
  }

  function syncWeightMode() {
    state.weightMode = q("stockUseManualWeight")?.checked ? "manual" : "product";
    const input = q("stockDisplayUnitWeightG");
    const saved = cleanNumber(state.profile?.default_unit_weight_g);
    if (!input) return;
    if (state.weightMode === "product") {
      input.value = saved ? String(saved) : "";
      input.readOnly = true;
    } else {
      input.readOnly = false;
      if (saved && cleanNumber(input.value) === saved) input.value = "";
      input.focus();
    }
    recalc();
  }

  function renderCalculator() {
    if (!state.profile) {
      q("stockCalculator").classList.add("hidden");
      return;
    }

    q("stockCalculator").classList.remove("hidden");

    const each = state.profile.stock_type === "each";
    const pack = selectedPackage();

    q("stockEachCalculator").classList.toggle("hidden", !each);
    q("stockApproxCalculator").classList.toggle("hidden", each);
    // Saved averages are defaults, not a substitute for today's measured weight.
    q("stockApproxDisplayWeightField").classList.toggle("hidden", each);

    q("stockPackageSelect").value = state.selectedPackageId || "";

    if (!each) {
      const defaultWeight = cleanNumber(state.profile.default_unit_weight_g);
      if (q("stockProductWeightHint")) {
        q("stockProductWeightHint").textContent = defaultWeight
          ? `Product weight: ${defaultWeight} g`
          : "No product weight saved — use Manual.";
      }
      if (state.weightMode === "product") {
        q("stockDisplayUnitWeightG").value = defaultWeight ? String(defaultWeight) : "";
        q("stockDisplayUnitWeightG").readOnly = true;
      }

      const manualMode = !pack || pack.approx_weight_mode === "manual";
      q("stockApproxFixedControls").classList.toggle("hidden", manualMode);
      q("stockApproxManualControls").classList.toggle("hidden", !manualMode);
    }

    recalc();
  }

  function recalc() {
    if (!state.profile) return;

    const each = state.profile.stock_type === "each";
    const pack = selectedPackage();
    const displayItems = displayCount();

    let packageTotal = 0;
    let displayTotal = 0;
    let grandTotal = 0;

    if (each) {
      const newPackages = cleanInt(q("stockNewPackagesEach").value);
      const remainingEach = cleanInt(q("stockRemainingEach").value);
      const unitsPerPackage = cleanInt(pack?.units_per_package);

      packageTotal = (newPackages * unitsPerPackage) + remainingEach;
      displayTotal = displayItems;
      grandTotal = packageTotal + displayTotal;

      q("stockPackageSubtotal").textContent = `${packageTotal} each`;
      q("stockDisplaySubtotal").textContent = `${displayTotal} each`;
      q("stockGrandTotal").textContent = `${grandTotal} each`;
    } else {
      const manualMode = !pack || pack.approx_weight_mode === "manual";
      const remainingKg = cleanNumber(
        q(manualMode ? "stockRemainingKgManual" : "stockRemainingKg").value
      );

      if (pack?.approx_weight_mode === "fixed") {
        const newPackages = cleanInt(q("stockNewPackagesApprox").value);
        packageTotal =
          (newPackages * cleanNumber(pack.fixed_package_weight_kg)) + remainingKg;
      } else {
        packageTotal =
          state.manualWeights.reduce((sum, value) => sum + cleanNumber(value), 0) + remainingKg;
      }

      const unitWeightG = state.weightMode === "manual"
        ? cleanNumber(q("stockDisplayUnitWeightG").value)
        : cleanNumber(state.profile.default_unit_weight_g);

      displayTotal = displayItems * unitWeightG / 1000;
      grandTotal = packageTotal + displayTotal;

      q("stockPackageSubtotal").textContent = `${packageTotal.toFixed(2)} kg`;
      q("stockDisplaySubtotal").textContent = unitWeightG
        ? `${displayTotal.toFixed(2)} kg`
        : `${displayItems} items · enter unit weight`;
      q("stockGrandTotal").textContent = `${grandTotal.toFixed(2)} kg`;
    }
  }

  function renderManualWeights() {
    const list = q("stockManualWeightList");
    list.innerHTML = "";

    state.manualWeights.forEach((weight, index) => {
      const row = document.createElement("div");
      row.className = "stock-manual-weight-row";
      row.innerHTML = `
        <span>Package ${index + 1}</span>
        <strong>${cleanNumber(weight).toFixed(2)} kg</strong>
      `;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button danger";
      remove.textContent = "×";
      remove.onclick = () => {
        state.manualWeights.splice(index, 1);
        renderManualWeights();
        recalc();
      };

      row.appendChild(remove);
      list.appendChild(row);
    });

    if (!state.manualWeights.length) {
      list.innerHTML = '<div class="item-sub">No package weights entered.</div>';
    }
  }

  function addManualWeight() {
    const value = cleanNumber(q("stockManualWeightInput").value);
    if (value <= 0) {
      showToast("Enter a package weight greater than zero.");
      return;
    }

    state.manualWeights.push(value);
    q("stockManualWeightInput").value = "";
    renderManualWeights();
    recalc();
  }

  function getScanner() {
    if (!state.scanner) {
      state.scanner = createBarcodeScanner({
        reader: q("stockReader"),
        overlay: q("stockScannerWrap"),
        status: q("stockScanStatus"),
        closeButton: q("stockStopScannerBtn"),
        scanButton: q("stockScanBtn"),
        onResult: async (raw) => {
          const barcode = normalizeScannedBarcode(raw);
          if (!barcode) return;
          try {
            state.scanner?.stop();
          } catch {}
          await handleBarcode(barcode);
        },
        onError: (error) => {
          console.error("Stock barcode scanner:", error);
          showToast(error.message || "Barcode scanner failed.", 6000);
        },
      });
    }

    return state.scanner;
  }

  function startScanner() {
    closeUnknownBarcode();
    return getScanner().start();
  }

  function stopScanner() {
    try {
      state.scanner?.stop();
    } catch {}
  }

  async function findProductByCode(code) {
    const catalog = await loadCatalog();
    return catalog.find((product) => product.code === code) || null;
  }

  async function findStoredBarcode(barcode) {
    const { data, error } = await supabase
      .from("product_barcodes")
      .select("barcode,product_code,barcode_type,products(name)")
      .eq("barcode", barcode)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const name = Array.isArray(data.products)
      ? data.products[0]?.name
      : data.products?.name;

    return {
      product: {
        code: data.product_code,
        name: name || data.product_code,
      },
      barcode_type: data.barcode_type,
    };
  }

  async function findFactoryBarcode(barcode) {
    const { data, error } = await supabase
      .from("gcfr_factory_packages")
      .select("id,factory_barcode,product_code,package_label,units_per_package,approx_weight_mode,fixed_package_weight_kg")
      .eq("factory_barcode", barcode)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  async function detectTicketProduct(barcode) {
    if (!/^\d{8}$/.test(barcode)) return null;
    const sum = [...barcode].reduce((total, digit, i) => total + Number(digit) * (i % 2 === 0 ? 3 : 1), 0);
    if (sum % 10 !== 0) return null;

    const catalog = await loadCatalog();
    const matches = catalog
      .filter((product) => {
        const code = String(product.code || "").trim();
        return /^\d{6,7}$/.test(code) && barcode.slice(0, 7) === code.padStart(7, "0");
      });

    if (!matches.length) return null;

    return matches.length === 1 ? matches[0] : null;
  }

  async function handleBarcode(rawBarcode) {
    const barcode = normalizeScannedBarcode(rawBarcode);
    if (!barcode) return;

    q("stockLastScan").textContent = barcode;

    try {
      const factory = await findFactoryBarcode(barcode);

      if (state.scanMode === "shopfloor" && factory) {
        showToast("Factory crate/carton barcode belongs to Backstock Scanning.");
        return;
      }

      if (factory) {
        const product = await findProductByCode(factory.product_code);
        if (product) {
          await selectProduct(product);
          state.selectedPackageId = factory.id;
          q("stockPackageSelect").value = factory.id;
          renderCalculator();
          showToast(`Factory package loaded: ${product.name}`);
          return;
        }
      }

      const stored = await findStoredBarcode(barcode);
      if (state.scanMode === "backstock" && stored && stored.barcode_type !== "factory_barcode") {
        showToast("Selling/Product Ticket barcode belongs to Shopfloor Scanning.");
        return;
      }
      if (stored) {
        await selectProduct(stored.product);
        showToast(`${stored.product.name} loaded.`);
        return;
      }

      if (state.scanMode === "backstock") {
        openUnknownBarcode(barcode);
        return;
      }

      const inferredTicket = await detectTicketProduct(barcode);
      if (inferredTicket) {
        await selectProduct(inferredTicket);

        if (canManage()) {
          const { error } = await supabase.rpc("gcfr_link_stock_barcode", {
            _barcode: barcode,
            _product_code: inferredTicket.code,
            _barcode_type: "ticket_barcode",
          });

          if (error) {
            console.warn("Could not persist inferred ticket barcode:", error);
          }
        }

        showToast(`Store Ticket detected: ${inferredTicket.name}`);
        return;
      }

      const exactProduct = await findProductByCode(barcode);
      if (exactProduct) {
        await selectProduct(exactProduct);
        showToast(`Product Code detected: ${exactProduct.name}`);
        return;
      }

      openUnknownBarcode(barcode);
    } catch (error) {
      if (/gcfr_factory_packages|schema cache|does not exist/i.test(error.message || "")) {
        showToast("V2 stock database has not been applied yet.", 5000);
      } else {
        showToast(error.message);
      }
    }
  }

  function openUnknownBarcode(barcode) {
    state.pendingBarcode = barcode;
    state.pendingBarcodeMode = "";

    q("stockUnknownBarcode").textContent = barcode;
    q("stockUnknownPanel").classList.remove("hidden");
    q("stockUnknownRegisterPanel")?.classList.add("hidden");
    q("stockUnknownManualForm")?.classList.add("hidden");
    q("stockUnknownManagerActions")?.classList.toggle("hidden", !canManage());

    q("stockUnknownSellingBtn")?.classList.toggle("hidden", state.scanMode !== "shopfloor");
    q("stockUnknownTicketBtn")?.classList.toggle("hidden", state.scanMode !== "shopfloor");
    q("stockUnknownFactoryBtn")?.classList.toggle("hidden", state.scanMode !== "backstock");

    q("stockUnknownMessage").textContent = canManage()
      ? (state.scanMode === "backstock"
          ? "Unregistered crate/carton barcode. Register it as a Factory Code."
          : "Unregistered shopfloor barcode. Register it as Selling Barcode or Product Ticket.")
      : "Product not registered. Joey, Troy J or Alex S can register it.";

    q("stockUnknownPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeUnknownBarcode() {
    state.pendingBarcode = "";
    state.pendingBarcodeMode = "";

    q("stockUnknownPanel")?.classList.add("hidden");
    q("stockUnknownRegisterPanel")?.classList.add("hidden");
    q("stockUnknownManualForm")?.classList.add("hidden");
    q("adminStockScanUnknownPanel")?.classList.add("hidden");
    q("adminStockManualRegisterPanel")?.classList.add("hidden");

    if (q("stockUnknownManualCode")) q("stockUnknownManualCode").value = "";
    if (q("stockUnknownManualName")) q("stockUnknownManualName").value = "";
    if (q("adminStockManualProductCode")) q("adminStockManualProductCode").value = "";
    if (q("adminStockManualProductName")) q("adminStockManualProductName").value = "";
  }

  async function chooseUnknownType(mode, source = "stock") {
    if (!state.pendingBarcode || !canManage()) return;

    state.pendingBarcodeMode = mode;

    if (mode === "selling" || mode === "ticket") {
      if (source === "stock") {
        q("stockUnknownRegisterPanel")?.classList.remove("hidden");
        q("stockUnknownMessage").textContent =
          "Search the product above to link this barcode, or register a new product below.";
        q("stockProductSearch")?.focus();
      } else {
        q("adminStockManualRegisterPanel")?.classList.remove("hidden");
        q("adminStockScanUnknownMessage").textContent =
          mode === "ticket"
            ? "Store Ticket selected. Search the product to link this ticket barcode."
            : "Selling Barcode selected. Search the product to link this selling barcode.";
        q("adminStockSearch")?.focus();
      }
      return;
    }

    if (source === "admin") {
      q("adminStockManualRegisterPanel")?.classList.remove("hidden");
      q("adminStockScanUnknownMessage").textContent =
        "Factory Code selected. Search the product above, or register a new product. Package setup will open next.";
      q("adminStockSearch")?.focus();
      return;
    }

    q("stockUnknownMessage").textContent =
      "Factory Code setup is completed in Admin → Stock Setup.";
    await openAdminStockSetup?.({
      barcode: state.pendingBarcode,
      mode: "factory",
    });
  }

  async function registerUnknownProduct({ source }) {
    if (!state.pendingBarcode || !state.pendingBarcodeMode || !canManage()) return;

    const isAdmin = source === "admin";
    const codeInput = q(isAdmin ? "adminStockManualProductCode" : "stockUnknownManualCode");
    const nameInput = q(isAdmin ? "adminStockManualProductName" : "stockUnknownManualName");
    const button = q(isAdmin ? "adminStockManualRegisterBtn" : "stockUnknownManualSubmit");

    const productCode = String(codeInput?.value || "").trim();
    const productName = String(nameInput?.value || "").trim();

    if (!productCode || !productName) {
      showToast("Product Code and Product Name are required.");
      return;
    }

    button.disabled = true;
    const previousText = button.textContent;
    button.textContent = "Registering...";

    let product = { code: productCode, name: productName };

    if (state.pendingBarcodeMode === "factory") {
      const { data, error } = await supabase.rpc("register_product_for_run", {
        _product_code: productCode,
        _product_name: productName,
      });

      if (error) {
        button.disabled = false;
        button.textContent = previousText;
        showToast(error.message);
        return;
      }

      const returned = Array.isArray(data) && data.length ? data[0] : null;
      product = {
        code: returned?.code || productCode,
        name: returned?.name || productName,
      };
    } else {
      const { data, error } = await supabase.rpc("register_scanned_barcode_product", {
        _barcode: state.pendingBarcode,
        _product_code: productCode,
        _product_name: productName,
      });

      if (error) {
        button.disabled = false;
        button.textContent = previousText;
        showToast(error.message);
        return;
      }

      const returned = Array.isArray(data) && data.length ? data[0] : null;
      product = {
        code: returned?.code || productCode,
        name: returned?.name || productName,
      };

      // Enforce the V2 barcode type selected by the user.
      const { error: linkError } = await supabase.rpc("gcfr_link_stock_barcode", {
        _barcode: state.pendingBarcode,
        _product_code: product.code,
        _barcode_type: "product_code",
      });

      if (linkError) {
        console.warn("Could not normalize barcode type:", linkError);
      }
    }

    button.disabled = false;
    button.textContent = previousText;
    state.catalog = null;

    if (isAdmin) {
      await selectForAdmin(product);
    } else {
      await selectProduct(product);
    }
  }

  async function savePendingProductBarcode() {
    if (
      !["selling", "ticket"].includes(state.pendingBarcodeMode)
      || !state.pendingBarcode
      || !state.selectedProduct
      || !canManage()
    ) return;

    const barcode = state.pendingBarcode;
    const isTicket = state.pendingBarcodeMode === "ticket";

    const { error } = await supabase.rpc("gcfr_link_stock_barcode", {
      _barcode: barcode,
      _product_code: state.selectedProduct.code,
      _barcode_type: isTicket ? "ticket_barcode" : "product_code",
    });

    if (error) {
      showToast(error.message);
      return;
    }

    const name = state.selectedProduct.name;
    await loadProfileAndPackages(false);
    renderBarcodeLinks();
    closeUnknownBarcode();
    showToast(`${isTicket ? "Store Ticket" : "Selling Barcode"} linked to ${name}.`);
  }

  function getAdminStockScanner() {
    if (!state.adminScanner) {
      state.adminScanner = createBarcodeScanner({
        reader: q("adminStockReader"),
        overlay: q("adminStockScannerWrap"),
        status: q("adminStockScanStatus"),
        closeButton: q("adminStockStopScannerBtn"),
        scanButton: q("adminStockScanBtn"),
        onResult: async (raw) => {
          const barcode = normalizeScannedBarcode(raw);
          if (!barcode) return;
          await handleAdminBarcode(barcode);
        },
        onError: (error) => {
          console.error("Admin Stock scanner:", error);
          showToast(error.message || "Barcode scanner failed.", 6000);
        },
      });
    }

    return state.adminScanner;
  }

  function startAdminStockScanner() {
    closeUnknownBarcode();
    return getAdminStockScanner().start();
  }

  function stopAdminStockScanner() {
    try {
      state.adminScanner?.stop();
    } catch {}
  }

  async function handleAdminBarcode(rawBarcode) {
    const barcode = normalizeScannedBarcode(rawBarcode);
    if (!barcode) return;

    state.pendingBarcode = "";
    state.pendingBarcodeMode = "";

    try {
      const factory = await findFactoryBarcode(barcode);

      if (factory) {
        const product = await findProductByCode(factory.product_code);
        if (product) {
          await selectForAdmin(product);
          openPackageEditor(factory);
          showToast(`Factory Code loaded: ${product.name}`);
          return;
        }
      }

      const stored = await findStoredBarcode(barcode);
      if (stored) {
        await selectForAdmin(stored.product);
        showToast(`${stored.product.name} loaded.`);
        return;
      }

      const inferredTicket = await detectTicketProduct(barcode);
      if (inferredTicket) {
        await selectForAdmin(inferredTicket);

        const { error } = await supabase.rpc("gcfr_link_stock_barcode", {
          _barcode: barcode,
          _product_code: inferredTicket.code,
          _barcode_type: "ticket_barcode",
        });

        if (error) console.warn("Could not persist inferred ticket:", error);

        showToast(`Store Ticket detected: ${inferredTicket.name}`);
        return;
      }

      const exactProduct = await findProductByCode(barcode);
      if (exactProduct) {
        await selectForAdmin(exactProduct);
        showToast(`Product Code detected: ${exactProduct.name}`);
        return;
      }

      state.pendingBarcode = barcode;
      state.pendingBarcodeMode = "";
      q("adminStockScanUnknownBarcode").textContent = barcode;
      q("adminStockScanUnknownPanel").classList.remove("hidden");
      q("adminStockManualRegisterPanel")?.classList.add("hidden");
      q("adminStockScanUnknownMessage").textContent =
        "This barcode is not registered. Choose what it represents.";
      q("adminStockScanUnknownPanel").scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    } catch (error) {
      showToast(error.message || "Could not read this barcode.");
    }
  }

  function clearCalculator() {
    [
      "stockNewPackagesEach",
      "stockRemainingEach",
      "stockNewPackagesApprox",
      "stockRemainingKg",
      "stockRemainingKgManual",
      "stockDisplayUnitWeightG",
      "stockLayer1Across",
      "stockLayer1Deep",
      "stockLayer2Across",
      "stockLayer2Deep",
      "stockLayer3Across",
      "stockLayer3Deep",
    ].forEach((id) => {
      if (q(id)) q(id).value = "";
    });

    state.manualWeights = [];
    renderManualWeights();

    if (state.profile?.default_unit_weight_g) {
      q("stockDisplayUnitWeightG").value = String(state.profile.default_unit_weight_g);
    }

    recalc();
  }

  function reset() {
    stopScanner();
    stopAdminStockScanner();
    clearTimeout(state.searchTimer);

    state.selectedProduct = null;
    state.profile = null;
    state.packages = [];
    state.selectedPackageId = "";
    state.pendingBarcode = "";
    state.pendingBarcodeMode = "";
    state.manualWeights = [];

    closeUnknownBarcode();

    if (q("stockProductSearch")) q("stockProductSearch").value = "";
    hideSearchResults();

    q("stockScannerWrap")?.classList.add("hidden");
    q("adminStockScannerWrap")?.classList.add("hidden");
    q("adminStockScanUnknownPanel")?.classList.add("hidden");
    q("stockSelectedProduct")?.classList.add("hidden");
    q("stockSetupPanel")?.classList.add("hidden");
    q("stockPackagePanel")?.classList.add("hidden");
    q("stockCalculator")?.classList.add("hidden");

    if (q("stockSelectedName")) q("stockSelectedName").textContent = "-";
    if (q("stockSelectedCode")) q("stockSelectedCode").textContent = "-";
    if (q("stockLastScan")) q("stockLastScan").textContent = "-";
    if (q("stockPackageList")) {
      q("stockPackageList").innerHTML =
        '<div class="empty-state">Select a product first.</div>';
    }

    clearCalculator();
  }

  function onScreenChange(screen) {
    if (screen !== "stock") {
      stopScanner();
      if (screen !== "admin") stopAdminStockScanner();
      return;
    }

    loadCatalog().catch((error) => {
      console.error("Stock catalog:", error);
    });
  }

  q("stockProductSearch")?.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(
      () => searchProducts(q("stockProductSearch").value),
      140,
    );
  });

  q("stockScanBtn").onclick = startScanner;
  q("stockStopScannerBtn").onclick = () => {
    stopScanner();
    q("stockScannerWrap").classList.add("hidden");
  };

  q("stockSetupBtn").onclick = () => openProfileSetup();
  q("stockTypeSelect").onchange = syncProfileSetupFields;
  q("stockSetupForm").onsubmit = saveProfile;
  q("stockCancelProfileBtn").onclick = () => q("stockSetupPanel").classList.add("hidden");

  q("stockAddPackageBtn").onclick = () => openPackageEditor();
  q("stockPackageForm").onsubmit = savePackage;
  q("stockCancelPackageBtn").onclick = closePackageEditor;
  q("stockApproxWeightMode").onchange = syncPackageEditorFields;

  q("stockPackageSelect").onchange = () => {
    state.selectedPackageId = q("stockPackageSelect").value;
    state.manualWeights = [];
    renderManualWeights();
    renderCalculator();
  };

  q("stockBackstockModeInput")?.addEventListener("change", (event) => {
    if (event.target.checked) setScanMode("backstock");
  });
  q("stockShopfloorModeInput")?.addEventListener("change", (event) => {
    if (event.target.checked) setScanMode("shopfloor");
  });
  q("stockUnknownSellingBtn")?.addEventListener("click", () => chooseUnknownType("selling", "stock"));
  q("stockUnknownTicketBtn")?.addEventListener("click", () => chooseUnknownType("ticket", "stock"));
  q("stockUnknownFactoryBtn")?.addEventListener("click", () => chooseUnknownType("factory", "stock"));
  q("stockUnknownManualToggle")?.addEventListener("click", () => {
    q("stockUnknownManualForm")?.classList.toggle("hidden");
  });
  q("stockUnknownManualForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await registerUnknownProduct({ source: "stock" });
  });
  q("stockUnknownCloseBtn").onclick = closeUnknownBarcode;

  q("adminStockScanBtn")?.addEventListener("click", startAdminStockScanner);
  q("adminStockStopScannerBtn")?.addEventListener("click", stopAdminStockScanner);
  q("adminStockUnknownSellingBtn")?.addEventListener("click", () => chooseUnknownType("selling", "admin"));
  q("adminStockUnknownTicketBtn")?.addEventListener("click", () => chooseUnknownType("ticket", "admin"));
  q("adminStockUnknownFactoryBtn")?.addEventListener("click", () => chooseUnknownType("factory", "admin"));
  q("adminStockScanUnknownCloseBtn")?.addEventListener("click", closeUnknownBarcode);
  q("adminStockManualRegisterForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await registerUnknownProduct({ source: "admin" });
  });

  q("stockAddManualWeightBtn").onclick = addManualWeight;
  q("stockManualWeightInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addManualWeight();
    }
  });

  q("stockClearCalculatorBtn").onclick = clearCalculator;

  [
    "stockNewPackagesEach",
    "stockRemainingEach",
    "stockNewPackagesApprox",
    "stockRemainingKg",
    "stockRemainingKgManual",
    "stockDisplayUnitWeightG",
    "stockLayer1Across",
    "stockLayer1Deep",
    "stockLayer2Across",
    "stockLayer2Deep",
    "stockLayer3Across",
    "stockLayer3Deep",
    "stockShopfloorLooseQty",
  ].forEach((id) => {
    q(id)?.addEventListener("input", recalc);
  });

  q("stockUseProductWeight")?.addEventListener("change", syncWeightMode);
  q("stockUseManualWeight")?.addEventListener("change", syncWeightMode);
  state.scanMode = "";
  setScanMode("backstock");
  renderManualWeights();

  return {
    reset,
    onScreenChange,
    handleBarcode,
    handleAdminBarcode,
    searchForAdmin,
    selectForAdmin,
  };
}
