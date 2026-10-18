/* ============================================================
   イジンデン一人回し - app.js
   デッキ構築＆ソロプレイ卓上アシスタント
   ============================================================ */

const CARDS = window.IJINDEN_CARDS || [];
const CARDS_BY_ID = {};
CARDS.forEach(c => { CARDS_BY_ID[c.id] = c; });

/* ---------------- 再録・イラスト違いのまとめ ----------------
   名前・種類・色・レベル・パワーが同じカードは「同じカードの別収録」とみなして1つにまとめる
   （ブルーオーブの第1弾と第5弾、PSRなど）。色やレベルが違うもの（ヒエロスガモス5種など）は別カードのまま。
   まとめた代表は、新しい弾（テキストが新しい表記）を優先する。デッキ内のIDも代表のIDにそろえる */
const SET_ORDER = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
const PRINT_GROUPS = {};      // groupKey -> [card]
const GROUP_KEY_OF = {};      // id -> groupKey
const CANON_ID = {};          // id -> 代表のid
CARDS.forEach(c => {
  const k = [c.name, c.type, c.color, c.level, c.power].join('|');
  GROUP_KEY_OF[c.id] = k;
  (PRINT_GROUPS[k] = PRINT_GROUPS[k] || []).push(c);
});
Object.values(PRINT_GROUPS).forEach(list => {
  const score = c => SET_ORDER.indexOf(c.set) * 10 + (c.rarity === 'PSR' ? 0 : 5);
  const rep = list.slice().sort((a, b) => score(b) - score(a))[0];
  list.forEach(c => { CANON_ID[c.id] = rep.id; });
});
const canonId = id => CANON_ID[id] || id;
function canonDraft(cards) {
  const out = {};
  Object.keys(cards || {}).forEach(id => { const k = canonId(id); out[k] = (out[k] || 0) + cards[id]; });
  return out;
}

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
    const tip = (typeof IjindenGlossary !== 'undefined') ? IjindenGlossary.descOf(m[0]) : '';
    if (tip) { strong.title = tip; strong.className = 'kw-term'; }
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

/* ---------------- プリセットデッキ（preset-decks.js） ---------------- */
const PRESET_PREFIX = '★';
const PRESET_DECKS = (window.IJINDEN_PRESET_DECKS || []).map(d => ({
  key: PRESET_PREFIX + d.name, name: d.name, series: d.series || '',
  cards: Object.fromEntries(Object.entries(d.cards).filter(([id]) => {
    const ok = !!(typeof CARDS_BY_ID !== 'undefined' && CARDS_BY_ID[id]);
    if (!ok) console.warn(`プリセット「${d.name}」: 未知のカードID ${id} を無視しました`);
    return ok;
  }))
}));
const PRESET_BY_KEY = Object.fromEntries(PRESET_DECKS.map(d => [d.key, { cards: d.cards, preset: true, name: d.name }]));
// 保存済みデッキ or プリセットを、キー(デッキ名 / ★名前)から取得
function getDeckByKey(key) {
  const d = (state.decks && state.decks[key]) || PRESET_BY_KEY[key] || null;
  return d ? Object.assign({}, d, { cards: canonDraft(d.cards) }) : null;   // 再録カードは代表のIDにそろえて返す
}
// <select> に「保存済み」「プリセット」の順で選択肢を詰める（count=枚数表示）
function fillDeckOptions(sel, withCount) {
  const mk = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; };
  const cnt = d => withCount ? ` (${Object.values(d.cards).reduce((a, b) => a + b, 0)}枚)` : '';
  const names = Object.keys(state.decks).sort();
  if (names.length) {
    const g = document.createElement('optgroup'); g.label = '保存済みデッキ';
    names.forEach(n => g.appendChild(mk(n, n + cnt(state.decks[n]))));
    sel.appendChild(g);
  }
  if (PRESET_DECKS.length) {
    // 弾（series）ごとにグループ分け。並びは preset-decks.js の順
    const groups = new Map();
    PRESET_DECKS.forEach(d => { const k = d.series || 'その他'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); });
    groups.forEach((list, k) => {
      const g = document.createElement('optgroup'); g.label = `プリセット：${k}`;
      list.forEach(d => g.appendChild(mk(d.key, `${PRESET_PREFIX}${d.name}` + cnt(d))));
      sel.appendChild(g);
    });
  }
}

/* ---------------- Global state ---------------- */
const state = {
  filters: {
    search: '',
    types: new Set(['イジン', 'マホウ', 'ハイケイ', 'マリョク']),
    colors: new Set(),
    sets: new Set(),
    rarities: new Set(),
    traits: new Set(),
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
   UNDO function
   ============================================================ */
const undoStack = [];

function updateUndoButton() {
  const b = document.getElementById('btnUndo');
  if (b) b.disabled = undoStack.length === 0;
}

// 操作を実行し、盤面(ログ以外)が変わったときだけ履歴に積む
function runUndoable(fn) {
  if (!GAME) return;
  const beforeFull = JSON.stringify(GAME);
  const beforeState = JSON.stringify({ ...GAME, log: null });
  fn();
  if (!GAME) return;
  if (JSON.stringify({ ...GAME, log: null }) !== beforeState) {
    undoStack.push(beforeFull);
    if (undoStack.length > 100) undoStack.shift();
  }
  updateUndoButton();
}

function undo() {
  if (!GAME || undoStack.length === 0) return;
  GAME = JSON.parse(undoStack.pop());
  log('↩ 一つ前の状態に戻しました');
  renderBoard();
  updateUndoButton();
}

document.getElementById('btnUndo').addEventListener('click', undo);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && GAME && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault(); undo();
  }
});

/* ============================================================
   TAB SWITCHING
   ============================================================ */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('is-active');
    if (btn.dataset.tab === 'solo') { refreshSoloDeckSelect(); scrollLogToEnd(document.getElementById('logList')); }
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
  // 特性（「特性：剣術」「特性：剣術　志願」など。全角/半角コロン・複数特性に対応）
  const traits = [...new Set(CARDS.flatMap(cardTraits))].sort((a, b) => a.localeCompare(b, 'ja'));
  setUpChipGroup(document.getElementById('fTrait'), traits, state.filters.traits, t => t);

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
    state.filters.traits.clear();
    state.filters.levelMin = null;
    state.filters.levelMax = null;
    document.getElementById('fSearch').value = '';
    document.getElementById('fLevelMin').value = '';
    document.getElementById('fLevelMax').value = '';
    document.querySelectorAll('#fColor .chip-toggle, #fSet .chip-toggle, #fRarity .chip-toggle, #fTrait .chip-toggle')
      .forEach(b => b.classList.remove('is-active'));
    renderCardGrid();
  });
}

/* ============================================================
   DECK BUILDER: FILTER / SORT LOGIC
   ============================================================ */
/* カードの特性の一覧（trait欄の「特性：剣術　志願」から ['剣術','志願'] を取り出す） */
function cardTraits(card) {
  const t = String(card.trait || '');
  const m = t.match(/特性\s*[:：]\s*(.+)$/);
  if (!m) return [];
  return m[1].split(/[\s\u3000・、,]+/).map(x => x.replace(/[「」『』]/g, '').trim()).filter(Boolean);
}

function matchesSearch(card, q) {
  if (!q) return true;
  const hay = [card.name, card.rule_text, card.legacy_ability, card.trait].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

function filterCards() {
  const f = state.filters;
  const seen = new Set();
  return CARDS.filter(c => matchesFilters(c, f)).map(c => CARDS_BY_ID[canonId(c.id)]).filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
function matchesFilters(c, f) {
  {
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
    if (f.traits.size > 0 && !cardTraits(c).some(t => f.traits.has(t))) return false;
    if (f.levelMin !== null && c.level < f.levelMin) return false;
    if (f.levelMax !== null && c.level > f.levelMax) return false;
    if (!matchesSearch(c, f.search)) return false;
    return true;
  }
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

  // 能力名の注記（ルールテキストと遺業能力に出てくる用語の説明）
  if (typeof IjindenGlossary !== 'undefined') {
    const seen = new Set();
    const hits = IjindenGlossary.find(card.rule_text).concat(IjindenGlossary.find(card.legacy_ability, { legacy: true }))
      .filter(h => !seen.has(h.term) && seen.add(h.term));
    if (hits.length) {
      const nb = document.createElement('div');
      nb.className = 'kw-notes';
      hits.forEach(h => {
        const line = document.createElement('div');
        line.className = 'kw-note';
        const b = document.createElement('b'); b.textContent = h.term;
        line.appendChild(b);
        line.appendChild(document.createTextNode(' ' + h.desc));
        nb.appendChild(line);
      });
      container.appendChild(nb);
    }
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
    // 収録：まとめた再録も並べて表示（例：1st R / 5th N）。同名で別カードがあるときはNo.も添える
    const prints = PRINT_GROUPS[GROUP_KEY_OF[card.id]] || [card];
    const sameNameGroups = new Set(CARDS.filter(x => x.name === card.name).map(x => GROUP_KEY_OF[x.id])).size;
    sourceEl.textContent = prints.map(p => `${p.set} ${p.rarity || ''}`.trim()).join(' / ') + (sameNameGroups > 1 ? `　No.${card.no}` : '');
    sourceEl.title = prints.map(p => `${p.set} ${p.no} ${p.rarity || ''}`).join(' / ');
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
  const card = CARDS_BY_ID[canonId(cardId)];
  const unlimited = UNLIMITED_RE.test(card.rule_text || '');
  cardId = canonId(cardId);
  // 「同名カードは4枚まで」：収録違い・色違いも名前が同じなら合算する
  const cur = state.draft[cardId] || 0;
  const sameName = Object.keys(state.draft).filter(id => CARDS_BY_ID[id] && CARDS_BY_ID[id].name === card.name).reduce((n, id) => n + state.draft[id], 0);
  if (!unlimited && sameName >= 4) {
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
  const prev = sel.value;
  sel.innerHTML = '';
  fillDeckOptions(sel, true);
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  refreshSoloDeckSelect();
}

function refreshSoloDeckSelect() {
  const sel = document.getElementById('soloDeckSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  fillDeckOptions(sel, true);
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
  const d = getDeckByKey(name);
  if (!d) return;
  state.draft = canonDraft(d.cards);
  // プリセットは上書きできないので、★を外した名前で自分用のコピーとして編集できるようにする
  document.getElementById('deckNameInput').value = d.preset ? d.name : name;
  if (d.preset) flashDeckStatus(`プリセット「${d.name}」を読み込みました（保存すると自分用のコピーになります）`);
  renderDeckPanel();
  renderCardGrid();
});

document.getElementById('btnDeleteDeck').addEventListener('click', () => {
  const name = document.getElementById('savedDeckSelect').value;
  if (name && PRESET_BY_KEY[name]) { alert('プリセットデッキは削除できません（読み取り専用です）'); return; }
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
    state.draft = canonDraft(newDraft);
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
  const deckObj = getDeckByKey(deckName);
  if (!deckName || !deckObj) { alert('デッキを選択してください'); return; }
  const isFirst = document.querySelector('#fFirst .chip-toggle.is-active').dataset.val === 'first';

  const pool = [];
  const deckDef = deckObj.cards;
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
    //resources: { manaPlace: 1, summon: 1 },
	resources: { manaPlace: 1, summon: 1, drawn: 0, drawLimit: isFirst ? 0 : 1 },
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

  document.getElementById('logList').innerHTML = '';
  log(`対戦準備完了：${deckName}（${isFirst ? '先攻' : '後攻'}） 手札6枚・ガーディアン4枚を配置`);

  document.getElementById('setupPanel').style.display = 'none';
  document.getElementById('boardPanel').style.display = 'block';
  undoStack.length = 0; updateUndoButton();	//undo
  renderBoard();
});

document.getElementById('btnEndGame').addEventListener('click', () => {
  if (!confirm('対戦を終了して準備画面に戻りますか？')) return;
  GAME = null;
  undoStack.length = 0; updateUndoButton();	//undo
  document.getElementById('setupPanel').style.display = 'block';
  document.getElementById('boardPanel').style.display = 'none';
});

/* ============================================================
   SOLO PLAY: PHASE / TURN PROGRESSION
   ============================================================ */
function nowTimeStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg) {
  if (!GAME) return;
  GAME.log.push({ t: nowTimeStr(), m: msg });
  renderLog();
}

/* ============================================================
   トースト通知（画面中央に一瞬だけ表示）
   ============================================================ */
function showToast(text, opts) {
  opts = opts || {};
  let layer = document.getElementById('toastLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'toastLayer';
    layer.className = 'toast-layer';
    document.body.appendChild(layer);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (opts.variant ? ' toast-' + opts.variant : '');
  const main = document.createElement('div');
  main.textContent = text;
  t.appendChild(main);
  if (opts.sub) {
    const sub = document.createElement('div');
    sub.className = 'toast-sub';
    sub.textContent = opts.sub;
    t.appendChild(sub);
  }
  const ms = opts.ms || 1300;
  t.style.animationDuration = (ms / 1000) + 's';
  layer.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, ms);
}

/* ============================================================
   ポップアップの配置（基本はカードの「上」。入らなければ下、どちらも狭ければ広い方にスクロール付きで）
   ============================================================ */
function placePopup(menuEl, anchorEl) {
  const GAP = 4;
  menuEl.style.maxHeight = '';
  menuEl.style.overflowY = '';
  menuEl.style.visibility = 'hidden';
  menuEl.classList.add('is-open');
  const r = anchorEl.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const w = menuEl.offsetWidth, h = menuEl.offsetHeight;

  // 上端の限界：固定されているヘッダー(board-topbar)の下まで
  let topLimit = 8;
  const bar = document.querySelector('.tab-panel.is-active .board-topbar');
  if (bar) {
    const pos = getComputedStyle(bar).position;
    if (pos === 'sticky' || pos === 'fixed') topLimit = Math.max(topLimit, bar.getBoundingClientRect().bottom + 8);
  }
  const roomAbove = r.top - GAP - topLimit;
  const roomBelow = vh - 8 - (r.bottom + GAP);

  let top;   // viewport 座標
  if (h <= roomAbove) top = r.top - GAP - h;
  else if (h <= roomBelow) top = r.bottom + GAP;
  else if (roomAbove >= roomBelow) {
    const mh = Math.max(80, roomAbove);
    menuEl.style.maxHeight = mh + 'px'; menuEl.style.overflowY = 'auto';
    top = r.top - GAP - Math.min(h, mh);
  } else {
    const mh = Math.max(80, roomBelow);
    menuEl.style.maxHeight = mh + 'px'; menuEl.style.overflowY = 'auto';
    top = r.bottom + GAP;
  }
  let left = Math.min(r.left, vw - w - 8);
  left = Math.max(8, left);
  menuEl.style.left = (window.scrollX + left) + 'px';
  menuEl.style.top = (window.scrollY + top) + 'px';
  menuEl.style.visibility = '';
}

function drawCards(n) {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (GAME.deck.length === 0) { log('山札が0枚のためこれ以上ドローできません'); break; }
    const id = GAME.deck.pop();
    GAME.hand.push({ uid: uidCounter++, cardId: id });
    drawn++;
  }
  GAME.resources.drawn += drawn;	//ドロー制限
  if (drawn > 0) {
    log(`${drawn}枚ドローしました（山札残り${GAME.deck.length}枚）`);
    showToast('ドロー！' + (drawn > 1 ? ` ×${drawn}` : ''));
  }
}
/*
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
*/
document.getElementById('btnDrawExtra').addEventListener('click', () => {
  if (!GAME) return;
  runUndoable(() => {
    const r = GAME.resources;
    if (r.drawn >= r.drawLimit &&
        !confirm(`このターンのドロー上限（${r.drawLimit}枚）に達しています。\n効果などで追加ドローする場合は続行してください。`)) return;
    drawCards(1);
    renderBoard();
  });
});

document.getElementById('btnAdvancePhase').addEventListener('click', () => {
  if (!GAME) return;
  runUndoable(() => {
    const order = ['start', 'draw', 'main', 'end'];
    let idx = (order.indexOf(GAME.phase) + 1) % order.length;
    if (idx === 0) GAME.turn += 1;
    GAME.phase = order[idx];
    onEnterPhase(GAME.phase);
    renderBoard();
  });
});

function onEnterPhase(phase) {
	
/*
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
*/
	if (phase === 'start') {
		GAME.field.forEach(c => c.tapped = false);
		GAME.resources.manaPlace = 1;
		GAME.resources.summon = 1;
		GAME.resources.drawn = 0;
		GAME.resources.drawLimit = 1;
		log(`── ターン${GAME.turn} スタートフェイズ：戦場を起こし、各種権利とドロー回数をリセット ──`);
	} else if (phase === 'draw') {
		if (GAME.resources.drawLimit === 0) {
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

/* 配置・召喚・使用したとき、能力があればトースト＋ログで知らせる（効果の処理は手動） */
function announceAbility(card, kind) {
  const text = IjindenSummon.abilityText(card, kind);
  if (!text) return;
  const notes = IjindenGlossary.noteLine(text);
  showToast(`${card.name}の能力`, { variant: 'ability', sub: text + (notes ? '\n' + notes : ''), ms: 2600 + Math.min(2400, notes.length * 18) });
  log(`　${card.name}の能力：${text.replace(/\n/g, ' ')}（自動処理されません）`);
}

/* --- resource-aware quick actions --- */
function doManaPlace(uid, faceUp) {
  if (GAME.resources.manaPlace < 1) { log('マリョク配置権がありません'); return; }
  GAME.resources.manaPlace -= 1;
  moveInstance(uid, 'hand', 'mana', { faceUp });
  if (faceUp) {
    const card = CARDS_BY_ID[(GAME.mana.find(x => x.uid === uid) || {}).cardId] || {};
    if (!soloAutoManaFromDeck(card)) announceAbility(card, 'mana');
  }
}
/* 自動処理：「魔力ゾーンに置かれたとき、自分の山札の上から1枚（カード2つ）を裏のまま魔力ゾーンに置く。」（〇〇の種・キャビネットなど） */
function soloAutoManaFromDeck(card) {
  const text = String(IjindenSummon.abilityText(card, 'mana') || '').replace(/＋/g, '+');
  const m = text.match(/自分の山札の上から(?:カード)?([123１２３一二三])(?:枚|つ)を裏のまま魔力ゾーンに置く/);
  if (!m || /発動できる|するか/.test(text)) return false;
  const n = { '1': 1, '2': 2, '3': 3, '１': 1, '２': 2, '３': 3, '一': 1, '二': 2, '三': 3 }[m[1]];
  let k = 0;
  for (; k < n && GAME.deck.length; k++) GAME.mana.push({ uid: uidCounter++, cardId: GAME.deck.pop(), faceUp: false, tapped: false });
  showToast(`${card.name}の能力`, { variant: 'ability', sub: '自動処理：' + text, ms: 2200 });
  log(`　${card.name}の能力（自動処理）：山札の上から${k}枚を裏のまま魔力ゾーンに置きました（山札残り${GAME.deck.length}枚）` + (k < n ? '　※山札が足りません' : ''));
  return true;
}
/*
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
*/
function summonAnalysis(card) {
  return IjindenSummon.analyze(card, GAME.mana, GAME.field, CARDS_BY_ID);
}
function doSummon(uid) {
  const inst = GAME.hand.find(x => x.uid === uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  if (GAME.resources.summon < 1) { log('イジン召喚権がありません'); return; }
  const info = summonAnalysis(card);
  const needModal = info.auto > 0 || info.hints.length > 0 || checkPlayable(card, info.auto).length > 0;
  if (!needModal) { finalizeSummon(uid, 0); return; }
  openSummonModal(card, {
    base: card.level || 0, auto: info.auto, parts: info.parts, hints: info.hints,
    flips: info.flips.map(f => f.name)
  }, extra => ({
    problems: checkPlayable(card, info.auto + extra),
    note: manaSummaryText()
  }), extra => runUndoable(() => finalizeSummon(uid, extra)), { allowForce: true });
}
// 実際の召喚処理（軽減値 = 自動分 + 手動分）
function finalizeSummon(uid, extra) {
  const inst = GAME.hand.find(x => x.uid === uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  if (GAME.resources.summon < 1) { log('イジン召喚権がありません'); renderBoard(); return; }
  const info = summonAnalysis(card);
  const red = info.auto + (extra || 0);
  GAME.resources.summon -= 1;
  moveInstance(uid, 'hand', 'field', { faceUp: true });
  if (red > 0) log(`　${card.name}：召喚時レベル ${card.level || 0} → ${IjindenSummon.effectiveLevel(card.level, red)}（軽減${red}）`);
  announceAbility(card, 'field');
  info.flips.forEach(f => {
    const m = GAME.mana.find(x => x.uid === f.uid);
    if (m && m.faceUp) { m.faceUp = false; log(`　${f.name}は裏向きになりました`); }
  });
  renderBoard();
}
function doHaikeiUse(uid) {
  const inst = GAME.hand.find(x => x.uid === uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  if (!confirmIfRestricted(card)) { log(`${card.name} の使用を取りやめました`); return; }
  moveInstance(uid, 'hand', 'field', { faceUp: true });
  announceAbility(card, 'field');
}
function doMahouUse(uid) {
  const inst = GAME.hand.find(x => x.uid === uid);
  if (!inst) return;
  const card = CARDS_BY_ID[inst.cardId];
  const cost = card.magic_cost ?? 0;
  const extra = GAME.mana.length < cost ? [`魔力ゾーン${GAME.mana.length}枚ではコスト${cost}を払えません`] : [];
  if (!confirmIfRestricted(card, extra)) { log(`${card.name} の使用を取りやめました`); return; }
  moveInstance(uid, 'hand', 'graveyard', {});
  log(`（魔力コスト${cost}枚を魔力ゾーンから墓地に置くのを忘れずに）`);
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
/* ログ描画：左に時刻、右にメッセージ。最新行が見える位置にいるときは自動で最下部へ追従する
   （過去ログを読もうと上へスクロールしている間は、その位置を維持する） */
function renderLog() {
  const el = document.getElementById('logList');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  const keepTop = el.scrollTop;
  el.innerHTML = '';
  GAME.log.slice(-200).forEach(entry => {
    const e = (typeof entry === 'string') ? { t: '', m: entry } : entry;
    const row = document.createElement('div');
    row.className = 'log-row';
    const t = document.createElement('span');
    t.className = 'log-time';
    t.textContent = e.t || '';
    const m = document.createElement('span');
    m.className = 'log-msg';
    m.textContent = e.m;
    row.appendChild(t);
    row.appendChild(m);
    el.appendChild(row);
  });
  el.scrollTop = atBottom ? el.scrollHeight : keepTop;
}
function scrollLogToEnd(listEl) {
  if (listEl) listEl.scrollTop = listEl.scrollHeight;
}
/*
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
*/
function getManaInfo() {
  let levelTotal = 0, faceDown = 0;
  const colors = new Set();
  GAME.mana.forEach(m => {
    if (m.faceUp) {
      const c = CARDS_BY_ID[m.cardId];
      levelTotal += (c.level || 0);
      if (c.color && c.color !== '無') [...c.color].forEach(ch => COLOR_HEX[ch] && colors.add(ch));
    } else faceDown += 1;
  });
  return { levelCap: levelTotal + faceDown, levelTotal, faceDown, colors };
}

function manaSummaryText() {
  const { levelCap, levelTotal, faceDown, colors } = getManaInfo();
  const colorTxt = colors.size ? [...colors].join('') : 'なし';
  return `使用可能な色: ${colorTxt} ／ レベル上限: ${levelCap}（表向き合計${levelTotal} + 裏向き${faceDown}枚）`;
}

/* マリョクゾーンの表示：色ごとのレベル内訳＋合計のレベル上限（ソロプレイと対戦で共通） */
function buildManaSummary(box, manaList) {
  const ORDER = '赤青緑黄紫無';
  const groups = {};          // カードの色（例:「赤」「赤青」）ごとの表向きレベル合計
  let faceDown = 0, total = 0;
  const usable = new Set();
  manaList.forEach(m => {
    if (!m.faceUp) { faceDown += 1; return; }
    const c = CARDS_BY_ID[m.cardId];
    const cols = [...(c.color || '無')].filter(ch => COLOR_HEX[ch]);
    const key = cols.length ? cols.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).join('') : '無';
    groups[key] = (groups[key] || 0) + (c.level || 0);
    total += (c.level || 0);
    cols.forEach(ch => { if (ch !== '無') usable.add(ch); });
  });
  box.innerHTML = '';
  const chips = document.createElement('div');
  chips.className = 'mana-chips';
  const keys = Object.keys(groups).sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]) || a.length - b.length);
  keys.forEach(k => {
    const chip = document.createElement('span');
    chip.className = 'mana-chip';
    const cols = [...k].map(ch => COLOR_HEX[ch]);
    chip.style.background = cols.length > 1 ? `linear-gradient(90deg, ${cols.join(', ')})` : cols[0];
    chip.innerHTML = `<b>${k}</b><span>Lv${groups[k]}</span>`;
    chips.appendChild(chip);
  });
  if (faceDown) {
    const chip = document.createElement('span');
    chip.className = 'mana-chip mana-chip-down';
    chip.innerHTML = `<b>裏</b><span>×${faceDown}</span>`;
    chips.appendChild(chip);
  }
  if (!keys.length && !faceDown) {
    const none = document.createElement('span');
    none.className = 'mana-none';
    none.textContent = 'マリョクなし';
    chips.appendChild(none);
  }
  const cap = document.createElement('div');
  cap.className = 'mana-cap';
  cap.innerHTML = `<span class="mana-cap-label">レベル上限</span><span class="mana-cap-num">${total + faceDown}</span>`;
  const colorsLine = document.createElement('div');
  colorsLine.className = 'mana-usable';
  colorsLine.innerHTML = '使える色：' + (usable.size
    ? [...usable].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).map(ch => `<i style="background:${COLOR_HEX[ch]}">${ch}</i>`).join('')
    : 'なし');
  box.appendChild(cap);
  box.appendChild(chips);
  box.appendChild(colorsLine);
  box.title = manaSummaryTextFrom(total, faceDown, usable);
  return box;
}
function manaSummaryTextFrom(total, faceDown, colors) {
  return `使用可能な色: ${colors.size ? [...colors].join('') : 'なし'} ／ レベル上限: ${total + faceDown}（表向き合計${total} + 裏向き${faceDown}枚）`;
}

function checkPlayable(card, reduction = 0) {
  const { levelCap, colors } = getManaInfo();
  const problems = [];
  const eff = (card.type === 'イジン') ? IjindenSummon.effectiveLevel(card.level, reduction) : (card.level || 0);
  if (eff > levelCap) problems.push(reduction > 0 ? `レベル${card.level}（軽減後${eff}）が上限${levelCap}を超えています` : `レベル${card.level}が上限${levelCap}を超えています`);
  const need = (card.color && card.color !== '無') ? [...card.color].filter(ch => ch !== '無' && COLOR_HEX[ch]) : [];
  const lacking = need.filter(ch => !colors.has(ch));
  if (lacking.length) problems.push(`使用可能な色が足りません（${lacking.join('')}）`);
  return problems;
}

function confirmIfRestricted(card, extra = []) {
  const problems = checkPlayable(card).concat(extra);
  if (!problems.length) return true;
  return confirm(`${card.name}\n・${problems.join('\n・')}\n\nそれでも続行しますか？`);
}

/* 召喚確認モーダル（レベル軽減・要確認の効果・裏向きになるカードを見せる）
   info: {base, auto, parts:[{name,n}], hints:[{name,text}], flips:[name]}
   getCheck(extra) -> {problems:[], note}
   onConfirm(extra) / opts.allowForce: 条件未達でも実行できるか */
function openSummonModal(card, info, getCheck, onConfirm, opts) {
  opts = opts || {};
  let extra = 0;
  modalContent.classList.remove('detail-face');
  modalContent.innerHTML = '';
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  modalContent.appendChild(mk('h3', '', `イジン召喚：${card.name}`));
  const grid = mk('div', 'sm-grid');
  modalContent.appendChild(grid);

  const row = (label, node) => { grid.appendChild(mk('div', 'sm-label', label)); grid.appendChild(node); };
  row('元のレベル', mk('div', '', `Lv${info.base}`));
  if (info.auto > 0) row('自動で拾った軽減', mk('div', '', `−${info.auto}（${info.parts.map(p => `${p.name} −${p.n}`).join('、')}）`));

  const stepper = mk('div', 'sm-stepper');
  const minus = mk('button', 'btn btn-ghost', '−'), plus = mk('button', 'btn btn-ghost', '＋');
  const val = mk('span', 'sm-val', '0');
  stepper.append(minus, val, plus);
  row('手動で追加の軽減', stepper);

  const eff = mk('div', 'sm-eff');
  row('召喚時のレベル', eff);

  const checkBox = mk('div', 'sm-checks');
  modalContent.appendChild(checkBox);

  if (info.hints.length) {
    modalContent.appendChild(mk('div', 'm-section-label', '要確認の効果（自動では数えていません）'));
    info.hints.forEach(h => {
      const b = mk('div', 'sm-hint');
      b.appendChild(mk('b', '', h.name));
      b.appendChild(mk('div', '', h.text));
      modalContent.appendChild(b);
    });
    modalContent.appendChild(mk('div', 'sm-note', '上の効果で下がる分は「手動で追加の軽減」に入力してください。'));
  }
  if (info.flips && info.flips.length) {
    modalContent.appendChild(mk('div', 'sm-flip', `召喚後に裏向きになるカード：${info.flips.join('、')}`));
  }

  const btnRow = mk('div', 'btn-row');
  const ok = mk('button', 'btn btn-primary', '召喚する');
  const cancel = mk('button', 'btn btn-ghost', 'キャンセル');
  btnRow.append(ok, cancel);
  modalContent.appendChild(btnRow);

  function refresh() {
    val.textContent = String(extra);
    const red = info.auto + extra;
    eff.textContent = `Lv${Math.max(0, info.base - red)}` + (red > 0 ? `（軽減${red}）` : '');
    const chk = getCheck(extra);
    checkBox.innerHTML = '';
    if (chk.note) checkBox.appendChild(mk('div', 'sm-note', chk.note));
    if (!chk.problems.length) checkBox.appendChild(mk('div', 'sm-ok', '✓ 召喚条件を満たしています'));
    else chk.problems.forEach(p => checkBox.appendChild(mk('div', 'sm-ng', '✗ ' + p)));
    if (!chk.problems.length) { ok.disabled = false; ok.textContent = '召喚する'; }
    else if (opts.allowForce) { ok.disabled = false; ok.textContent = '条件未達でも召喚する'; }
    else { ok.disabled = true; ok.textContent = '召喚できません'; }
  }
  minus.addEventListener('click', () => { if (extra > 0) { extra--; refresh(); } });
  plus.addEventListener('click', () => { if (extra < 20) { extra++; refresh(); } });
  ok.addEventListener('click', () => { const x = extra; closeModal(); onConfirm(x); });
  cancel.addEventListener('click', closeModal);
  refresh();
  modalOverlay.classList.add('is-open');
}

/* ミニカード左上の丸型レベルバッジ（表向きのときだけ使う） */
function miniLevelBadge(card) {
  const b = document.createElement('span');
  b.className = 'mini-level';
  b.style.background = cardPrimaryColorHex(card);
  b.textContent = card.level ?? 0;
  b.title = `レベル${card.level ?? 0}`;
  return b;
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
    el.classList.add('has-level');
    el.appendChild(miniLevelBadge(card));
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
  if (zoneKey !== 'field') { arr.forEach(inst => container.appendChild(createMiniCard(inst, zoneKey))); return; }
  // 戦場は「イジン・ガーディアン」と「ハイケイ」の段に分けて表示する
  const isHaikei = inst => inst.faceUp && CARDS_BY_ID[inst.cardId].type === 'ハイケイ';
  const main = document.createElement('div');
  main.className = 'zone-cards field-main';
  arr.filter(x => !isHaikei(x)).forEach(inst => main.appendChild(createMiniCard(inst, zoneKey)));
  const hk = arr.filter(isHaikei);
  const row = document.createElement('div');
  row.className = 'haikei-row' + (hk.length ? '' : ' is-empty');
  row.innerHTML = '<div class="haikei-row-label">ハイケイ</div>';
  const hwrap = document.createElement('div');
  hwrap.className = 'zone-cards haikei-cards';
  hk.forEach(inst => hwrap.appendChild(createMiniCard(inst, zoneKey)));
  row.appendChild(hwrap);
  container.appendChild(main);
  container.appendChild(row);
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

  buildManaSummary(document.getElementById('manaSummary'), GAME.mana);

  document.getElementById('cntDraw').textContent = `${GAME.resources.drawn}/${GAME.resources.drawLimit}`; //ドロー数カウンタ

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
/*
function addMenuBtn(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => { closeActionMenu(); fn(); });
  actionMenuEl.appendChild(b);
}
*/
function addMenuBtn(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => { closeActionMenu(); runUndoable(fn); });
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
    if (card.type === 'イジン') {
      const red = summonAnalysis(card).auto;
      addMenuBtn(`イジン召喚${red > 0 ? `（Lv−${red}）` : ''} [権:${GAME.resources.summon}]`, () => doSummon(inst.uid));
    }
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
  placePopup(actionMenuEl, anchorEl);   // カードの上に出す（入らなければ下）
}

/* ============================================================
   INIT
   ============================================================ */
initFilterUI();
renderCardGrid();
renderDeckPanel();
refreshSavedDeckSelect();
