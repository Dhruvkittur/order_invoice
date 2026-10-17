/* =========================================================
   ANIRUDH AGENCY — Sales Order Entry
   app.js — Complete Application Logic
   ========================================================= */

'use strict';

/* ── CONSTANTS ─────────────────────────────────────────── */
const DB_NAME           = 'FinovaxDB';
const DB_VERSION        = 2; // Upgraded to v2 for Item Master & Metadata
const STORE_ORDERS      = 'orders';
const STORE_SEQUENCE    = 'sequence';
const STORE_ITEM_MASTER = 'item_master';
const STORE_META        = 'meta';

/* ── STATE ──────────────────────────────────────────────── */
let db                 = null;
let currentEditOrderId = null;
let currentViewOrderId = null;
let isSaving           = false;

/* Item Master in-memory cache for ultra-fast local search */
let cachedItemMaster   = [];
let itemMasterMetadata = { lastUpdated: null, itemCount: 0, filename: '' };
let pendingImportData  = null;

/* =========================================================
   1. DATABASE LAYER
   ========================================================= */

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE_ORDERS)) {
        const store = idb.createObjectStore(STORE_ORDERS, { keyPath: 'orderId' });
        store.createIndex('date', 'date', { unique: false });
      }
      if (!idb.objectStoreNames.contains(STORE_SEQUENCE)) {
        idb.createObjectStore(STORE_SEQUENCE, { keyPath: 'key' });
      }
      if (!idb.objectStoreNames.contains(STORE_ITEM_MASTER)) {
        const imStore = idb.createObjectStore(STORE_ITEM_MASTER, { keyPath: 'itemId' });
        imStore.createIndex('itemName', 'itemName', { unique: false });
      }
      if (!idb.objectStoreNames.contains(STORE_META)) {
        idb.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };

    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror   = (e) => reject(e.target.error);
    req.onblocked = ()  => reject(new Error('IndexedDB blocked by another tab'));
  });
}

/* Generate next unique order ID — never reuses deleted IDs */
async function generateOrderId() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_SEQUENCE, 'readwrite');
    const st  = tx.objectStore(STORE_SEQUENCE);
    const req = st.get('orderSeq');

    req.onsuccess = (e) => {
      const current  = e.target.result ? e.target.result.value : 0;
      const next     = current + 1;
      const putReq   = st.put({ key: 'orderSeq', value: next });
      putReq.onsuccess = () => resolve('ORD-' + String(next).padStart(4, '0'));
      putReq.onerror   = (err) => reject(err.target.error);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/* Insert new order */
async function dbSaveOrder(order) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ORDERS, 'readwrite');
    const st  = tx.objectStore(STORE_ORDERS);
    const req = st.add(order);
    req.onsuccess = () => resolve(order);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* Update existing order (put = upsert, keyed by orderId) */
async function dbUpdateOrder(order) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ORDERS, 'readwrite');
    const st  = tx.objectStore(STORE_ORDERS);
    const req = st.put(order);
    req.onsuccess = () => resolve(order);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* Delete order by ID */
async function dbDeleteOrder(orderId) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ORDERS, 'readwrite');
    const st  = tx.objectStore(STORE_ORDERS);
    const req = st.delete(orderId);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* Get all orders */
async function dbGetAllOrders() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ORDERS, 'readonly');
    const st  = tx.objectStore(STORE_ORDERS);
    const req = st.getAll();
    req.onsuccess = (e) => resolve(e.target.result || []);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* Get single order by ID */
async function dbGetOrder(orderId) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ORDERS, 'readonly');
    const st  = tx.objectStore(STORE_ORDERS);
    const req = st.get(orderId);
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* Delete all orders (does NOT reset sequence counter intentionally) */
async function dbClearAllOrders() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ORDERS, 'readwrite');
    const st  = tx.objectStore(STORE_ORDERS);
    const req = st.clear();
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* ── ITEM MASTER DB METHODS ────────────────────────────── */

/* Get all items from Item Master */
async function dbGetItemMaster() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_ITEM_MASTER, 'readonly');
    const st  = tx.objectStore(STORE_ITEM_MASTER);
    const req = st.getAll();
    req.onsuccess = (e) => resolve(e.target.result || []);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* Save / Replace Item Master with atomic transaction */
async function dbSaveItemMaster(items, meta) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ITEM_MASTER, STORE_META], 'readwrite');
    const itemStore = tx.objectStore(STORE_ITEM_MASTER);
    const metaStore = tx.objectStore(STORE_META);

    // Clear previous items
    itemStore.clear();

    // Insert new items
    for (let i = 0; i < items.length; i++) {
      itemStore.put(items[i]);
    }

    // Save metadata
    if (meta) {
      metaStore.put({ key: 'itemMasterMeta', value: meta });
    }

    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
    tx.onabort    = (e) => reject(e.target.error);
  });
}

/* Clear all items from Item Master */
async function dbClearItemMaster() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ITEM_MASTER, STORE_META], 'readwrite');
    tx.objectStore(STORE_ITEM_MASTER).clear();
    tx.objectStore(STORE_META).delete('itemMasterMeta');
    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
  });
}

/* Get single metadata item */
async function dbGetMeta(key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_META, 'readonly');
    const st  = tx.objectStore(STORE_META);
    const req = st.get(key);
    req.onsuccess = (e) => resolve(e.target.result ? e.target.result.value : null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* Load item master and metadata into in-memory cache */
async function loadItemMasterCache() {
  try {
    cachedItemMaster = await dbGetItemMaster();
    const meta = await dbGetMeta('itemMasterMeta');
    if (meta) {
      itemMasterMetadata = meta;
    } else {
      itemMasterMetadata = {
        lastUpdated: cachedItemMaster.length > 0 ? getTodayISO() : null,
        itemCount: cachedItemMaster.length,
        filename: ''
      };
    }
  } catch (err) {
    console.error('Failed to load item master cache:', err);
    cachedItemMaster = [];
  }
}

/* =========================================================
   2. DATE & CURRENCY HELPERS
   ========================================================= */

/** Returns today's date as YYYY-MM-DD (local time, no TZ drift) */
function getTodayISO() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  const d   = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

/** Converts YYYY-MM-DD → DD/MM/YYYY for display */
function formatDateForDisplay(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return d + '/' + m + '/' + y;
}

/** Formats a number with Indian rupee grouping */
function formatCurrency(amount) {
  const num = parseFloat(amount) || 0;
  return new Intl.NumberFormat('en-IN', {
    style:                 'currency',
    currency:              'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(num);
}

/** Safely parses a number, returning fallback on NaN/Infinity */
function sanitizeNumber(val, fallback) {
  if (fallback === undefined) fallback = 0;
  const n = parseFloat(val);
  if (!isFinite(n) || isNaN(n)) return fallback;
  return n;
}

/* =========================================================
   3. SCREEN NAVIGATION
   ========================================================= */

const screens = {
  home:        document.getElementById('screen-home'),
  newOrder:    document.getElementById('screen-new-order'),
  savedOrders: document.getElementById('screen-saved-orders'),
  viewOrder:   document.getElementById('screen-view-order'),
  export:      document.getElementById('screen-export'),
  itemMaster:  document.getElementById('screen-item-master')
};

function showScreen(name, updateHistory) {
  if (updateHistory === undefined) updateHistory = true;
  Object.values(screens).forEach(s => s && s.classList.remove('active'));
  if (screens[name]) screens[name].classList.add('active');
  window.scrollTo(0, 0);

  if (updateHistory && window.history && window.history.pushState) {
    const targetHash = '#' + name;
    if (window.location.hash !== targetHash) {
      window.history.pushState({ screen: name }, '', targetHash);
    }
  }

  /* Synchronize bottom navigation */
  const navMap = {
    home:        'nav-btn-home',
    savedOrders: 'nav-btn-orders',
    itemMaster:  'nav-btn-catalog',
    export:      'nav-btn-export'
  };

  const allNavBtns = document.querySelectorAll('.bottom-nav .nav-item');
  allNavBtns.forEach(b => b.classList.remove('active'));

  if (navMap[name]) {
    const activeBtn = document.getElementById(navMap[name]);
    if (activeBtn) activeBtn.classList.add('active');
  }
}

/* =========================================================
   4. TOAST NOTIFICATIONS
   ========================================================= */

const toastContainer = document.getElementById('toast-container');

function showToast(message, type, duration) {
  type     = type     || 'info';
  duration = duration || 3000;

  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.innerHTML =
    '<span class="toast-icon">' + (icons[type] || 'ℹ') + '</span>' +
    '<span>' + escapeHtml(message) + '</span>';
  toastContainer.appendChild(toast);

  setTimeout(function () {
    toast.classList.add('hiding');
    toast.addEventListener('animationend', function () { toast.remove(); }, { once: true });
  }, duration);
}

/* =========================================================
   5. MODAL CONFIRM DIALOG
   ========================================================= */

const modalOverlay    = document.getElementById('modal-overlay');
const modalIconEl     = document.getElementById('modal-icon');
const modalTitleEl    = document.getElementById('modal-title');
const modalMessageEl  = document.getElementById('modal-message');
const btnModalCancel  = document.getElementById('btn-modal-cancel');
const btnModalConfirm = document.getElementById('btn-modal-confirm');

function showConfirmModal(opts) {
  modalIconEl.textContent     = opts.icon    || '⚠️';
  modalTitleEl.textContent    = opts.title   || '';
  modalMessageEl.textContent  = opts.message || '';
  btnModalConfirm.textContent = opts.confirmText || 'Confirm';
  btnModalCancel.textContent  = opts.cancelText  || 'Cancel';

  if (opts.confirmClass) {
    btnModalConfirm.className = opts.confirmClass;
  } else {
    btnModalConfirm.className = 'btn-modal-confirm';
  }

  modalOverlay.classList.add('active');

  btnModalConfirm.onclick = function () {
    hideModal();
    if (opts.onConfirm) opts.onConfirm();
  };
  btnModalCancel.onclick = function () {
    hideModal();
    if (opts.onCancel) opts.onCancel();
  };
}

function hideModal() { modalOverlay.classList.remove('active'); }

/* =========================================================
   6. LOADING OVERLAY
   ========================================================= */

const loadingOverlay = document.getElementById('loading-overlay');

function showLoading(text) {
  document.getElementById('loading-text').textContent = text || 'Loading…';
  loadingOverlay.classList.add('active');
}
function hideLoading() { loadingOverlay.classList.remove('active'); }

/* =========================================================
   7. HOME SCREEN
   ========================================================= */

async function renderHome() {
  const today  = getTodayISO();
  const orders = await dbGetAllOrders();

  const todayOrders = orders.filter(function (o) { return o.date === today; });
  const todayTotal  = todayOrders.reduce(function (s, o) { return s + (o.total || 0); }, 0);

  document.getElementById('stat-today-count').textContent = todayOrders.length;
  document.getElementById('stat-today-total').textContent = formatCurrency(todayTotal);
  document.getElementById('home-date').textContent        = formatDateForDisplay(today);

  /* Item Master summary on Home screen */
  const itemCountEl   = document.getElementById('stat-item-count');
  const itemUpdatedEl = document.getElementById('stat-item-updated');
  if (itemCountEl) {
    itemCountEl.textContent = cachedItemMaster.length + (cachedItemMaster.length === 1 ? ' Item' : ' Items');
  }
  if (itemUpdatedEl) {
    if (itemMasterMetadata && itemMasterMetadata.lastUpdated) {
      itemUpdatedEl.textContent = 'Last Updated: ' + formatDateForDisplay(itemMasterMetadata.lastUpdated);
    } else if (cachedItemMaster.length > 0) {
      itemUpdatedEl.textContent = 'Last Updated: ' + formatDateForDisplay(today);
    } else {
      itemUpdatedEl.textContent = 'Last Updated: Never';
    }
  }

  /* Dynamic greeting */
  const hour = new Date().getHours();
  let greeting = 'Good Morning';
  if (hour >= 12 && hour < 17) greeting = 'Good Afternoon';
  else if (hour >= 17) greeting = 'Good Evening';
  const greetingEl = document.getElementById('home-greeting-sub');
  if (greetingEl) greetingEl.textContent = greeting + ' · Sales Dashboard';

  showScreen('home');
}

/* =========================================================
   8. ITEM CARDS (New Order / Edit Order share one form)
   ========================================================= */

function getItemsContainer() {
  return document.getElementById('items-container');
}

function highlightMatch(text, query) {
  if (!text) return '';
  if (!query) return escapeHtml(text);
  const qLower = query.toLowerCase();
  const tLower = text.toLowerCase();
  const idx = tLower.indexOf(qLower);
  if (idx === -1) return escapeHtml(text);

  const before = text.substring(0, idx);
  const match  = text.substring(idx, idx + query.length);
  const after  = text.substring(idx + query.length);

  return escapeHtml(before) + '<mark class="ac-hl">' + escapeHtml(match) + '</mark>' + escapeHtml(after);
}

/** Create a single item entry card with 2-letter autocomplete */
function createItemCard(index, data) {
  data = data || {};

  const card = document.createElement('div');
  card.className = 'item-card';
  card.dataset.itemIndex = index;

  // Check if item exists in Item Master to attach stock info
  let matchedCatalogItem = null;
  if (data.itemName) {
    const lowerName = data.itemName.trim().toLowerCase();
    matchedCatalogItem = cachedItemMaster.find(function (it) {
      return (it.itemName || '').trim().toLowerCase() === lowerName;
    });
  }

  const availQty = (data.availableQuantity !== undefined && data.availableQuantity !== null)
    ? data.availableQuantity
    : (matchedCatalogItem ? matchedCatalogItem.availableQuantity : undefined);

  if (availQty !== undefined && availQty !== null) {
    card.dataset.availableQuantity = availQty;
  }

  const qtyVal  = (data.quantity !== undefined && data.quantity !== '') ? data.quantity : '';
  const rateVal = (data.rate     !== undefined && data.rate     !== '') ? data.rate     : (matchedCatalogItem ? matchedCatalogItem.rate : '');
  const amtVal  = sanitizeNumber(data.amount, (sanitizeNumber(qtyVal, 0) * sanitizeNumber(rateVal, 0)));
  const hasStockInfo = (availQty !== undefined && availQty !== null);

  card.innerHTML =
    '<div class="item-card-header">' +
      '<span class="item-card-title">Item ' + index + '</span>' +
      '<button type="button" class="btn-remove-item" aria-label="Remove item">&#x2715; Remove</button>' +
    '</div>' +
    '<div class="item-grid">' +
      '<div class="form-group full-width autocomplete-wrap">' +
        '<label>Select Item <span class="required">*</span></label>' +
        '<input type="text" class="form-control item-name" placeholder="Type first 2 letters..." value="' + escapeAttr(data.itemName || '') + '" autocomplete="off" autocorrect="off" spellcheck="false" />' +
        '<div class="autocomplete-status">Type at least 2 letters to search.</div>' +
        '<div class="autocomplete-dropdown" style="display:none">' +
          '<div class="autocomplete-dropdown-header">' +
            '<span class="ac-header-title">MATCHING ITEMS</span>' +
            '<span class="ac-header-count">0</span>' +
          '</div>' +
          '<div class="autocomplete-list"></div>' +
        '</div>' +
        '<p class="validation-msg item-name-msg">Please enter or select an item name.</p>' +
        '<div class="item-stock-info" style="' + (hasStockInfo ? 'display:flex' : 'display:none') + '">' +
          '<span class="item-stock-avail">Available: <span class="avail-qty-val">' + (hasStockInfo ? availQty : '—') + '</span></span>' +
          '<span class="item-stock-rate">Rate: &#8377;<span class="catalog-rate-val">' + (rateVal !== '' ? rateVal : '0') + '</span></span>' +
        '</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Order Quantity <span class="required">*</span></label>' +
        '<div class="qty-control-wrap">' +
          '<button type="button" class="btn-qty-step btn-qty-minus" aria-label="Decrease quantity">&#x2212;</button>' +
          '<input type="number" class="form-control item-qty" placeholder="1" value="' + qtyVal + '" min="0.01" step="any" inputmode="decimal" />' +
          '<button type="button" class="btn-qty-step btn-qty-plus" aria-label="Increase quantity">+</button>' +
        '</div>' +
        '<div class="qty-preset-chips">' +
          '<span class="qty-chips-label">Select:</span>' +
          '<button type="button" class="chip-qty" data-val="1">1</button>' +
          '<button type="button" class="chip-qty" data-val="2">2</button>' +
          '<button type="button" class="chip-qty" data-val="5">5</button>' +
          '<button type="button" class="chip-qty" data-val="10">10</button>' +
          '<button type="button" class="chip-qty" data-val="25">25</button>' +
          '<button type="button" class="chip-qty" data-val="50">50</button>' +
        '</div>' +
        '<p class="validation-msg item-qty-msg">Quantity must be &gt; 0.</p>' +
        '<div class="stock-warning' + (hasStockInfo && sanitizeNumber(qtyVal, 0) > availQty ? ' visible' : '') + '">⚠️ Only <span class="stock-max-val">' + (hasStockInfo ? availQty : 0) + '</span> units are currently available.</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Rate (&#8377;) <span class="required">*</span></label>' +
        '<input type="number" class="form-control item-rate" placeholder="0" value="' + rateVal + '" min="0" step="any" inputmode="decimal" />' +
        '<p class="validation-msg item-rate-msg">Rate cannot be negative.</p>' +
      '</div>' +
      '<div class="full-width">' +
        '<div class="amount-display">' +
          '<span class="amount-label">Amount</span>' +
          '<span class="amount-value item-amount">' + formatCurrency(amtVal) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  /* Elements */
  const nameInput   = card.querySelector('.item-name');
  const dropdown    = card.querySelector('.autocomplete-dropdown');
  const statusEl    = card.querySelector('.autocomplete-status');
  const countEl     = card.querySelector('.ac-header-count');
  const acList      = card.querySelector('.autocomplete-list');
  const stockInfo   = card.querySelector('.item-stock-info');
  const availQtyEl  = card.querySelector('.avail-qty-val');
  const catRateEl   = card.querySelector('.catalog-rate-val');
  const qtyInput    = card.querySelector('.item-qty');
  const rateInput   = card.querySelector('.item-rate');
  const warningEl   = card.querySelector('.stock-warning');
  const stockMaxEl  = card.querySelector('.stock-max-val');

  /* Check stock limit warning (Section 10) */
  function checkStockLimit() {
    if (card.dataset.availableQuantity !== undefined && card.dataset.availableQuantity !== '') {
      const avail = sanitizeNumber(card.dataset.availableQuantity, -1);
      const orderQty = sanitizeNumber(qtyInput.value, 0);
      if (avail >= 0 && orderQty > avail) {
        stockMaxEl.textContent = avail;
        warningEl.classList.add('visible');
      } else {
        warningEl.classList.remove('visible');
      }
    } else {
      warningEl.classList.remove('visible');
    }
  }

  /* Autocomplete search logic (Sections 4, 5, 6, 7, 16, 17) */
  function renderAutocomplete(query) {
    query = (query || '').trim();

    // Minimum search length: 2 characters (Section 4)
    if (query.length < 2) {
      dropdown.style.display = 'none';
      statusEl.textContent = 'Type at least 2 letters to search.';
      statusEl.className = 'autocomplete-status';
      return;
    }

    const qLower = query.toLowerCase();
    const prefixMatches   = [];
    const containsMatches = [];

    for (let i = 0; i < cachedItemMaster.length; i++) {
      const it = cachedItemMaster[i];
      const itName = it.itemName || '';
      const itLower = itName.toLowerCase();
      if (itLower.startsWith(qLower)) {
        prefixMatches.push(it);
      } else if (itLower.includes(qLower)) {
        containsMatches.push(it);
      }
    }

    const matches = prefixMatches.concat(containsMatches);

    if (matches.length === 0) {
      statusEl.textContent = 'No matching items found.';
      statusEl.className = 'autocomplete-status';
      countEl.textContent = '0';
      acList.innerHTML = '<div class="autocomplete-empty">No matching items found.</div>';
      dropdown.style.display = 'block';
      return;
    }

    statusEl.textContent = matches.length + ' matching item' + (matches.length > 1 ? 's' : '');
    statusEl.className = 'autocomplete-status active-search';
    countEl.textContent = matches.length;

    // Fast rendering: top 40 matches (Section 16)
    const limit = Math.min(matches.length, 40);
    acList.innerHTML = '';

    for (let i = 0; i < limit; i++) {
      const item = matches[i];
      const acCard = document.createElement('div');
      acCard.className = 'autocomplete-card';

      const highlighted = highlightMatch(item.itemName, query);
      acCard.innerHTML =
        '<div class="ac-card-name">' + highlighted + '</div>' +
        '<div class="ac-card-meta">' +
          '<span class="ac-qty">Available: ' + item.availableQuantity + '</span>' +
          '<span class="ac-rate">&#8377;' + item.rate + '</span>' +
        '</div>';

      acCard.addEventListener('mousedown', function (e) {
        e.preventDefault(); // Keep input focus until selection is done
      });

      acCard.addEventListener('click', function () {
        selectProduct(item);
      });

      acList.appendChild(acCard);
    }

    dropdown.style.display = 'block';
  }

  /* When an item is selected from autocomplete (Sections 8, 9, 12, 18) */
  function selectProduct(item) {
    // ── DUPLICATE ITEM CHECK (Section 12) ──
    const allCards = getItemsContainer().querySelectorAll('.item-card');
    let duplicateCard = null;

    allCards.forEach(function (other) {
      if (other !== card) {
        const otherName = (other.querySelector('.item-name').value || '').trim().toLowerCase();
        if (otherName === item.itemName.trim().toLowerCase()) {
          duplicateCard = other;
        }
      }
    });

    if (duplicateCard) {
      dropdown.style.display = 'none';
      showConfirmModal({
        icon: '⚠️',
        title: 'Item Already Added',
        message: item.itemName + ' is already added to this order.',
        confirmText: 'Increase Quantity',
        cancelText: 'Cancel',
        confirmClass: 'btn-modal-confirm',
        onConfirm: function () {
          const otherQtyInp = duplicateCard.querySelector('.item-qty');
          const currentQty  = sanitizeNumber(otherQtyInp.value, 1);
          otherQtyInp.value = currentQty + 1;
          calculateItemAmount(duplicateCard);
          calculateOrderTotals();

          // Check stock limit for that card
          if (duplicateCard.dataset.availableQuantity !== undefined) {
            const avail = sanitizeNumber(duplicateCard.dataset.availableQuantity, -1);
            const otherWarn = duplicateCard.querySelector('.stock-warning');
            const otherMax  = duplicateCard.querySelector('.stock-max-val');
            if (avail >= 0 && (currentQty + 1) > avail) {
              otherMax.textContent = avail;
              otherWarn.classList.add('visible');
            }
          }

          // If current card was empty, clean it up
          if (allCards.length > 1 && !card.dataset.availableQuantity) {
            card.remove();
            renumberItemCards();
          } else {
            nameInput.value = '';
            statusEl.textContent = 'Type at least 2 letters to search.';
            statusEl.className = 'autocomplete-status';
          }

          duplicateCard.classList.add('duplicate-highlight');
          setTimeout(function () { duplicateCard.classList.remove('duplicate-highlight'); }, 1200);
          duplicateCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          showToast('Updated ' + item.itemName + ' quantity to ' + (currentQty + 1), 'info');
        },
        onCancel: function () {
          nameInput.focus();
        }
      });
      return;
    }

    // Populate selected product (Section 8)
    nameInput.value = item.itemName;
    nameInput.dataset.selected = 'true';
    card.dataset.availableQuantity = item.availableQuantity;
    availQtyEl.textContent = item.availableQuantity;
    catRateEl.textContent  = item.rate;
    stockInfo.style.display = 'flex';

    rateInput.value = item.rate;

    // Order Quantity: default to [ 1 ] (Section 8)
    if (!qtyInput.value || sanitizeNumber(qtyInput.value, 0) <= 0) {
      qtyInput.value = '1';
    }

    dropdown.style.display = 'none';
    statusEl.textContent = 'Selected: ' + item.itemName;
    statusEl.className = 'autocomplete-status';

    calculateItemAmount(card);
    calculateOrderTotals();
    checkStockLimit();

    // Logical focus to Order Quantity field for Android typing (Section 18)
    try {
      qtyInput.focus();
      qtyInput.select();
    } catch (e) {}
  }

  /* ── QUANTITY STEPPER & QUICK CHIP HANDLERS ── */
  const btnMinus = card.querySelector('.btn-qty-minus');
  const btnPlus  = card.querySelector('.btn-qty-plus');

  if (btnMinus) {
    btnMinus.addEventListener('click', function () {
      const current = sanitizeNumber(qtyInput.value, 1);
      const next = Math.max(1, current - 1);
      qtyInput.value = next;
      checkStockLimit();
      calculateItemAmount(card);
      calculateOrderTotals();
    });
  }

  if (btnPlus) {
    btnPlus.addEventListener('click', function () {
      const current = sanitizeNumber(qtyInput.value, 0);
      const next = current + 1;
      qtyInput.value = next;
      checkStockLimit();
      calculateItemAmount(card);
      calculateOrderTotals();
    });
  }

  card.querySelectorAll('.chip-qty').forEach(function (chip) {
    chip.addEventListener('click', function () {
      qtyInput.value = chip.dataset.val;
      checkStockLimit();
      calculateItemAmount(card);
      calculateOrderTotals();
      try { qtyInput.focus(); } catch (e) {}
    });
  });

  /* Auto-select text on focus/click so typing replaces existing quantity directly */
  qtyInput.addEventListener('focus', function () {
    try { this.select(); } catch (err) {}
  });
  qtyInput.addEventListener('click', function () {
    try { this.select(); } catch (err) {}
  });

  /* Input events for autocomplete */
  nameInput.addEventListener('input', function (e) {
    if (nameInput.dataset.selected && nameInput.value.trim() !== statusEl.textContent.replace('Selected: ', '').trim()) {
      delete card.dataset.availableQuantity;
      delete nameInput.dataset.selected;
      stockInfo.style.display = 'none';
      checkStockLimit();
    }
    renderAutocomplete(e.target.value);
  });

  nameInput.addEventListener('focus', function () {
    if (nameInput.value.trim().length >= 2) {
      renderAutocomplete(nameInput.value);
    }
  });

  /* Dismiss dropdown when clicking outside */
  document.addEventListener('click', function (e) {
    if (!card.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });

  /* Remove handler */
  card.querySelector('.btn-remove-item').addEventListener('click', function () {
    removeItemCard(card);
  });

  /* Auto-recalculate & stock warning checks */
  qtyInput.addEventListener('input', function () {
    checkStockLimit();
    calculateItemAmount(card);
    calculateOrderTotals();
  });

  rateInput.addEventListener('input', function () {
    calculateItemAmount(card);
    calculateOrderTotals();
  });

  if (hasStockInfo) {
    checkStockLimit();
  }

  return card;
}

function removeItemCard(card) {
  const container = getItemsContainer();
  if (container.children.length <= 1) {
    showToast('An order must have at least one item.', 'warning');
    return;
  }
  card.remove();
  renumberItemCards();
  calculateOrderTotals();
}

function renumberItemCards() {
  const cards = getItemsContainer().querySelectorAll('.item-card');
  cards.forEach(function (card, i) {
    card.querySelector('.item-card-title').textContent = 'Item ' + (i + 1);
    card.dataset.itemIndex = i + 1;
  });
}

function calculateItemAmount(card) {
  const qty    = sanitizeNumber(card.querySelector('.item-qty').value,  0);
  const rate   = sanitizeNumber(card.querySelector('.item-rate').value, 0);
  const amount = qty * rate;
  card.querySelector('.item-amount').textContent = formatCurrency(amount);
  return amount;
}

function calculateOrderTotals() {
  const cards = getItemsContainer().querySelectorAll('.item-card');
  let subtotal = 0;
  cards.forEach(function (card) { subtotal += calculateItemAmount(card); });

  document.getElementById('order-subtotal').textContent    = formatCurrency(subtotal);
  document.getElementById('order-grand-total').textContent = formatCurrency(subtotal);
}

function addItemCard(data) {
  const container = getItemsContainer();
  const index     = container.children.length + 1;
  const card      = createItemCard(index, data || {});
  container.appendChild(card);
  calculateOrderTotals();
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearItemCards() {
  getItemsContainer().innerHTML = '';
}

/* =========================================================
   9. NEW ORDER SCREEN
   ========================================================= */

async function openNewOrderScreen() {
  currentEditOrderId = null;

  document.getElementById('new-order-title').textContent = 'New Order';
  document.getElementById('save-order-btn').textContent  = 'SAVE ORDER';

  /* Reset form fields */
  document.getElementById('new-customer-name').value  = '';
  document.getElementById('new-customer-phone').value = '';
  document.getElementById('new-order-date').value     = getTodayISO();
  document.getElementById('new-order-notes').value    = '';

  clearValidationErrors();

  /* Auto-generate order number */
  try {
    const orderId = await generateOrderId();
    document.getElementById('new-order-id-display').textContent = orderId;
  } catch (err) {
    document.getElementById('new-order-id-display').textContent = 'ORD-????';
    console.error('Order ID generation failed:', err);
  }

  /* Start with one blank item */
  clearItemCards();
  addItemCard();

  showScreen('newOrder');
}

/* =========================================================
   10. EDIT ORDER SCREEN
   ========================================================= */

async function openEditOrderScreen(orderId) {
  const order = await dbGetOrder(orderId);
  if (!order) { showToast('Order not found.', 'error'); return; }

  currentEditOrderId = orderId;

  document.getElementById('new-order-title').textContent = 'Edit Order';
  document.getElementById('save-order-btn').textContent  = 'UPDATE ORDER';

  document.getElementById('new-customer-name').value  = order.customerName || '';
  document.getElementById('new-customer-phone').value = order.phone        || '';
  document.getElementById('new-order-date').value     = order.date         || getTodayISO();
  document.getElementById('new-order-notes').value    = order.notes        || '';
  document.getElementById('new-order-id-display').textContent = order.orderId;

  clearValidationErrors();

  clearItemCards();
  (order.items || []).forEach(function (item) { addItemCard(item); });
  calculateOrderTotals();

  showScreen('newOrder');
}

/* =========================================================
   11. VALIDATION
   ========================================================= */

function clearValidationErrors() {
  document.querySelectorAll('#screen-new-order .form-control').forEach(function (f) {
    f.classList.remove('error');
  });
  document.querySelectorAll('#screen-new-order .validation-msg').forEach(function (m) {
    m.classList.remove('visible');
  });
}

function showFieldError(field, msgEl, message) {
  field.classList.add('error');
  msgEl.textContent = message;
  msgEl.classList.add('visible');
}

function validateOrderForm() {
  clearValidationErrors();
  let valid = true;

  /* Customer name */
  const nameField = document.getElementById('new-customer-name');
  const nameMsg   = document.getElementById('new-customer-name-msg');
  if (!nameField.value.trim()) {
    showFieldError(nameField, nameMsg, 'Please enter customer name.');
    valid = false;
  }

  /* At least one item */
  const cards = getItemsContainer().querySelectorAll('.item-card');
  if (cards.length === 0) {
    showToast('Please add at least one item.', 'error');
    return false;
  }

  /* Per-item validation */
  cards.forEach(function (card) {
    const nameInput = card.querySelector('.item-name');
    const nameMsg2  = card.querySelector('.item-name-msg');
    const qtyInput  = card.querySelector('.item-qty');
    const qtyMsg    = card.querySelector('.item-qty-msg');
    const rateInput = card.querySelector('.item-rate');
    const rateMsg   = card.querySelector('.item-rate-msg');

    if (!nameInput.value.trim()) {
      showFieldError(nameInput, nameMsg2, 'Please enter item name.');
      valid = false;
    }
    var qty = sanitizeNumber(qtyInput.value, -1);
    if (qty <= 0) {
      showFieldError(qtyInput, qtyMsg, 'Quantity must be greater than 0.');
      valid = false;
    }
    var rate = sanitizeNumber(rateInput.value, -1);
    if (rate < 0) {
      showFieldError(rateInput, rateMsg, 'Rate cannot be negative.');
      valid = false;
    }
  });

  if (!valid) {
    var firstErr = document.querySelector('#screen-new-order .form-control.error');
    if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  return valid;
}

/* =========================================================
   12. COLLECT FORM DATA & SAVE / UPDATE
   ========================================================= */

function collectOrderData(orderId) {
  const cards = getItemsContainer().querySelectorAll('.item-card');
  const items = [];
  let total   = 0;

  cards.forEach(function (card) {
    var qty    = sanitizeNumber(card.querySelector('.item-qty').value,  0);
    var rate   = sanitizeNumber(card.querySelector('.item-rate').value, 0);
    var amount = parseFloat((qty * rate).toFixed(2));
    total += amount;
    items.push({
      itemName: card.querySelector('.item-name').value.trim(),
      quantity: qty,
      rate:     rate,
      amount:   amount
    });
  });

  return {
    orderId:      orderId,
    date:         document.getElementById('new-order-date').value || getTodayISO(),
    customerName: document.getElementById('new-customer-name').value.trim(),
    phone:        document.getElementById('new-customer-phone').value.trim(),
    items:        items,
    total:        parseFloat(total.toFixed(2)),
    notes:        document.getElementById('new-order-notes').value.trim(),
    createdAt:    new Date().toISOString()
  };
}

async function handleSaveOrder() {
  if (isSaving) return;
  if (!validateOrderForm()) return;

  isSaving = true;
  const btn = document.getElementById('save-order-btn');
  btn.disabled = true;

  try {
    if (currentEditOrderId) {
      /* UPDATE */
      const existing = await dbGetOrder(currentEditOrderId);
      const order    = collectOrderData(currentEditOrderId);
      order.createdAt = (existing && existing.createdAt) ? existing.createdAt : order.createdAt;
      order.updatedAt = new Date().toISOString();
      await dbUpdateOrder(order);

      showToast('Order updated — ' + order.orderId + ' | ' + formatCurrency(order.total), 'success', 4000);
      await renderHome();
      setTimeout(openSavedOrdersScreen, 800);
    } else {
      /* SAVE new */
      const orderId = document.getElementById('new-order-id-display').textContent;
      const order   = collectOrderData(orderId);
      await dbSaveOrder(order);

      showToast('Order saved — ' + order.orderId + ' | ' + formatCurrency(order.total), 'success', 4000);
      await renderHome();
      setTimeout(openSavedOrdersScreen, 800);
    }
  } catch (err) {
    console.error('Save error:', err);
    showToast('Failed to save order. Please try again.', 'error');
    btn.disabled = false;
    isSaving     = false;
  } finally {
    setTimeout(function () {
      btn.disabled = false;
      isSaving     = false;
    }, 1600);
  }
}

/* =========================================================
   13. SAVED ORDERS SCREEN
   ========================================================= */

async function openSavedOrdersScreen() {
  const q = document.getElementById('order-search-input').value || '';
  await renderSavedOrders(q);
  showScreen('savedOrders');
}

async function renderSavedOrders(query) {
  const orders = await dbGetAllOrders();
  const q      = (query || '').toLowerCase().trim();

  /* Sort newest date first, then by creation time */
  orders.sort(function (a, b) {
    if (b.date !== a.date) return b.date.localeCompare(a.date);
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  const filtered = q ? orders.filter(function (o) { return searchOrder(o, q); }) : orders;

  const list = document.getElementById('orders-list');
  list.innerHTML = '';

  if (filtered.length === 0) {
    list.innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-icon">' + (q ? '🔍' : '📋') + '</div>' +
        '<div class="empty-title">' + (q ? 'No orders found' : 'No saved orders yet') + '</div>' +
        '<div class="empty-sub">' + (q ? 'Try a different search term.' : 'Tap + New Order to create your first order.') + '</div>' +
      '</div>';
    return;
  }

  filtered.forEach(function (order) {
    list.appendChild(buildOrderCard(order));
  });
}

function searchOrder(order, q) {
  if ((order.orderId       || '').toLowerCase().includes(q)) return true;
  if ((order.customerName  || '').toLowerCase().includes(q)) return true;
  if ((order.items || []).some(function (i) {
    return (i.itemName || '').toLowerCase().includes(q);
  })) return true;
  return false;
}

function buildOrderCard(order) {
  const div = document.createElement('div');
  div.className = 'order-card';

  const itemCount = (order.items || []).length;
  div.innerHTML =
    '<div class="order-card-top">' +
      '<span class="order-card-id">' + escapeHtml(order.orderId) + '</span>' +
      '<span class="order-card-total">' + formatCurrency(order.total) + '</span>' +
    '</div>' +
    '<div class="order-card-customer">' + escapeHtml(order.customerName) + '</div>' +
    '<div class="order-card-meta">' +
      '<div class="order-card-meta-item">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ' +
        formatDateForDisplay(order.date) +
      '</div>' +
      '<div class="order-card-meta-item">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg> ' +
        itemCount + ' item' + (itemCount !== 1 ? 's' : '') +
      '</div>' +
    '</div>' +
    '<div class="order-card-actions">' +
      '<button class="btn-card-view" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> View</button>' +
      '<button class="btn-card-edit" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit</button>' +
      '<button class="btn-card-delete" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete</button>' +
    '</div>';

  div.querySelector('.btn-card-view').addEventListener('click', function () {
    openViewOrderScreen(order.orderId);
  });
  div.querySelector('.btn-card-edit').addEventListener('click', function () {
    openEditOrderScreen(order.orderId);
  });
  div.querySelector('.btn-card-delete').addEventListener('click', function () {
    confirmDeleteOrder(order.orderId, order.customerName);
  });

  return div;
}

/* =========================================================
   14. VIEW ORDER SCREEN
   ========================================================= */

async function openViewOrderScreen(orderId) {
  const order = await dbGetOrder(orderId);
  if (!order) { showToast('Order not found.', 'error'); return; }

  currentViewOrderId = orderId;

  document.getElementById('view-order-id').textContent       = order.orderId;
  document.getElementById('view-order-date').textContent     = formatDateForDisplay(order.date);
  document.getElementById('view-customer-name').textContent  = order.customerName;
  document.getElementById('view-customer-phone').textContent = order.phone || '—';

  const itemsDiv = document.getElementById('view-items-list');
  itemsDiv.innerHTML = '';
  (order.items || []).forEach(function (item) {
    const d = document.createElement('div');
    d.className = 'view-item-card';
    d.innerHTML =
      '<div class="view-item-name">'   + escapeHtml(item.itemName)          + '</div>' +
      '<div class="view-item-meta">' +
        '<span>Qty: '   + item.quantity           + '</span>' +
        '<span>Rate: '  + formatCurrency(item.rate) + '</span>' +
      '</div>' +
      '<div class="view-item-amount">' + formatCurrency(item.amount) + '</div>';
    itemsDiv.appendChild(d);
  });

  document.getElementById('view-total').textContent = formatCurrency(order.total);

  const notesSection = document.getElementById('view-notes-section');
  if (order.notes && order.notes.trim()) {
    document.getElementById('view-notes-text').textContent = order.notes;
    notesSection.style.display = '';
  } else {
    notesSection.style.display = 'none';
  }

  showScreen('viewOrder');
}

/* =========================================================
   15. DELETE ORDER
   ========================================================= */

function confirmDeleteOrder(orderId, customerName) {
  showConfirmModal({
    icon:        '🗑️',
    title:       'Delete this order?',
    message:     'Order ' + orderId + ' for "' + customerName + '" will be permanently deleted. This action cannot be undone.',
    confirmText: 'Delete',
    onConfirm:   function () { deleteOrder(orderId); }
  });
}

async function deleteOrder(orderId) {
  try {
    await dbDeleteOrder(orderId);
    showToast('Order deleted successfully.', 'success');
    await renderHome();
    await openSavedOrdersScreen();
  } catch (err) {
    console.error('Delete error:', err);
    showToast('Failed to delete order.', 'error');
  }
}

/* =========================================================
   16. CLEAR ALL DATA
   ========================================================= */

function confirmClearAll() {
  showConfirmModal({
    icon:        '⚠️',
    title:       'Clear all saved orders?',
    message:     'This will permanently delete ALL locally stored orders. This action cannot be undone.',
    confirmText: 'Clear All Data',
    onConfirm:   clearAllData
  });
}

async function clearAllData() {
  try {
    await dbClearAllOrders();
    showToast('All orders have been deleted.', 'success');
    await renderHome();
    await renderSavedOrders('');
  } catch (err) {
    console.error('Clear error:', err);
    showToast('Failed to clear data.', 'error');
  }
}

/* =========================================================
   17. EXPORT SCREEN
   ========================================================= */

function openExportScreen() {
  document.getElementById('export-date-picker').value = getTodayISO();
  showScreen('export');
}

function getExportFilename(suffix) {
  var d    = getTodayISO().split('-');
  var date = d[2] + '-' + d[1] + '-' + d[0];
  return 'Sales_' + date + (suffix || '') + '.xlsx';
}

async function exportAllOrders() {
  const orders = await dbGetAllOrders();
  if (!orders.length) { showToast('No orders to export.', 'warning'); return; }
  generateExcel(orders, getExportFilename());
}

async function exportTodayOrders() {
  const today  = getTodayISO();
  const orders = (await dbGetAllOrders()).filter(function (o) { return o.date === today; });
  if (!orders.length) { showToast('No orders for today.', 'warning'); return; }
  generateExcel(orders, getExportFilename('_Today'));
}

async function exportDateOrders() {
  const dateVal = document.getElementById('export-date-picker').value;
  if (!dateVal) { showToast('Please select a date.', 'warning'); return; }
  const orders = (await dbGetAllOrders()).filter(function (o) { return o.date === dateVal; });
  if (!orders.length) { showToast('No orders found for this date.', 'warning'); return; }
  var d    = dateVal.split('-');
  var date = d[2] + '-' + d[1] + '-' + d[0];
  generateExcel(orders, 'Sales_' + date + '.xlsx');
}

/* =========================================================
   18. EXCEL GENERATION via SheetJS
   ========================================================= */

async function generateExcel(orders, filename) {
  if (typeof XLSX === 'undefined') {
    showToast('Excel library not loaded. Check internet connection.', 'error');
    return;
  }
  try {
    const wb = XLSX.utils.book_new();

    /* Sheet 1 — Orders (one row per order) */
    const ordersRows = [
      ['Order No.', 'Date', 'Customer Name', 'Phone', 'Number of Items', 'Total Amount', 'Notes']
    ];
    orders.forEach(function (o) {
      ordersRows.push([
        o.orderId,
        formatDateForDisplay(o.date),
        o.customerName,
        o.phone || '',
        (o.items || []).length,
        o.total || 0,
        o.notes || ''
      ]);
    });
    const wsOrders = XLSX.utils.aoa_to_sheet(ordersRows);
    wsOrders['!cols'] = [
      { wch: 12 }, { wch: 12 }, { wch: 26 }, { wch: 14 },
      { wch: 15 }, { wch: 14 }, { wch: 36 }
    ];
    XLSX.utils.book_append_sheet(wb, wsOrders, 'Orders');

    /* Sheet 2 — Items (one row per item) */
    const itemsRows = [
      ['Order No.', 'Date', 'Customer Name', 'Item Name', 'Quantity', 'Rate', 'Amount']
    ];
    orders.forEach(function (o) {
      (o.items || []).forEach(function (item) {
        itemsRows.push([
          o.orderId,
          formatDateForDisplay(o.date),
          o.customerName,
          item.itemName,
          item.quantity,
          item.rate,
          item.amount
        ]);
      });
    });
    const wsItems = XLSX.utils.aoa_to_sheet(itemsRows);
    wsItems['!cols'] = [
      { wch: 12 }, { wch: 12 }, { wch: 26 }, { wch: 26 },
      { wch: 10 }, { wch: 12 }, { wch: 14 }
    ];
    XLSX.utils.book_append_sheet(wb, wsItems, 'Items');

    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    /* Android Native WebApp Bridge for seamless native share & save */
    if (window.AndroidApp && typeof window.AndroidApp.saveOrShareExcel === 'function') {
      try {
        let binary = '';
        const bytes = new Uint8Array(wbout);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const b64 = window.btoa(binary);
        window.AndroidApp.saveOrShareExcel(b64, filename, mimeType);
        showToast('Orders exported & ready to share!', 'success', 4000);
        return;
      } catch (nativeErr) {
        console.warn('Native share error, falling back:', nativeErr);
      }
    }

    /* Mobile Web Share API: share directly to WhatsApp, Gmail, Drive, etc. */
    if (typeof navigator.share === 'function' && typeof File === 'function') {
      try {
        const file = new File([wbout], filename, { type: mimeType });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: 'ANIRUDH AGENCY — Wholesale Orders',
            text: 'Exported sales orders from ANIRUDH AGENCY (' + filename + ')'
          });
          showToast('Orders shared successfully!', 'success', 4000);
          return;
        }
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return; // User closed the native share sheet
        console.warn('Web Share fallback to direct download:', shareErr);
      }
    }

    /* Method 1: Modern File Save Dialog (Desktop Chrome / Edge) */
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: 'Excel Spreadsheet (*.xlsx)',
            accept: { [mimeType]: ['.xlsx'] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(wbout);
        await writable.close();
        showToast('Saved: ' + filename, 'success', 4000);
        return;
      } catch (pickerErr) {
        if (pickerErr.name === 'AbortError') return; // User cancelled the save dialog
        console.warn('showSaveFilePicker fallback:', pickerErr);
      }
    }

    /* Method 2: Blob URL download (works reliably on Android Chrome, iOS Safari, and Desktop) */
    const blob = new Blob([wbout], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(blobUrl);
      if (a.parentNode) {
        document.body.removeChild(a);
      }
    }, 2000);

    showToast('Exported: ' + filename, 'success', 4000);
  } catch (err) {
    console.error('Export error:', err);
    showToast('Export failed. Please try again.', 'error');
  }
}

/* =========================================================
   19. ITEM MASTER: EXCEL IMPORT & CATALOG MANAGEMENT
   ========================================================= */

/** Open Item Master Catalog Screen (Section 13) */
async function openItemMasterScreen() {
  const searchInp = document.getElementById('item-master-search-input');
  if (searchInp) searchInp.value = '';
  await renderItemMasterList('');
  showScreen('itemMaster');
}

/** Render Item Master list with search filtering */
async function renderItemMasterList(query) {
  const q = (query || '').toLowerCase().trim();
  const listEl = document.getElementById('item-master-list');
  const countBadge = document.getElementById('catalog-count-badge');
  const updatedBadge = document.getElementById('catalog-updated-badge');

  if (countBadge) {
    countBadge.textContent = cachedItemMaster.length + ' Product' + (cachedItemMaster.length !== 1 ? 's' : '');
  }
  if (updatedBadge) {
    if (itemMasterMetadata && itemMasterMetadata.lastUpdated) {
      updatedBadge.textContent = 'Updated: ' + formatDateForDisplay(itemMasterMetadata.lastUpdated);
    } else {
      updatedBadge.textContent = 'Updated: Never';
    }
  }

  if (!listEl) return;
  listEl.innerHTML = '';

  if (cachedItemMaster.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-icon">📦</div>' +
        '<div class="empty-title">Catalog is Empty</div>' +
        '<div class="empty-sub">Import an Excel (.xlsx) file or load our sample catalog to start creating wholesale orders.</div>' +
        '<div style="margin-top:16px; display:flex; flex-direction:column; gap:10px; width:100%">' +
          '<button type="button" id="btn-empty-load-demo" class="btn-primary-action" style="margin-bottom:0">⚡ Load Demo Catalog (25 Items)</button>' +
          '<button type="button" id="btn-empty-import" class="btn-secondary-action" style="margin-bottom:0">📂 Import My Excel File (.xlsx)</button>' +
        '</div>' +
      '</div>';
    const bDemo = document.getElementById('btn-empty-load-demo');
    if (bDemo) bDemo.addEventListener('click', loadDemoCatalog);
    const bImp = document.getElementById('btn-empty-import');
    if (bImp) bImp.addEventListener('click', function () {
      const fi = document.getElementById('item-master-file-input');
      if (fi) fi.click();
    });
    return;
  }

  const filtered = q
    ? cachedItemMaster.filter(function (it) {
        return (it.itemName || '').toLowerCase().includes(q) || (it.itemId || '').toLowerCase().includes(q);
      })
    : cachedItemMaster;

  if (filtered.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-icon">🔍</div>' +
        '<div class="empty-title">No matching products</div>' +
        '<div class="empty-sub">Try searching with different keywords.</div>' +
      '</div>';
    return;
  }

  filtered.forEach(function (item) {
    const card = document.createElement('div');
    card.className = 'catalog-item-card';
    card.innerHTML =
      '<div class="catalog-item-top">' +
        '<div class="catalog-item-name">' + escapeHtml(item.itemName) + '</div>' +
        (item.itemId ? '<span class="catalog-item-code">' + escapeHtml(item.itemId) + '</span>' : '') +
      '</div>' +
      '<div class="catalog-item-details">' +
        '<span class="catalog-qty-badge">Available: ' + item.availableQuantity + '</span>' +
        '<span class="catalog-rate-badge">&#8377;' + item.rate + '</span>' +
      '</div>';
    listEl.appendChild(card);
  });
}

/** Confirm clear Item Master */
function confirmClearItemMaster() {
  if (cachedItemMaster.length === 0) {
    showToast('Item master is already empty.', 'info');
    return;
  }
  showConfirmModal({
    icon: '⚠️',
    title: 'Clear Item Master?',
    message: 'This will delete all locally stored catalog items. Customer orders will NOT be affected.',
    confirmText: 'Clear Catalog',
    cancelText: 'Cancel',
    confirmClass: 'btn-modal-confirm',
    onConfirm: async function () {
      try {
        await dbClearItemMaster();
        await loadItemMasterCache();
        showToast('Item master catalog cleared.', 'success');
        await renderHome();
        await renderItemMasterList('');
      } catch (err) {
        console.error('Clear catalog error:', err);
        showToast('Failed to clear catalog.', 'error');
      }
    }
  });
}

/** Tolerant Excel column header mapping (Section 14) */
function detectItemMasterColumns(headerRow) {
  const norm = headerRow.map(function (c) {
    return String(c || '').toLowerCase().trim().replace(/[\r\n\t_]+/g, ' ').replace(/\s+/g, ' ');
  });

  const nameAliases = [
    'item name', 'product name', 'item', 'product', 'name',
    'item_name', 'product_name', 'description', 'particulars'
  ];
  const qtyAliases = [
    'quantity', 'qty', 'stock', 'available qty', 'available quantity',
    'avail qty', 'available stock', 'stock qty', 'opening stock', 'units', 'count'
  ];
  const rateAliases = [
    'rate', 'price', 'selling price', 'unit price', 'mrp', 'cost',
    'unit rate', 'item rate', 'amount per unit'
  ];
  const codeAliases = [
    'item code', 'product code', 'code', 'sku', 'item id', 'id', 'product id'
  ];

  let nameIdx = -1, qtyIdx = -1, rateIdx = -1, codeIdx = -1;

  for (let i = 0; i < norm.length; i++) {
    const val = norm[i];
    if (!val) continue;

    if (nameIdx === -1 && nameAliases.includes(val)) {
      nameIdx = i;
    } else if (qtyIdx === -1 && qtyAliases.includes(val)) {
      qtyIdx = i;
    } else if (rateIdx === -1 && rateAliases.includes(val)) {
      rateIdx = i;
    } else if (codeIdx === -1 && codeAliases.includes(val)) {
      codeIdx = i;
    }
  }

  // Tolerant includes check
  if (nameIdx === -1) {
    for (let i = 0; i < norm.length; i++) {
      if (norm[i].includes('name') || norm[i].includes('item') || norm[i].includes('product')) {
        nameIdx = i; break;
      }
    }
  }
  if (qtyIdx === -1) {
    for (let i = 0; i < norm.length; i++) {
      if (norm[i].includes('qty') || norm[i].includes('quantity') || norm[i].includes('stock')) {
        qtyIdx = i; break;
      }
    }
  }
  if (rateIdx === -1) {
    for (let i = 0; i < norm.length; i++) {
      if (norm[i].includes('rate') || norm[i].includes('price') || norm[i].includes('mrp')) {
        rateIdx = i; break;
      }
    }
  }

  return { nameIdx: nameIdx, qtyIdx: qtyIdx, rateIdx: rateIdx, codeIdx: codeIdx };
}

/** File input change handler (Section 1) */
function handleExcelFileSelect(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  // Reset file input so selecting the same file again works
  e.target.value = '';

  if (typeof XLSX === 'undefined') {
    showToast('Excel library not loaded. Please check your setup.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = function (evt) {
    try {
      const data = new Uint8Array(evt.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        showToast('Excel file has no sheets.', 'error');
        return;
      }
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      processExcelItemRows(file.name, rawRows);
    } catch (err) {
      console.error('Excel parse error:', err);
      showToast('Failed to read Excel file. Please ensure it is a valid .xlsx file.', 'error');
    }
  };
  reader.onerror = function () {
    showToast('Could not read selected file.', 'error');
  };
  reader.readAsArrayBuffer(file);
}

/** Process raw rows from Excel (Sections 14, 15) */
function processExcelItemRows(filename, rawRows) {
  if (!rawRows || rawRows.length < 2) {
    showToast('Excel file does not contain enough data rows.', 'warning');
    return;
  }

  // Find header row (check first 6 rows)
  let headerRowIndex = -1;
  let cols = null;

  for (let r = 0; r < Math.min(rawRows.length, 6); r++) {
    const row = rawRows[r];
    if (Array.isArray(row) && row.length > 0) {
      const detected = detectItemMasterColumns(row);
      if (detected.nameIdx !== -1 && detected.qtyIdx !== -1 && detected.rateIdx !== -1) {
        headerRowIndex = r;
        cols = detected;
        break;
      }
    }
  }

  if (headerRowIndex === -1 || !cols) {
    showConfirmModal({
      icon: '✕',
      title: 'Unable to identify required columns.',
      message: 'Please ensure your Excel contains:\nItem Name\nQuantity\nRate',
      confirmText: 'OK',
      cancelText: 'Close'
    });
    return;
  }

  const validItems = [];
  const seenNames = new Map();
  const duplicateNames = [];

  for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || !Array.isArray(row)) continue;

    // Check if completely empty row
    const hasContent = row.some(function (cell) {
      return cell !== null && cell !== undefined && String(cell).trim() !== '';
    });
    if (!hasContent) continue;

    const rawName = String(row[cols.nameIdx] !== undefined ? row[cols.nameIdx] : '').trim();
    if (!rawName) {
      showToast('Row ' + (r + 1) + ': Item Name cannot be blank.', 'error', 4000);
      return;
    }

    const rawQty = row[cols.qtyIdx];
    const qty = parseFloat(rawQty);
    if (isNaN(qty) || !isFinite(qty) || qty < 0) {
      showToast('Row ' + (r + 1) + ' ("' + rawName + '"): Quantity must be a non-negative number.', 'error', 4000);
      return;
    }

    const rawRate = row[cols.rateIdx];
    const rate = parseFloat(rawRate);
    if (isNaN(rate) || !isFinite(rate) || rate < 0) {
      showToast('Row ' + (r + 1) + ' ("' + rawName + '"): Rate must be a non-negative number.', 'error', 4000);
      return;
    }

    const code = cols.codeIdx !== -1 && row[cols.codeIdx] !== undefined && String(row[cols.codeIdx]).trim() !== ''
      ? String(row[cols.codeIdx]).trim()
      : ('P' + String(validItems.length + 1).padStart(3, '0'));

    // Duplicate detection (Section 15)
    const lower = rawName.toLowerCase();
    if (seenNames.has(lower)) {
      if (!duplicateNames.includes(rawName)) {
        duplicateNames.push(rawName);
      }
    } else {
      seenNames.set(lower, true);
    }

    validItems.push({
      itemId: code,
      itemName: rawName,
      availableQuantity: qty,
      rate: rate
    });
  }

  // Duplicate items warning (Section 15)
  if (duplicateNames.length > 0) {
    showConfirmModal({
      icon: '⚠️',
      title: duplicateNames.length + ' duplicate item name' + (duplicateNames.length > 1 ? 's' : '') + ' found.',
      message: 'Found duplicates such as "' + duplicateNames[0] + '".\n\nPlease review your Excel file before importing.',
      confirmText: 'OK',
      cancelText: 'Close'
    });
    return;
  }

  if (validItems.length === 0) {
    showToast('No valid items found to import.', 'warning');
    return;
  }

  // Show Import Preview (Section 2)
  pendingImportData = {
    filename: filename,
    items: validItems
  };

  showImportPreview(filename, validItems);
}

/** Show Import Preview Dialog (Section 2) */
function showImportPreview(filename, items) {
  document.getElementById('preview-file-name').textContent = filename;
  document.getElementById('preview-count-pill').textContent = '✓ ' + items.length + ' item' + (items.length !== 1 ? 's' : '') + ' detected';
  document.getElementById('btn-preview-confirm').textContent = 'Import ' + items.length + ' Items';

  const tbody = document.getElementById('preview-table-body');
  tbody.innerHTML = '';

  const previewCount = Math.min(items.length, 50);
  for (let i = 0; i < previewCount; i++) {
    const item = items[i];
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><strong>' + escapeHtml(item.itemName) + '</strong></td>' +
      '<td style="text-align:right">' + item.availableQuantity + '</td>' +
      '<td style="text-align:right">&#8377;' + item.rate + '</td>';
    tbody.appendChild(tr);
  }

  if (items.length > 50) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td colspan="3" style="text-align:center; color:var(--text-muted); padding:8px">' +
        '… and ' + (items.length - 50) + ' more items' +
      '</td>';
    tbody.appendChild(tr);
  }

  document.getElementById('preview-modal-overlay').classList.add('active');
}

function hideImportPreview() {
  document.getElementById('preview-modal-overlay').classList.remove('active');
}

/** Handle tap on Import [N] Items button (Section 2) */
function handleImportConfirm() {
  if (!pendingImportData) return;

  if (cachedItemMaster.length > 0) {
    // Section 2: If an existing item master exists, clearly ask:
    showConfirmModal({
      icon: '⚠️',
      title: 'Replace existing item master?',
      message: 'The current product list will be replaced by the newly imported Excel data.',
      confirmText: 'Replace',
      cancelText: 'Cancel',
      confirmClass: 'btn-modal-confirm',
      onConfirm: async function () {
        await executeSaveItemMaster();
      }
    });
  } else {
    executeSaveItemMaster();
  }
}

async function executeSaveItemMaster() {
  if (!pendingImportData) return;
  showLoading('Saving Item Master…');
  try {
    const today = getTodayISO();
    const meta = {
      lastUpdated: today,
      itemCount: pendingImportData.items.length,
      filename: pendingImportData.filename
    };
    await dbSaveItemMaster(pendingImportData.items, meta);
    await loadItemMasterCache();

    hideImportPreview();
    showToast('Imported ' + pendingImportData.items.length + ' items successfully!', 'success', 4000);
    pendingImportData = null;

    await renderHome();
    if (screens.itemMaster && screens.itemMaster.classList.contains('active')) {
      await renderItemMasterList('');
    }
  } catch (err) {
    console.error('Import save error:', err);
    showToast('Failed to save imported item master.', 'error');
  } finally {
    hideLoading();
  }
}

/* =========================================================
   20. UTILITY
   ========================================================= */

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

/* =========================================================
   20B. DEMO CATALOG & SAMPLE TEMPLATE
   ========================================================= */

async function loadDemoCatalog() {
  const sampleItems = [
    { itemId: 'AASH-10', itemName: 'Aashirvaad Superior MP Atta 10kg', availableQuantity: 100, rate: 420 },
    { itemId: 'FORT-1L', itemName: 'Fortune Sunlite Refined Sunflower Oil 1L', availableQuantity: 240, rate: 135 },
    { itemId: 'SUGR-5K', itemName: 'Madhur Pure & Hygienic Sugar 5kg', availableQuantity: 80, rate: 230 },
    { itemId: 'RICE-5K', itemName: 'Daawat Rozana Super Basmati Rice 5kg', availableQuantity: 60, rate: 390 },
    { itemId: 'SALT-1K', itemName: 'Tata Salt Vacuum Evaporated 1kg', availableQuantity: 500, rate: 26 },
    { itemId: 'TEA-GLD', itemName: 'Tata Tea Gold 500g', availableQuantity: 150, rate: 310 },
    { itemId: 'TEA-RED', itemName: 'Red Label Natural Care Tea 500g', availableQuantity: 120, rate: 295 },
    { itemId: 'MAGG-24', itemName: 'Maggi 2-Minute Noodles 70g (Pack of 24)', availableQuantity: 75, rate: 312 },
    { itemId: 'PARL-80', itemName: 'Parle-G Glucose Biscuits 800g', availableQuantity: 200, rate: 72 },
    { itemId: 'GOOD-DAY', itemName: 'Britannia Good Day Butter Cookies 600g', availableQuantity: 180, rate: 110 },
    { itemId: 'DAL-TOOR', itemName: 'Toor Dal Desi Polished 1kg', availableQuantity: 150, rate: 165 },
    { itemId: 'DAL-MOON', itemName: 'Moong Dal Yellow Split 1kg', availableQuantity: 120, rate: 140 },
    { itemId: 'DAL-CHAN', itemName: 'Chana Dal Premium 1kg', availableQuantity: 140, rate: 98 },
    { itemId: 'SPIC-HLD', itemName: 'Everest Turmeric Powder 500g', availableQuantity: 90, rate: 145 },
    { itemId: 'SPIC-CHL', itemName: 'Everest Chilli Powder 500g', availableQuantity: 85, rate: 195 },
    { itemId: 'DET-SURF', itemName: 'Surf Excel Easy Wash Detergent Powder 1kg', availableQuantity: 110, rate: 140 },
    { itemId: 'DET-RIN4', itemName: 'Rin Detergent Bar 250g (Pack of 4)', availableQuantity: 160, rate: 76 },
    { itemId: 'SOAP-DET', itemName: 'Dettol Original Bathing Soap 125g (Pack of 3)', availableQuantity: 95, rate: 155 },
    { itemId: 'SOAP-LIF', itemName: 'Lifebuoy Total Soap 125g (Pack of 4)', availableQuantity: 130, rate: 125 },
    { itemId: 'TOOTH-CL', itemName: 'Colgate Strong Teeth Toothpaste 500g', availableQuantity: 140, rate: 215 },
    { itemId: 'DISH-VIM', itemName: 'Vim Lemon Dishwash Bar 300g', availableQuantity: 250, rate: 30 },
    { itemId: 'SAUCE-KS', itemName: 'Kissan Fresh Tomato Ketchup 1kg', availableQuantity: 65, rate: 125 },
    { itemId: 'SNK-BHUJ', itemName: 'Haldiram Bhujia Sev 1kg', availableQuantity: 70, rate: 260 },
    { itemId: 'BUTR-AML', itemName: 'Amul Butter 500g', availableQuantity: 50, rate: 275 },
    { itemId: 'SPIC-PEP', itemName: 'Catch Black Pepper Powder 100g', availableQuantity: 80, rate: 95 }
  ];

  try {
    showLoading('Loading demo wholesale catalog...');
    await dbSaveItemMaster(sampleItems, {
      filename: 'Sample_FMCG_Catalog.xlsx',
      importedAt: new Date().toISOString(),
      itemCount: sampleItems.length,
      columnsUsed: { nameCol: 'Item Name', qtyCol: 'Quantity', rateCol: 'Rate', codeCol: 'Item Code' }
    });
    await loadItemMasterCache();
    await renderHome();
    await renderItemMasterList('');
    hideLoading();
    showToast('Loaded 25 wholesale products into catalog!', 'success', 4000);
  } catch (err) {
    hideLoading();
    console.error('Failed to load demo catalog:', err);
    showToast('Could not load sample catalog.', 'error');
  }
}

function downloadSampleTemplate() {
  if (typeof XLSX === 'undefined') {
    showToast('Excel library not loaded.', 'error');
    return;
  }
  const headers = ['Item Code', 'Item Name', 'Quantity', 'Rate'];
  const sampleData = [
    headers,
    ['AASH-10', 'Aashirvaad Superior MP Atta 10kg', 100, 420],
    ['FORT-1L', 'Fortune Sunlite Refined Sunflower Oil 1L', 240, 135],
    ['SUGR-5K', 'Madhur Pure & Hygienic Sugar 5kg', 80, 230],
    ['RICE-5K', 'Daawat Rozana Super Basmati Rice 5kg', 60, 390],
    ['SALT-1K', 'Tata Salt Vacuum Evaporated 1kg', 500, 26],
    ['TEA-GLD', 'Tata Tea Gold 500g', 150, 310]
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sampleData);
  XLSX.utils.book_append_sheet(wb, ws, 'Items');
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const filename = 'Shop_Items_Template.xlsx';
  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  if (window.AndroidApp && typeof window.AndroidApp.saveOrShareExcel === 'function') {
    try {
      let binary = '';
      const bytes = new Uint8Array(wbout);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = window.btoa(binary);
      window.AndroidApp.saveOrShareExcel(b64, filename, mimeType);
      showToast('Template downloaded & ready to share!', 'success');
      return;
    } catch (e) {
      console.warn('Native download fallback:', e);
    }
  }

  const blob = new Blob([wbout], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    URL.revokeObjectURL(blobUrl);
    if (a.parentNode) document.body.removeChild(a);
  }, 2000);
  showToast('Downloaded Shop_Items_Template.xlsx', 'success');
}

/* =========================================================
   21. WIRE ALL UI EVENTS
   ========================================================= */

function wireEvents() {
  /* ── HOME ── */
  document.getElementById('btn-new-order')    .addEventListener('click', openNewOrderScreen);
  document.getElementById('btn-saved-orders') .addEventListener('click', openSavedOrdersScreen);
  document.getElementById('btn-export')       .addEventListener('click', openExportScreen);

  /* ── ITEM MASTER (HOME & CATALOG) ── */
  const fileInput = document.getElementById('item-master-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', handleExcelFileSelect);
  }
  const btnHomeImport = document.getElementById('btn-home-import-master');
  if (btnHomeImport && fileInput) {
    btnHomeImport.addEventListener('click', function () { fileInput.click(); });
  }
  const btnHomeView = document.getElementById('btn-home-view-master');
  if (btnHomeView) {
    btnHomeView.addEventListener('click', openItemMasterScreen);
  }
  const btnHomeDemo = document.getElementById('btn-home-demo-master');
  if (btnHomeDemo) {
    btnHomeDemo.addEventListener('click', loadDemoCatalog);
  }

  const btnBackFromMaster = document.getElementById('btn-back-from-item-master');
  if (btnBackFromMaster) {
    btnBackFromMaster.addEventListener('click', async function () { await renderHome(); });
  }
  const searchMasterInput = document.getElementById('item-master-search-input');
  if (searchMasterInput) {
    searchMasterInput.addEventListener('input', function (e) { renderItemMasterList(e.target.value); });
  }
  const btnCatalogReimport = document.getElementById('btn-catalog-reimport');
  if (btnCatalogReimport && fileInput) {
    btnCatalogReimport.addEventListener('click', function () { fileInput.click(); });
  }
  const btnCatalogDemo = document.getElementById('btn-catalog-demo');
  if (btnCatalogDemo) {
    btnCatalogDemo.addEventListener('click', loadDemoCatalog);
  }
  const btnCatalogTemplate = document.getElementById('btn-catalog-template');
  if (btnCatalogTemplate) {
    btnCatalogTemplate.addEventListener('click', downloadSampleTemplate);
  }
  const btnClearMaster = document.getElementById('btn-clear-item-master');
  if (btnClearMaster) {
    btnClearMaster.addEventListener('click', confirmClearItemMaster);
  }

  /* ── IMPORT PREVIEW MODAL ── */
  const btnPreviewCancel = document.getElementById('btn-preview-cancel');
  if (btnPreviewCancel) {
    btnPreviewCancel.addEventListener('click', hideImportPreview);
  }
  const btnPreviewCloseX = document.getElementById('btn-preview-close-x');
  if (btnPreviewCloseX) {
    btnPreviewCloseX.addEventListener('click', hideImportPreview);
  }
  const btnPreviewConfirm = document.getElementById('btn-preview-confirm');
  if (btnPreviewConfirm) {
    btnPreviewConfirm.addEventListener('click', handleImportConfirm);
  }

  /* ── NEW / EDIT ORDER ── */
  document.getElementById('btn-back-from-new').addEventListener('click', async function () {
    await renderHome();
  });
  document.getElementById('btn-add-item')   .addEventListener('click', function () { addItemCard(); });
  document.getElementById('save-order-btn') .addEventListener('click', handleSaveOrder);

  /* ── SAVED ORDERS ── */
  document.getElementById('btn-back-from-saved').addEventListener('click', async function () {
    await renderHome();
  });
  document.getElementById('order-search-input').addEventListener('input', function (e) {
    renderSavedOrders(e.target.value);
  });
  document.getElementById('btn-clear-all-data').addEventListener('click', confirmClearAll);

  /* ── VIEW ORDER ── */
  document.getElementById('btn-back-from-view').addEventListener('click', openSavedOrdersScreen);
  document.getElementById('btn-view-edit')     .addEventListener('click', function () {
    openEditOrderScreen(currentViewOrderId);
  });
  document.getElementById('btn-view-delete').addEventListener('click', function () {
    dbGetOrder(currentViewOrderId).then(function (o) {
      if (o) confirmDeleteOrder(o.orderId, o.customerName);
    });
  });

  /* ── EXPORT ── */
  document.getElementById('btn-back-from-export').addEventListener('click', async function () {
    await renderHome();
  });
  document.getElementById('btn-export-all')   .addEventListener('click', exportAllOrders);
  document.getElementById('btn-export-today') .addEventListener('click', exportTodayOrders);
  document.getElementById('btn-export-date')  .addEventListener('click', exportDateOrders);

  /* ── MODAL ── */
  btnModalCancel.addEventListener('click', hideModal);
  modalOverlay.addEventListener('click', function (e) {
    if (e.target === modalOverlay) hideModal();
  });

  /* ── BOTTOM NAVIGATION ── */
  const navBtnHome = document.getElementById('nav-btn-home');
  if (navBtnHome) {
    navBtnHome.addEventListener('click', async function () { await renderHome(); });
  }
  const navBtnOrders = document.getElementById('nav-btn-orders');
  if (navBtnOrders) {
    navBtnOrders.addEventListener('click', openSavedOrdersScreen);
  }
  const navBtnCatalog = document.getElementById('nav-btn-catalog');
  if (navBtnCatalog) {
    navBtnCatalog.addEventListener('click', openItemMasterScreen);
  }
  const navBtnExport = document.getElementById('nav-btn-export');
  if (navBtnExport) {
    navBtnExport.addEventListener('click', openExportScreen);
  }

  /* ── PWA & MOBILE DOWNLOAD / QR EVENTS ── */
  const btnHeaderInstall = document.getElementById('btn-header-install');
  if (btnHeaderInstall) {
    btnHeaderInstall.addEventListener('click', triggerInstallFlow);
  }
  const btnPwaInstall = document.getElementById('btn-pwa-install');
  if (btnPwaInstall) {
    btnPwaInstall.addEventListener('click', triggerInstallFlow);
  }
  const btnPwaQr = document.getElementById('btn-pwa-qr');
  if (btnPwaQr) {
    btnPwaQr.addEventListener('click', showQrModal);
  }
  const btnQrClose = document.getElementById('btn-qr-close');
  if (btnQrClose) {
    btnQrClose.addEventListener('click', hideQrModal);
  }
  const btnQrDone = document.getElementById('btn-qr-done');
  if (btnQrDone) {
    btnQrDone.addEventListener('click', hideQrModal);
  }
  const qrOverlay = document.getElementById('qr-modal-overlay');
  if (qrOverlay) {
    qrOverlay.addEventListener('click', function (e) {
      if (e.target === qrOverlay) hideQrModal();
    });
  }
  const btnCopyQrUrl = document.getElementById('btn-copy-qr-url');
  if (btnCopyQrUrl) {
    btnCopyQrUrl.addEventListener('click', function () {
      const input = document.getElementById('qr-url-input');
      if (input && input.value) {
        navigator.clipboard.writeText(input.value).then(function () {
          showToast('App URL copied to clipboard!', 'success');
        }).catch(function () {
          input.select();
          document.execCommand('copy');
          showToast('App URL copied to clipboard!', 'success');
        });
      }
    });
  }
  const btnCopyQrPw = document.getElementById('btn-copy-qr-pw');
  if (btnCopyQrPw) {
    btnCopyQrPw.addEventListener('click', function () {
      if (networkInfo.tunnelPassword) {
        navigator.clipboard.writeText(networkInfo.tunnelPassword).then(function () {
          showToast('Tunnel IP copied: ' + networkInfo.tunnelPassword, 'success');
        }).catch(function () {
          showToast('IP: ' + networkInfo.tunnelPassword, 'info');
        });
      }
    });
  }

  /* ── IOS GUIDE MODAL EVENTS ── */
  const btnIosGuideClose = document.getElementById('btn-ios-guide-close');
  if (btnIosGuideClose) {
    btnIosGuideClose.addEventListener('click', hideIOSGuideModal);
  }
  const btnIosDone = document.getElementById('btn-ios-done');
  if (btnIosDone) {
    btnIosDone.addEventListener('click', hideIOSGuideModal);
  }
  const iosOverlay = document.getElementById('ios-guide-modal-overlay');
  if (iosOverlay) {
    iosOverlay.addEventListener('click', function (e) {
      if (e.target === iosOverlay) hideIOSGuideModal();
    });
  }
}

/* =========================================================
   22. PWA & MOBILE APP ENGINE
   ========================================================= */

let deferredInstallPrompt = null;

function isRunningStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    document.referrer.includes('android-app://')
  );
}

function isIOS() {
  return /ipad|iphone|ipod/.test(navigator.userAgent.toLowerCase()) && !window.MSStream;
}

function initPWA() {
  // 1. Register Service Worker for 100% offline capability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(function (reg) {
        console.log('[PWA] ServiceWorker registered with scope:', reg.scope);
      })
      .catch(function (err) {
        console.warn('[PWA] ServiceWorker registration failed:', err);
      });
  }

  // 2. Check if already installed
  updateInstallUI();

  // 3. Capture beforeinstallprompt (Android Chrome / Chromium)
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateInstallUI();
    console.log('[PWA] Captured beforeinstallprompt event');
  });

  // 4. App installed callback
  window.addEventListener('appinstalled', function () {
    deferredInstallPrompt = null;
    updateInstallUI();
    showToast('ANIRUDH AGENCY Mobile App installed successfully! 🎉', 'success', 5000);
  });
}

function updateInstallUI() {
  const btnInstall = document.getElementById('btn-pwa-install');
  const pwaDesc = document.getElementById('pwa-card-desc');
  const pwaBadge = document.getElementById('pwa-status-badge');
  const headerInstallText = document.getElementById('btn-header-install-text');

  if (isRunningStandalone()) {
    if (pwaBadge) {
      pwaBadge.textContent = 'Installed';
      pwaBadge.style.background = 'rgba(82, 183, 136, 0.4)';
      pwaBadge.style.color = '#FFFFFF';
    }
    if (pwaDesc) {
      pwaDesc.textContent = 'Running offline in standalone mobile app mode';
    }
    if (btnInstall) {
      btnInstall.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span>App Installed</span>';
      btnInstall.disabled = true;
      btnInstall.style.opacity = '0.75';
      btnInstall.style.cursor = 'default';
    }
    if (headerInstallText) headerInstallText.textContent = 'Installed';
  } else if (deferredInstallPrompt) {
    if (pwaBadge) pwaBadge.textContent = '1-Tap Ready';
    if (pwaDesc) pwaDesc.textContent = 'Install directly onto your Android phone';
  } else if (isIOS()) {
    if (pwaBadge) pwaBadge.textContent = 'iOS Ready';
    if (pwaDesc) pwaDesc.textContent = 'Add to iPhone / iPad home screen';
  }
}

async function triggerInstallFlow() {
  if (isRunningStandalone()) {
    showToast('App is already installed and running standalone!', 'info');
    return;
  }

  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      console.log('[PWA] User choice:', choice.outcome);
      if (choice.outcome === 'accepted') {
        showToast('Installing ANIRUDH AGENCY App…', 'info');
      }
      deferredInstallPrompt = null;
      updateInstallUI();
    } catch (err) {
      console.warn('Install prompt error:', err);
      showQrModal();
    }
  } else if (isIOS()) {
    showIOSGuideModal();
  } else {
    showQrModal();
  }
}

/* Network info — updated live from server API */
let networkInfo = {
  url: null,            // Best URL (public tunnel if available, else LAN)
  lan: null,            // LAN URL (same Wi-Fi)
  publicUrl: null,      // Public tunnel URL (any network)
  tunnelPassword: null, // Host public IP required by localtunnel on first mobile visit
  tunnelReady: false
};

async function fetchNetworkInfo() {
  try {
    const res = await fetch('/api/network-ip');
    if (res.ok) {
      const data = await res.json();
      networkInfo.url            = data.url   || networkInfo.url;
      networkInfo.lan            = data.lan   || networkInfo.lan;
      networkInfo.publicUrl      = data.public || null;
      networkInfo.tunnelPassword = data.tunnelPassword || null;
      networkInfo.tunnelReady    = !!data.tunnelReady;
    }
  } catch (e) { /* offline / non-server environment */ }
}

/* Poll for tunnel URL for up to 60s after startup */
function startTunnelPolling() {
  let attempts = 0;
  const MAX = 30;
  const poll = setInterval(async () => {
    attempts++;
    const prev = networkInfo.publicUrl;
    await fetchNetworkInfo();

    // If tunnel just became ready and QR modal is open — refresh it
    if (networkInfo.publicUrl && networkInfo.publicUrl !== prev) {
      const overlay = document.getElementById('qr-modal-overlay');
      if (overlay && overlay.classList.contains('active')) {
        renderQrCode(networkInfo.publicUrl);
        showToast('✅ Public URL ready — anyone can now scan this QR!', 'success', 5000);
      }
      clearInterval(poll);
    }

    if (attempts >= MAX) clearInterval(poll);
  }, 2000);
}

/* ── QR CODE MODAL ── */
function renderQrCode(url) {
  const container = document.getElementById('qr-code-canvas-container');
  const urlInput  = document.getElementById('qr-url-input');
  const qrNote    = document.getElementById('qr-network-note');
  const pwRow     = document.getElementById('qr-password-row');
  const pwVal     = document.getElementById('qr-password-val');

  if (!container || !urlInput) return;

  urlInput.value = url;

  container.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(container, {
      text: url,
      width: 200,
      height: 200,
      colorDark: '#0B2B1E',
      colorLight: '#FFFFFF',
      correctLevel: QRCode.CorrectLevel.M
    });
  } else {
    container.innerHTML = '<p style="font-size:12px;word-break:break-all;color:#555">' + escapeHtml(url) + '</p>';
  }

  // Update the note under QR
  if (qrNote) {
    const isPublic = url.includes('trycloudflare.com') || url.includes('loca.lt') || url.includes('ngrok') || url.startsWith('https://');
    qrNote.textContent = isPublic
      ? '🌐 Works on ANY device — mobile data or any Wi-Fi!'
      : '📶 Works on same Wi-Fi only. Public tunnel starting…';
    qrNote.style.color = isPublic ? '#1b4332' : '#92400e';
    qrNote.style.background = isPublic ? '#d8f3dc' : '#fef3c7';
  }

  // Localtunnel IP password row helper
  if (pwRow && pwVal) {
    if (networkInfo.tunnelPassword && (url.includes('loca.lt') || url.includes('ngrok'))) {
      pwVal.textContent = networkInfo.tunnelPassword;
      pwRow.style.display = 'flex';
    } else {
      pwRow.style.display = 'none';
    }
  }
}

async function showQrModal() {
  const overlay = document.getElementById('qr-modal-overlay');
  if (overlay) overlay.classList.add('active');

  // Fetch latest network info in case tunnel or IP password arrived
  try {
    await fetchNetworkInfo();
  } catch (e) {}

  // Pick best URL: public > LAN > current page
  const bestUrl =
    networkInfo.publicUrl ||
    networkInfo.url ||
    networkInfo.lan ||
    window.location.href.split('#')[0];

  renderQrCode(bestUrl);

  // If tunnel not yet ready, show loading hint
  if (!networkInfo.tunnelReady && !networkInfo.publicUrl) {
    const qrNote = document.getElementById('qr-network-note');
    if (qrNote) {
      qrNote.textContent = '⏳ Getting public URL… (LAN shown for now)';
      qrNote.style.color = '#92400e';
      qrNote.style.background = '#fef3c7';
    }
  }
}

function hideQrModal() {
  const overlay = document.getElementById('qr-modal-overlay');
  if (overlay) overlay.classList.remove('active');
}

/* ── IOS GUIDE MODAL ── */
function showIOSGuideModal() {
  const overlay = document.getElementById('ios-guide-modal-overlay');
  if (overlay) overlay.classList.add('active');
}

function hideIOSGuideModal() {
  const overlay = document.getElementById('ios-guide-modal-overlay');
  if (overlay) overlay.classList.remove('active');
}

/* ── BACK BUTTON & POPSTATE HANDLING (MOBILE NATIVE FEEL) ── */
function setupMobileHistory() {
  window.addEventListener('popstate', function (e) {
    if (modalOverlay && modalOverlay.classList.contains('active')) {
      hideModal();
      return;
    }
    const previewModal = document.getElementById('preview-modal-overlay');
    if (previewModal && previewModal.classList.contains('active')) {
      hideImportPreview();
      return;
    }
    const qrModal = document.getElementById('qr-modal-overlay');
    if (qrModal && qrModal.classList.contains('active')) {
      hideQrModal();
      return;
    }
    const iosModal = document.getElementById('ios-guide-modal-overlay');
    if (iosModal && iosModal.classList.contains('active')) {
      hideIOSGuideModal();
      return;
    }

    if (e.state && e.state.screen) {
      showScreen(e.state.screen, false);
    } else {
      showScreen('home', false);
    }
  });
}

/* =========================================================
   23. APP INITIALISATION
   ========================================================= */

async function initApp() {
  showLoading('Starting ANIRUDH AGENCY…');
  try {
    await initDB();
    await loadItemMasterCache();
    wireEvents();
    initPWA();
    setupMobileHistory();
    fetchNetworkInfo();        // Initial fetch
    startTunnelPolling();      // Keep polling until public tunnel URL is ready


    // Check deep-link hash navigation (e.g. from PWA shortcuts)
    const hash = (window.location.hash || '').replace('#', '');
    if (hash === 'new-order') {
      await openNewOrderScreen();
    } else if (hash === 'saved-orders') {
      await openSavedOrdersScreen();
    } else if (hash === 'item-master') {
      await openItemMasterScreen();
    } else if (hash === 'export') {
      openExportScreen();
    } else {
      await renderHome();
    }
  } catch (err) {
    console.error('Initialisation error:', err);
    document.body.innerHTML =
      '<div style="padding:32px;text-align:center;font-family:sans-serif;max-width:480px;margin:0 auto">' +
        '<div style="font-size:48px;margin-bottom:16px">⚠️</div>' +
        '<h2 style="color:#DC2626;margin-bottom:12px">Failed to start ANIRUDH AGENCY</h2>' +
        '<p style="color:#475569;margin-bottom:16px">Could not open local database.<br>' +
        'Please close other tabs using this app and refresh the page.</p>' +
        '<p style="font-size:12px;color:#94A3B8">' + (err.message || String(err)) + '</p>' +
        '<button onclick="location.reload()" style="margin-top:20px;padding:12px 24px;background:#2563EB;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer">Retry</button>' +
      '</div>';
  } finally {
    hideLoading();
  }
}

document.addEventListener('DOMContentLoaded', initApp);


