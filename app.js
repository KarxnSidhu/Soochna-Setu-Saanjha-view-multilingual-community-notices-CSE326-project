"use strict";

// Find elements in the HTML by their CSS selectors.
function getElement(selector) {
  return document.querySelector(selector);
}

function getElements(selector) {
  return [...document.querySelectorAll(selector)];
}

// 2. VARIABLES AND APPLICATION STATE
const STORAGE_KEY = "saajha-preferences-v2";
const LANGUAGES = { en: "English", hi: "हिन्दी", pa: "ਪੰਜਾਬੀ" };

function freshData() {
  return {
    notices: [],
    categories: [],
    saved: [],
    language: "en",
    largeText: false,
    logs: []
  };
}
let state = loadState();
let session = null;
let csrfToken = "";
let serverToday = "";
let page = "board";
let adminTab = "notices";
let selectedCategory = "all";
let visibleLimit = 6;
let toastTimeout;
let dialogReturnFocus;
let currentDetailId = null;

// 3. LOCAL STORAGE FUNCTIONS
function loadState() {
  const initial = freshData();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    initial.saved = Array.isArray(saved.saved) ? saved.saved.filter(id => typeof id === 'string') : [];
    initial.language = ['en','hi','pa'].includes(saved.language) ? saved.language : 'en';
    initial.largeText = saved.largeText === true;
  } catch { /* Default preferences when storage is unavailable. */ }
  return initial;
}

function persist() {
  try {
    const { saved, language, largeText } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({saved, language, largeText}));
  } catch { toast('Browser preferences could not be saved. Notice data remains in the database.'); }
}

function dateAfter(days) {
    const date = new Date((serverToday || new Date().toLocaleDateString('en-CA')) + 'T12:00:00');
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
}

async function api(path, method='GET', body) {
  const response = await fetch('/api' + path, {
    method, headers: {'Content-Type':'application/json', 'X-CSRF-Token':csrfToken},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The request failed. Please retry.');
  return value;
}

async function refreshData() {
  const [data, categories] = await Promise.all([
    api(session ? '/workspace' : '/notices'), api('/categories')
  ]);
  state.notices = data.notices;
  state.categories = categories.categories;
  state.logs = data.logs || [];
}

async function mutate(path, method, body, message) {
  try {
    await api(path, method, body);
    await refreshData();
    closeDialog(); render(); toast(message);
    return true;
  } catch(error) { toast(error.message); return false; }
}

function escapeHTML(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}
function translateText(key) {
  return words[state.language][key] || words.en[key] || key;
}
function findNotice(id) {
  return state.notices.find((notice) => notice.id === id);
}
function findCategory(id) {
  return state.categories.find((item) => item.id === id);
}
function categoryName(item) {
  if (!item) return "Other";
  return item[state.language] || item.name;
}
function isExpired(notice) {
  return notice.expiry < dateAfter(0) || notice.status === "archived";
}
function isScheduled(notice) {
  return notice.published > dateAfter(0);
}
function isPublic(notice) {
  return notice.status === "published" && !isScheduled(notice);
}
function actualStatus(notice) {
  if (notice.status === "draft" || notice.status === "withdrawn") return notice.status;
  if (isExpired(notice)) return "expired";
  if (isScheduled(notice) && notice.status === "published") return "scheduled";
  return notice.status;
}
function approvedTranslation(notice, lang = state.language) {
  const translated = notice.translations[lang];
  return translated &&
    translated.status === "completed" &&
    translated.version === notice.version
    ? translated
    : null;
};
function displayedText(notice) {
  return approvedTranslation(notice) || notice;
}
function dateLabel(value) {
  return new Intl.DateTimeFormat(
    state.language === "en" ? "en-IN" : `${state.language}-IN`,
    { day: "numeric", month: "short", year: "numeric" },
  ).format(new Date(`${value}T12:00:00`));
}

function timestamp(value) {
  return new Date(value).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function canManage() {
  return session !== null && session.role === "admin";
}

function canReview() {
  return session !== null && (session.role === "admin" || session.role === "reviewer");
}



function toast(message) {
  clearTimeout(toastTimeout);
  getElement("#toast").textContent = message;
  getElement("#toast").hidden = false;
  toastTimeout = setTimeout(() => {
    getElement("#toast").hidden = true;
  }, 4500);
}

function openDialog(title, content, kicker = "SOOCHNASETU · COMMUNITY NOTICEBOARD") {
  dialogReturnFocus = document.activeElement;
  getElement("#dialog-kicker").textContent = kicker;
  getElement("#dialog-content").innerHTML =
    `<h2 id="dialog-title" class="dialog-title">${escapeHTML(title)}</h2>${content}`;
  if (!getElement("#app-dialog").open) getElement("#app-dialog").showModal();
  document.body.classList.add("body-locked");
}

function closeDialog() {
  getElement("#app-dialog").close();
}

function applyLanguage() {
  document.documentElement.lang = state.language;
  document.title = `Saajha · ${translateText("communityNotices")}`;
  getElement("#language").value = state.language;
  getElements("[data-i18n]").forEach((element) => {
    element.textContent = translateText(element.dataset.i18n);
  });
  getElements("[data-placeholder]").forEach((element) => {
    element.placeholder = translateText(element.dataset.placeholder);
  });
  getElement("#text-size").setAttribute(
    "aria-pressed",
    String(Boolean(state.largeText)),
  );
  document.documentElement.classList.toggle(
    "large-text",
    Boolean(state.largeText),
  );
}

// 5. NOTICE RENDERING AND PAGE NAVIGATION
function route() {
  const hash = location.hash.slice(1) || "board";
  if (hash === "about") {
    render();
    showAbout();
    return;
  }
  if (hash.startsWith("notice/")) {
    let id;
    try {
      id = decodeURIComponent(hash.slice(7));
    } catch (error) {
      location.hash = "board";
      return toast("That notice link is invalid.");
    }
    const notice = findNotice(id);
    if (notice && (isPublic(notice) || notice.status === "archived")) {
      page = isExpired(notice) ? "archive" : "board";
      render();
      showDetail(id);
    } else {
      toast("This notice is not available on the public board.");
      location.hash = "board";
    }
    return;
  }
  currentDetailId = null;
  if (getElement("#app-dialog").open) closeDialog();
  if (hash === "admin" && !session) {
    page = "board";
    render();
    showLogin();
    return;
  }
  page = ["board", "saved", "archive", "admin"].includes(hash)
    ? hash
    : "board";
  getElement("#status-filter").value = page === "archive" ? "expired" : page === "saved" ? "all" : "active";
  selectedCategory = "all";
  visibleLimit = 6;
  render();
}

function render() {
  getElement("#saved-count").textContent = state.saved.length;
  const adminVisible = page === "admin" && session;
  getElement("#public-view").hidden = Boolean(adminVisible);
  getElement("#admin-view").hidden = !adminVisible;
  getElements(".main-nav a").forEach((link) => {
    const active = !adminVisible && link.dataset.page === page;
    link.classList.toggle("active", active);
    active
      ? link.setAttribute("aria-current", "page")
      : link.removeAttribute("aria-current");
  });
  if (adminVisible) renderAdmin();
  else renderBoard();
}

function baseNotices() {
  if (page === "archive")
    return state.notices.filter(
      (notice) =>
        (isPublic(notice) || notice.status === "archived") &&
        isExpired(notice),
    );
  if (page === "saved")
    return state.notices.filter(
      (notice) =>
        state.saved.includes(notice.id) &&
        (isPublic(notice) || notice.status === "archived"),
    );
  return state.notices.filter(
    (notice) => (isPublic(notice) || notice.status === "archived") &&
      (getElement("#status-filter").value === "all" ||
       isExpired(notice) === (getElement("#status-filter").value === "expired")),
  );
}

function renderBoard() {
  const notices = baseNotices();
  let heading = "communityNotices";
  let description = "boardDescription";

  if (page === "saved") {
    heading = "savedTitle";
    description = "savedDescription";
  } else if (page === "archive") {
    heading = "archiveTitle";
    description = "archiveDescription";
  }

  getElement("#board-title").textContent = translateText(heading);
  getElement("#board-description").textContent = translateText(description);
  getElement("#notice-total").textContent = `${notices.length} ${translateText("notices")}`;

  renderCategories(notices);
  renderLocations(notices);
  renderUrgentBanner(notices);
  renderCards();
}

function renderCategories(notices) {
  const allSelected = selectedCategory === "all";
  let html = `
    <button class="category-button ${allSelected ? "active" : ""}"
            data-category="all" aria-pressed="${allSelected}">
      <span class="category-icon" aria-hidden="true">▦</span>
      ${escapeHTML(translateText("allNotices"))}
      <span class="count">${notices.length}</span>
    </button>
  `;

  for (const item of state.categories) {
    const selected = selectedCategory === item.id;
    const count = notices.filter(function (notice) {
      return notice.category === item.id;
    }).length;

    html += `
      <button class="category-button ${selected ? "active" : ""}"
              data-category="${escapeHTML(item.id)}" aria-pressed="${selected}">
        <span class="category-icon" aria-hidden="true">${escapeHTML(item.icon)}</span>
        ${escapeHTML(categoryName(item))}
        <span class="count">${count}</span>
      </button>
    `;
  }

  getElement("#categories").innerHTML = html;
}

function renderLocations(notices) {
  const locationSelect = getElement("#location");
  const previouslySelected = locationSelect.value;
  const locations = [...new Set(notices.map(function (notice) {
    return notice.location;
  }))].sort();

  let html = `<option value="all">${escapeHTML(translateText("allLocations"))}</option>`;
  for (const location of locations) {
    html += `<option value="${escapeHTML(location)}">${escapeHTML(location)}</option>`;
  }
  locationSelect.innerHTML = html;
  locationSelect.value = locations.includes(previouslySelected) ? previouslySelected : "all";
}

function renderUrgentBanner(notices) {
  const banner = getElement("#urgent-banner");
  const urgentNotice = page === "board"
    ? notices.find(function (notice) { return notice.urgent && !isExpired(notice); })
    : null;

  banner.hidden = !urgentNotice;
  if (!urgentNotice) return;

  const noticeLanguage = approvedTranslation(urgentNotice) ? state.language : urgentNotice.original_language;
  banner.innerHTML = `
    <span class="urgent-label">△ ${escapeHTML(translateText("urgent"))}</span>
    <span class="urgent-title" lang="${noticeLanguage}">
      ${escapeHTML(displayedText(urgentNotice).title)} · ${escapeHTML(urgentNotice.location)}
    </span>
    <button class="text-button" data-open="${escapeHTML(urgentNotice.id)}">
      ${escapeHTML(translateText("viewDetails"))}
    </button>
  `;
}

// 6. SEARCH AND CATEGORY FILTERING
function filterNotices() {
  const searchInput = getElement("#search");
  const searchText = searchInput.value.trim().toLocaleLowerCase();
  const selectedLocation = getElement("#location").value;
  const selectedDays = getElement("#date-filter").value;
  const earliestDate = selectedDays === "all" ? null : dateAfter(-Number(selectedDays));
  const results = [];

  for (const notice of baseNotices()) {
    if (selectedCategory !== "all" && notice.category !== selectedCategory) continue;
    if (selectedLocation !== "all" && notice.location !== selectedLocation) continue;
    if (earliestDate && notice.published < earliestDate) continue;
    const priority = getElement('#priority-filter').value;
    if (priority !== 'all' && priority !== (notice.urgent ? 'urgent' : notice.critical ? 'critical' : 'normal')) continue;
    const language = getElement('#language-filter').value;
    if (language !== 'all' && notice.original_language !== language && !approvedTranslation(notice, language)) continue;
    const expiry = getElement('#status-filter').value;
    if (expiry !== 'all' && isExpired(notice) !== (expiry === 'expired')) continue;

    // Search the original notice and translations already approved on this noticeboard.
    let searchableText = [
      notice.title,
      notice.body,
      notice.location,
      notice.issuer,
      categoryName(findCategory(notice.category)),
      notice.original_language, LANGUAGES[notice.original_language],
      ({en:"English",hi:"Hindi",pa:"Punjabi"})[notice.original_language]
    ].join(" ");

    for (const [code, translation] of Object.entries(notice.translations)) {
      if (translation.status === "completed" && translation.version === notice.version) {
        searchableText += " " + translation.title + " " + translation.body + " " + LANGUAGES[code] + " " + ({en:"English",hi:"Hindi",pa:"Punjabi"})[code];
      }
    }

    if (searchText && !searchableText.toLocaleLowerCase().includes(searchText)) continue;
    results.push(notice);
  }

  return results;
}

// 7. SORTING AND EXPIRED NOTICES
function sortNotices(notices) {
  const sortMode = getElement("#sort").value;

  notices.sort(function (first, second) {
    if (first.highlighted !== second.highlighted) return Number(second.highlighted) - Number(first.highlighted);
    if (sortMode === "oldest") {
      return first.published.localeCompare(second.published);
    }
    if (sortMode === "expiry") {
      return first.expiry.localeCompare(second.expiry);
    }
    if (sortMode === "priority") {
      // Urgent notices first; critical notices next; newest breaks a tie.
      const firstScore = Number(first.urgent) * 2 + Number(first.critical);
      const secondScore = Number(second.urgent) * 2 + Number(second.critical);
      if (firstScore !== secondScore) return secondScore - firstScore;
    }
    return second.published.localeCompare(first.published);
  });

  return notices;
}

function translationLabel(notice) {
  if (state.language === (notice.original_language || "en")) {
    return `<span class="translation-status">◎ ${escapeHTML(translateText("original"))} · ${escapeHTML(LANGUAGES[notice.original_language])}</span>`;
  }

  if (approvedTranslation(notice)) {
    return `<span class="translation-status approved">✓ ${escapeHTML(translateText("approved"))}</span>`;
  }

  const hasDraft = notice.translations[state.language]?.status === "pending";
  const label = hasDraft ? "awaiting" : "unavailable";
  return `<span class="translation-status pending">◷ ${escapeHTML(translateText(label))}</span>`;
}

function bookmarkIcon(saved) {
  return `<svg width="16" height="18" viewBox="0 0 16 18" fill="${saved ? "currentColor" : "none"}" aria-hidden="true"><path d="M4 2h8a1 1 0 0 1 1 1v13l-5-3-5 3V3a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
}

function renderCards() {
  const notices = sortNotices(filterNotices());
  const noticeGrid = getElement("#notice-grid");

  getElement("#result-announcement").textContent =
    `${notices.length} ${translateText("notices")}`;

  if (notices.length === 0) {
    const help = page === "saved" ? "noSavedHelp" : "noResultsHelp";
    noticeGrid.innerHTML = `
      <div class="empty-state">
        <span aria-hidden="true">⌕</span>
        <h3>${escapeHTML(translateText("noResults"))}</h3>
        <p>${escapeHTML(translateText(help))}</p>
        <button class="button button-outline" data-clear>
          ${escapeHTML(translateText("clearFilters"))}
        </button>
      </div>
    `;
  } else {
    const visibleNotices = notices.slice(0, visibleLimit);
    noticeGrid.innerHTML = visibleNotices.map(createNoticeCard).join("");
  }

  getElement("#load-more").hidden = notices.length <= visibleLimit;
}

function createNoticeCard(notice) {
  const noticeCategory = findCategory(notice.category);
  const text = displayedText(notice);
  const isSaved = state.saved.includes(notice.id);
  const language = approvedTranslation(notice) ? state.language : (notice.original_language || "en");

  let statusTag = "";
  if (isExpired(notice)) {
    statusTag = `<span class="urgency-tag expired">${escapeHTML(translateText("expired"))}</span>`;
  } else if (notice.urgent) {
    statusTag = `<span class="urgency-tag">△ ${escapeHTML(translateText("urgent"))}</span>`;
  }

  return `
    <article class="notice-card ${isExpired(notice) ? "is-expired" : notice.urgent ? "is-urgent" : ""} ${notice.highlighted ? "is-pinned" : ""}">
      <div class="card-top">
        <span class="category-chip ${escapeHTML(noticeCategory ? noticeCategory.id : "")}">
          <span aria-hidden="true">${escapeHTML(noticeCategory ? noticeCategory.icon : "▤")}</span>
          ${escapeHTML(categoryName(noticeCategory))}
        </span>
        <div>
          ${notice.highlighted ? '<span class="pin-label">Pinned</span>' : ""} ${statusTag}
          <button class="icon-button ${isSaved ? "saved" : ""}"
                  data-save="${escapeHTML(notice.id)}"
                  aria-label="${escapeHTML(translateText(isSaved ? "unsave" : "save"))}"
                  aria-pressed="${isSaved}">
            ${bookmarkIcon(isSaved)}
          </button>
        </div>
      </div>
      <h3 class="card-title" lang="${language}">
        <button data-open="${escapeHTML(notice.id)}">${escapeHTML(text.title)}</button>
      </h3>
      <p class="card-summary" lang="${language}">${escapeHTML(text.body)}</p>
      <div class="card-meta">
        <span>◷ <time datetime="${escapeHTML(notice.published)}">${escapeHTML(dateLabel(notice.published))}</time></span>
        <span>⌾ ${escapeHTML(notice.location)}</span>
      </div>
      <p class="expiry-line ${!isExpired(notice) && notice.expiry <= dateAfter(3) ? 'expiry-soon' : ''}">
        ${isExpired(notice) ? 'Expired' : notice.expiry <= dateAfter(3) ? 'Expires soon' : 'Expires'} · ${escapeHTML(dateLabel(notice.expiry))}
      </p><div class="card-bottom">
        ${translationLabel(notice)}
        <button class="text-button" data-open="${escapeHTML(notice.id)}">
          ${escapeHTML(translateText("readNotice"))}
        </button>
      </div>
    </article>
  `;
}

function clearFilters() {
  selectedCategory = "all";
  getElement("#search").value = "";
  getElement("#location").value = "all";
  getElement("#date-filter").value = "all";
  getElement("#sort").value = "newest";
  ["priority", "language", "status"].forEach(name => getElement(`#${name}-filter`).value = "all");
  getElement("#status-filter").value = page === "archive" ? "expired" : page === "saved" ? "all" : "active";
  visibleLimit = 6;
  renderBoard();
}

// 8. SAVED NOTICES
// Saved notice IDs are stored in state.saved and displayed by baseNotices().

// 9. NOTICE DETAILS
function showDetail(id, preview = null) {
  const notice = preview || findNotice(id);
  if (!notice) return;

  if (!preview && !isPublic(notice) && notice.status !== "archived" && !session) {
    toast("This notice is not public.");
    return;
  }

  currentDetailId = preview ? null : id;
  const translation = approvedTranslation(notice);
  const text = translation || notice;
  const language = translation ? state.language : (notice.original_language || "en");

  let translationMessage = "";
  if (state.language === (notice.original_language || "en")) {
    translationMessage = `
      <div class="detail-translation">
        ◎ ${escapeHTML(translateText("original"))} · ${escapeHTML(LANGUAGES[notice.original_language])}
      </div>
    `;
  } else if (translation) {
    translationMessage = `
      <div class="detail-translation">
        ✓ ${escapeHTML(translateText("demoApproval"))}
        <small>${escapeHTML(translation.reviewer)} · ${escapeHTML(timestamp(translation.reviewedAt))}</small>
      </div>
    `;
  } else {
    const message = notice.translations[state.language] ? "fallback" : "translationMissing";
    translationMessage = `<div class="warning-panel">${escapeHTML(translateText(message))}</div>`;
  }

  let actionButtons = "";
  if (!preview) {
    actionButtons = `
      <div class="detail-actions">
        <button class="button button-primary" data-save="${escapeHTML(notice.id)}">
          ${escapeHTML(translateText(state.saved.includes(notice.id) ? "unsave" : "save"))}
        </button>
        <button class="button button-outline" data-share="${escapeHTML(notice.id)}">
          ${escapeHTML(translateText("share"))}
        </button>
        <button class="button button-outline" data-print>${escapeHTML(translateText("print"))}</button>
      </div>
    `;
  }

  const content = `
    ${preview ? '<div class="warning-panel">PREVIEW ONLY · This has not been saved or published.</div>' : ""}
    ${isExpired(notice) ? `<div class="warning-panel">${escapeHTML(translateText("expired"))} · ${escapeHTML(dateLabel(notice.expiry))}</div>` : ""}
    <span class="category-chip ${escapeHTML(notice.category)}">
      ${escapeHTML(categoryName(findCategory(notice.category)))}
    </span>
    <dl class="detail-meta">
      <div><dt>${escapeHTML(translateText("issuer"))}</dt><dd>${escapeHTML(notice.issuer)}</dd></div>
      <div><dt>${escapeHTML(translateText("location"))}</dt><dd>${escapeHTML(notice.location)}</dd></div>
      <div><dt>${escapeHTML(translateText("published"))}</dt><dd>${escapeHTML(dateLabel(notice.published))}</dd></div>
      <div><dt>${escapeHTML(translateText("expires"))}</dt><dd>${escapeHTML(dateLabel(notice.expiry))}</dd></div>
    </dl>
    ${translationMessage}
    <div lang="${language}">
      <p class="detail-content">${escapeHTML(text.body)}</p>
      <div class="action-box">
        <strong>${escapeHTML(translateText("requiredAction"))}</strong>
        ${escapeHTML(text.action || translateText("noAction"))}
      </div>
    </div>
    <details class="original-section">
      <summary>${escapeHTML(translateText("viewOriginal"))}</summary>
      <div lang="${notice.original_language || "en"}">
        <h3>${escapeHTML(notice.title)}</h3>
        <p class="detail-content">${escapeHTML(notice.body)}</p>
        <div class="action-box">
          <strong>${escapeHTML(translateText("englishAction"))}</strong>
          ${escapeHTML(notice.action || translateText("noAction"))}
        </div>
      </div>
    </details>
    ${actionButtons}
  `;

  openDialog(text.title, content);
  getElement("#dialog-title").lang = language;
}

function showAbout() {
  currentDetailId = null;
  openDialog('Information that brings us together.', `<div class="prose">
    <p>Saajha / Soochna Setu is a community noticeboard in English, Hindi and Punjabi.</p>
    <h3>Every language version has a source.</h3><p>Translations are entered manually. Pending or unavailable versions fall back to the original. Only completed, reviewed versions appear publicly. Editing a source requires a fresh review.</p>
    <h3>Clear dates. Shared information.</h3><p>Published notices and translations are stored in SQLite. Expiry is calculated daily using India Standard Time. Archived and expired notices remain clearly marked for reference.</p>
    <h3>Made to be accessible.</h3><p>Use A+ for larger text, / to search, and Escape to close a dialog. Bookmarks and reading preferences stay in your browser. Publisher and reviewer accounts are managed by the project administrator.</p>
    <p>Optional sample notices are fictional. Translations still need a competent language reviewer; no automated translation service is connected.</p></div>`);
}

function showLogin() {
  currentDetailId = null;
  openDialog('Welcome to your community workspace.', `<p>Sign in to publish notices or review language versions.</p>
    <form id="login-form" class="form-grid">
      <label class="full-width">Username<input name="username" autocomplete="username" required maxlength="80"></label>
      <label class="full-width">Password<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
      <p id="login-error" class="form-error full-width" role="alert" hidden></p>
      <button class="button button-primary" type="submit">Sign in</button>
    </form>`, 'PUBLISHER & REVIEWER ACCESS');
}

async function enterWorkspace(form) {
  try {
    const result = await api('/login', 'POST', Object.fromEntries(new FormData(form)));
    csrfToken = result.csrf;
    session = {role:result.user.role, name:result.user.username};
    await refreshData();
    adminTab = session.role === 'reviewer' ? 'reviews' : 'notices';
    closeDialog(); page = 'admin'; location.hash = 'admin'; render();
  } catch(error) {
    getElement('#login-error').hidden = false;
    getElement('#login-error').textContent = error.message;
  }
}

function pendingReviews() {
  return state.notices.flatMap((notice) =>
    Object.keys(LANGUAGES).filter(lang => lang !== notice.original_language).map(lang =>
      [lang, notice.translations[lang] || {status:"unavailable", version:notice.version}])
      .filter(
        ([, version]) =>
          version.status !== "completed" || version.version !== notice.version,
      )
      .map(([lang, version]) => ({ notice, lang, version })),
  );
}

// 10. ADMIN DASHBOARD
function renderAdmin() {
  if (!session) return;

  getElement("#admin-view").lang = "en";
  getElement("#session-label").textContent = `${session.name} · signed-in workspace`;
  getElement("#create-notice").hidden = !canManage();

  for (const button of getElements("[data-admin-tab]")) {
    const administratorOnly = ["notices", "categories"].includes(button.dataset.adminTab);
    button.hidden = administratorOnly && !canManage();
    button.classList.toggle("active", adminTab === button.dataset.adminTab);
    button.setAttribute("aria-pressed", String(adminTab === button.dataset.adminTab));
  }

  const reviews = pendingReviews();
  getElement("#review-count").textContent = `(${reviews.length})`;

  const statistics = [
    [state.notices.filter(function (notice) {
      return isPublic(notice) && !isExpired(notice);
    }).length, "Current notices"],
    [reviews.length, "Translations to review"],
    [state.notices.filter(function (notice) {
      return notice.status === "draft";
    }).length, "Draft notices"],
    [state.notices.filter(isExpired).length, "Archived / expired"]
  ];

  getElement("#admin-stats").innerHTML = statistics.map(function (statistic) {
    return `
      <div class="stat-card">
        <strong>${statistic[0]}</strong>
        <span>${statistic[1]}</span>
      </div>
    `;
  }).join("");

  if (adminTab === "reviews") {
    renderReviewDashboard(reviews);
  } else if (adminTab === "history") {
    renderActivityLog();
  } else if (adminTab === "categories" && canManage()) {
    renderCategoryManager();
  } else if (canManage()) {
    renderAdminNoticeTable();
  }
}

function createReviewRow(notice, language, status, buttonLabel) {
  return `
    <article class="review-card">
      <div>
        <h3>${escapeHTML(notice.title)}</h3>
        <p>${escapeHTML(LANGUAGES[language])} · ${escapeHTML(status)} · source v${notice.version}</p>
      </div>
      <button class="button button-outline" data-review="${escapeHTML(notice.id)}" data-lang="${language}">
        ${buttonLabel}
      </button>
    </article>
  `;
}

function renderReviewDashboard(reviews) {
  let html = `
    <div class="info-panel">
      No live translator is configured. Language versions are manually editable
      versions. Completed versions are stored in the database.
    </div>
  `;

  if (reviews.length === 0) {
    html += '<div class="empty-state"><h3>All caught up.</h3><p>No translations need review right now.</p></div>';
  } else {
    for (const review of reviews) {
      html += createReviewRow(review.notice, review.lang,
        review.version.status.replaceAll("-", " "), "Review ↗");
    }
  }

  // Approved demo versions can be reopened and edited again.
  let approvedHtml = "";
  for (const notice of state.notices) {
    for (const language of Object.keys(LANGUAGES).filter(lang => lang !== notice.original_language)) {
      if (approvedTranslation(notice, language)) {
        approvedHtml += createReviewRow(notice, language, "completed", "Reopen");
      }
    }
  }
  if (approvedHtml) {
    html += '<h3 class="review-list-heading">Previously approved on this noticeboard</h3>' + approvedHtml;
  }

  getElement("#admin-content").innerHTML = html;
}

function renderActivityLog() {
  const adminContent = getElement("#admin-content");
  if (state.logs.length === 0) {
    adminContent.innerHTML = `
      <div class="empty-state">
        <h3>A fresh start.</h3>
        <p>Publishing and translation activity will appear here.</p>
      </div>
    `;
    return;
  }

  let html = '<ul class="activity-list">';
  for (const entry of state.logs) {
    const note = entry.note ? ` · ${escapeHTML(entry.note)}` : "";
    html += `
      <li>
        <time datetime="${escapeHTML(entry.at)}">${escapeHTML(timestamp(entry.at))}</time>
        <div>
          <strong>${escapeHTML(entry.action)}</strong> ${escapeHTML(entry.notice)}
          <small>${escapeHTML(entry.actor)}${note}</small>
        </div>
      </li>
    `;
  }
  adminContent.innerHTML = html + "</ul>";
}

function renderCategoryManager() {
  let categoryHtml = "";
  for (const item of state.categories) {
    categoryHtml += `<span>${escapeHTML(item.icon)} ${escapeHTML(item.name)}</span>`;
  }

  getElement("#admin-content").innerHTML = `
    <div class="info-panel">
      Add a category for new notices. Custom names remain in the language you enter.
    </div>
    <div class="category-manager">${categoryHtml}</div>
    <form id="category-form" class="category-form">
      <label class="sr-only" for="category-name">New category name</label>
      <input id="category-name" class="field-input" name="name" required
             maxlength="40" placeholder="e.g. Transport">
      <button class="button button-primary" type="submit">Add category</button>
    </form>
  `;
}

function createAdminTableRow(notice) {
  const status = actualStatus(notice);
  const languageStatuses = Object.keys(LANGUAGES).filter(lang => lang !== notice.original_language).map(function (language) {
    const translation = notice.translations[language];
    const label = translation ? translation.status : "not added";
    return `${language.toUpperCase()}: ${escapeHTML(label)}`;
  }).join("<br>");

  const publishButton = notice.status !== "published" || isExpired(notice)
    ? `<button data-publish="${escapeHTML(notice.id)}">Publish</button>`
    : `<button data-withdraw="${escapeHTML(notice.id)}">Withdraw</button>`;
  const archiveButton = notice.status !== "published"
    ? ""
    : `<button data-archive="${escapeHTML(notice.id)}">Archive</button>`;

  return `
    <tr>
      <td>
        <strong>${escapeHTML(notice.title)}</strong>
        <small>
          ${escapeHTML(notice.issuer)}
          <br>${escapeHTML(notice.location)} · expires ${escapeHTML(dateLabel(notice.expiry))}
        </small>
      </td>
      <td>
        <span class="status-pill ${escapeHTML(status)}">${escapeHTML(status)}</span>
        ${notice.critical ? '<small>Critical · approval required for translations</small>' : ""}
      </td>
      <td>${escapeHTML(notice.original_language.toUpperCase())} source<small>${languageStatuses}</small></td>
      <td>
        <div class="row-actions">
          <button data-admin-preview="${escapeHTML(notice.id)}">Preview</button>
          <button data-edit="${escapeHTML(notice.id)}">Edit</button>
          <button data-drafts="${escapeHTML(notice.id)}">Translations</button>
          ${publishButton}
          ${archiveButton}
          <button data-delete="${escapeHTML(notice.id)}">Delete</button>
        </div>
      </td>
    </tr>
  `;
}

function renderAdminNoticeTable() {
  const rows = state.notices.map(createAdminTableRow).join("");
  getElement("#admin-content").innerHTML = `
    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th scope="col">Notice</th>
            <th scope="col">Status</th>
            <th scope="col">Languages</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// 11. CREATE AND EDIT NOTICES
function formMarkup(notice = {}) {
  const categoryOptions = state.categories.map(function (item) {
    const selected = item.id === notice.category ? "selected" : "";
    return `<option value="${escapeHTML(item.id)}" ${selected}>${escapeHTML(item.name)}</option>`;
  }).join("");

  return `
    <form id="notice-form" class="form-grid" data-editing="${escapeHTML(notice.id || "")}" data-version="${notice.version || 1}">
      <p class="form-hint full-width">
        Choose the language of the original notice.
        Fields marked * are required.
      </p>
      <div id="form-error" class="form-error full-width" role="alert" hidden></div>

      <label>Original language *
        <select name="original_language">${Object.entries(LANGUAGES).map(([code, name]) => `<option value="${code}" ${code === (notice.original_language || 'en') ? 'selected' : ''}>${name}</option>`).join('')}</select>
      </label><label class="checkbox-field"><input type="checkbox" name="highlighted" ${notice.highlighted ? 'checked' : ''}>Pin this notice at the top</label>
      <label class="full-width">Notice title *
        <input name="title" required maxlength="160" value="${escapeHTML(notice.title || "")}" placeholder="What should your neighbours know?">
      </label>
      <label class="full-width">Notice content *
        <textarea name="body" required maxlength="12000" rows="6" placeholder="Start with the important details. Keep it clear and simple.">${escapeHTML(notice.body || "")}</textarea>
      </label>
      <label>Category *
        <select name="category" required>${categoryOptions}</select>
      </label>
      <label>Issuing organisation *
        <input name="issuer" required maxlength="100" value="${escapeHTML(notice.issuer || "")}" placeholder="e.g. Sample Residents Association">
      </label>
      <label class="full-width">Affected location *
        <input name="location" required maxlength="100" value="${escapeHTML(notice.location || "")}" placeholder="e.g. Blocks A & B">
      </label>
      <label>Publication date *
        <input name="published" type="date" required value="${escapeHTML(notice.published || dateAfter(0))}">
      </label>
      <label>Expiry date *
        <input name="expiry" type="date" required value="${escapeHTML(notice.expiry || dateAfter(7))}">
      </label>
      <label class="full-width">Action residents should take *
        <textarea name="action" required maxlength="2000" rows="2" placeholder="Use a clear action, or write 'No action required'.">${escapeHTML(notice.action || "")}</textarea>
      </label>
      <label class="checkbox-field full-width">
        <input type="checkbox" name="urgent" ${notice.urgent ? "checked" : ""}>
        Mark as urgent
      </label>
      <label class="checkbox-field full-width">
        <input type="checkbox" name="critical" ${notice.critical ? "checked" : ""}>
        Critical information: safety, health, legal matters, payments, emergencies or deadlines.
        These translations must be reviewed before publication.
      </label>
      <p class="form-hint full-width">
        All translations require explicit review before public display.
        Changing the original source or dates flags translations for re-review.
      </p>
      <div class="detail-actions full-width">
        <button type="submit" class="button button-primary">${notice.id ? "Save changes" : "Save as draft"}</button>
        <button type="button" class="button button-outline" id="preview-form">Preview</button>
        <button type="button" class="button button-outline" data-cancel>Cancel</button>
      </div>
    </form>
  `;
}

function showNoticeForm(id) {
  if (!canManage())
    return toast("Only the administrator can manage notices.");
  const notice = id ? findNotice(id) : null;
  currentDetailId = null;
  openDialog(
    notice
      ? "A small update can make a big difference."
      : "Something your community should know?",
    formMarkup(notice || {}),
    "NOTICE EDITOR · ORIGINAL SOURCE",
  );
  getElement("#notice-form").lang = "en";
}

function readNoticeForm(form) {
  const values = new FormData(form);
  return {
    original_language: values.get("original_language"),
    highlighted: values.has("highlighted"),
    title: String(values.get("title")).trim(),
    body: String(values.get("body")).trim(),
    action: String(values.get("action")).trim(),
    issuer: String(values.get("issuer")).trim(),
    location: String(values.get("location")).trim(),
    category: values.get("category"),
    published: values.get("published"),
    expiry: values.get("expiry"),
    urgent: values.has("urgent"),
    critical:
      values.has("critical") ||
      ["health", "safety"].includes(values.get("category")),
  };
}

function validateNotice(notice) {
  if (
    ["title", "body", "issuer", "location", "action"].some(
      (key) => !notice[key],
    )
  )
    return "Please complete every required field. Spaces alone do not count.";
  if (
    notice.title.length > 160 ||
    notice.body.length > 12000 ||
    notice.action.length > 2000 ||
    notice.issuer.length > 100 ||
    notice.location.length > 100
  )
    return "One of the fields exceeds its length limit.";
  if (!findCategory(notice.category))
    return "Please choose an existing category.";
  if (
    ![notice.published, notice.expiry].every(
      (value) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(`${value}T12:00:00`)),
    )
  )
    return "Enter valid publication and expiry dates.";
  if (notice.expiry < notice.published)
    return "Expiry must be on or after the publication date.";
  return null;
}

async function saveNotice(form) {
  if (!canManage()) return;
  const values = readNoticeForm(form);
  const error = validateNotice(values);
  if (error) { getElement('#form-error').textContent=error; getElement('#form-error').hidden=false; return; }
  const id = form.dataset.editing;
  await mutate('/notices' + (id ? '/' + id : ''), id ? 'PUT' : 'POST',
    {...values, version:Number(form.dataset.version)}, 'Saved to the database. Add translations or publish when ready.');
}

function showDraftOptions(id) {
  if (!canReview()) return;

  const notice = findNotice(id);
  if (!notice) return;

  let languageButtons = "";
  for (const language of Object.keys(LANGUAGES).filter(lang => lang !== notice.original_language)) {
    const existingTranslation = notice.translations[language];
    const explanation = existingTranslation
      ? `${escapeHTML(existingTranslation.status)} · open translation`
      : "Add a manual draft";

    languageButtons += `
      <button class="role-card" data-review="${escapeHTML(id)}" data-lang="${language}">
        <strong>${escapeHTML(LANGUAGES[language])}</strong>
        <small>${explanation}</small>
      </button>
    `;
  }

  const content = `
    <div class="warning-panel">
      <strong>Live translation is not configured.</strong>
      There is no API request, machine translation or invented result.
      You can add a translation manually; it stays unpublished until approved on this noticeboard.
    </div>
    <h3>${escapeHTML(notice.title)}</h3>
    <div class="role-cards">${languageButtons}</div>

  `;

  openDialog("Give this notice another voice.", content, "MANUAL TRANSLATION VERSIONS");
}

function showReview(id, language) {
  if (!canReview() || !Object.hasOwn(LANGUAGES, language)) return;

  const notice = findNotice(id);
  if (!notice) return;

  const translation = notice.translations[language] || {
    title: "",
    body: "",
    action: "",
    status: "pending"
  };

  currentDetailId = null;
  const content = `
    <div class="warning-panel">
      <strong>Review the translation against its source.</strong>
      Compare names, dates, times, amounts, locations and instructions.
      Approval makes this version visible in the noticeboard.
    </div>
    <div class="review-columns">
      <section class="review-source" lang="${notice.original_language}">
        <h3>Original · ${escapeHTML(LANGUAGES[notice.original_language])} · v${notice.version}</h3>
        <strong>${escapeHTML(notice.title)}</strong>
        <p>${escapeHTML(notice.body)}</p>
        <strong>Action required</strong>
        <p>${escapeHTML(notice.action)}</p>
        <small>
          ${escapeHTML(notice.issuer)} · ${escapeHTML(notice.location)}
          ${escapeHTML(notice.published)} → ${escapeHTML(notice.expiry)}
        </small>
      </section>
      <form id="review-form" class="form-grid" data-notice="${escapeHTML(id)}" data-lang="${language}" data-version="${notice.version}">
        <div class="info-panel">
          ${escapeHTML(LANGUAGES[language])} · ${escapeHTML(translation.status.replaceAll("-", " "))}
        </div>
        <label>Translated title *
          <input name="title" lang="${language}" value="${escapeHTML(translation.title)}" required maxlength="200">
        </label>
        <label>Translated content *
          <textarea name="body" lang="${language}" required maxlength="16000" rows="8">${escapeHTML(translation.body)}</textarea>
        </label>
        <label>Translated action *
          <textarea name="action" lang="${language}" required maxlength="3000" rows="3">${escapeHTML(translation.action || "")}</textarea>
        </label>
        <label class="checkbox-field">
          <input type="checkbox" id="review-check" name="checked">
          I have compared names, dates, times, locations, quantities and instructions
          with the current source. I confirm this version is ready for readers.
        </label>
        <div id="review-error" class="form-error" role="alert" hidden></div>
        <div class="detail-actions">
          <button class="button button-primary" type="submit" name="decision" value="approve">Complete translation</button>
          <button class="button button-outline" type="submit" name="decision" value="save" formnovalidate>Save pending</button>
          <button class="button button-danger" type="button" data-reject="${escapeHTML(id)}" data-lang="${language}">Mark unavailable</button>
        </div>
      </form>
    </div>
  `;

  openDialog("A careful review makes all the difference.", content,
    `TRANSLATION REVIEW · ${LANGUAGES[language]}`);
}

async function saveReview(form, decision) {
  if (!canReview()) return;
  const values = Object.fromEntries(new FormData(form));
  await mutate('/notices/' + form.dataset.notice + '/translations/' + form.dataset.lang, 'PUT', {
    title:values.title, body:values.body, action:values.action,
    checked:values.checked === 'on', version:Number(form.dataset.version),
    status:decision === 'approve' ? 'completed' : 'pending'
  }, decision === 'approve' ? 'Translation completed and available to readers.' : 'Translation saved as pending.');
}

async function updateNoticeStatus(id, status) {
  if (canManage()) await mutate('/notices/' + id + '/status', 'PATCH', {status}, 'Notice ' + status + '.');
}

function showDelete(id) {
  if (!canManage()) return;
  const notice = findNotice(id);
  if (!notice) return;
  openDialog(
    "Remove this sample notice?",
    `<p>${escapeHTML(notice.title)}</p><p>This removes the notice, its stored language versions. The activity log keeps a record. This cannot be undone.</p><div class="detail-actions"><button class="button button-danger" data-confirm-delete="${escapeHTML(id)}">Delete notice</button><button class="button button-outline" data-cancel>Keep notice</button></div>`,
  );
}

function toggleSave(id) {
  if (!findNotice(id)) return;
  const saved = state.saved.includes(id);
  state.saved = saved
    ? state.saved.filter((item) => item !== id)
    : [...state.saved, id];
  persist();
  render();
  if (getElement("#app-dialog").open && currentDetailId === id) {
    const button = getElement("#dialog-content [data-save]");
    if (button) button.textContent = translateText(saved ? "save" : "unsave");
  }
  toast(translateText(saved ? "removedToast" : "savedToast"));
}

async function shareNotice(id) {
  const url = new URL(location.href);
  url.hash = `notice/${encodeURIComponent(id)}`;
  try {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(url.href);
    toast(
      "Notice link copied. Anyone who can access this server can open published notices.",
    );
  } catch (error) {
    openDialog(
      "Copy this notice link.",
      `<p>Clipboard access is unavailable. Select and copy the link below. Only published notices can be viewed without signing in.</p><label class="field-label">Notice link<input class="field-input" id="copy-link" readonly value="${escapeHTML(url.href)}"></label>`,
    );
    getElement("#copy-link").select();
  }
}

// 13. EXPORT NOTICES
// Download the current notice data as a JSON file for backup or demonstration.
function exportNotices() {
  const exportData = {
    exportedAt: new Date().toISOString(),
    project: "Saajha – Community Notice Board",
    categories: state.categories,
    notices: state.notices,
    activity: state.logs,
  };
  const file = new Blob([JSON.stringify(exportData, null, 2)], {
    type: "application/json",
  });
  const fileUrl = URL.createObjectURL(file);
  const downloadLink = document.createElement("a");
  downloadLink.href = fileUrl;
  downloadLink.download = "saajha-notices.json";
  document.body.append(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  URL.revokeObjectURL(fileUrl);
  toast("Notice data exported as JSON.");
}

// 14. EVENT LISTENERS
// Event delegation keeps the code small without inline onclick handlers.
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const data = button.dataset;
  if (data.open) return showDetail(data.open);
  if (data.save) return toggleSave(data.save);
  if (data.share) return void shareNotice(data.share);
  if ("print" in data) return window.print();
  if (button.id === "export-notices") return exportNotices();
  if ("clear" in data) return clearFilters();
  if ("cancel" in data) return closeDialog();
  if (data.category) {
    selectedCategory = data.category;
    visibleLimit = 6;
    return renderBoard();
  }
  if (data.adminTab) {
    adminTab = data.adminTab;
    return renderAdmin();
  }
  if (data.edit) return showNoticeForm(data.edit);
  if (data.adminPreview) return showDetail(data.adminPreview);
  if (data.drafts) return showDraftOptions(data.drafts);
  if (data.review) return showReview(data.review, data.lang);
  if (data.publish) return updateNoticeStatus(data.publish, "published");
  if (data.withdraw) return updateNoticeStatus(data.withdraw, "withdrawn");
  if (data.archive) return updateNoticeStatus(data.archive, "archived");
  if (data.delete) return showDelete(data.delete);
  if (data.confirmDelete && canManage()) return mutate('/notices/' + data.confirmDelete, 'DELETE', undefined, 'Notice deleted.');
  if (data.reject && canReview()) {
    const form=getElement('#review-form');
    return mutate('/notices/' + data.reject + '/translations/' + data.lang, 'PUT', {
      status:'unavailable', version:Number(form.dataset.version), title:'', body:'', action:''
    }, 'Translation marked unavailable. Readers see the original.');
  }
  if (button.id === "preview-form") {
    const form = getElement("#notice-form");
    if (!form.reportValidity()) return;
    const values = readNoticeForm(form);
    const error = validateNotice(values);
    if (error) return toast(error);
    const existing = findNotice(form.dataset.editing);
    const preview = {
      ...values,
      id: existing?.id || "preview",
      status: "draft",
      version: existing?.version || 1,
      translations: {},
    };
    const previewText = `<article lang="${values.original_language}"><h3>${escapeHTML(preview.title)}</h3><div class="detail-meta">${escapeHTML(preview.issuer)} · ${escapeHTML(preview.location)} · ${escapeHTML(preview.published)} → ${escapeHTML(preview.expiry)}</div><p class="detail-content">${escapeHTML(preview.body)}</p><div class="action-box"><strong>Action required</strong>${escapeHTML(preview.action)}</div></article>`;
    // Keep the editor mounted so unsaved input survives a preview.
    let panel = getElement("#inline-preview");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "inline-preview";
      panel.className = "info-panel full-width";
      panel.setAttribute("aria-label", "Unsaved notice preview");
      form.append(panel);
    }
    panel.innerHTML = `<div class="eyebrow">UNSAVED PREVIEW</div>${previewText}`;
    panel.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "login-form") { event.preventDefault(); return enterWorkspace(event.target); }
  if (event.target.id === "notice-form") {
    event.preventDefault();
    return saveNotice(event.target);
  }
  if (event.target.id === "review-form") {
    event.preventDefault();
    return saveReview(event.target, event.submitter?.value || "save");
  }
  if (event.target.id === "category-form") {
    event.preventDefault();
    if (!canManage()) return;
    const name = getElement("#category-name").value.trim();
    if (!name || name.length > 40)
      return toast("Use a category name between 1 and 40 characters.");
    if (
      state.categories.some(
        (item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      return toast("That category already exists.");
    return mutate('/categories', 'POST', {name}, 'Category added.');
  }
});

getElement("#search").addEventListener("input", () => {
  visibleLimit = 6;
  renderCards();
});
["#sort", "#location", "#date-filter", "#priority-filter", "#language-filter", "#status-filter"].forEach((selector) =>
  getElement(selector).addEventListener("change", () => {
    visibleLimit = 6;
    renderBoard();
  }),
);
getElement("#clear-filters").addEventListener("click", clearFilters);
getElement("#load-more").addEventListener("click", () => {
  visibleLimit += 6;
  renderCards();
});
getElement("#language").addEventListener("change", (event) => {
  state.language = event.target.value;
  persist();
  applyLanguage();
  render();
});
getElement("#text-size").addEventListener("click", () => {
  state.largeText = !state.largeText;
  persist();
  applyLanguage();
});
getElement("#admin-entry").addEventListener("click", () => {
  if (session) {
    page = "admin";
    location.hash = "admin";
    render();
  } else showLogin();
});
getElement('#logout').addEventListener('click', async () => {
  try {
    const result=await api('/logout','POST'); csrfToken=result.csrf; session=null;
    await refreshData(); page='board'; location.hash='board'; render(); toast('Signed out.');
  } catch(error) { toast(error.message); }
});
getElement("#create-notice").addEventListener("click", () => showNoticeForm());
getElement("#how-translations-work").addEventListener("click", showAbout);
getElement("#close-dialog").addEventListener("click", closeDialog);
getElement("#app-dialog").addEventListener("click", (event) => {
  if (event.target === getElement("#app-dialog")) {
    const rect = event.target.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      closeDialog();
  }
});
getElement("#app-dialog").addEventListener("close", () => {
  document.body.classList.remove("body-locked");
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  // Do not strand navigation on a modal-only route after it closes.
  if (location.hash === "#about" || location.hash.startsWith("#notice/"))
    history.replaceState(null, "", `#${page === "admin" ? "admin" : page}`);
});
getElement('#reset-demo').addEventListener('click', () => {
  state.saved=[]; state.language='en'; state.largeText=false;
  persist(); applyLanguage(); clearFilters(); render(); toast('Reading preferences and bookmarks reset.');
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) &&
    !getElement("#app-dialog").open &&
    page !== "admin"
  ) {
    event.preventDefault();
    getElement("#search").focus();
  }
});
window.addEventListener("hashchange", route);
// Refresh shared records without interrupting an editor.
setInterval(async () => {
  if (getElement('#app-dialog').open || getElement('#search').matches(':focus')) return;
  try {
    const result = await api('/session');
    serverToday = result.today; csrfToken = result.csrf;
    session = result.user ? {role:result.user.role, name:result.user.username} : null;
    await refreshData(); render();
  } catch { /* Keep loaded notices during temporary connection failures. */ }
}, 60000);

async function initialise() {
  applyLanguage();
  getElement('#notice-grid').innerHTML='<p role="status">Loading community notices…</p>';
  try {
    const result=await api('/session'); csrfToken=result.csrf; serverToday=result.today;
    session=result.user ? {role:result.user.role,name:result.user.username} : null;
    if(session?.role === 'reviewer') adminTab='reviews';
    await refreshData(); route();
  } catch(error) {
    getElement('#notice-grid').innerHTML='<div class="empty-state"><h3>Unable to load notices</h3><p>Check that the Flask server is running, then reload this page.</p></div>';
    toast(error.message);
  }
}
initialise();
