/* ============================================================
   イジンデン一人回し - app.js
   デッキ構築＆ソロプレイ卓上アシスタント
   ============================================================ */

const CARDS = window.IJINDEN_CARDS || [];
const CARDS_BY_ID = {};
CARDS.forEach(c => { CARDS_BY_ID[c.id] = c; });

const COLOR_HEX = { '赤': '#b6423a', '青': '#2f8fd6', '緑': '#4a7f4f', '黄': '#c99a2e', '紫': '#5c3d8a', '無': '#7d8394' };
const BASE_COLORS = ['赤', '青', '緑', '黄', '紫', '無'];
const PHASE_LABEL = { start: 'スタート', draw: 'ドロー', main: 'メイン', end: 'エンド' };

const UNLIMITED_RE = /デッキに何枚でも入れてよい/;

/* ---------------- Rule-text keyword highlighting ---------------- */
const OFFICIAL_KEYWORDS = [
  '即応', 'ダブルプレッシャー', 'トリプルプレッシャー', 'クアドラプルプレッシャー', 'スタンド',
  '反魂', 'モータル', '喪神', 'ウォッチャー', '木霊', '冥府発動', '魔力化', '復元', '装備', '冥装'
];
function extractCustomKeywords(cards) {
  const set = new Set();
  const re = /(?:^|\n)([^\s\n]{2,10}?)\s?[-‐]\s/g;
  cards.forEach(c => {
    const text = c.rule_text || '';
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const token = m[1];
      if (/^[ぁ-んァ-ヶ一-龠ー]+$/.test(token)) set.add(token);
    }
  });
  return set;
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const KEYWORDS_ALL = new Set([...OFFICIAL_KEYWORDS, ...extractCustomKeywords(CARDS)]);
const KEYWORD_REGEX = new RegExp(
  ['(?:パワー|アタック|ブロック)\\+\\d+', ...[...KEYWORDS_ALL].sort((a, b) => b.length - a.length).map(escapeRegExp)].join('|'),
  'g'
);

function renderRuleTextNode(text) {
  const frag = document.createDocumentFragment();
  let lastIndex = 0;
  KEYWORD_REGEX.lastIndex = 0;
  let m;
  while ((m = KEYWORD_REGEX.exec(text)) !== null) {
    if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
    const strong = document.createElement('strong');
    strong.textContent = m[0];
    frag.appendChild(strong);
    lastIndex = m.index + m[0].length;
    if (m[0].length === 0) KEYWORD_REGEX.lastIndex++;
  }
  if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
  return frag;
}

/* ---------------- Legacy ability (遺業能力) formatting ----------------
   Strips explanatory parentheticals like "（戦場から墓地に置かれたときに発動できる）"
   and any leading "遺業能力：" label, leaving just "遺業能力:キーワード" or
   "遺業能力:効果の要約". Returns null if there is no legacy ability. */
function formatLegacyAbility(raw) {
  if (!raw) return null;
  let t = raw.trim();
  if (t === '-' || t === '') return null;
  t = t.replace(/^遺業能力[:：]\s*/, '');
  t = t.replace(/[（(][^）)]*[）)]/g, '');
  t = t.replace(/\s+/g, '').trim();
  if (!t) return null;
  return `遺業能力:${t}`;
}

/* ---------------- Local storage helpers ---------------- */
function loadDecks() {
  try { return JSON.parse(localStorage.getItem('ijinden_decks_v1') || '{}'); }
  catch (e) { return {}; }
}
function saveDecks(obj) {
  localStorage.setItem('ijinden_decks_v1', JSON.stringify(obj));
}

/* ---------------- Global state ---------------- */
const state = {
  filters: {
    search: '',
    types: new Set(['イジン', 'マホウ', 'ハイケイ', 'マリョク']),
    colors: new Set(),
    sets: new Set(),
    rarities: new Set(),
    levelMin: null,
    levelMax: null
  },
  sort: 'set_asc',
  draft: {},        // cardId -> count (deck being built)
  decks: loadDecks() // name -> {cards:{cardId:count}}
};

let GAME = null;      // solo-play game state
let uidCounter = 1;
let activeMenuInstance = null;

/* ============================================================
   TAB SWITCHING
   ============================================================ */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('is-active');
    if (btn.dataset.tab === 'solo') refreshSoloDeckSelect();
  });
});

/* ============================================================
   DECK BUILDER: FILTER UI SETUP
   ============================================================ */
function setUpChipGroup(containerEl, values, targetSet, labelFn, colorFn) {
  containerEl.innerHTML = '';
  values.forEach(v => {
    const b = document.createElement('button');
    b.className = 'chip-toggle';
    b.textContent = labelFn ? labelFn(v) : v;
    if (colorFn) b.style.borderColor = colorFn(v);
    b.dataset.val = v;
    b.addEventListener('click', () => {
      if (targetSet.has(v)) { targetSet.delete(v); b.classList.remove('is-active'); }
      else { targetSet.add(v); b.classList.add('is-active'); }
      renderCardGrid();
    });
    containerEl.appendChild(b);
  });
}

function initFilterUI() {
  // type chips already in HTML; wire them
  document.querySelectorAll('#fType .chip-toggle').forEach(b => {
    b.addEventListener('click', () => {
      const v = b.dataset.val;
      if (state.filters.types.has(v)) { state.filters.types.delete(v); b.classList.remove('is-active'); }
      else { state.filters.types.add(v); b.classList.add('is-active'); }
      renderCardGrid();
    });
  });

  setUpChipGroup(document.getElementById('fColor'), BASE_COLORS, state.filters.colors, c => c, c => COLOR_HEX[c]);

  const sets = [...new Set(CARDS.map(c => c.set))];
  const setOrder = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  sets.sort((a, b) => setOrder.indexOf(a) - setOrder.indexOf(b));
  setUpChipGroup(document.getElementById('fSet'), sets, state.filters.sets, s => s);

  const rarities = [...new Set(CARDS.map(c => c.rarity || 'ー'))];
  setUpChipGroup(document.getElementById('fRarity'), rarities, state.filters.rarities, r => r);

  document.getElementById('fSearch').addEventListener('input', e => {
    state.filters.search = e.target.value.trim();
    renderCardGrid();
  });
  document.getElementById('fLevelMin').addEventListener('input', e => {
    state.filters.levelMin = e.target.value === '' ? null : Number(e.target.value);
    renderCardGrid();
  });
  document.getElementById('fLevelMax').addEventListener('input', e => {
    state.filters.levelMax = e.target.value === '' ? null : Number(e.target.value);
    renderCardGrid();
  });
  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sort = e.target.value;
    renderCardGrid();
  });
  document.getElementById('btnResetFilters').addEventListener('click', () => {
    state.filters.search = '';
    state.filters.colors.clear();
    state.filters.sets.clear();
    state.filters.rarities.clear();
    state.filters.levelMin = null;
    state.filters.levelMax = null;
    document.getElementById('fSearch').value = '';
    document.getElementById('fLevelMin').value = '';
    document.getElementById('fLevelMax').value = '';
    document.querySelectorAll('#fColor .chip-toggle, #fSet .chip-toggle, #fRarity .chip-toggle')
      .forEach(b => b.classList.remove('is-active'));
    renderCardGrid();
  });
}

/* ============================================================
   DECK BUILDER: FILTER / SORT LOGIC
   ============================================================ */
function matchesSearch(card, q) {
  if (!q) return true;
  const hay = [card.name, card.rule_text, card.legacy_ability, card.trait].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

function filterCards() {
  const f = state.filters;
  return CARDS.filter(c => {
    if (f.types.size > 0 && !f.types.has(c.type)) return false;
    if (f.colors.size > 0) {
      let ok = false;
      f.colors.forEach(col => {
        if (col === '無') { if (c.color === '無') ok = true; }
        else if (c.color && c.color.includes(col)) ok = true;
      });
      if (!ok) return false;
    }
    if (f.sets.size > 0 && !f.sets.has(c.set)) return false;
    if (f.rarities.size > 0 && !f.rarities.has(c.rarity || 'ー')) return false;
    if (f.levelMin !== null && c.level < f.levelMin) return false;
    if (f.levelMax !== null && c.level > f.levelMax) return false;
    if (!matchesSearch(c, f.search)) return false;
    return true;
  });
}

function sortCards(list) {
  const setOrder = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  const arr = list.slice();
  const bySetAsc = (a, b) => {
    const si = setOrder.indexOf(a.set) - setOrder.indexOf(b.set);
    if (si !== 0) return si;
    return Number(a.no) - Number(b.no) || String(a.no).localeCompare(String(b.no));
  };
  switch (state.sort) {
    case 'set_desc':
      arr.sort((a, b) => -bySetAsc(a, b)); break;
    case 'level_asc':
      arr.sort((a, b) => (a.level || 0) - (b.level || 0)); break;
    case 'level_desc':
      arr.sort((a, b) => (b.level || 0) - (a.level || 0)); break;
    case 'power_asc':
      arr.sort((a, b) => (typeof a.power === 'number' ? a.power : -1) - (typeof b.power === 'number' ? b.power : -1)); break;
    case 'power_desc':
      arr.sort((a, b) => (typeof b.power === 'number' ? b.power : -1) - (typeof a.power === 'number' ? a.power : -1)); break;
    case 'set_asc':
    default:
      arr.sort(bySetAsc);
  }
  return arr;
}

/* ============================================================
   DECK BUILDER: RENDERING CARD GRID
   ============================================================ */
function cardPrimaryColorHex(card) {
  const colorStr = card.color || '無';
  for (const ch of colorStr) { if (COLOR_HEX[ch]) return COLOR_HEX[ch]; }
  return COLOR_HEX['無'];
}
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ============================================================
   UNIFIED CARD BADGE — used everywhere a card's type/level icon
   is shown (search grid, deck list, card detail view):
     - background/text color = the card's own color
     - label = type letter (イ/マ/ハ), or for マリョク, its level number
     - shape = rounded square for イジン/マホウ/ハイケイ, circle for マリョク
   ============================================================ */
const CARD_TYPE_LETTER = { 'イジン': 'イ', 'マホウ': 'マ', 'ハイケイ': 'ハ' };

function cardBadge(card) {
  const span = document.createElement('span');
  span.className = 'card-type-badge';
  if (card.type !== 'マリョク') span.classList.add('badge-square');
  span.style.background = cardPrimaryColorHex(card);
  if (card.type === 'マリョク') {
    span.textContent = card.level;
    span.title = `マリョク（レベル${card.level}）・色:${card.color}`;
  } else {
    span.textContent = CARD_TYPE_LETTER[card.type] || '?';
    span.title = `${card.type}・色:${card.color}`;
  }
  return span;
}

/* Right-slot badge: level number (not shown for マリョク, whose level is already on the left badge).
   Text color uses the card's own color for a quick visual match with the left badge. */
function tileLevelBadge(card) {
  const span = document.createElement('span');
  span.className = 'card-type-badge level-badge';
  span.style.color = cardPrimaryColorHex(card);
  span.textContent = card.level;
  span.title = `レベル${card.level}`;
  return span;
}

function cardStatText(card) {
  if (card.type === 'イジン') return `Lv${card.level} / パワー${card.power}`;
  if (card.type === 'マホウ') return `Lv${card.level} / コスト${card.magic_cost ?? 0}`;
  return `Lv${card.level}`;
}

/* Shared "card face" builder: header (badge/name/level) + trait + rule text (with bolded
   keywords) + sub row (legacy ability / power or cost). Appended directly into `container`,
   which may be a search-grid tile or the (larger) card detail view.
   Set includeSource=true to also append a set/rarity line (used in the detail view; the
   search-grid tile instead folds the set/rarity into its own footer, alongside the deck buttons). */
function appendCardFace(container, card, { includeSource = false } = {}) {
  const header = document.createElement('div');
  header.className = 'card-header-row';
  header.appendChild(cardBadge(card));
  const nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = card.name;
  header.appendChild(nameEl);
  if (card.type === 'マホウ' && (card.magic_cost || 0) > 0) {
    const costEl = document.createElement('span');
    costEl.className = 'card-cost-pips';
    costEl.textContent = '○'.repeat(card.magic_cost);
    costEl.title = `魔力コスト${card.magic_cost}`;
    header.appendChild(costEl);
  }
  if (card.type !== 'マリョク') header.appendChild(tileLevelBadge(card));
  container.appendChild(header);

  const trait = (card.trait || '').trim();
  if (trait && trait !== '（空欄）') {
    const traitEl = document.createElement('div');
    traitEl.className = 'card-trait';
    traitEl.textContent = trait;
    container.appendChild(traitEl);
  }

  const ruleText = (card.rule_text || '').trim();
  if (ruleText && ruleText !== '（空欄）' && ruleText !== '-') {
    const ruleEl = document.createElement('div');
    ruleEl.className = 'card-rule-text';
    ruleEl.style.background = hexToRgba(cardPrimaryColorHex(card), 0.14);
    ruleEl.appendChild(renderRuleTextNode(ruleText));
    container.appendChild(ruleEl);
  }

  const subRow = document.createElement('div');
  subRow.className = 'card-sub-row';
  const legacyEl = document.createElement('span');
  legacyEl.className = 'card-legacy';
  legacyEl.textContent = formatLegacyAbility(card.legacy_ability) || '';
  subRow.appendChild(legacyEl);

  const statEl = document.createElement('span');
  if (card.type === 'イジン') {
    statEl.className = 'card-power';
    statEl.style.color = cardPrimaryColorHex(card);
    statEl.textContent = card.power;
  }
  subRow.appendChild(statEl);
  container.appendChild(subRow);

  if (includeSource) {
    const sourceEl = document.createElement('div');
    sourceEl.className = 'card-source';
    sourceEl.textContent = `${card.set}　${card.rarity || ''}`;
    container.appendChild(sourceEl);
  }
}

function renderCardGrid() {
  const list = sortCards(filterCards());
  document.getElementById('listCount').textContent = `カード一覧（${list.length}件）`;
  const grid = document.getElementById('cardGrid');
  grid.innerHTML = '';
  list.forEach(card => {
    const tile = document.createElement('div');
    tile.className = 'card-tile';

    appendCardFace(tile, card);

    // Footer: set / rarity on the left --- count, minus, add on the right
    const footer = document.createElement('div');
    footer.className = 'card-tile-footer';

    const sourceEl = document.createElement('span');
    sourceEl.className = 'card-source';
    sourceEl.textContent = `${card.set}　${card.rarity || ''}`;
    footer.appendChild(sourceEl);

    const rightWrap = document.createElement('span');
    rightWrap.className = 'card-tile-footer-right';
    const countBadge = document.createElement('span');
    const cur = state.draft[card.id] || 0;
    countBadge.className = 'count-badge';
    countBadge.textContent = cur > 0 ? ('x' + cur) : '';
    countBadge.style.visibility = cur > 0 ? 'visible' : 'hidden';
    rightWrap.appendChild(countBadge);

    const minusBtn = document.createElement('button');
    minusBtn.className = 'add-btn';
    minusBtn.textContent = '－';
    minusBtn.addEventListener('click', (e) => { e.stopPropagation(); decCardFromDraft(card.id); });
    rightWrap.appendChild(minusBtn);

    const addBtn = document.createElement('button');
    addBtn.className = 'add-btn';
    addBtn.textContent = '＋ 追加';
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); addCardToDraft(card.id); });
    rightWrap.appendChild(addBtn);

    footer.appendChild(rightWrap);
    tile.appendChild(footer);

    grid.appendChild(tile);
  });
}

/* ============================================================
   DECK BUILDER: DRAFT MANAGEMENT
   ============================================================ */
function addCardToDraft(cardId) {
  const card = CARDS_BY_ID[cardId];
  const unlimited = UNLIMITED_RE.test(card.rule_text || '');
  const cur = state.draft[cardId] || 0;
  if (!unlimited && cur >= 4) {
    flashDeckStatus('同名カードは4枚までです（' + card.name + '）');
    return;
  }
  state.draft[cardId] = cur + 1;
  renderDeckPanel();
  renderCardGrid();
}

function decCardFromDraft(cardId) {
  const cur = state.draft[cardId] || 0;
  if (cur <= 1) delete state.draft[cardId];
  else state.draft[cardId] = cur - 1;
  renderDeckPanel();
  renderCardGrid();
}

function removeCardFromDraft(cardId) {
  delete state.draft[cardId];
  renderDeckPanel();
  renderCardGrid();
}

let statusFlashTimeout = null;
function flashDeckStatus(msg) {
  const el = document.getElementById('deckStatus');
  const prevHTML = el.innerHTML;
  el.textContent = msg;
  el.classList.add('warn');
  clearTimeout(statusFlashTimeout);
  statusFlashTimeout = setTimeout(() => { renderDeckPanel(); }, 1800);
}

const DECK_TYPE_ORDER = ['イジン', 'ハイケイ', 'マホウ', 'マリョク'];

/* Sort a deck's card ids in a fixed, always-consistent order:
   イジン → ハイケイ → マホウ → マリョク, then by name within each group.
   Used by both the deck panel display and the text export, so the two always match. */
function sortDeckIds(draft) {
  return Object.keys(draft).sort((a, b) => {
    const ca = CARDS_BY_ID[a], cb = CARDS_BY_ID[b];
    const ta = DECK_TYPE_ORDER.indexOf(ca.type), tb = DECK_TYPE_ORDER.indexOf(cb.type);
    if (ta !== tb) return ta - tb;
    return ca.name.localeCompare(cb.name, 'ja');
  });
}

function renderDeckPanel() {
  const el = document.getElementById('deckStatus');
  const total = Object.values(state.draft).reduce((a, b) => a + b, 0);
  el.classList.remove('warn', 'ok');
  if (total >= 40) {
    el.textContent = `合計 ${total} 枚 ・ 構築OK（40枚以上）`;
    el.classList.add('ok');
  } else {
    el.textContent = `合計 ${total} 枚 ・ あと ${40 - total} 枚必要です`;
    el.classList.add('warn');
  }

  const listEl = document.getElementById('deckList');
  listEl.innerHTML = '';
  const ids = sortDeckIds(state.draft);
  let lastType = null;
  ids.forEach(id => {
    const card = CARDS_BY_ID[id];
    const count = state.draft[id];

    if (card.type !== lastType) {
      lastType = card.type;
      const heading = document.createElement('div');
      heading.className = 'deck-group-heading';
      heading.textContent = card.type;
      listEl.appendChild(heading);
    }

    const row = document.createElement('div');
    row.className = 'deck-row';

    row.appendChild(cardBadge(card));

    const nameEl = document.createElement('span');
    nameEl.className = 'dr-name';
    nameEl.textContent = `${card.name} ×${count}`;
    nameEl.addEventListener('click', () => openCardDetail(id));
    row.appendChild(nameEl);

    const minus = document.createElement('button');
    minus.textContent = '−';
    minus.addEventListener('click', () => decCardFromDraft(id));
    row.appendChild(minus);

    const plus = document.createElement('button');
    plus.textContent = '＋';
    plus.addEventListener('click', () => addCardToDraft(id));
    row.appendChild(plus);

    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', () => removeCardFromDraft(id));
    row.appendChild(del);

    listEl.appendChild(row);
  });
}

/* ============================================================
   DECK BUILDER: SAVE / LOAD / EXPORT / IMPORT
   ============================================================ */
function refreshSavedDeckSelect() {
  const sel = document.getElementById('savedDeckSelect');
  sel.innerHTML = '';
  Object.keys(state.decks).sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
  refreshSoloDeckSelect();
}

function refreshSoloDeckSelect() {
  const sel = document.getElementById('soloDeckSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  Object.keys(state.decks).sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name + ` (${totalCount(state.decks[name].cards)}枚)`;
    sel.appendChild(opt);
  });
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function totalCount(cardsObj) {
  return Object.values(cardsObj).reduce((a, b) => a + b, 0);
}

document.getElementById('btnSaveDeck').addEventListener('click', () => {
  const name = document.getElementById('deckNameInput').value.trim();
  if (!name) { alert('デッキ名を入力してください'); return; }
  if (Object.keys(state.draft).length === 0) { alert('デッキが空です'); return; }
  state.decks[name] = { cards: { ...state.draft } };
  saveDecks(state.decks);
  refreshSavedDeckSelect();
  flashDeckStatus(`「${name}」として保存しました`);
});

document.getElementById('btnNewDeck').addEventListener('click', () => {
  state.draft = {};
  document.getElementById('deckNameInput').value = '';
  renderDeckPanel();
  renderCardGrid();
});

document.getElementById('btnLoadDeck').addEventListener('click', () => {
  const name = document.getElementById('savedDeckSelect').value;
  if (!name || !state.decks[name]) return;
  state.draft = { ...state.decks[name].cards };
  document.getElementById('deckNameInput').value = name;
  renderDeckPanel();
  renderCardGrid();
});

document.getElementById('btnDeleteDeck').addEventListener('click', () => {
  const name = document.getElementById('savedDeckSelect').value;
  if (!name || !state.decks[name]) return;
  if (!confirm(`「${name}」を削除しますか？`)) return;
  delete state.decks[name];
  saveDecks(state.decks);
  refreshSavedDeckSelect();
});

document.getElementById('btnExportDeck').addEventListener('click', () => {
  const ids = sortDeckIds(state.draft);
  const lines = [];
  let lastType = null;
  ids.forEach(id => {
    const c = CARDS_BY_ID[id];
    if (c.type !== lastType) {
      lastType = c.type;
      lines.push(`▼ ${c.type}`);
    }
    lines.push(`${state.draft[id]}\t${id}\t${c.name}`);
  });
  openTextModal('デッキ書出（コピーして保存してください）', lines.join('\n'), null);
});

document.getElementById('btnImportDeck').addEventListener('click', () => {
  openTextModal('デッキ読込（1行ごとに「枚数 カードID」を貼り付け）', '', (text) => {
    const newDraft = {};
    text.split('\n').forEach(line => {
      const m = line.trim().match(/^(\d+)\s+([^\s\t]+)/);
      if (m) {
        const count = Number(m[1]);
        const id = m[2];
        if (CARDS_BY_ID[id]) newDraft[id] = (newDraft[id] || 0) + count;
      }
    });
    state.draft = newDraft;
    renderDeckPanel();
    renderCardGrid();
  });
});

/* ============================================================
   MODALS: card detail + text import/export
   ============================================================ */
const modalOverlay = document.getElementById('cardModal');
const modalContent = document.getElementById('cardModalContent');

function closeModal() { modalOverlay.classList.remove('is-open'); modalContent.innerHTML = ''; modalContent.classList.remove('detail-face'); }
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

function openCardDetail(cardId) {
  const c = CARDS_BY_ID[cardId];
  modalContent.innerHTML = '';
  modalContent.classList.add('detail-face');

  appendCardFace(modalContent, c, { includeSource: true });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-ghost m-close btn-block';
  closeBtn.textContent = '閉じる';
  closeBtn.addEventListener('click', closeModal);
  modalContent.appendChild(closeBtn);

  modalOverlay.classList.add('is-open');
}

function openTextModal(title, initialText, onSubmit) {
  modalContent.classList.remove('detail-face');
  modalContent.innerHTML = '';
  const h = document.createElement('h3'); h.textContent = title; modalContent.appendChild(h);
  const ta = document.createElement('textarea');
  ta.style.width = '100%'; ta.style.height = '260px'; ta.style.fontFamily = 'monospace';
  ta.style.fontSize = '12px'; ta.style.padding = '8px'; ta.style.boxSizing = 'border-box';
  ta.value = initialText;
  modalContent.appendChild(ta);

  const row = document.createElement('div'); row.className = 'btn-row';
  if (onSubmit) {
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-primary'; okBtn.textContent = '読み込む';
    okBtn.addEventListener('click', () => { onSubmit(ta.value); closeModal(); });
    row.appendChild(okBtn);
  } else {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-primary'; copyBtn.textContent = 'コピー';
    copyBtn.addEventListener('click', () => {
      ta.select();
      try { document.execCommand('copy'); copyBtn.textContent = 'コピーしました！'; }
      catch (e) { navigator.clipboard && navigator.clipboard.writeText(ta.value); }
    });
    row.appendChild(copyBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-ghost'; closeBtn.textContent = '閉じる';
  closeBtn.addEventListener('click', closeModal);
  row.appendChild(closeBtn);
  modalContent.appendChild(row);

  modalOverlay.classList.add('is-open');
}

/* ============================================================
   SOLO PLAY: SETUP
   ============================================================ */
document.querySelectorAll('#fFirst .chip-toggle').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#fFirst .chip-toggle').forEach(x => x.classList.remove('is-active'));
    b.classList.add('is-active');
  });
});

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

document.getElementById('btnStartGame').addEventListener('click', () => {
  const deckName = document.getElementById('soloDeckSelect').value;
  if (!deckName || !state.decks[deckName]) { alert('デッキを選択してください'); return; }
  const isFirst = document.querySelector('#fFirst .chip-toggle.is-active').dataset.val === 'first';

  const pool = [];
  const deckDef = state.decks[deckName].cards;
  Object.keys(deckDef).forEach(id => { for (let i = 0; i < deckDef[id]; i++) pool.push(id); });

  let deck = shuffle(pool);

  GAME = {
    deckName, isFirst,
    turn: 1, phase: 'start',
    deck: [],
    hand: [],
    graveyard: [],
    mana: [],
    field: [],
    resources: { manaPlace: 1, summon: 1 },
    log: []
  };
  GAME.deck = deck; // top = end of array

  // draw 6 to hand
  for (let i = 0; i < 6 && GAME.deck.length; i++) {
    const id = GAME.deck.pop();
    GAME.hand.push({ uid: uidCounter++, cardId: id });
  }
  // 4 guardians face-down to field
  for (let i = 0; i < 4 && GAME.deck.length; i++) {
    const id = GAME.deck.pop();
    GAME.field.push({ uid: uidCounter++, cardId: id, faceUp: false, tapped: false, isGuardian: true });
  }

  log(`対戦準備完了：${deckName}（${isFirst ? '先攻' : '後攻'}） 手札6枚・ガーディアン4枚を配置`);

  document.getElementById('setupPanel').style.display = 'none';
  document.getElementById('boardPanel').style.display = 'block';
  renderBoard();
});

document.getElementById('btnEndGame').addEventListener('click', () => {
  if (!confirm('対戦を終了して準備画面に戻りますか？')) return;
  GAME = null;
  document.getElementById('setupPanel').style.display = 'block';
  document.getElementById('boardPanel').style.display = 'none';
});

/* ============================================================
   SOLO PLAY: PHASE / TURN PROGRESSION
   ============================================================ */
function log(msg) {
  if (!GAME) return;
  GAME.log.push(msg);
  renderLog();
}

function drawCards(n) {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (GAME.deck.length === 0) { log('山札が0枚のためこれ以上ドローできません'); break; }
    const id = GAME.deck.pop();
    GAME.hand.push({ uid: uidCounter++, cardId: id });
    drawn++;
  }
  if (drawn > 0) log(`${drawn}枚ドローしました（山札残り${GAME.deck.length}枚）`);
}

document.getElementById('btnDrawExtra').addEventListener('click', () => {
  if (!GAME) return;
  drawCards(1);
  renderBoard();
});

document.getElementById('btnAdvancePhase').addEventListener('click', () => {
  if (!GAME) return;
  const order = ['start', 'draw', 'main', 'end'];
  let idx = (order.indexOf(GAME.phase) + 1) % order.length;
  if (idx === 0) GAME.turn += 1;
  GAME.phase = order[idx];
  onEnterPhase(GAME.phase);
  renderBoard();
});

function onEnterPhase(phase) {
  if (phase === 'start') {
    GAME.field.forEach(c => c.tapped = false);
    GAME.resources.manaPlace = 1;
    GAME.resources.summon = 1;
    log(`── ターン${GAME.turn} スタートフェイズ：戦場を起こし、マリョク配置権・イジン召喚権をリセット ──`);
  } else if (phase === 'draw') {
    if (GAME.turn === 1 && GAME.isFirst) {
      log('先攻1ターン目のためドローをスキップします');
    } else {
      drawCards(1);
    }
  } else if (phase === 'main') {
    log(`ターン${GAME.turn} メインフェイズ`);
  } else if (phase === 'end') {
    log(`ターン${GAME.turn} エンドフェイズ：未使用の配置権・召喚権が消滅します`);
  }
}

/* ============================================================
   SOLO PLAY: ZONE MOVEMENT
   ============================================================ */
function findAndRemove(zoneArr, uid) {
  const idx = zoneArr.findIndex(x => x.uid === uid);
  if (idx === -1) return null;
  return zoneArr.splice(idx, 1)[0];
}

function zoneArrayOf(zoneKey) {
  return { hand: GAME.hand, mana: GAME.mana, field: GAME.field, graveyard: GAME.graveyard }[zoneKey];
}

function moveInstance(uid, fromZone, toZone, opts = {}) {
  const fromArr = zoneArrayOf(fromZone);
  const inst = findAndRemove(fromArr, uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];

  if (toZone === 'hand') {
    GAME.hand.push({ uid: inst.uid, cardId: inst.cardId });
    log(`${card.name} を手札に戻しました`);
  } else if (toZone === 'mana') {
    GAME.mana.push({ uid: inst.uid, cardId: inst.cardId, faceUp: !!opts.faceUp });
    log(`${card.name} を魔力ゾーンに${opts.faceUp ? '表向きで' : '裏向きで'}置きました`);
  } else if (toZone === 'field') {
    GAME.field.push({ uid: inst.uid, cardId: inst.cardId, faceUp: opts.faceUp !== false, tapped: false, isGuardian: !!opts.isGuardian });
    log(`${card.name} を戦場に${opts.faceUp !== false ? '表向きで' : '裏向き（ガーディアン）で'}置きました`);
  } else if (toZone === 'graveyard') {
    GAME.graveyard.push({ uid: inst.uid, cardId: inst.cardId });
    let msg = `${card.name} を墓地に置きました`;
    if (card.legacy_ability && !['-', '（空欄）', ''].includes(card.legacy_ability.trim())) {
      msg += '　※遺業能力の発動を確認してください';
    }
    log(msg);
  } else if (toZone === 'deckTop') {
    GAME.deck.push(inst.cardId);
    log(`${card.name} を山札の上に戻しました`);
  } else if (toZone === 'deckBottom') {
    GAME.deck.unshift(inst.cardId);
    log(`${card.name} を山札の下に戻しました`);
  }
  renderBoard();
}

/* --- resource-aware quick actions --- */
function doManaPlace(uid, faceUp) {
  if (GAME.resources.manaPlace < 1) { log('マリョク配置権がありません'); return; }
  GAME.resources.manaPlace -= 1;
  moveInstance(uid, 'hand', 'mana', { faceUp });
}
function doSummon(uid) {
  if (GAME.resources.summon < 1) { log('イジン召喚権がありません'); return; }
  GAME.resources.summon -= 1;
  moveInstance(uid, 'hand', 'field', { faceUp: true });
}
function doHaikeiUse(uid) {
  moveInstance(uid, 'hand', 'field', { faceUp: true });
}
function doMahouUse(uid) {
  const inst = GAME.hand.find(x => x.uid === uid);
  const card = inst ? CARDS_BY_ID[inst.cardId] : null;
  moveInstance(uid, 'hand', 'graveyard', {});
  if (card) log(`（魔力コスト${card.magic_cost ?? 0}枚を魔力ゾーンから墓地に置くのを忘れずに）`);
}
function toggleFaceUp(uid, zoneKey) {
  const arr = zoneArrayOf(zoneKey);
  const inst = arr.find(x => x.uid === uid);
  if (!inst) return;
  inst.faceUp = !inst.faceUp;
  log(`${CARDS_BY_ID[inst.cardId].name} を${inst.faceUp ? '表' : '裏'}にしました`);
  renderBoard();
}
function toggleTapped(uid) {
  const inst = GAME.field.find(x => x.uid === uid);
  if (!inst) return;
  inst.tapped = !inst.tapped;
  log(`${CARDS_BY_ID[inst.cardId].name} を${inst.tapped ? '寝かせ' : '起こし'}ました`);
  renderBoard();
}

/* ============================================================
   SOLO PLAY: RENDERING
   ============================================================ */
function renderLog() {
  const el = document.getElementById('logList');
  el.innerHTML = '';
  GAME.log.slice(-60).forEach(m => {
    const d = document.createElement('div');
    d.textContent = m;
    el.appendChild(d);
  });
}

function manaSummaryText() {
  let levelTotal = 0, faceDownCount = 0;
  const colors = new Set();
  GAME.mana.forEach(m => {
    if (m.faceUp) {
      const c = CARDS_BY_ID[m.cardId];
      levelTotal += (c.level || 0);
      if (c.color && c.color !== '無') [...c.color].forEach(ch => COLOR_HEX[ch] && colors.add(ch));
    } else {
      faceDownCount += 1;
    }
  });
  const colorTxt = colors.size ? [...colors].join('') : 'なし';
  return `使用可能な色: ${colorTxt} ／ レベル上限: ${levelTotal + faceDownCount}（表向き合計${levelTotal} + 裏向き${faceDownCount}枚）`;
}

function createMiniCard(inst, zoneKey) {
  const card = CARDS_BY_ID[inst.cardId];
  const el = document.createElement('div');
  el.className = 'mini-card';

  const isFaceDownZone = (zoneKey === 'mana' || zoneKey === 'field');
  const faceUp = isFaceDownZone ? inst.faceUp : true;

  if (isFaceDownZone && !faceUp) {
    el.classList.add('is-facedown');
    el.textContent = inst.isGuardian ? 'ガーディアン' : '裏向き';
  } else {
    const nameEl = document.createElement('div');
    nameEl.className = 'mini-card-name';
    nameEl.textContent = card.name;
    el.appendChild(nameEl);
    const metaEl = document.createElement('div');
    metaEl.className = 'mini-card-meta';
    metaEl.textContent = `${card.type} ・ ${cardStatText(card)}`;
    el.appendChild(metaEl);
  }

  if (zoneKey === 'field' && inst.tapped) el.classList.add('is-tapped');
  if (zoneKey === 'field' && inst.isGuardian && faceUp) {
    const tag = document.createElement('span'); tag.className = 'mini-card-tag'; tag.textContent = 'G';
    el.appendChild(tag);
  }

  el.addEventListener('click', (e) => openActionMenu(inst, zoneKey, e.currentTarget));
  return el;
}

function renderZoneCards(zoneKey, containerId) {
  const arr = zoneArrayOf(zoneKey);
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  arr.forEach(inst => container.appendChild(createMiniCard(inst, zoneKey)));
}

function renderBoard() {
  if (!GAME) return;
  document.getElementById('stampTurn').textContent = `第${GAME.turn}ターン`;
  document.getElementById('stampPhase').textContent = PHASE_LABEL[GAME.phase];
  document.getElementById('cntMana').textContent = GAME.resources.manaPlace;
  document.getElementById('cntSummon').textContent = GAME.resources.summon;
  document.getElementById('cntDeck').textContent = GAME.deck.length;

  document.getElementById('cntField').textContent = `(${GAME.field.length})`;
  document.getElementById('cntMana2').textContent = `(${GAME.mana.length})`;
  document.getElementById('cntGrave').textContent = `(${GAME.graveyard.length})`;
  document.getElementById('cntHand').textContent = `(${GAME.hand.length})`;

  document.getElementById('manaSummary').textContent = manaSummaryText();

  renderZoneCards('field', 'zoneField');
  renderZoneCards('mana', 'zoneMana');
  renderZoneCards('graveyard', 'zoneGrave');
  renderZoneCards('hand', 'zoneHand');

  renderLog();
}

/* ============================================================
   SOLO PLAY: ACTION MENU (context menu per card)
   ============================================================ */
const actionMenuEl = document.getElementById('actionMenu');

function closeActionMenu() {
  actionMenuEl.classList.remove('is-open');
  actionMenuEl.innerHTML = '';
  activeMenuInstance = null;
}
document.addEventListener('click', (e) => {
  if (!actionMenuEl.contains(e.target) && !e.target.closest('.mini-card')) closeActionMenu();
});

function addMenuBtn(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => { closeActionMenu(); fn(); });
  actionMenuEl.appendChild(b);
}
function addMenuDivider() {
  const d = document.createElement('div'); d.className = 'am-divider';
  actionMenuEl.appendChild(d);
}

function openActionMenu(inst, zoneKey, anchorEl) {
  const card = CARDS_BY_ID[inst.cardId];
  actionMenuEl.innerHTML = '';
  activeMenuInstance = { uid: inst.uid, zoneKey };

  const title = document.createElement('div');
  title.style.fontWeight = '700'; title.style.padding = '4px 8px 6px'; title.style.fontSize = '12.5px';
  title.style.color = '#e6c869';
  title.textContent = card.name;
  actionMenuEl.appendChild(title);
  addMenuDivider();

  if (zoneKey === 'hand') {
    addMenuBtn(`マリョク配置（表） [権:${GAME.resources.manaPlace}]`, () => doManaPlace(inst.uid, true));
    addMenuBtn(`マリョク配置（裏） [権:${GAME.resources.manaPlace}]`, () => doManaPlace(inst.uid, false));
    if (card.type === 'イジン') addMenuBtn(`イジン召喚 [権:${GAME.resources.summon}]`, () => doSummon(inst.uid));
    if (card.type === 'ハイケイ') addMenuBtn('ハイケイ使用（戦場へ）', () => doHaikeiUse(inst.uid));
    if (card.type === 'マホウ') addMenuBtn(`マホウ使用（墓地へ・コスト${card.magic_cost ?? 0}）`, () => doMahouUse(inst.uid));
    addMenuBtn('裏向きで戦場に置く（ガーディアン化）', () => moveInstance(inst.uid, 'hand', 'field', { faceUp: false, isGuardian: true }));
    addMenuDivider();
    addMenuBtn('墓地に置く', () => moveInstance(inst.uid, 'hand', 'graveyard'));
    addMenuBtn('山札の上に戻す', () => moveInstance(inst.uid, 'hand', 'deckTop'));
    addMenuBtn('山札の下に戻す', () => moveInstance(inst.uid, 'hand', 'deckBottom'));
  }

  if (zoneKey === 'field') {
    addMenuBtn(inst.tapped ? '起こす' : '寝かせる', () => toggleTapped(inst.uid));
    addMenuBtn(inst.faceUp ? '裏にする' : '表にする', () => toggleFaceUp(inst.uid, 'field'));
    addMenuDivider();
    addMenuBtn('手札に戻す', () => moveInstance(inst.uid, 'field', 'hand'));
    addMenuBtn('魔力ゾーンに置く（表）', () => moveInstance(inst.uid, 'field', 'mana', { faceUp: true }));
    addMenuBtn('魔力ゾーンに置く（裏）', () => moveInstance(inst.uid, 'field', 'mana', { faceUp: false }));
    addMenuBtn('墓地に置く（破壊/離脱）', () => moveInstance(inst.uid, 'field', 'graveyard'));
    addMenuBtn('山札の上に戻す', () => moveInstance(inst.uid, 'field', 'deckTop'));
    addMenuBtn('山札の下に戻す', () => moveInstance(inst.uid, 'field', 'deckBottom'));
  }

  if (zoneKey === 'mana') {
    addMenuBtn(inst.faceUp ? '裏にする' : '表にする', () => toggleFaceUp(inst.uid, 'mana'));
    addMenuDivider();
    addMenuBtn('手札に戻す', () => moveInstance(inst.uid, 'mana', 'hand'));
    addMenuBtn('戦場に置く（表）', () => moveInstance(inst.uid, 'mana', 'field', { faceUp: true }));
    addMenuBtn('戦場に置く（裏）', () => moveInstance(inst.uid, 'mana', 'field', { faceUp: false, isGuardian: true }));
    addMenuBtn('墓地に置く（マホウコスト支払い等）', () => moveInstance(inst.uid, 'mana', 'graveyard'));
  }

  if (zoneKey === 'graveyard') {
    addMenuBtn('手札に戻す', () => moveInstance(inst.uid, 'graveyard', 'hand'));
    addMenuBtn('戦場に置く（表）', () => moveInstance(inst.uid, 'graveyard', 'field', { faceUp: true }));
    addMenuBtn('戦場に置く（裏）', () => moveInstance(inst.uid, 'graveyard', 'field', { faceUp: false }));
    addMenuBtn('魔力ゾーンに置く（表）', () => moveInstance(inst.uid, 'graveyard', 'mana', { faceUp: true }));
    addMenuBtn('魔力ゾーンに置く（裏）', () => moveInstance(inst.uid, 'graveyard', 'mana', { faceUp: false }));
    addMenuBtn('山札の上に戻す', () => moveInstance(inst.uid, 'graveyard', 'deckTop'));
    addMenuBtn('山札の下に戻す', () => moveInstance(inst.uid, 'graveyard', 'deckBottom'));
  }

  addMenuDivider();
  addMenuBtn('カード詳細を見る', () => openCardDetail(card.id));

  // position
  const rect = anchorEl.getBoundingClientRect();
  actionMenuEl.style.left = (window.scrollX + rect.left) + 'px';
  actionMenuEl.style.top = (window.scrollY + rect.bottom + 4) + 'px';
  actionMenuEl.classList.add('is-open');
}

/* ============================================================
   INIT
   ============================================================ */
initFilterUI();
renderCardGrid();
renderDeckPanel();
refreshSavedDeckSelect();
