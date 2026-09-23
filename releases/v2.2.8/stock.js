import { createBarcodeScanner } from "./barcode-scanner.js";
import { initStockCounts } from "./stock-counts.js";

export function initGcfrV2Stock({
  supabase,
  $,
  showToast,
  getCurrentUser,
  canManageProductData,
  normalizeScannedBarcode,
  openAdminStockSetup,
  renderBarcode,
  openStock,
}) {
  const state = {
    scanner: null,
    adminScanner: null,
    adminScanPurpose: "register",
    stockScanPurpose: "count",
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
    scanRequest: 0,
    setupData: [],
    scanMode: "backstock",
    weightMode: "product",
    backstockEntryMode: "used",
    activeShopfloorLayers: new Set(),
  };

  const q = (id) => $(id);
  function focusStep(id, message) {
    const element = q(id);
    if (!element) return;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === "DETAILS") parent.open = true;
    }
    if (message && q("adminStockStep")) q("adminStockStep").textContent = message;
    element.scrollIntoView({behavior:"smooth",block:"center"});
    element.focus({preventScroll:true});
  }
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

  const counts = initStockCounts({supabase,getUser:currentUser,toast:showToast,renderBarcode,openStock,onAreaChange(area){
    ++state.scanRequest;state.scanMode=area;state.selectedProduct=null;
    stopScanner();closeUnknownBarcode();q('stockSelectedProduct').classList.add('hidden');
  }});

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

  async function selectProduct(product, options = {}) {
    const barcode = options.barcode || state.pendingBarcode || "";
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
      await loadProfileAndPackages(false);
      if (state.selectedProduct !== selection) return;
      if (options.factory) state.selectedPackageId = options.factory.id;

      const hasSavedProfile = !!state.profile;
      if (!state.profile) {
        const inferred = inferProfileFromName(state.selectedProduct.name);
        if (inferred.stock_type) {
          state.profile = {
            product_code: state.selectedProduct.code,
            ...inferred,
            inferred: true,
          };
        }
      }

      renderSelectedProduct();

      if (["selling", "ticket"].includes(state.pendingBarcodeMode) && state.pendingBarcode) {
        if (!(await savePendingProductBarcode())) return;
      } else if (state.pendingBarcodeMode === "factory" && state.pendingBarcode) {
        if (!hasSavedProfile) {
          openProfileSetup();
          showToast("Set 1 Each or Approx first, then save the Factory Code package.");
        } else {
          openPackageEditor({ factory_barcode: state.pendingBarcode });
        }
      }
      await counts.select({product:state.selectedProduct,profile:state.profile,pack:options.factory || selectedPackage(),barcode},{auto:!!options.auto});
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
        if (canManage()) {
          const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Set product type';
          button.onclick=()=>openAdminStockSetup?.({product:state.selectedProduct});status.appendChild(button);
        }
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
    const ranked = rankProducts(catalog, rawQuery);
    const barcode = normalizeScannedBarcode(rawQuery);
    if (!barcode || /\s/.test(String(rawQuery).trim())) return ranked;
    const stored = await findStoredBarcode(barcode);
    const factory = stored ? null : await findFactoryBarcode(barcode);
    const product = stored?.product || (factory ? await findProductByCode(factory.product_code) : null)
      || await detectTicketProduct(barcode);
    return product ? [product, ...ranked.filter(row => row.code !== product.code)] : ranked;
  }

  function renderProfileSummary() {
    const box = q("stockProfileSummary");
    if (!box) return;

    if (!state.profile) {
      box.innerHTML = '<div class="stock-warning"><strong>No stock profile saved.</strong></div>';
      return;
    }

    const type = state.profile.stock_type === "approx" ? "Approx" : "1 Each";
    const weight = cleanNumber(state.profile.default_unit_weight_g);
    box.innerHTML = `
      <div class="stock-profile-ready">
        <div>
          <strong>${escapeHtml(type)}</strong>
          <small>${state.profile.stock_type === "approx"
            ? (weight ? `Default unit weight ${weight} g` : "No default unit weight")
            : "Counted as individual units"}</small>
        </div>
      </div>
    `;
  }

  async function fetchAllRows(table, columns) {
    const rows = [];
    let from = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .range(from, from + pageSize - 1);

      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }

    return rows;
  }

  function renderSetupData() {
    const list = q("stockSetupDataList");
    const count = q("stockSetupDataCount");
    if (!list) return;

    const query = normalizeText(q("stockSetupDataSearch")?.value || "");
    const rows = (state.setupData || []).filter((row) => {
      if (!query) return true;
      return normalizeText([
        row.name,
        row.code,
        row.stock_type,
        row.default_unit_weight_g,
        ...(row.barcodes || []).map((item) => item.barcode),
        ...(row.packages || []).map((item) => item.factory_barcode),
      ].join(" ")).includes(query);
    });

    if (count) count.textContent = `${rows.length} of ${state.setupData.length} products`;
    list.innerHTML = "";

    if (!rows.length) {
      list.innerHTML = '<div class="empty-state">No saved stock data found.</div>';
      return;
    }

    for (const row of rows) {
      const card = document.createElement("details");
      card.className = "stock-package-row stock-setup-data-row";

      const type = row.stock_type === "approx" ? "Approx" : row.stock_type === "each" ? "1 Each" : "No type";
      const weight = cleanNumber(row.default_unit_weight_g);
      const codes = [
        ...(row.barcodes || []).map((item) => `${item.barcode_type === "ticket_barcode" ? "Ticket" : item.barcode_type === "factory_barcode" ? "Factory" : "Selling"} ${item.barcode}`),
        ...(row.packages || [])
          .filter((item) => !(row.barcodes || []).some((b) => String(b.barcode) === String(item.factory_barcode)))
          .map((item) => `Factory ${item.factory_barcode}`),
      ];

      card.innerHTML = `
        <summary>
          <strong>${escapeHtml(row.name || row.code)}</strong>
          <span>Product Code ${escapeHtml(row.code)} · ${escapeHtml(type)}${weight ? ` · ${weight} g` : ""}</span>
        </summary><div>
          <small>${escapeHtml(codes.length ? codes.join(" · ") : "No linked barcode")}</small>
        </div>
        <div class="stock-package-actions"><button type="button" class="secondary">Edit / Register</button></div>
      `;

      card.querySelector("button").onclick = () => {
        closeUnknownBarcode();
        void selectForAdmin({ code: row.code, name: row.name || row.code });
      };
      list.appendChild(card);
    }
  }

  async function refreshSetupData() {
    const list = q("stockSetupDataList");
    if (list) list.innerHTML = '<div class="empty-state">Loading stock data...</div>';

    try {
      const [catalog, profiles, packages, barcodeLinks] = await Promise.all([
        loadCatalog(),
        fetchAllRows("gcfr_stock_profiles", "product_code,stock_type,default_unit_weight_g,updated_at"),
        fetchAllRows("gcfr_factory_packages", "id,factory_barcode,product_code,package_label,units_per_package,approx_weight_mode,fixed_package_weight_kg,updated_at"),
        fetchAllRows("product_barcodes", "barcode,product_code,barcode_type"),
      ]);

      const byCode = new Map();
      const productMap = new Map(catalog.map((product) => [String(product.code), product]));

      const ensure = (code) => {
        const key = String(code || "").trim();
        if (!key) return null;
        if (!byCode.has(key)) {
          const product = productMap.get(key);
          byCode.set(key, {
            code: key,
            name: product?.name || key,
            stock_type: "",
            default_unit_weight_g: null,
            packages: [],
            barcodes: [],
          });
        }
        return byCode.get(key);
      };

      for (const product of catalog) ensure(product.code);
      for (const profile of profiles) Object.assign(ensure(profile.product_code), profile);
      for (const pack of packages) ensure(pack.product_code)?.packages.push(pack);
      for (const link of barcodeLinks) {
        if (!["product_code", "ticket_barcode", "factory_barcode"].includes(link.barcode_type)) continue;
        ensure(link.product_code)?.barcodes.push(link);
      }

      state.setupData = [...byCode.values()]
        .sort((a, b) => a.name.localeCompare(b.name));

      renderSetupData();
    } catch (error) {
      if (list) list.innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Unable to load stock data.")}</div>`;
      showToast(error.message || "Unable to load stock data.", 5000);
    }
  }

  async function selectForAdmin(product) {
    closePackageEditor();
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

    renderProfileSummary();
    openProfileSetup(false);
    renderBarcodeLinks();
    renderPackages();

    focusStep("stockTypeSelect", "Product selected · Review product type.");

    if (["selling", "ticket"].includes(state.pendingBarcodeMode) && state.pendingBarcode) {
      if (await savePendingProductBarcode()) {
        q("adminStockScanUnknownPanel")?.classList.add("hidden");
        focusStep("adminStockScanBtn", "Saved · Scan the next barcode.");
      }
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
      void refreshSetupData();

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
    renderProfileSummary();
    q("stockAddPackageBtn")?.classList.remove("hidden");
    void refreshSetupData();

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
    focusStep(state.profile.stock_type === "each" ? "stockUnitsPerPackage" : "stockApproxWeightMode",
      "Step 3 · Enter package quantity / weight and save.");
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
    renderBarcodeLinks();
    void refreshSetupData();

    const saved = state.packages.find((row) => row.factory_barcode === barcode);
    if (saved) state.selectedPackageId = saved.id;
    renderCalculator();
    focusStep("adminStockScanBtn", "Package saved · Scan the next barcode.");
  }

  function selectedPackage() {
    return state.packages.find((row) => String(row.id) === String(state.selectedPackageId)) || null;
  }

  function renderShopfloorLayers() {
    for (let layer = 1; layer <= 3; layer += 1) {
      const active = state.activeShopfloorLayers.has(layer);
      const toggle = q(`stockLayer${layer}Toggle`);
      const across = q(`stockLayer${layer}Across`);
      const deep = q(`stockLayer${layer}Deep`);
      const row = toggle?.closest(".stock-layer-row");

      toggle?.classList.toggle("active", active);
      toggle?.setAttribute("aria-pressed", String(active));
      row?.classList.toggle("active", active);

      if (across) across.disabled = !active;
      if (deep) deep.disabled = !active;

      if (!active) {
        if (across) across.value = "";
        if (deep) deep.value = "";
        if (q(`stockLayer${layer}Total`)) {
          q(`stockLayer${layer}Total`).textContent = "0";
        }
      }
    }
  }

  function toggleShopfloorLayer(layer) {
    if (state.activeShopfloorLayers.has(layer)) {
      state.activeShopfloorLayers.delete(layer);
    } else {
      state.activeShopfloorLayers.add(layer);
    }

    renderShopfloorLayers();
    recalc();

    if (state.activeShopfloorLayers.has(layer)) {
      q(`stockLayer${layer}Across`)?.focus();
    }
  }

  function displayCount() {
    let total = 0;

    for (let layer = 1; layer <= 3; layer += 1) {
      const active = state.activeShopfloorLayers.has(layer);
      const across = active ? cleanInt(q(`stockLayer${layer}Across`)?.value) : 0;
      const deep = active ? cleanInt(q(`stockLayer${layer}Deep`)?.value) : 0;
      const layerTotal = across > 0 && deep > 0 ? across * deep : 0;

      total += layerTotal;
      if (q(`stockLayer${layer}Total`)) {
        q(`stockLayer${layer}Total`).textContent = String(layerTotal);
      }
    }

    // Loose quantity is the +A part of "Across × Deep + A".
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
    if (q("stockUsedEntryInput")) q("stockUsedEntryInput").value = "";
    state.backstockEntryMode = "used";
    if (state.profile) renderCalculator();
  }

  function manualSampleAverage() {
    const values = [1, 2, 3]
      .map((index) => cleanNumber(q(`stockSampleWeight${index}`)?.value))
      .filter((value) => value > 0);

    if (values.length !== 3) return 0;
    return values.reduce((sum, value) => sum + value, 0) / 3;
  }

  function updateManualSampleAverage() {
    const average = manualSampleAverage();
    const output = q("stockSampleAverage");
    const input = q("stockDisplayUnitWeightG");

    if (output) output.textContent = average ? `${average.toFixed(1)} g` : "0 g";
    if (state.weightMode === "manual" && input) {
      input.value = average ? String(average) : "";
    }

    recalc();
  }

  function syncWeightMode() {
    state.weightMode = q("stockUseManualWeight")?.checked ? "manual" : "product";
    const input = q("stockDisplayUnitWeightG");
    const saved = cleanNumber(state.profile?.default_unit_weight_g);
    if (!input) return;

    q("stockProductWeightMode")?.classList.toggle("hidden", state.weightMode !== "product");
    q("stockManualAveragePanel")?.classList.toggle("hidden", state.weightMode !== "manual");

    if (state.weightMode === "product") {
      input.value = saved ? String(saved) : "";
    } else {
      const average = manualSampleAverage();
      input.value = average ? String(average) : "";
      q("stockSampleWeight1")?.focus();
    }

    recalc();
  }

  function renderBackstockQuickEntry() {
    const box = q("stockBackstockQuickEntry");
    if (!box || !state.profile) return;

    const each = state.profile.stock_type === "each";
    const pack = selectedPackage();
    const manualPackage = !each && pack?.approx_weight_mode === "manual";
    const newCount = each
      ? cleanInt(q("stockNewPackagesEach")?.value)
      : manualPackage
        ? state.manualWeights.length
        : cleanInt(q("stockNewPackagesApprox")?.value);
    const usedTotal = each
      ? cleanInt(q("stockRemainingEach")?.value)
      : cleanNumber(q(manualPackage ? "stockRemainingKgManual" : "stockRemainingKg")?.value);

    if (q("stockNewPackageCount")) {
      q("stockNewPackageCount").textContent = each || !manualPackage
        ? String(newCount)
        : `${newCount} weighed`;
    }

    if (q("stockUsedTotal")) {
      q("stockUsedTotal").textContent = each
        ? `${usedTotal} each`
        : `${usedTotal.toFixed(2)} kg`;
    }

    const input = q("stockUsedEntryInput");
    if (input) {
      input.step = each ? "1" : "0.01";
      input.inputMode = each ? "numeric" : "decimal";
      input.placeholder = state.backstockEntryMode === "newWeight"
        ? "New package weight kg"
        : each
          ? "Used each"
          : "Used kg";
    }

    const button = q("stockAddNewPackageBtn");
    if (button) {
      button.disabled = !pack;
      button.textContent = manualPackage ? "+ New" : "+ New";
    }

    const hint = q("stockBackstockEntryHint");
    if (hint) {
      if (!pack) {
        hint.textContent = "Scan a registered Factory Code first.";
      } else if (manualPackage) {
        hint.textContent = state.backstockEntryMode === "newWeight"
          ? "Enter the full package weight, then Submit."
          : "New packages require a weight. Tap New, enter kg, then Submit.";
      } else if (each) {
        hint.textContent = `1 new package = ${cleanInt(pack.units_per_package)} each`;
      } else {
        hint.textContent = `1 new package = ${cleanNumber(pack.fixed_package_weight_kg).toFixed(2)} kg`;
      }
    }
  }

  function addNewBackstockPackage() {
    if (!state.profile) return;
    const pack = selectedPackage();
    if (!pack) {
      showToast("Scan a registered Factory Code first.");
      return;
    }

    const each = state.profile.stock_type === "each";

    if (each) {
      const input = q("stockNewPackagesEach");
      input.value = String(cleanInt(input.value) + 1);
    } else if (pack.approx_weight_mode === "fixed") {
      const input = q("stockNewPackagesApprox");
      input.value = String(cleanInt(input.value) + 1);
    } else {
      state.backstockEntryMode = "newWeight";
      const input = q("stockUsedEntryInput");
      if (input) {
        input.value = "";
        input.placeholder = "New package weight kg";
        input.focus();
      }
      renderBackstockQuickEntry();
      return;
    }

    renderBackstockQuickEntry();
    recalc();
  }

  function submitBackstockUsed() {
    if (!state.profile) return;
    const input = q("stockUsedEntryInput");
    const rawValue = cleanNumber(input?.value);
    if (rawValue <= 0) {
      showToast("Enter a value greater than zero.");
      return;
    }

    const each = state.profile.stock_type === "each";
    const pack = selectedPackage();

    if (!each && pack?.approx_weight_mode === "manual" && state.backstockEntryMode === "newWeight") {
      state.manualWeights.push(rawValue);
      renderManualWeights();
      state.backstockEntryMode = "used";
    } else if (each) {
      const target = q("stockRemainingEach");
      target.value = String(cleanInt(target.value) + cleanInt(rawValue));
    } else {
      const target = q(pack?.approx_weight_mode === "manual"
        ? "stockRemainingKgManual"
        : "stockRemainingKg");
      target.value = String(cleanNumber(target.value) + rawValue);
    }

    if (input) input.value = "";
    renderBackstockQuickEntry();
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
    const backstock = state.scanMode === "backstock";

    q("stockEachCalculator")?.classList.add("hidden");
    q("stockApproxCalculator")?.classList.add("hidden");
    q("stockBackstockQuickEntry")?.classList.toggle("hidden", !backstock);
    q("stockShopfloorCalculator")?.classList.toggle("hidden", backstock);
    q("stockPackageSelectWrap")?.classList.toggle(
      "hidden",
      !backstock || state.packages.length === 0
    );

    if (q("stockPackageSelect")) {
      q("stockPackageSelect").value = state.selectedPackageId || "";
    }

    q("stockApproxDisplayWeightField")?.classList.toggle(
      "hidden",
      backstock || each
    );

    if (!each) {
      const defaultWeight = cleanNumber(state.profile.default_unit_weight_g);
      if (q("stockProductWeightHint")) {
        q("stockProductWeightHint").textContent = defaultWeight
          ? `Product weight: ${defaultWeight} g`
          : "No product weight saved — use Manual.";
      }
      if (state.weightMode === "product" && q("stockDisplayUnitWeightG")) {
        q("stockDisplayUnitWeightG").value = defaultWeight ? String(defaultWeight) : "";
      }
      q("stockProductWeightMode")?.classList.toggle("hidden", state.weightMode !== "product");
      q("stockManualAveragePanel")?.classList.toggle("hidden", state.weightMode !== "manual");
      if (state.weightMode === "manual") {
        const average = manualSampleAverage();
        q("stockDisplayUnitWeightG").value = average ? String(average) : "";
        if (q("stockSampleAverage")) {
          q("stockSampleAverage").textContent = average ? `${average.toFixed(1)} g` : "0 g";
        }
      }
    }

    renderBackstockQuickEntry();
    recalc();
  }

  function recalc() {
    if (!state.profile) return;

    const each = state.profile.stock_type === "each";
    const pack = selectedPackage();
    const displayItems = displayCount();

    let packageTotal = 0;

    if (each) {
      const newPackages = cleanInt(q("stockNewPackagesEach")?.value);
      const remainingEach = cleanInt(q("stockRemainingEach")?.value);
      const unitsPerPackage = cleanInt(pack?.units_per_package);

      packageTotal = (newPackages * unitsPerPackage) + remainingEach;
      const grandItems = packageTotal + displayItems;

      q("stockPackageSubtotal").textContent = `${packageTotal} items`;
      q("stockDisplaySubtotal").textContent = `${displayItems} items`;
      q("stockGrandTotal").textContent = `${grandItems} items`;
      if (q("stockShopfloorItemTotal")) {
        q("stockShopfloorItemTotal").textContent = `${displayItems} items`;
      }
      if (q("stockShopfloorWeightTotal")) q("stockShopfloorWeightTotal").textContent = "";
    } else {
      const manualMode = !pack || pack.approx_weight_mode === "manual";
      const remainingKg = cleanNumber(
        q(manualMode ? "stockRemainingKgManual" : "stockRemainingKg")?.value
      );

      if (pack?.approx_weight_mode === "fixed") {
        const newPackages = cleanInt(q("stockNewPackagesApprox")?.value);
        packageTotal =
          (newPackages * cleanNumber(pack.fixed_package_weight_kg)) + remainingKg;
      } else {
        packageTotal =
          state.manualWeights.reduce((sum, value) => sum + cleanNumber(value), 0) + remainingKg;
      }

      const unitWeightG = state.weightMode === "manual"
        ? cleanNumber(q("stockDisplayUnitWeightG")?.value)
        : cleanNumber(state.profile.default_unit_weight_g);

      const displayWeightKg = unitWeightG
        ? displayItems * unitWeightG / 1000
        : 0;
      const backstockItems = unitWeightG
        ? Math.round(packageTotal * 1000 / unitWeightG)
        : 0;
      const grandItems = backstockItems + displayItems;
      const grandWeightKg = packageTotal + displayWeightKg;

      q("stockPackageSubtotal").textContent = unitWeightG
        ? `${packageTotal.toFixed(2)} kg · ~${backstockItems} items`
        : `${packageTotal.toFixed(2)} kg`;
      q("stockDisplaySubtotal").textContent = unitWeightG
        ? `${displayItems} items · ~${displayWeightKg.toFixed(2)} kg`
        : `${displayItems} items · enter unit weight`;
      q("stockGrandTotal").textContent = unitWeightG
        ? `${grandItems} items · ~${grandWeightKg.toFixed(2)} kg`
        : `${displayItems} items + ${packageTotal.toFixed(2)} kg`;

      if (q("stockShopfloorItemTotal")) {
        q("stockShopfloorItemTotal").textContent = `${displayItems} items`;
      }
      if (q("stockShopfloorWeightTotal")) {
        q("stockShopfloorWeightTotal").textContent = unitWeightG
          ? `Estimated ${displayWeightKg.toFixed(2)} kg`
          : "Choose Product weight or Manual weight.";
      }
    }

    renderBackstockQuickEntry();
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
          if (state.stockScanPurpose === "link") {
            state.stockScanPurpose = "count";
            await linkScannedProduct(barcode, "stock");
          } else await handleBarcode(barcode);
        },
        onTextCandidates: (candidates, meta) =>
          resolveTicketTextCandidate(candidates, false, meta),
        onError: (error) => {
          console.error("Stock barcode scanner:", error);
          showToast(error.message || "Barcode scanner failed.", 6000);
        },
      });
    }

    return state.scanner;
  }

  function startScanner() {
    state.stockScanPurpose = "count";
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

  async function resolveTicketTextCandidate(candidates, adminMode = false, meta = {}) {
    const values = [...new Set(
      (candidates || [])
        .map((value) => normalizeScannedBarcode(value))
        .filter((value) => /^\d{6,8}$/.test(value))
    )];

    if (!values.length) return { value: "", known: false };

    const catalog = await loadCatalog();
    const productCodes = new Set(catalog.map((product) => String(product.code || "").trim()));

    for (const value of values) {
      if (productCodes.has(value)) return { value, known: true };

      const factory = await findFactoryBarcode(value);
      if (factory && (adminMode || state.scanMode === "backstock")) {
        return { value, known: true };
      }

      const stored = await findStoredBarcode(value);
      if (!stored) continue;

      if (
        adminMode
        || state.scanMode === "shopfloor"
        || stored.barcode_type === "factory_barcode"
      ) {
        return { value, known: true };
      }
    }

    // Unknown printed codes are accepted only after OCR sees the same digits
    // more than once. This prevents a single bad OCR pass from inventing a
    // factory/ticket code while still allowing new codes to reach registration.
    const counts = meta?.counts || {};
    const confirmed = values.find((value) => Number(counts[value] || 0) >= 2);
    return { value: confirmed || "", known: false };
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
    if (counts.isBusy()) return;
    const request=++state.scanRequest;
    const barcode = normalizeScannedBarcode(rawBarcode);
    if (!barcode) return;

    q("stockLastScan").textContent = barcode;

    try {
      const factory = await findFactoryBarcode(barcode);
      if(request!==state.scanRequest)return;

      if (state.scanMode === "shopfloor" && factory) {
        showToast("Factory crate/carton barcode belongs to Backstock Scanning.");
        return;
      }

      if (factory) {
        if (counts.area() === 'shopfloor') {showToast('Use the selling barcode or product ticket for shopfloor.');return;}
        const product = await findProductByCode(factory.product_code);
        if(request!==state.scanRequest)return;
        if (product) {
          await selectProduct(product,{factory,barcode});
          state.selectedPackageId = factory.id;
          q("stockPackageSelect").value = factory.id;
          renderCalculator();
          if (factory.approx_weight_mode === 'manual') showToast('Enter this package weight, then confirm.');
          return;
        }
      }

      const stored = await findStoredBarcode(barcode);
      if(request!==state.scanRequest)return;
      if (state.scanMode === "backstock" && stored && stored.barcode_type !== "factory_barcode") {
        showToast("Selling/Product Ticket barcode belongs to Shopfloor Scanning.");
        return;
      }
      if (stored) {
        if (counts.area() === 'backstock') {
          if (stored.barcode_type === 'factory_barcode' && canManage()) await openAdminStockSetup?.({barcode,mode:'factory'});
          else showToast('Scan a crate / carton factory barcode for backstock.');
          return;
        }
        if(stored.barcode_type==='factory_barcode'){showToast('Use the selling barcode or product ticket for shopfloor.');return;}
        await selectProduct(stored.product,{barcode});
        showToast(`${stored.product.name} loaded.`);
        return;
      }

      if(counts.area()==='backstock') {openUnknownBarcode(barcode);return;}

      const inferredTicket = await detectTicketProduct(barcode);
      if(request!==state.scanRequest)return;
      if (inferredTicket) {
        await selectProduct(inferredTicket,{barcode});

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
      if(request!==state.scanRequest)return;
      if (exactProduct) {
        await selectProduct(exactProduct,{barcode});
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
    q('stockUnknownFactoryBtn').classList.toggle('hidden',counts.area()==='shopfloor');
    q('stockUnknownSellingBtn').classList.toggle('hidden',counts.area()==='backstock');
    q('stockUnknownTicketBtn').classList.toggle('hidden',counts.area()==='backstock');

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
        focusStep("stockLinkScanBtn");
      } else {
        q("adminStockManualRegisterPanel")?.classList.remove("hidden");
        q("adminStockScanUnknownMessage").textContent =
          mode === "ticket"
            ? "Store Ticket selected. Search the product to link this ticket barcode."
            : "Selling Barcode selected. Search the product to link this selling barcode.";
        focusStep("adminStockLinkScanBtn", "Step 2 · Scan the product ticket or search below.");
      }
      return;
    }

    if (source === "admin") {
      q("adminStockManualRegisterPanel")?.classList.remove("hidden");
      q("adminStockScanUnknownMessage").textContent =
        "Factory Code selected. Search the product above, or register a new product. Package setup will open next.";
      focusStep("adminStockLinkScanBtn", "Step 2 · Scan selling barcode / product ticket, or search below.");
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

    const mode = state.pendingBarcodeMode;
    const { data, error } = await supabase.rpc("gcfr_register_stock_product", {
      _barcode: state.pendingBarcode,
      _product_code: productCode,
      _product_name: productName,
      _barcode_type: mode === "factory" ? "factory_barcode" : mode === "ticket" ? "ticket_barcode" : "product_code",
    });
    if (error) {
      button.disabled = false;
      button.textContent = previousText;
      showToast(error.message);
      return;
    }
    const returned = Array.isArray(data) ? data[0] : data;
    const product = {code:returned?.code || productCode,name:returned?.name || productName};

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
    ) return false;

    const barcode = state.pendingBarcode;
    const isTicket = state.pendingBarcodeMode === "ticket";

    const { error } = await supabase.rpc("gcfr_link_stock_barcode", {
      _barcode: barcode,
      _product_code: state.selectedProduct.code,
      _barcode_type: isTicket ? "ticket_barcode" : "product_code",
    });

    if (error) {
      showToast(error.message);
      return false;
    }

    const name = state.selectedProduct.name;
    await loadProfileAndPackages(false);
    renderBarcodeLinks();
    void refreshSetupData();
    closeUnknownBarcode();
    showToast(`${isTicket ? "Store Ticket" : "Selling Barcode"} linked to ${name}.`);
    return true;
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
        onTextCandidates: (candidates, meta) =>
          resolveTicketTextCandidate(candidates, true, meta),
        onError: (error) => {
          console.error("Admin Stock scanner:", error);
          showToast(error.message || "Barcode scanner failed.", 6000);
        },
      });
    }

    return state.adminScanner;
  }

  function startAdminStockScanner(purpose = "register") {
    state.adminScanPurpose = typeof purpose === "string" ? purpose : "register";
    if (state.adminScanPurpose === "register") closeUnknownBarcode();
    return getAdminStockScanner().start();
  }

  function stopAdminStockScanner() {
    try {
      state.adminScanner?.stop();
    } catch {}
  }

  async function linkScannedProduct(barcode, source = "admin") {
      if (!state.pendingBarcode || !state.pendingBarcodeMode) return;
      const pending = state.pendingBarcode;
      try {
        const stored = await findStoredBarcode(barcode);
        if (stored?.barcode_type === "factory_barcode"
          || (state.pendingBarcodeMode === "selling" && stored?.barcode_type === "product_code")) {
          showToast("Scan the product ticket / product code, or search for the product.");
          return;
        }
        const inferred = stored ? null : await detectTicketProduct(barcode);
        const product = stored?.product || inferred || await findProductByCode(barcode);
        if (!product) {
          showToast("Product not found. Search manually below; the first barcode is still saved.");
          focusStep(source === "stock" ? "stockProductSearch" : "adminStockLinkSearch");
          return;
        }
        if (inferred) {
          const {error} = await supabase.rpc("gcfr_link_stock_barcode", {
            _barcode:barcode, _product_code:product.code, _barcode_type:"ticket_barcode",
          });
          if (error) throw error;
        }
        if (state.pendingBarcode !== pending) return;
        if (source === "stock") await selectProduct(product);
        else await selectForAdmin(product);
      } catch (error) { showToast(error.message || "Could not link barcode."); }
  }

  async function handleAdminBarcode(rawBarcode) {
    const barcode = normalizeScannedBarcode(rawBarcode);
    if (!barcode) return;
    if (state.adminScanPurpose === "search") {
      q("stockSetupDataSearch").value = barcode;
      await refreshSetupData();
      focusStep("stockSetupDataSearch");
      return;
    }
    if (state.adminScanPurpose === "link") return linkScannedProduct(barcode);

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

        if (error) throw error;
        await loadProfileAndPackages(false);
        renderBarcodeLinks();
        void refreshSetupData();
        focusStep("adminStockScanBtn", "Ticket linked · Scan the next barcode.");
        showToast(`Store Ticket linked: ${inferredTicket.name}`);
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
      const mode = q("adminStockRegistrationMode")?.value || "ticket";
      await chooseUnknownType(mode, "admin");
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
      "stockShopfloorLooseQty",
      "stockUsedEntryInput",
      "stockSampleWeight1",
      "stockSampleWeight2",
      "stockSampleWeight3",
    ].forEach((id) => {
      if (q(id)) q(id).value = "";
    });

    state.manualWeights = [];
    state.backstockEntryMode = "used";
    state.activeShopfloorLayers = new Set();
    renderShopfloorLayers();
    renderManualWeights();

    if (state.profile?.default_unit_weight_g) {
      q("stockDisplayUnitWeightG").value = String(state.profile.default_unit_weight_g);
    }
    if (q("stockSampleAverage")) q("stockSampleAverage").textContent = "0 g";

    recalc();
  }

  function reset() {
    ++state.scanRequest;
    counts.reset();
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
    state.adminScanPurpose = "register";
    if (q("stockSetupDataSection")) q("stockSetupDataSection").open = false;

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
    if (screen === 'history') void counts.loadHistory();
    if (screen !== "stock") {
      stopScanner();
      if (screen !== "admin") stopAdminStockScanner();
      return;
    }

    void counts.load();

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
  q("adminStockLinkScanBtn")?.addEventListener("click", async () => {
    if (!state.pendingBarcode) return;
    if (!state.pendingBarcodeMode) await chooseUnknownType(q("adminStockRegistrationMode").value, "admin");
    return startAdminStockScanner("link");
  });
  q("stockLinkScanBtn")?.addEventListener("click", () => {
    if (!state.pendingBarcode || !state.pendingBarcodeMode || !canManage()) return;
    state.stockScanPurpose = "link";
    return getScanner().start();
  });
  q("stockSetupDataScanBtn")?.addEventListener("click", () => startAdminStockScanner("search"));
  q("adminStockRegistrationMode")?.addEventListener("change", () => {
    closeUnknownBarcode();
    focusStep("adminStockScanBtn", "Step 1 · Scan the barcode to register.");
  });
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
  for (let layer = 1; layer <= 3; layer += 1) {
    q(`stockLayer${layer}Toggle`)?.addEventListener("click", () => {
      toggleShopfloorLayer(layer);
    });
  }
  q("stockAddNewPackageBtn")?.addEventListener("click", addNewBackstockPackage);
  q("stockUsedSubmitBtn")?.addEventListener("click", submitBackstockUsed);
  q("stockUsedEntryInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitBackstockUsed();
    }
  });

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

  q("stockSetupDataSearch")?.addEventListener("input", renderSetupData);
  // Keep the database below every registration / package editor.
  if (q("stockSetupDataSection")) q("adminStockSetupView")?.appendChild(q("stockSetupDataSection"));
  q("stockSetupDataRefreshBtn")?.addEventListener("click", refreshSetupData);

  q("stockUseProductWeight")?.addEventListener("change", syncWeightMode);
  q("stockUseManualWeight")?.addEventListener("change", syncWeightMode);
  ["stockSampleWeight1", "stockSampleWeight2", "stockSampleWeight3"].forEach((id) => {
    q(id)?.addEventListener("input", updateManualSampleAverage);
  });
  state.scanMode = "";
  renderShopfloorLayers();
  setScanMode("backstock");
  renderManualWeights();

  return {
    reset,
    onScreenChange,
    handleBarcode,
    handleAdminBarcode,
    searchForAdmin,
    selectForAdmin,
    refreshSetupData,
  };
}
