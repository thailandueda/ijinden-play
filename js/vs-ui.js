/* ============================================================
   イジンデン CPU対戦タブ（画面側）
   依存: app.js（state / CARDS_BY_ID / openCardDetail / cardStatText /
         closeModal / modalContent / modalOverlay）と vs-engine.js
   ============================================================ */
(function () {
  'use strict';
  if (typeof IjindenEngine === 'undefined') { console.error('vs-engine.js が読み込まれていません'); return; }

  const ENG = IjindenEngine.create(CARDS_BY_ID);
  const VS = { G: null, mode: 'normal', selAtk: new Set(), selBlocker: null, assign: {}, busy: false, flashMsg: '', legacy: [], annaSel: new Set(), trig: null, afterAnna: null, afterLegacy: null, annaPrev: 'normal', assist: [], assistTurn: 0, pumping: false };
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /* ---------------- 戦績（勝敗をブラウザに保存し、デッキ別の勝率を出す） ---------------- */
  const STATS_KEY = 'ijinden_vs_stats_v1';
  function loadStats() {
    try { const a = JSON.parse(localStorage.getItem(STATS_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveStats(list) {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(list.slice(-2000))); } catch (e) { /* 保存できない環境では記録しない */ }
  }
  function deckLabel(key) {
    const d = (typeof getDeckByKey === 'function') ? getDeckByKey(key) : null;
    return (d && d.name && !(typeof state !== 'undefined' && state.decks && state.decks[key])) ? `${typeof PRESET_PREFIX === 'string' ? PRESET_PREFIX : ''}${d.name}` : key;
  }
  function recordResult(G) {
    if (!VS.deckKeys || G.winner === null) return;
    const list = loadStats();
    list.push({ t: new Date().toISOString(), my: VS.deckKeys.my, cpu: VS.deckKeys.cpu, first: G.firstIdx === 0, win: G.winner === 0, turns: G.turn });
    saveStats(list);
  }
  const pct = (w, n) => (n ? Math.round(w * 1000 / n) / 10 + '%' : '-');
  function statsTable(title, head, rows) {
    const box = el('div', 'vs-stats-block');
    box.appendChild(el('h3', 'zone-title', title));
    const t = el('table', 'vs-stats-table');
    const hr = el('tr');
    head.forEach(h => hr.appendChild(el('th', '', h)));
    t.appendChild(hr);
    rows.forEach(r => { const tr = el('tr'); r.forEach((c, i) => tr.appendChild(el('td', i === 0 ? 'vs-stats-name' : '', String(c)))); t.appendChild(tr); });
    box.appendChild(t);
    return box;
  }
  function renderStats() {
    const host = $('vsStats');
    if (!host) return;
    host.innerHTML = '';
    host.appendChild(el('h3', 'panel-title', '戦績（このブラウザに保存）'));
    const list = loadStats();
    if (!list.length) { host.appendChild(el('p', 'hint-text', 'まだ対戦記録がありません。決着がつくと自動で記録されます（途中で「対戦終了」した対戦は記録されません）。')); return; }
    const agg = (keyFn) => {
      const m = new Map();
      list.forEach(r => { const k = keyFn(r), a = m.get(k) || { n: 0, w: 0 }; a.n++; if (r.win) a.w++; m.set(k, a); });
      return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    };
    const total = list.length, wins = list.filter(r => r.win).length;
    host.appendChild(el('p', 'vs-stats-total', `通算 ${total}戦 ${wins}勝 ${total - wins}敗　勝率 ${pct(wins, total)}`));
    host.appendChild(statsTable('あなたのデッキ別', ['デッキ', '対戦', '勝', '敗', '勝率'],
      agg(r => r.my).map(([k, a]) => [deckLabel(k), a.n, a.w, a.n - a.w, pct(a.w, a.n)])));
    host.appendChild(statsTable('対戦カード別（あなた vs CPU）', ['あなた vs CPU', '対戦', '勝', '勝率'],
      agg(r => r.my + '\u0000' + r.cpu).map(([k, a]) => { const [m, c] = k.split('\u0000'); return [`${deckLabel(m)} vs ${deckLabel(c)}`, a.n, a.w, pct(a.w, a.n)]; })));
    const f = list.filter(r => r.first), sc = list.filter(r => !r.first);
    host.appendChild(el('p', 'vs-stats-total', `先攻 ${f.length}戦 勝率${pct(f.filter(r => r.win).length, f.length)}　／　後攻 ${sc.length}戦 勝率${pct(sc.filter(r => r.win).length, sc.length)}`));
    const rs = el('button', 'btn btn-ghost btn-sm', '戦績をリセット');
    rs.addEventListener('click', () => { if (confirm('保存した戦績をすべて消します。よろしいですか？')) { saveStats([]); renderStats(); } });
    host.appendChild(rs);
  }
  (function mountStats() {
    const panel = $('vsSetupPanel');
    if (!panel) return;
    const host = el('div', 'vs-stats'); host.id = 'vsStats';
    panel.appendChild(host);
    renderStats();
  })();

  /* ---------------- 準備画面 ---------------- */
  function refreshVsDecks() {
    ['vsMyDeck', 'vsCpuDeck'].forEach(id => {
      const sel = $(id);
      const prev = sel.value;
      sel.innerHTML = '';
      if (id === 'vsCpuDeck') {
        const o = el('option', '', '（あなたと同じデッキ）');
        o.value = '';
        sel.appendChild(o);
      }
      fillDeckOptions(sel, true);   // 保存済み → プリセット の順
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    });
  }
  document.querySelector('.tab-btn[data-tab="vs"]').addEventListener('click', () => {
    refreshVsDecks();
    const l = document.querySelector('#vsBoard .log-list');
    if (l) l.scrollTop = l.scrollHeight;
  });

  document.querySelectorAll('#vsFirst .chip-toggle').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#vsFirst .chip-toggle').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
    });
  });

  $('vsStart').addEventListener('click', () => {
    const my = $('vsMyDeck').value;
    if (!my || !getDeckByKey(my)) { alert('あなたのデッキを選んでください（先にデッキ構築で保存してください）'); return; }
    const cpu = $('vsCpuDeck').value || my;
    if (!getDeckByKey(cpu)) { alert('CPUのデッキが見つかりません'); return; }
    const total = d => Object.values(d.cards).reduce((a, b) => a + b, 0);
    if (total(getDeckByKey(my)) < 10 || total(getDeckByKey(cpu)) < 10) { alert('手札6枚＋ガーディアン4枚を用意するため、10枚以上のデッキが必要です'); return; }
    const sel = document.querySelector('#vsFirst .chip-toggle.is-active').dataset.val;
    startMatch(my, cpu, sel);
  });
  // オプション：手札の引き直し（ON/OFF はブラウザに保存）
  const MULL_KEY = 'ijinden-vs-mulligan';
  const mullOn = () => { try { return localStorage.getItem(MULL_KEY) === '1'; } catch (e) { return false; } };
  document.querySelectorAll('#vsMulligan .chip-toggle').forEach(b => {
    if ((b.dataset.val === 'on') === mullOn()) b.classList.add('is-active'); else b.classList.remove('is-active');
    b.addEventListener('click', () => {
      document.querySelectorAll('#vsMulligan .chip-toggle').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
      try { localStorage.setItem(MULL_KEY, b.dataset.val === 'on' ? '1' : '0'); } catch (e) { /* 保存できない環境 */ }
    });
  });
  /* 演出レベル：all=すべて／key=重要だけ／none=なし（勝敗のみ）。対戦中でもすぐ反映 */
  const FX_KEY = 'ijinden-vs-fxlevel';
  const fxLevel = () => { try { return localStorage.getItem(FX_KEY) || 'all'; } catch (e) { return 'all'; } };
  document.querySelectorAll('#vsFxLevel .chip-toggle').forEach(b => {
    b.classList.toggle('is-active', b.dataset.val === fxLevel());
    b.addEventListener('click', () => {
      document.querySelectorAll('#vsFxLevel .chip-toggle').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
      try { localStorage.setItem(FX_KEY, b.dataset.val); } catch (e) { /* 保存できない環境 */ }
    });
  });
  // 種類ごとに表示するか。key では能力の自動処理・効果によるドローを出さない
  const KEY_FX = new Set(['dive', 'turn', 'attack', 'destroy', 'nodestroy', 'legacy', 'win']);
  const fxShow = kind => { const lv = fxLevel(); return lv === 'all' || kind === 'win' || (lv === 'key' && KEY_FX.has(kind)); };
  /* 対戦を始める（再戦でも使う）。sel: 'first' | 'second' | 'random' */
  function startMatch(my, cpu, sel) {
    const first = sel === 'first' ? 0 : sel === 'second' ? 1 : (Math.random() < 0.5 ? 0 : 1);
    closeMenu();
    VS.deckKeys = { my, cpu, sel };
    VS.G = ENG.newGame(getDeckByKey(my).cards, getDeckByKey(cpu).cards, first, [1], { mulligan: mullOn() });
    { const fb = document.getElementById('vsFeed'); if (fb) fb.innerHTML = ''; }   // 前の対戦の履歴を消す
    VS.mode = 'normal'; VS.selAtk = new Set(); VS.selBlocker = null; VS.assign = {}; VS.busy = false; VS.flashMsg = ''; VS.legacy = []; VS.annaSel = new Set(); VS.trig = null; VS.afterAnna = null; VS.afterLegacy = null; VS.assist = []; VS.assistTurn = 0; fxCursor = 0;
    $('vsSetupPanel').style.display = 'none';
    $('vsBoard').style.display = 'block';
    if (fxShow('dive')) schedule(2200, () => showToast('ダイブトゥイジンデン！', { variant: 'dive', ms: 2200 }));
    if (VS.G.mulligan && VS.G.mulligan[0] === 'pending') VS.mode = 'mulligan';   // 引き直すかを先に決める
    render();
    if (VS.G.current === 1 && VS.mode !== 'mulligan') runCpu();
  }
  function decideMulligan(redo) {
    const G = VS.G;
    const r = ENG.mulligan(G, 0, redo);
    if (!r.ok) { flash(r.msg); return; }
    // あなたが先攻なら、このあとCPU（後攻）が決める
    const cpuNote = G.firstIdx === 0 && G.mulligan[1] !== 'pending' ? (G.mulligan[1] === 'done' ? 'CPU（後攻）は手札を引き直しました' : 'CPU（後攻）は手札をそのまま使います') : undefined;
    showToast(redo ? '手札を引き直しました' : 'この手札で始めます', { variant: 'long', sub: cpuNote, ms: cpuNote ? 2000 : 1400 });
    VS.mode = 'normal';
    render();
    if (G.current === 1) runCpu();
  }
  // 再戦：同じデッキ・同じ先攻／後攻の設定でもう一度（ランダムならもう一度抽選）
  function rematch() {
    const k = VS.deckKeys;
    if (!k || !getDeckByKey(k.my) || !getDeckByKey(k.cpu)) { endGame(); return; }
    if (VS.G && VS.G.winner === null && !confirm('対戦中です。この対戦をやめて、同じデッキで最初からやり直しますか？')) return;
    startMatch(k.my, k.cpu, k.sel || 'random');
  }

  /* ---------- CPU同士で100戦（デッキ評価）。画面が固まらないよう、少しずつ進める ---------- */
  $('vsSim').addEventListener('click', () => {
    const my = $('vsMyDeck').value, cpu = $('vsCpuDeck').value || my;
    const A = getDeckByKey(my), B = getDeckByKey(cpu);
    if (!A || !B) { alert('デッキを選んでください'); return; }
    const total = d => Object.values(d.cards).reduce((a, b) => a + b, 0);
    if (total(A) < 10 || total(B) < 10) { alert('10枚以上のデッキが必要です'); return; }
    const N = 100, SIM = IjindenEngine.create(CARDS_BY_ID);
    const st = { done: 0, aWin: 0, bWin: 0, draw: 0, aFirstWin: 0, aFirst: 0, aSecondWin: 0, aSecond: 0, turns: [], reasons: {}, auto: [0, 0], unproc: [0, 0], err: 0 };
    const box = $('vsSimResult'), btns = [$('vsSim'), $('vsStart')];
    btns.forEach(b => { b.disabled = true; });
    box.hidden = false;
    const nameA = (A.name || '').replace(/^★/, ''), nameB = (B.name || '').replace(/^★/, '');
    const one = g => {
      const aSeat = g % 2, first = Math.floor(g / 2) % 2;   // 席と先攻を均等に入れ替える
      const decks = aSeat === 0 ? [A, B] : [B, A];
      const G = SIM.newGame(decks[0].cards, decks[1].cards, first, [0, 1]);
      let steps = 0;
      while (G.winner === null && G.turn <= 120 && steps++ < 20000) { const r = SIM.cpuStep(G); if (r === 'idle' || r === 'await_block') break; }
      const aFirst = first === aSeat;
      if (aFirst) st.aFirst++; else st.aSecond++;
      if (G.winner === null) st.draw++;
      else if (G.winner === aSeat) { st.aWin++; if (aFirst) st.aFirstWin++; else st.aSecondWin++; }
      else st.bWin++;
      st.turns.push(G.turn);
      const rs = G.winner === null ? '120ターンで決着せず' : /山札が0枚/.test(G.winReason) ? '山札切れ' : /防げなかった/.test(G.winReason) ? 'アタックを防げず' : 'その他';
      st.reasons[rs] = (st.reasons[rs] || 0) + 1;
      G.fx.forEach(f => { if (f.type === 'ability' || f.type === 'legacy') { const side = f.pi === aSeat ? 0 : 1; if (f.auto) st.auto[side]++; else st.unproc[side]++; } });
    };
    const pct = (a, b) => (b ? Math.round(100 * a / b) : 0) + '%';
    const show = fin => {
      const t = st.turns.slice().sort((a, b) => a - b);
      const rate = side => pct(st.auto[side], st.auto[side] + st.unproc[side]);
      box.innerHTML = `<div class="sim-title">${fin ? '結果' : '対戦中…'}（${st.done}/${N}戦）</div>` +
        `<div class="sim-vs"><b>${nameA}</b> ${st.aWin}勝 ／ <b>${nameB}</b> ${st.bWin}勝` + (st.draw ? ` ／ 引き分け${st.draw}` : '') + `</div>` +
        `<div class="sim-bar"><span style="width:${st.done ? 100 * st.aWin / st.done : 0}%"></span></div>` +
        `<div class="sim-line">${nameA}の勝率 <b>${pct(st.aWin, st.done)}</b>（先攻 ${pct(st.aFirstWin, st.aFirst)} ／ 後攻 ${pct(st.aSecondWin, st.aSecond)}）</div>` +
        (t.length ? `<div class="sim-line">決着までのターン数：中央 ${t[t.length >> 1]}（最短 ${t[0]}・最長 ${t[t.length - 1]}）</div>` : '') +
        `<div class="sim-line">決着の理由：${Object.entries(st.reasons).map(([k, v]) => `${k} ${v}`).join(' ／ ')}</div>` +
        `<div class="sim-note">CPUが自動処理できた能力：${nameA} ${rate(0)} ／ ${nameB} ${rate(1)}。処理できない効果は「何も起きない」扱いなので、この割合が低いデッキの結果は参考程度にしてください。</div>`;
    };
    const step = () => {
      for (let k = 0; k < 4 && st.done < N; k++, st.done++) { try { one(st.done); } catch (e) { st.err++; console.error(e); } }
      show(st.done >= N);
      if (st.done < N) setTimeout(step, 0);
      else btns.forEach(b => { b.disabled = false; });
    };
    show(false);
    setTimeout(step, 30);
  });

  function endGame() {
    if (VS.G && VS.G.winner === null && !confirm('対戦を終了して準備画面に戻りますか？')) return;
    VS.G = null; VS.busy = false;
    closeMenu();
    renderStats();
    $('vsSetupPanel').style.display = 'block';
    $('vsBoard').style.display = 'none';
  }

  /* ---------------- ポップアップメニュー ---------------- */
  const menuEl = el('div', 'action-menu');
  document.body.appendChild(menuEl);
  function closeMenu() { menuEl.classList.remove('is-open'); menuEl.innerHTML = ''; }
  document.addEventListener('click', e => {
    if (!e.target.isConnected) return;   // メニューの項目から次のメニューを開いたとき（押したボタンはもう消えている）は閉じない
    if (!menuEl.contains(e.target) && !e.target.closest('.mini-card') && !e.target.closest('[data-vsmenu]') && !e.target.closest('.equip-slip')) closeMenu();
  });
  function showMenu(title, items, anchor) {
    menuEl.innerHTML = '';
    if (title) {
      const t = el('div', '', title);
      t.style.cssText = 'font-weight:700;padding:4px 8px 6px;font-size:12.5px;color:#e6c869';
      menuEl.appendChild(t);
      menuEl.appendChild(el('div', 'am-divider'));
    }
    items.forEach(it => {
      if (it === '-') { menuEl.appendChild(el('div', 'am-divider')); return; }
      const b = el('button', '', it.label);
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => { closeMenu(); it.fn(); });
      menuEl.appendChild(b);
    });
    placePopup(menuEl, anchor);   // カードの上に出す（入らなければ下）
  }

  /* ---------------- 共通ヘルパー ---------------- */
  function flash(msg) {
    VS.flashMsg = msg;
    render();
    setTimeout(() => { if (VS.flashMsg === msg) { VS.flashMsg = ''; render(); } }, 2500);
  }
  function run(r) {
    if (!r.ok) flash(r.msg); else render();
    return r;
  }
  function noteEffect(card) {
    ENG.addLog(VS.G, `【効果を手動で処理】${card.name}：${String(card.rule_text || '').replace(/\s*\n\s*/g, ' ')}`);
    render();
  }
  function statText(inst) {
    const c = CARDS_BY_ID[inst.cardId];
    if (c.type !== 'イジン') return cardStatText(c);
    const p = ENG.powerOf(inst, VS.G), d = p - ENG.powerOf(inst);
    return `Lv${c.level} / パワー${p}` + (d ? `（${d > 0 ? '+' : ''}${d}）` : '');
  }
  function kwText(inst) {
    const k = ENG.kwOf(inst), out = [];
    if (k.haste) out.push('即応');
    if (k.watcher) out.push('ウォッチャー');
    const need = VS.G ? ENG.requiredBlockers(inst, VS.G) : k.pressure;   // 武帝（パワー5000以上）・織田信長などの条件付きも反映
    if (need > 1) out.push(`圧力×${need}`);
    if (k.mortal) out.push('モータル');
    if (k.noIjinBlock || inst.noIjin) out.push('対イジン不可');
    if (k.attack) out.push(`攻+${k.attack}`);
    if (k.block) out.push(`守+${k.block}`);
    return out.join(' ');
  }
  function manaText(P) {
    const m = ENG.manaInfo(P);
    return `使用可能な色: ${m.colors.size ? [...m.colors].join('') : 'なし'} ／ レベル上限: ${m.cap}（表向き合計${m.faceUpSum} + 裏向き${m.faceDown}枚）`;
  }

  /* ---------------- 演出（トースト）とログの連動 ---------------- */
  let fxCursor = 0;   // 直前に予約した演出が終わる時刻。これ以降に次の演出を出す（順番に表示するため）
  function schedule(ms, fn) {
    const now = Date.now(), at = Math.max(now, fxCursor);
    setTimeout(fn, at - now);
    fxCursor = at + ms;
  }
  const atkName = a => (a.faceUp ? CARDS_BY_ID[a.cardId].name : 'ガーディアン');
  const whose = pi => (pi === 0 ? 'あなたの' : 'CPUの');
  /* 能力・ドローの履歴：画面左下に積み上げる小さなカード（最大4件・新しいものが下。マウスを乗せている間は消えない） */
  // 消えるまでの時間（設定。0 = 消さない）。ブラウザに保存
  const FEED_KEY = 'ijinden-vs-feedms';
  const feedMs = () => { try { const v = localStorage.getItem(FEED_KEY); return v === null ? 10000 : Number(v); } catch (e) { return 10000; } };
  document.querySelectorAll('#vsFeedTime .chip-toggle').forEach(b => {
    b.classList.toggle('is-active', Number(b.dataset.val) === feedMs());
    b.addEventListener('click', () => {
      document.querySelectorAll('#vsFeedTime .chip-toggle').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
      try { localStorage.setItem(FEED_KEY, b.dataset.val); } catch (e) { /* 保存できない環境 */ }
    });
  });
  const feedMax = () => (window.matchMedia && window.matchMedia('(max-width: 600px)').matches ? 2 : 4);   // スマホは盤面を隠さないよう2件まで
  function feedBox() {
    let box = document.getElementById('vsFeed');
    if (!box) { box = document.createElement('div'); box.id = 'vsFeed'; box.className = 'vs-feed'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    return box;
  }
  function pushFeed(item) {
    let timer = null;
    const close = () => { clearTimeout(timer); card.classList.add('is-out'); setTimeout(() => card.remove(), 350); };
    if (!document.getElementById('tab-vs') || !document.getElementById('tab-vs').classList.contains('is-active')) return;
    const box = feedBox();
    const card = document.createElement('div');
    card.className = 'vs-feed-item' + (item.pi === 1 ? ' is-cpu' : ' is-me') + (item.manual ? ' is-manual' : '');
    const head = document.createElement('div'); head.className = 'vs-feed-head'; head.textContent = item.title;
    if (item.tag) { const t = document.createElement('span'); t.className = 'vs-feed-tag'; t.textContent = item.tag; head.appendChild(t); }
    const x = document.createElement('button'); x.type = 'button'; x.className = 'vs-feed-close'; x.textContent = '×'; x.title = '閉じる'; x.setAttribute('aria-label', '閉じる');
    x.addEventListener('click', ev => { ev.stopPropagation(); close(); });
    head.appendChild(x);
    card.appendChild(head);
    (item.lines || []).forEach(l => { const d = document.createElement('div'); d.className = 'vs-feed-line'; d.textContent = l; card.appendChild(d); });
    if (item.cardId) { card.classList.add('is-link'); card.title = 'タップでカード詳細'; card.addEventListener('click', () => openCardDetail(item.cardId)); }
    const arm = ms => { clearTimeout(timer); if (feedMs() > 0) timer = setTimeout(close, ms); };
    card.addEventListener('mouseenter', () => clearTimeout(timer));
    card.addEventListener('mouseleave', () => arm(Math.min(4000, feedMs())));
    box.appendChild(card);
    while (box.children.length > feedMax()) box.firstChild.remove();
    arm(item.manual ? feedMs() + 3000 : feedMs());
  }
  /* 1回の操作で連続した「能力の自動処理」「効果によるドロー」は、1枚にまとめる */
  function chainLine(f) {
    if (f.type === 'draw') {
      const mine = f.pi === 0;
      return `→ ${mine ? '' : 'CPU'}${f.n}ドロー` + (mine && f.names && f.names.length ? `（引いた：${f.names.join('、')}）` : '');
    }
    return `${whose(f.pi)}${f.name}：${f.text}`;
  }
  const chainable = f => (f.type === 'ability' && f.auto) || (f.type === 'draw' && !f.turn);
  function playFx(G, list) {
    const legacy = [];
    let chain = [];
    // 能力・効果によるドローは左下の履歴へ（順番を保つため、短い間隔で予約する）
    const feed = item => schedule(350, () => pushFeed(item));
    const flushChain = () => {
      const c = chain; chain = [];
      if (!c.length || !fxShow(c[0].type === 'draw' ? 'draw' : 'ability')) return;
      if (c.length === 1) { showOne(c[0]); return; }
      const ab = c.filter(f => f.type === 'ability');
      const title = ab.length ? `${whose(ab[0].pi)}${ab[0].name}の能力` + (ab.length > 1 ? `ほか${ab.length - 1}件` : '') : 'ドロー！';
      feed({ pi: (ab[0] || c[0]).pi, title, tag: '自動処理', lines: c.map(chainLine), cardId: ab.length ? ab[0].cardId : null });
    };
    function showOne(f) {
      if (f.type === 'draw') {
        if (!fxShow(f.turn ? 'turn' : 'draw')) return;
        const mine = f.pi === 0;
        if (!f.turn) {   // 効果によるドロー：左下の履歴へ
          feed({ pi: f.pi, title: (mine ? 'ドロー！' : 'CPUドロー') + (f.n > 1 ? ` ×${f.n}` : ''), lines: mine && f.names && f.names.length ? ['引いたカード：' + f.names.join('、')] : [] });
          return;
        }
        // ターン開始のドローは、ターンが変わった合図として中央に出す
        const text = (mine ? '俺のターン、ドロー！' : 'CPUのターン、ドロー！') + (f.n > 1 ? ` ×${f.n}` : '');
        const sub = mine && f.names && f.names.length ? '引いたカード：' + f.names.join('、') : undefined;   // 自分が引いたカード名
        schedule(sub ? 1700 : 1300, () => showToast(text, { variant: mine ? 'me' : 'cpu', sub, ms: sub ? 1700 : 1300 }));
      } else if (f.type === 'ability') {
        if (!fxShow('ability')) return;
        if (f.auto) feed({ pi: f.pi, title: `${whose(f.pi)}${f.name}の能力`, tag: '自動処理', lines: f.text ? [f.text] : [], cardId: f.cardId });
        else feed({ pi: f.pi, title: `${whose(f.pi)}${f.name}の能力`, tag: f.pi === 0 && f.text ? '手動で処理' : null, lines: f.pi === 0 && f.text ? ['上の案内の「効果アシスト」から処理できます'] : [], cardId: f.cardId, manual: f.pi === 0 && !!f.text });
      }
    }
    list.forEach(f => {
      if (chainable(f)) { if (chain.length && chain[chain.length - 1].pi !== f.pi) flushChain(); chain.push(f); return; }   // プレイヤーが変わったら別の1件に
      flushChain();
      if (f.type === 'draw') {
        showOne(f);
      } else if (f.type === 'attack') {
        if (!fxShow('attack')) return;
        const text = `バトル！${f.pi === 0 ? '' : 'CPUの'}${f.names.join('・')}で攻撃！`;
        schedule(1800, () => showToast(text, { variant: 'long', ms: 1800 }));
      } else if (f.type === 'destroy') {
        if (!fxShow('destroy')) return;
        const text = `${f.manual ? '' : 'バトルの結果、'}${whose(f.pi)}${f.items.map(x => x.name).join('、')}は破壊されて墓地へ`;
        schedule(2200, () => showToast(text, { variant: 'long', ms: 2200 }));
      } else if (f.type === 'nodestroy') {
        if (!fxShow('nodestroy')) return;
        schedule(1600, () => showToast('バトルの結果、破壊されたカードはありません', { variant: 'long', ms: 1600 }));
      } else if (f.type === 'ability') {
        // 手動で処理する能力：効果アシストのバナーに出す（演出レベルに関係なく必ず）
        showOne(f);
        if (f.text) VS.assist.push({ pi: f.pi, uid: f.uid, cardId: f.cardId, name: f.name, text: f.text, kind: f.kind });
      } else if (f.type === 'win') {
        const who = f.winner === 0 ? 'あなた' : 'CPU';
        schedule(3600, () => showToast(`対戦終了！${who}の勝利！`, { variant: 'long', sub: f.reason, ms: 3600 }));
      } else if (f.type === 'legacy') {
        if (G.winner !== null) return;   // 決着がついたら遺業能力は処理しない
        if (fxShow('legacy')) schedule(1700, () => showToast(`遺業能力発動！ ${whose(f.pi)}${f.name}`, { variant: 'legacy', ms: 1700 }));
        legacy.push(f);
      }
    });
    flushChain();
    if (legacy.length) {
      VS.legacy = VS.legacy.concat(legacy);
      const wait = Math.max(0, fxCursor - Date.now());
      setTimeout(() => {
        if (VS.G !== G || G.winner !== null || !VS.legacy.length || VS.mode === 'legacy') return;
        // ブロック指定の途中なら、遺業能力を処理したあとにブロック指定へ戻る（指定済みのブロッカーはそのまま）
        if (VS.mode === 'block' && !VS.afterLegacy) VS.afterLegacy = () => { VS.mode = 'block'; render(); };
        VS.mode = 'legacy';
        render();
      }, wait);
    }
  }
  const fxWait = () => Math.max(0, fxCursor - Date.now());

  function finishLegacy() {
    VS.legacy = [];
    VS.mode = 'normal';
    const G = VS.G, next = VS.afterLegacy;
    VS.afterLegacy = null;
    if (next) { next(); return; }
    // CPUのアタック中（あなたのブロック待ち）なら、ブロック指定へ
    if (G && G.winner === null && G.battle && G.current === 1 && !G.battle.declared) { enterBlockMode(); return; }
    render();
  }

  /* ---------------- 描画 ---------------- */
  function render() {
    const G = VS.G;
    if (!G) return;
    closeMenu();
    if (G.winner !== null && !G.recorded) { G.recorded = true; recordResult(G); }   // 決着したら戦績に1回だけ記録
    if (VS.assistTurn !== G.turn) { VS.assist = []; VS.assistTurn = G.turn; }   // ターンが変わったら効果アシストを片付ける
    if (G.fx && G.fx.length) playFx(G, G.fx.splice(0));
    const root = $('vsBoard');
    // 再描画でログ欄が作り直されるので、スクロール位置を覚えておく
    const old = root.querySelector('.log-list');
    const keep = old ? { top: old.scrollTop, atBottom: old.scrollHeight - old.scrollTop - old.clientHeight < 24 } : null;
    root.innerHTML = '';
    root.appendChild(buildTopbar());   // ログ欄はこの中（固定バー）に入っている
    root.appendChild(buildBanner());
    root.appendChild(buildSide(1));
    root.appendChild(buildSide(0));
    const list = root.querySelector('.log-list');
    if (list) list.scrollTop = (!keep || keep.atBottom) ? list.scrollHeight : keep.top;   // 最新行へ自動追従
  }

  function buildTopbar() {
    const G = VS.G, me = G.players[0], cpu = G.players[1];
    const bar = el('div', 'board-topbar');

    const main = el('div', 'topbar-main');
    const stamp = el('div', 'seal-stamp');
    stamp.appendChild(el('span', 'seal-turn', `第${G.turn}ターン`));
    stamp.appendChild(el('span', 'seal-phase', G.winner !== null ? '決着' : (G.current === 0 ? 'あなた' : 'CPU')));
    main.appendChild(stamp);

    const counters = el('div', 'resource-counters');
    [['マリョク配置権', me.manaPlace], ['イジン召喚権', me.summon], ['あなたの山札', me.deck.length], ['CPUの山札', cpu.deck.length]]
      .forEach(([label, val]) => {
        const c = el('div', 'counter');
        c.appendChild(el('span', 'counter-label', label));
        c.appendChild(el('span', 'counter-value', String(val)));
        counters.appendChild(c);
      });
    main.appendChild(counters);

    const act = el('div', 'board-actions');
    const btn = (label, cls, fn, disabled) => {
      const b = el('button', 'btn ' + cls, label);
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      act.appendChild(b);
      return b;
    };
    const myTurn = G.winner === null && G.current === 0 && !VS.busy;
    if (G.winner !== null) {
      btn('再戦（同じデッキ）', 'btn-primary', rematch);
      btn('準備画面へ戻る', 'btn-ghost', endGame);
    } else if (VS.mode === 'attack') {
      btn(`アタック確定（${VS.selAtk.size}体）`, 'btn-primary', confirmAttack, VS.selAtk.size === 0);
      btn('キャンセル', 'btn-ghost', () => { VS.mode = 'normal'; VS.selAtk = new Set(); render(); });
    } else if (VS.mode === 'mulligan') {
      btn('この手札で始める', 'btn-primary', () => decideMulligan(false));
      btn('手札を引き直す（1回だけ）', 'btn-ghost', () => decideMulligan(true));
    } else if (VS.mode === 'legacy') {
      btn('遺業フェーズを終える', 'btn-primary', () => {
        if (VS.legacy.length && !confirm(`未処理の遺業能力が${VS.legacy.length}件あります。処理済みとして終了しますか？`)) return;
        finishLegacy();
      });
      const m2 = btn('手動調整 ▾', 'btn-ghost', e => openAdjustMenu(e.currentTarget));
      m2.dataset.vsmenu = '1';
    } else if (VS.mode === 'anna') {
      btn(`発動する（${VS.annaSel.size}体を手札へ）`, 'btn-primary', () => finishAnna(true), VS.annaSel.size === 0);
      btn('発動しない', 'btn-ghost', () => finishAnna(false));
    } else if (VS.mode === 'block') {
      btn('ブロック確定', 'btn-primary', confirmBlocks);
      // 遁甲式：魔力ゾーンで裏の遁甲カードを表にして発動（相手のターンのブロックステップ）
      ENG.tonkoOptions(G, 0).forEach(o => {
        const b = btn(`🀄 ${o.name}を発動 ▾`, 'btn-ghost', e => openTonkoMenu(o, e.currentTarget));
        b.dataset.vsmenu = '1';
      });
    } else {
      const canAtk = myTurn && ENG.canAct(G, 0) && !G.battleUsed && ENG.eligibleAttackers(G, 0).length > 0;
      btn('アタック宣言', 'btn-primary', startAttack, !canAtk);
      btn('ターン終了', 'btn-ghost', endMyTurn, !(myTurn && ENG.canAct(G, 0)));
      const m = btn('手動調整 ▾', 'btn-ghost', e => openAdjustMenu(e.currentTarget), VS.busy);
      m.dataset.vsmenu = '1';
      btn('対戦終了', 'btn-danger', endGame);
    }
    main.appendChild(act);
    bar.appendChild(main);
    bar.appendChild(buildLog());
    // 固定バーの1行案内（いま何をする場面か）。タップで詳しい案内の位置へ
    const st = statusLine(G);
    const line = el('button', 'vs-status' + (st.warn ? ' is-warn' : ''), st.text);
    line.type = 'button';
    line.title = '詳しい案内を表示';
    line.addEventListener('click', () => { const bn = document.querySelector('#vsBoard .vs-banner'); if (bn) bn.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    bar.appendChild(line);
    return bar;
  }
  function statusLine(G) {
    if (VS.flashMsg) return { text: '⚠ ' + VS.flashMsg, warn: true };
    if (G.winner !== null) return { text: G.winner === 0 ? '🎉 あなたの勝利！' : 'CPUの勝利…' };
    if (VS.mode === 'mulligan') return { text: '🃏 手札を引き直すか決めてください' };
    if (VS.mode === 'legacy') return { text: `🕯 遺業能力を処理してください（${VS.legacy.length}件）` };
    if (VS.mode === 'anna' && VS.trig) { const i = ENG.triggerInfo(G, VS.trig); return { text: `アンナ・パブロワ：手札に戻すイジンを選択（${VS.annaSel.size}/${i.max}）` }; }
    if (VS.mode === 'attack') return { text: `⚔ アタッカーを選んで「アタック確定」（選択 ${VS.selAtk.size}体）` };
    if (VS.mode === 'block' && G.battle) {
      const atkP = G.players[G.current];
      const lack = G.battle.attackers.map((u, i) => { const a = atkP.field.find(x => x.uid === u); if (!a) return null; const need = ENG.requiredBlockers(a, G); const n = Object.values(VS.assign).filter(v => v === u).length; return n < need ? `攻${i + 1} ${atkName(a)} あと${need - n}体` : null; }).filter(Boolean);
      const tk = ENG.tonkoOptions(G, 0).length ? '　🀄遁甲を使えます' : '';
      return lack.length ? { text: `🛡 ブロック指定中：${lack.join('、')}${tk}`, warn: true } : { text: `🛡 ブロック指定中：必要数を満たしています →「ブロック確定」${tk}` };
    }
    if (G.deferredTrig && G.deferredTrig.length) return { text: `⏳ CPUの${G.deferredTrig.map(d => d.name).join('・')}の能力が待機中` };
    if (VS.assist.length) return { text: `✦ 手動で処理する能力が${VS.assist.length}件あります` };
    if (G.current === 1) return { text: 'CPUのターン…' };
    return { text: `あなたのターン：手札のカードをクリックして行動${G.battleUsed ? '（バトルは使用済み）' : ''}` };
  }

  /* 遺業能力の「実行」ボタン（墓地に置かれたカードを、能力どおりに動かす） */
  function legacyActions(f, done0) {
    const done = () => (f.curDone || done0)();
    const G = VS.G, P = G.players[f.pi], nmx = `${whose(f.pi)}${f.name}`;
    const acts = [];
    const mv = (to, opts, label) => () => {
      const r = ENG.manualMove(G, f.pi, f.uid, 'grave', to, opts);
      if (!r.ok) { flash(r.msg); render(); return; }
      ENG.addLog(G, `遺業能力を実行：${nmx}（${label}）`);
      done();
    };
    if (!P.grave.some(x => x.uid === f.uid)) return acts;   // すでに墓地にない（手動で動かした等）
    if (/復元/.test(f.text)) acts.push({ label: '復元：魔力ゾーンに表向きで置く', fn: mv('mana', { faceUp: true }, '復元') });
    if (/魔力化/.test(f.text)) acts.push({ label: '魔力化：魔力ゾーンに裏向きで置く', fn: mv('mana', { faceUp: false }, '魔力化') });
    if (/これを手札に戻す/.test(f.text)) acts.push({ label: '手札に戻す', fn: mv('hand', {}, '手札に戻す') });
    if (/ガーディアン.{0,4}追加|山札.{0,12}ガーディアン/.test(f.text)) acts.push({ label: '山札の上から1枚をガーディアンに追加', fn: () => {
      const r = ENG.manualGuardianFromDeck(G, f.pi);
      if (!r.ok) { flash(r.msg); render(); return; }
      ENG.addLog(G, `遺業能力を実行：${nmx}（山札からガーディアン追加）`);
      done();
    } });
    if (/1ドローする/.test(f.text)) acts.push({ label: '1ドローする', fn: () => {
      const r = ENG.manualDraw(G, f.pi, 1);
      if (!r.ok) { flash(r.msg); render(); return; }
      ENG.addLog(G, `遺業能力を実行：${nmx}（1ドロー）`);
      done();
    } });
    // 冥府発動：このマホウの能力を（コストなしで）発動する。マホウの文から、手動で処理できるボタンを作る（あなたのカード）
    const card = CARDS_BY_ID[f.cardId];
    if (/冥府発動/.test(f.text) && f.pi === 0 && card && card.type === 'マホウ') {
      const e = { pi: 0, uid: f.uid, cardId: f.cardId, name: `${f.name}（冥府発動）`, text: String(card.rule_text || ''), onDone: () => done() };
      assistActions(e, () => {}).forEach(a => acts.push({ label: `冥府発動：${a.label}`, fn: anchor => a.fn(anchor) }));
    }
    if (/反魂/.test(f.text)) {
      const guards = P.field.filter(x => !x.faceUp);
      if (guards.length) acts.push({ label: '反魂：ガーディアンを山札の下へ→戦場に戻す', fn: anchor => {
        showMenu('山札の下に戻すガーディアンを選ぶ', guards.map((g, i) => ({
          label: `ガーディアン${i + 1}（裏向き）`,
          fn: () => {
            ENG.manualMove(G, f.pi, g.uid, 'field', 'deckBottom');
            ENG.manualMove(G, f.pi, f.uid, 'grave', 'field', { faceUp: true });
            ENG.addLog(G, `遺業能力を実行：${nmx}（反魂）`);
            done();
          }
        })), anchor);
      } });
    }
    return acts;
  }

  /* 能力テキストから、手動で再現できる処理のボタンを作る（自分のカード用）。それ以外は「手動調整」でフォローできる */
  const NUM = { '１': 1, '２': 2, '３': 3, '４': 4, '一': 1, '二': 2, '三': 3 };
  const num = t => (t === undefined ? 1 : (NUM[t] || Number(t) || 1));
  function assistActions(e, done) {
    const G = VS.G, P = G.players[0], acts = [];
    // 「戦場のイジン1体を指定して発動できる。そのイジンを手札に戻す」→「戦場のイジン1体を手札に戻す」と同じに読む（ストームなど）
    const text = String(e.text || '').replace(/((?:相手の|自分の)?戦場の(?:イジン|ガーディアン))1体を指定して発動できる。その(?:イジン|ガーディアン)を/g, '$11体を');
    const ok = (r, msg) => {
      if (!r.ok) { flash(r.msg); return false; }
      ENG.addLog(G, `効果を手動で処理：${e.name}（${msg}）`);
      if (e.curAct) { (e.used = e.used || new Set()).add(e.curAct); doneToast(`${whose(e.pi)}${e.name}`, e.curAct); }
      if (e.onDone) e.onDone();   // 遺業能力（冥府発動）から呼ばれたとき：遺業フェーズの行を処理済みにする
      return true;
    };
    const self = () => ['field', 'mana', 'grave'].map(z => ({ z, i: P[z].find(x => x.uid === e.uid) })).find(x => x.i);
    const pickMenu = (title, list, anchor, fn) => {
      if (!list.length) { flash('対象がありません'); return; }
      showMenu(title, list.map(it => ({ label: it.label, fn: () => fn(it) })), anchor);
    };
    const ownGuards = () => P.field.filter(x => !x.faceUp).map((x, i) => ({ inst: x, pi: 0, label: `ガーディアン${i + 1}（裏向き）` }));
    const izin = pi => G.players[pi].field.filter(x => x.faceUp && CARDS_BY_ID[x.cardId].type === 'イジン').map(x => ({ inst: x, pi, label: `${pi === 0 ? '自分' : 'CPU'}：${CARDS_BY_ID[x.cardId].name}` }));
    let m;
    if ((m = text.match(/山札の上から([0-9１-４一-三])枚(?:を|目を)?(?:裏向きの)?ガーディアン(?:にして|として)戦場に置/))) {
      const n = num(m[1]);
      acts.push({ label: `山札の上から${n}枚をガーディアンにして戦場に置く`, fn: () => { let r; for (let i = 0; i < n; i++) r = ENG.manualGuardianFromDeck(G, 0); if (ok(r, `ガーディアン追加×${n}`)) { render(); } } });
    }
    // 「自分の戦場のハイケイ1つにつき1ドローする」（行基など）：押したときの枚数を数えてドローする
    const per = text.match(/(自分の|相手の)?(戦場|魔力ゾーン|墓地)の(ハイケイ|イジン|ガーディアン|カード|マリョク)1(?:つ|体)につき([0-9１-４一-三])ドロー/);
    if (per) {
      const [, who, zone, what, k] = per;
      const countNow = () => {
        const Q = G.players[who === '相手の' ? 1 : 0], arr = { '戦場': Q.field, '魔力ゾーン': Q.mana, '墓地': Q.grave }[zone];
        return arr.filter(x => what === 'カード' ? true : what === 'ガーディアン' ? !x.faceUp : x.faceUp && CARDS_BY_ID[x.cardId].type === what).length;
      };
      const unit = { 'ハイケイ': 'つ', 'マリョク': 'つ', 'カード': 'つ' }[what] || '体';
      acts.push({ label: `${zone}の${what}${countNow()}${unit}×${num(k)}＝${countNow() * num(k)}ドローする`, fn: () => {
        const n = countNow() * num(k);
        if (!n) { flash(`${zone}に${what}がないのでドローしません`); return; }
        if (ok(ENG.manualDraw(G, 0, n), `${what}${countNow()}${unit}につき${n}ドロー`)) render();
      } });
    } else if ((m = text.match(/([0-9１-４一-三])ドロー|ドローする/))) {
      const n = num(m[1]);
      acts.push({ label: `${n}ドローする`, fn: () => { if (ok(ENG.manualDraw(G, 0, n), `${n}ドロー`)) render(); } });
    }
    // m は後続の判定で上書きされるので、押したときではなくここで数値を確定しておく
    if ((m = text.match(/イジン召喚権[+＋](\d)/))) { const n = Number(m[1]); acts.push({ label: `イジン召喚権+${n}`, fn: () => { if (ok(ENG.manualRights(G, 0, 'summon', n), `召喚権+${n}`)) render(); } }); }
    if ((m = text.match(/マリョク配置権[+＋](\d)/))) { const n = Number(m[1]); acts.push({ label: `マリョク配置権+${n}`, fn: () => { if (ok(ENG.manualRights(G, 0, 'manaPlace', n), `配置権+${n}`)) render(); } }); }
    if ((m = text.match(/山札の上から([0-9１-４一-三])枚を墓地/))) {
      const n = num(m[1]);
      acts.push({ label: `自分の山札の上から${n}枚を墓地へ`, fn: () => { if (ok(ENG.manualMill(G, 0, n), `山札${n}枚を墓地へ`)) render(); } });
    }
    if (/自分の戦場のガーディアン1体を手札に戻/.test(text)) acts.push({ label: '自分のガーディアン1体を手札に戻す', fn: a => pickMenu('手札に戻すガーディアン', ownGuards(), a, it => { if (ok(ENG.manualMove(G, 0, it.inst.uid, 'field', 'hand'), 'ガーディアンを手札へ')) render(); }) });
    if (/相手の戦場のイジン1体を手札に戻/.test(text)) acts.push({ label: '相手のイジン1体を手札に戻す', fn: a => pickMenu('手札に戻す相手のイジン', izin(1), a, it => { if (ok(ENG.manualMove(G, 1, it.inst.uid, 'field', 'hand'), `${CARDS_BY_ID[it.inst.cardId].name}を手札へ`)) render(); }) });
    if (/相手の戦場のイジン1体を破壊/.test(text)) acts.push({ label: '相手のイジン1体を破壊する', fn: a => pickMenu('破壊する相手のイジン', izin(1), a, it => { if (ok(ENG.manualDestroy(G, 1, it.inst.uid), `${CARDS_BY_ID[it.inst.cardId].name}を破壊`)) render(); }) });
    if (/戦場のイジン1体を(?:手札に戻|破壊)/.test(text) && !/相手の戦場のイジン/.test(text)) {
      const back = /手札に戻/.test(text);
      acts.push({ label: back ? 'イジン1体を手札に戻す（双方から選ぶ）' : 'イジン1体を破壊する（双方から選ぶ）', fn: a => pickMenu(back ? '手札に戻すイジン' : '破壊するイジン', izin(0).concat(izin(1)), a, it => {
        const r = back ? ENG.manualMove(G, it.pi, it.inst.uid, 'field', 'hand') : ENG.manualDestroy(G, it.pi, it.inst.uid);
        if (ok(r, `${CARDS_BY_ID[it.inst.cardId].name}を${back ? '手札へ' : '破壊'}`)) render();
      }) });
    }
    if (/手札(?:から|の)[^。]{0,14}イジン[^。]{0,14}戦場に置/.test(text)) acts.push({ label: '手札のイジンを戦場に置く', fn: a => placeFromZone('hand', a) });
    if (/墓地(?:から|の)[^。]{0,14}イジン[^。]{0,14}戦場に置/.test(text)) acts.push({ label: '墓地のイジンを戦場に置く', fn: a => placeFromZone('grave', a) });
    if (/これを手札に戻す/.test(text)) acts.push({ label: 'これを手札に戻す', fn: () => { const s = self(); if (!s) { flash('このカードは見つかりません'); return; } if (ok(ENG.manualMove(G, 0, e.uid, s.z, 'hand'), '手札に戻す')) render(); } });
    if (/これを破壊する/.test(text)) acts.push({ label: 'これを破壊する', fn: () => { if (ok(ENG.manualDestroy(G, 0, e.uid), '自壊')) render(); } });
    return acts;
  }
  /* バナーの効果ボタンの二度押し対策：押した直後の短い間はほかの効果ボタンも受け付けない
     （処理後に行が消えて、下の行のボタンが同じ位置に来ても誤って押さないように） */
  let actLockUntil = 0;
  const guarded = fn => ev => {
    const now = Date.now();
    if (now < actLockUntil) return;
    actLockUntil = now + 700;
    fn(ev.currentTarget);
  };
  const doneToast = (name, label) => showToast(`効果処理：${label}`, { variant: 'long', sub: name, ms: 1500 });

  function buildAssist(b) {
    const G = VS.G;
    VS.assist.forEach(e => {
      const mine = e.pi === 0;
      const row = el('div', 'vs-legacy-row vs-assist-row');
      row.appendChild(el('div', 'vs-legacy-name', `✦ ${whose(e.pi)}${e.name}の能力${mine ? '（手動で処理できます）' : '（自動処理されません）'}`));
      row.appendChild(el('div', 'vs-legacy-text', e.text));
      const opt = /発動できる/.test(e.text), man = /発動する/.test(e.text);
      if (opt || man) row.appendChild(el('div', 'vs-legacy-text', (opt ? '任意：発動しなくてもかまいません' : '') + (opt && man ? ' ／ ' : '') + (man ? '強制：条件を満たしたら必ず処理します' : '')));
      const acts = el('div', 'vs-banner-actions');
      if (mine) assistActions(e, () => {}).forEach(a => {
        const used = e.used && e.used.has(a.label);
        // 一度処理した効果は「✓ 処理済み」にして押せなくする（もう一度必要なら「手動調整」から）
        const bt = el('button', 'btn btn-sm ' + (used ? 'btn-ghost is-used' : 'btn-primary'), (used ? '✓ ' : '') + a.label + (used ? '（処理済み）' : ''));
        bt.dataset.vsmenu = '1';
        if (used) bt.disabled = true;
        else bt.addEventListener('click', guarded(t => { e.curAct = a.label; a.fn(t); }));
        acts.appendChild(bt);
      });
      const adj = el('button', 'btn btn-ghost btn-sm', '手動調整 ▾');
      adj.dataset.vsmenu = '1';
      adj.addEventListener('click', ev => openAdjustMenu(ev.currentTarget));
      const d = el('button', 'btn btn-ghost btn-sm', '🔍 カード詳細');
      d.addEventListener('click', () => openCardDetail(e.cardId));
      const x = el('button', 'btn btn-ghost btn-sm', opt && !man ? '発動しない' : '閉じる');
      x.addEventListener('click', () => { VS.assist.splice(VS.assist.indexOf(e), 1); render(); });
      acts.append(adj, d, x);
      row.appendChild(acts);
      b.appendChild(row);
    });
  }

  function buildBanner() {
    const G = VS.G;
    const b = el('div', 'vs-banner');
    const lines = [];
    if (G.winner !== null) {
      b.classList.add(G.winner === 0 ? 'is-win' : 'is-lose');
      lines.push(G.winner === 0 ? '🎉 あなたの勝利！' : 'CPUの勝利…');
      lines.push(G.winReason);
    } else if (VS.mode === 'mulligan') {
      lines.push('🃏 手札の引き直し：今の手札6枚で始めるか、1回だけ引き直すかを選んでください（引き直すと手札6枚を山札に戻してシャッフルし、6枚引きます。ガーディアンはそのまま）。');
      if (G.firstIdx === 1 && G.mulligan) lines.push(G.mulligan[1] === 'done' ? 'CPU（先攻）は手札を引き直しました。次はあなたが決めます。' : 'CPU（先攻）は手札をそのまま使います。次はあなたが決めます。');
      else lines.push('先攻のあなたが先に決めます。そのあとCPU（後攻）が決めます。');
    } else if (VS.mode === 'legacy') {
      lines.push('🕯 遺業フェーズ：能力を処理して「処理済み」を押してください。');
    } else if (VS.mode === 'anna' && VS.trig) {
      const info = ENG.triggerInfo(G, VS.trig);
      lines.push(`アンナ・パブロワ：手札に戻すイジンを最大${info.n}体まで選んでください（選択 ${VS.annaSel.size}/${info.max}）`);
      // 内訳：上限の理由と、選べる対象の数
      lines.push(`内訳：寝ているガーディアン あなた${info.tappedBy[0]}体・CPU${info.tappedBy[1]}体（計${info.per}体${info.annas > 1 ? ` × アンナ${info.annas}体` : ''}）→ 最大${info.n}体 ／ 戻せるイジン：あなた${info.targetsBy[0]}体・CPU${info.targetsBy[1]}体`);
      if (info.targets.length < info.n) lines.push(`⚠ 戦場に戻せるイジンが${info.targets.length}体しかいないため、選べるのは${info.targets.length}体までです${ENG.arenaOn(G, G.current) ? '' : '（裏向きのガーディアンはイジンではないので選べません）'}。`);
      lines.push('双方の戦場のイジンをクリック → 上の「発動する」。使わないなら「発動しない」。' + (ENG.arenaOn(G, G.current) ? '（円形闘技場：そのターンのガーディアンもイジンとして選べます）' : ''));
    } else if (VS.mode === 'attack') {
      if (ENG.arenaOn(G, 0)) lines.push('円形闘技場の効果：ガーディアンもパワー3000のアタッカーとして選べます。');
      lines.push('アタッカーにするイジンを（緑枠のカードから）クリックで選び、「アタック確定」を押してください。');
    } else if (VS.mode === 'block') {
      lines.push('CPUがバトルを宣言しました！ 自分の戦場の緑枠のカード（ブロッカー）をクリックして指定します（アタッカーが複数いるときは、続けて守りたいアタッカー［赤枠］をクリック）。ブロッカーは必要数だけ複数選べます。もう一度クリックすると指定を外せます。「ブロック確定」で決定。');
      const atkP = G.players[G.current];
      { const tk = ENG.tonkoOptions(G, 0); if (tk.length) lines.push(`🀄 魔力ゾーンに裏の${tk.map(o => o.name).join('・')}があります。ブロックを確定する前に、上のボタンから表にして発動できます。`); }
      if (annaRisk()) lines.push('⚠ アンナ・パブロワが戦場にいます：ガーディアンでブロックすると寝て誘発し、ブロッカーのイジンを手札に戻されることがあります。戻されたブロック分は防げません（ブロッカーの指定は終わっているため、代わりのブロックはできません）。');
      G.battle.attackers.forEach((u, i) => {
        const a = atkP.field.find(x => x.uid === u);
        if (!a) return;
        const n = Object.values(VS.assign).filter(v => v === u).length;
        const need = ENG.requiredBlockers(a, G);
        lines.push(`攻${i + 1}：${atkName(a)}（パワー${ENG.attackPowerOf(a, G)}）／必要ブロッカー${need}体以上／割当${n}体${n < need ? '　⚠不足' : ''}`);
      });
    } else if (G.current === 1) {
      lines.push('CPUのターン…');
    } else {
      lines.push(`あなたのターン（メインフェイズ）${G.battleUsed ? '　※バトルは使用済み' : ''}`);
      lines.push('手札のカードをクリックして行動できます。終わったら「ターン終了」。');
    }
    // 山札切れの注意：自分のターンが始まるときに山札が0枚だと負け（相手も同じ）
    if (G.winner === null) {
      const d0 = G.players[0].deck.length, d1 = G.players[1].deck.length;
      if (d0 <= 3) lines.push(`⚠ あなたの山札は残り${d0}枚です。あなたのターンが始まるときに山札が0枚だと負けになります。`);
      if (d1 <= 3) lines.push(`★ CPUの山札は残り${d1}枚です。CPUのターンが始まるときに山札が0枚ならあなたの勝ちです。`);
    }
    if (VS.flashMsg) lines.push('⚠ ' + VS.flashMsg);
    lines.forEach((t, i) => { const p = el('div', i === 0 ? 'vs-banner-main' : 'vs-banner-sub', t); b.appendChild(p); });
    if (G.winner === null && VS.mode === 'block' && G.battle) {
      // 相手のアタッカーの詳細を確認するボタン（カードのクリックはブロック指定に使うため）
      const atkP = G.players[G.current];
      const row = el('div', 'vs-banner-actions');
      G.battle.attackers.forEach((u, i) => {
        const a = atkP.field.find(x => x.uid === u);
        if (!a) return;
        if (!a.faceUp) return;   // 円形闘技場のガーディアンは詳細なし
        const bt = el('button', 'btn btn-ghost btn-sm', `🔍 攻${i + 1}：${CARDS_BY_ID[a.cardId].name}の詳細`);
        bt.addEventListener('click', () => openCardDetail(a.cardId));
        row.appendChild(bt);
      });
      b.appendChild(row);
    }
    if (G.winner === null && VS.assist.length) buildAssist(b);
    if (G.winner === null && G.deferredTrig && G.deferredTrig.length) {
      // ターンプレイヤー（あなた）の能力が先。CPUの能力は、あなたが処理し終えてから発動する
      const row = el('div', 'vs-legacy-row vs-assist-row');
      row.appendChild(el('div', 'vs-legacy-name', `⏳ 待機中：CPUの${G.deferredTrig.map(d => d.name).join('・')}の能力`));
      row.appendChild(el('div', 'vs-legacy-text', 'ターンプレイヤーのあなたの能力が先に解決されます。あなたの能力を処理し終えたら、このボタンでCPUの能力を発動させてください（次の行動をしたときにも自動で発動します）。待機中に戦場を離れたり裏になったりしたカードの能力は発動しません。'));
      const acts = el('div', 'vs-banner-actions');
      const bt = el('button', 'btn btn-primary btn-sm', 'CPUの能力を処理する');
      bt.addEventListener('click', guarded(() => { ENG.resolveDeferred(G); render(); }));
      acts.appendChild(bt); row.appendChild(acts); b.appendChild(row);
    }
    if (G.winner === null && VS.mode === 'legacy') {
      VS.legacy.forEach((f) => {
        const row = el('div', 'vs-legacy-row');
        row.appendChild(el('div', 'vs-legacy-name', `${whose(f.pi)}${f.name}`));
        row.appendChild(el('div', 'vs-legacy-text', f.text));
        row.appendChild(el('div', 'vs-legacy-text', '任意：発動しなくてもかまいません（そのまま「処理済み」でOK）'));
        const done = () => {
          VS.legacy.splice(VS.legacy.indexOf(f), 1);
          if (!VS.legacy.length) finishLegacy(); else render();
        };
        const acts = el('div', 'vs-banner-actions');
        const doneWith = label => () => { doneToast(`${whose(f.pi)}${f.name}（遺業能力）`, label); done(); };
        legacyActions(f, done).forEach(a => {
          const bt = el('button', 'btn btn-primary btn-sm', a.label);
          bt.dataset.vsmenu = '1';
          bt.addEventListener('click', guarded(t => { f.curDone = doneWith(a.label); a.fn(t); }));
          acts.appendChild(bt);
        });
        const d = el('button', 'btn btn-ghost btn-sm', '🔍 カード詳細');
        d.addEventListener('click', () => openCardDetail(f.cardId));
        const ok = el('button', 'btn btn-ghost btn-sm', '処理済み（手動で処理した）');
        ok.addEventListener('click', guarded(() => {
          ENG.addLog(G, `遺業能力を処理：${whose(f.pi)}${f.name}`);
          doneWith('処理済み')();
        }));
        acts.append(d, ok);
        row.appendChild(acts);
        b.appendChild(row);
      });
    }
    return b;
  }

  function buildSide(pi) {
    const G = VS.G, P = G.players[pi];
    const side = el('div', 'vs-side ' + (pi === 1 ? 'vs-cpu' : 'vs-me'));
    const title = el('h3', 'vs-side-title', pi === 1 ? 'CPU' : 'あなた');
    title.appendChild(el('small', '', `山札 ${P.deck.length}枚 ／ 手札 ${P.hand.length}枚`));
    side.appendChild(title);

    const zones = el('div', 'vs-zones');
    // CPUは上下を反転して、お互いの戦場が向かい合う配置にする
    const order = pi === 1 ? [['墓地', 'grave'], ['手札', 'hand'], ['戦場', 'field'], ['魔力ゾーン', 'mana']]
      : [['戦場', 'field'], ['魔力ゾーン', 'mana'], ['墓地', 'grave'], ['手札', 'hand']];
    order.forEach(([label, key]) => {
      const z = el('div', 'zone');
      const t = el('h3', 'zone-title', label);
      t.appendChild(el('span', 'zone-count', `(${P[key].length})`));
      z.appendChild(t);
      if (key === 'mana' && pi === 0) z.appendChild(buildManaSummary(el('div', 'mana-summary'), P.mana, ENG.manaInfo(P)));
      if (key === 'field') {
        // 戦場は「イジン・ガーディアン」と「ハイケイ」の段に分けて表示する
        const isHaikei = inst => inst.faceUp && CARDS_BY_ID[inst.cardId].type === 'ハイケイ';
        const main = el('div', 'zone-cards');
        P.field.filter(x => !isHaikei(x)).forEach(inst => main.appendChild(mini(inst, pi, key)));
        const hk = P.field.filter(isHaikei);
        const hrow = el('div', 'haikei-row' + (hk.length ? '' : ' is-empty'));
        hrow.appendChild(el('div', 'haikei-row-label', 'ハイケイ'));
        const hwrap = el('div', 'zone-cards haikei-cards');
        hk.forEach(inst => hwrap.appendChild(mini(inst, pi, key)));
        hrow.appendChild(hwrap);
        // CPU側は上下反転の配置なので、ハイケイ段を相手寄り（上）ではなく外側に置く
        if (pi === 1) { z.appendChild(hrow); z.appendChild(main); } else { z.appendChild(main); z.appendChild(hrow); }
      } else {
        const wrap = el('div', 'zone-cards');
        P[key].forEach(inst => wrap.appendChild(mini(inst, pi, key)));
        z.appendChild(wrap);
      }
      zones.appendChild(z);
    });
    side.appendChild(zones);
    return side;
  }

  function mini(inst, pi, zone) {
    const G = VS.G, card = CARDS_BY_ID[inst.cardId];
    const e = el('div', 'mini-card');
    const faceDown = (zone === 'mana' || zone === 'field') && !inst.faceUp;
    const hidden = pi === 1 && (zone === 'hand' || faceDown);

    if (hidden || faceDown) {
      e.classList.add('is-facedown');
      e.textContent = zone === 'field' ? 'ガーディアン' : zone === 'hand' ? '手札' : '裏向き';
    } else {
      e.appendChild(el('div', 'mini-card-name', card.name));
      e.appendChild(el('div', 'mini-card-meta', `${card.type} ・ ${statText(inst)}`));
      const kw = card.type === 'イジン' ? kwText(inst) : '';
      if (kw) e.appendChild(el('div', 'mini-card-meta', kw));
      if (zone === 'field' && inst.equips && inst.equips.length) e.classList.add('has-equips');
      e.classList.add('has-level');
      e.appendChild(miniLevelBadge(card));
    }
    if (zone === 'field' && inst.tapped) e.classList.add('is-tapped');
    if (zone === 'field' && inst.faceUp) {   // 状態表示：破壊されない＝赤枠、能力禁止中＝青枠（右下に小さく表示）
      const ind = ENG.isIndestructible(G, inst), sil = !!inst.silenced;
      if (ind) e.classList.add('is-indestructible');
      if (sil) e.classList.add('is-silenced');
      if (ind || sil) {
        const box = el('div', 'mini-card-states');
        if (ind) box.appendChild(el('span', 'st-ind', '破壊されない'));
        if (sil) box.appendChild(el('span', 'st-sil', '能力禁止中'));
        e.appendChild(box);
      }
    }
    if (zone === 'field' && inst.faceUp && card.type === 'イジン' && inst.placedTurn === G.turn) { e.classList.add('has-new'); e.appendChild(el('span', 'mini-card-new', 'New')); }
    // 新しく引いたカード（自分のターンを終えるまで表示）
    if (zone === 'hand' && pi === 0 && inst.drawnSeq && inst.drawnSeq > (G.players[0].seenSeq || 0)) { e.classList.add('is-drawn'); e.appendChild(el('span', 'mini-card-drawn', '引いた')); }

    // バトル表示・選択状態
    const tag = (text, extra) => { const t = el('span', 'mini-card-tag ' + (extra || ''), text); e.appendChild(t); };
    if (G.battle && zone === 'field' && pi === G.current && G.battle.attackers.includes(inst.uid)) {
      tag('攻' + (G.battle.attackers.indexOf(inst.uid) + 1));
      e.classList.add('is-attacker');
      if (VS.mode === 'block' && VS.selBlocker !== null) e.classList.add('is-selectable');
    }
    if (zone === 'field' && !inst.faceUp && inst.isGuardian && ENG.arenaOn(G, pi) && !inst.tapped) tag('闘技3000');
    if (VS.mode === 'anna' && zone === 'field' && ((inst.faceUp && card.type === 'イジン') || (!inst.faceUp && ENG.arenaOn(G, pi)))) {
      e.classList.add(VS.annaSel.has(pi + ':' + inst.uid) ? 'is-selected' : 'is-selectable');
    }
    if (VS.mode === 'attack' && pi === 0 && zone === 'field') {
      if (ENG.eligibleAttackers(G, 0).some(x => x.uid === inst.uid)) e.classList.add(VS.selAtk.has(inst.uid) ? 'is-selected' : 'is-selectable');
    }
    if (VS.mode === 'block' && pi === 0 && zone === 'field') {
      if (ENG.eligibleBlockers(G, 0).some(x => x.uid === inst.uid)) {
        e.classList.add(VS.selBlocker === inst.uid ? 'is-selected' : 'is-selectable');
        if (VS.assign[inst.uid] !== undefined) tag('守→攻' + (G.battle.attackers.indexOf(VS.assign[inst.uid]) + 1), 'tag-block');
      }
    }
    if (!(pi === 1 && zone === 'hand')) e.addEventListener('click', () => onCardClick(inst, pi, zone, e));
    e.dataset.uid = inst.uid;
    // 装備されているカードは、イジンの下に少し重ねて表示（装備テキストだけが有効。クリックで詳細・外す）
    if (zone === 'field' && inst.faceUp && inst.equips && inst.equips.length) {
      const stack = el('div', 'equip-stack' + (inst.tapped ? ' is-tapped-host' : ''));
      stack.appendChild(e);
      inst.equips.forEach(q => {
        const qc = CARDS_BY_ID[q.cardId];
        const slip = el('div', 'equip-slip', '⚔ ' + qc.name);
        slip.title = '装備：' + (String(qc.rule_text || '').match(/装備\s*(?:（[^）]*）)?\s*[:：]\s*([\s\S]*)$/) || ['', ''])[1].replace(/\s+/g, ' ');
        slip.addEventListener('click', ev => {
          ev.stopPropagation();
          const items = [{ label: `装備カードの詳細：${qc.name}`, fn: () => openCardDetail(qc.id) }];
          if (pi === 0) items.push({ label: `装備を外す（${q.origin && q.origin.zone === 'field' ? '戦場' : q.origin && q.origin.zone === 'grave' ? '墓地' : '魔力ゾーン'}に戻る）`, fn: () => run(ENG.manualUnequip(G, pi, inst.uid, q.uid)) });
          showMenu(`装備：${qc.name}`, items, slip);
        });
        stack.appendChild(slip);
      });
      return stack;
    }
    return e;
  }

  function buildLog() {
    const panel = el('div', 'log-panel');
    panel.appendChild(el('h3', 'zone-title', 'ログ'));
    const list = el('div', 'log-list');
    VS.G.log.slice(-200).forEach(entry => {
      const e = (typeof entry === 'string') ? { t: '', m: entry } : entry;
      const row = el('div', 'log-row');
      row.appendChild(el('span', 'log-time', e.t || ''));
      row.appendChild(el('span', 'log-msg', e.m));
      list.appendChild(row);
    });
    panel.appendChild(list);
    return panel;
  }

  /* ---------------- クリック処理 ---------------- */
  function onCardClick(inst, pi, zone, anchor) {
    const G = VS.G;
    if (VS.busy) return;
    if (VS.mode === 'mulligan') { if (inst.faceUp || (pi === 0 && zone === 'hand')) openCardDetail(inst.cardId); return; }   // 引き直しを決めるまでは見るだけ
    if (VS.mode === 'anna') {
      if (zone === 'field' && ((inst.faceUp && CARDS_BY_ID[inst.cardId].type === 'イジン') || (!inst.faceUp && ENG.arenaOn(G, pi)))) {
        const key = pi + ':' + inst.uid, info = ENG.triggerInfo(G, VS.trig);
        if (VS.annaSel.has(key)) VS.annaSel.delete(key);
        else if (VS.annaSel.size < info.n) VS.annaSel.add(key);
        else { flash(`選べるのは${info.n}体までです`); return; }
        render();
      }
      return;
    }
    if (VS.mode === 'attack') {
      if (pi === 0 && zone === 'field' && ENG.eligibleAttackers(G, 0).some(x => x.uid === inst.uid)) {
        if (VS.selAtk.has(inst.uid)) VS.selAtk.delete(inst.uid); else VS.selAtk.add(inst.uid);
        render();
      }
      return;
    }
    if (VS.mode === 'block') {
      if (pi === 0 && zone === 'field' && ENG.eligibleBlockers(G, 0).some(x => x.uid === inst.uid)) {
        if (VS.assign[inst.uid] !== undefined) { delete VS.assign[inst.uid]; VS.selBlocker = null; }
        else if (G.battle.attackers.length === 1) {   // アタッカーが1体ならワンクリックで割当
          const at = G.players[1].field.find(x => x.uid === G.battle.attackers[0]);
          if (!ENG.canBlockAttacker(G, inst, at)) { flash('このアタッカーはそのカードにブロックされません'); return; }
          VS.assign[inst.uid] = G.battle.attackers[0]; VS.selBlocker = null;
        }
        else VS.selBlocker = inst.uid;
        render();
      } else if (pi === 1 && zone === 'field' && G.battle.attackers.includes(inst.uid) && VS.selBlocker !== null) {
        const bl = G.players[0].field.find(x => x.uid === VS.selBlocker);
        if (bl && !ENG.canBlockAttacker(G, bl, inst)) { flash('このアタッカーはそのカードにブロックされません'); return; }
        VS.assign[VS.selBlocker] = inst.uid;
        VS.selBlocker = null;
        render();
      }
      return;
    }
    if (pi === 0 && zone === 'hand') openHandMenu(inst, anchor);
    else openManualMenu(inst, pi, zone, anchor);
  }

  /* イジン召喚のあと：装備させられるカードがあれば選ぶ（任意）。そのあとカード詳細を出す */
  function afterSummon(inst, card) {
    const G = VS.G, host = G.players[0].field.find(x => x.uid === inst.uid);
    const cands = host ? ENG.equipCandidates(G, 0, host) : [];
    if (!cands.length) { openCardDetail(card.id); return; }
    const anchor = document.querySelector(`.mini-card[data-uid="${inst.uid}"]`) || document.body;
    showMenu(`${card.name}に装備させますか？（任意）`, cands.map(o => ({
      label: `⚔ ${o.name}を装備させる（${{ mana: '魔力ゾーン', field: '戦場', grave: '墓地' }[o.zone]}から）`,
      fn: () => { run(ENG.manualEquip(G, 0, o.uid, o.zone, inst.uid)); }
    })).concat(['-', { label: '装備させない', fn: () => openCardDetail(card.id) }]), anchor);
  }

  function openHandMenu(inst, anchor) {
    const G = VS.G, P = G.players[0], card = CARDS_BY_ID[inst.cardId];
    const can = ENG.canAct(G, 0) && !VS.busy;
    const items = [];
    items.push({
      label: 'マリョク配置（表）' + (card.type !== 'マリョク' ? '（マリョクのみ）' : ''),
      disabled: !can || card.type !== 'マリョク' || P.manaPlace < 1,
      fn: () => run(ENG.placeMana(G, 0, inst.uid, true))
    });
    items.push({
      label: 'マリョク配置（裏）',
      disabled: !can || P.manaPlace < 1,
      fn: () => run(ENG.placeMana(G, 0, inst.uid, false))
    });
    if (card.type === 'イジン') {
      const info = ENG.summonInfo(G, 0, card);
      const prob = ENG.playProblems(G, 0, card);
      const noRight = P.summon < 1;
      let label = 'イジン召喚';
      if (info.auto > 0) label += `（Lv−${info.auto}）`;
      if (noRight) label += '（不可：召喚権なし）';
      else if (prob.length) label += `（不可：${prob[0]}）`;
      items.push({
        label,
        // 軽減を手動で足せば召喚できる場合があるので、条件未達でもモーダルを開けるようにする
        disabled: !can || noRight,
        fn: () => {
          const needModal = info.auto > 0 || info.hints.length > 0 || prob.length > 0;
          // 召喚したら、マホウの使用時と同じようにカード詳細を表示する（戦場に置かれたとき等の効果を確認するため）
          if (!needModal) { if (run(ENG.summon(G, 0, inst.uid)).ok) afterSummon(inst, card); return; }
          openSummonModal(card, {
            base: info.base, auto: info.auto, parts: info.parts, hints: info.hints,
            flips: info.flips.map(f => f.name)
          }, extra => ({ problems: ENG.playProblems(G, 0, card, extra), note: manaText(P) }),
          extra => { if (run(ENG.summon(G, 0, inst.uid, extra)).ok) afterSummon(inst, card); }, { allowForce: false });
        }
      });
    } else if (['ハイケイ', 'マホウ'].includes(card.type)) {
      const prob = ENG.playProblems(G, 0, card);
      const base = { 'ハイケイ': 'ハイケイ使用', 'マホウ': 'マホウ使用' }[card.type];
      items.push({
        label: base + (prob.length ? `（不可：${prob[0]}）` : ''),
        disabled: !can || prob.length > 0,
        fn: () => {
          if (card.type === 'ハイケイ') { if (run(ENG.useHaikei(G, 0, inst.uid)).ok) openCardDetail(card.id); }   // イジン召喚と同じく、設置したらカード詳細を表示
          else openPayModal(inst);
        }
      });
    }
    items.push('-');
    items.push({ label: 'カード詳細を見る', fn: () => openCardDetail(card.id) });
    items.push('-');
    if (card.type === 'イジン') items.push({ label: '【手動】効果で戦場に置く（召喚権を使わない）', fn: () => { const r = ENG.manualMove(G, 0, inst.uid, 'hand', 'field', { faceUp: true }); if (r.ok) { ENG.addLog(G, `効果で戦場に置く：${card.name}（手札から）`); render(); } else flash(r.msg); } });
    items.push({ label: '【手動】墓地に置く', fn: () => run(ENG.manualMove(G, 0, inst.uid, 'hand', 'grave')) });
    items.push({ label: '【手動】山札の上に戻す', fn: () => run(ENG.manualMove(G, 0, inst.uid, 'hand', 'deckTop')) });
    items.push({ label: '【手動】山札の下に戻す', fn: () => run(ENG.manualMove(G, 0, inst.uid, 'hand', 'deckBottom')) });
    showMenu(card.name, items, anchor);
  }

  /* 効果でイジンを戦場に置く（召喚権は使わない）。手札／墓地から選ぶ */
  function placeFromZone(zone, anchor) {
    const G = VS.G, P = G.players[0];
    const list = P[zone].filter(x => CARDS_BY_ID[x.cardId].type === 'イジン');
    if (!list.length) { flash(zone === 'hand' ? '手札にイジンがありません' : '墓地にイジンがありません'); return; }
    setTimeout(() => showMenu(zone === 'hand' ? '手札から戦場に置くイジン' : '墓地から戦場に置くイジン', list.map(x => {
      const c = CARDS_BY_ID[x.cardId];
      return { label: `${c.name}（Lv${c.level}・${ENG.powerOf(x, G)}）`, fn: () => {
        const r = ENG.manualMove(G, 0, x.uid, zone, 'field', { faceUp: true });
        if (r.ok) { ENG.addLog(G, `効果で戦場に置く：${c.name}（${zone === 'hand' ? '手札' : '墓地'}から）`); render(); } else flash(r.msg);
      } };
    }), anchor), 0);
  }

  function openManualMenu(inst, pi, zone, anchor) {
    const G = VS.G, card = CARDS_BY_ID[inst.cardId];
    const visible = pi === 0 || inst.faceUp || zone === 'grave';
    const mv = (to, opts) => () => run(ENG.manualMove(G, pi, inst.uid, zone, to, opts));
    const items = [];
    if (zone === 'field') items.push({ label: inst.tapped ? '起こす' : '寝かせる', fn: () => { const r = ENG.manualTap(G, pi, inst.uid); if (!r.ok) flash(r.msg); else pumpTriggers(render); } });
    if (pi === 0 && (zone === 'field' || zone === 'mana')) {
      items.push({ label: inst.faceUp ? '裏にする' : '表にする', fn: () => run(ENG.manualFlip(G, pi, inst.uid, zone)) });
    }
    if (zone === 'field' && inst.faceUp && card.type === 'イジン') {
      items.push({ label: 'パワー +1000（このターン）', fn: () => run(ENG.manualPower(G, pi, inst.uid, 1000)) });
      items.push({ label: 'パワー −1000（このターン）', fn: () => run(ENG.manualPower(G, pi, inst.uid, -1000)) });
      items.push({ label: inst.noIjin ? '「イジンにブロックされない」を解除' : '「イジンにブロックされない」を得る（このターン）', fn: () => run(ENG.manualNoIjin(G, pi, inst.uid)) });
    }
    if (zone === 'field' && inst.faceUp) {
      const st = (kind, name, onLabel) => {
        if (inst[kind]) items.push({ label: `${name}を解除`, fn: () => run(ENG.manualState(G, pi, inst.uid, kind, 'off')) });
        else {
          items.push({ label: `${onLabel}（このターンの間）`, fn: () => run(ENG.manualState(G, pi, inst.uid, kind, 'turn')) });
          items.push({ label: `${onLabel}（解除するまで）`, fn: () => run(ENG.manualState(G, pi, inst.uid, kind, 'keep')) });
        }
      };
      st('indestructible', '「破壊されない」', '「破壊されない」を得る');
      st('silenced', '「能力禁止中」', '能力は発動しない（能力禁止）');
    }
    if (zone === 'field' && inst.faceUp && inst.equips && inst.equips.length) {
      inst.equips.forEach(e => {
        const en = CARDS_BY_ID[e.cardId].name;
        items.push({ label: `装備を外す：${en}（元の場所へ戻る）`, fn: () => run(ENG.manualUnequip(G, pi, inst.uid, e.uid)) });
        items.push({ label: `装備カードの詳細：${en}`, fn: () => openCardDetail(e.cardId) });
      });
    }
    const fieldEquip = zone === 'field' && inst.faceUp && card.type === 'ハイケイ' && /装備させてもよい/.test(card.rule_text || '');   // 安宅船・蒸気機関車など
    if ((['mana', 'grave', 'hand'].includes(zone) || fieldEquip) && visible) {
      const hosts = G.players[pi].field.filter(x => x.faceUp && x !== inst && CARDS_BY_ID[x.cardId].type === 'イジン');
      if (hosts.length) items.push({ label: 'イジンに装備させる…', fn: () => showMenu(`「${card.name}」を装備させるイジン`, hosts.map(h => ({
        label: CARDS_BY_ID[h.cardId].name + (h.equips && h.equips.length ? `（装備${h.equips.length}）` : ''),
        fn: () => run(ENG.manualEquip(G, pi, inst.uid, zone, h.uid))
      })), anchor) });
    }
    if (items.length) items.push('-');
    items.push({ label: '手札に戻す', fn: mv('hand') });
    if (zone !== 'field') items.push({ label: '戦場に置く（表）', fn: mv('field', { faceUp: true }) });
    if (zone !== 'mana') {
      items.push({ label: '魔力ゾーンに置く（表）', fn: mv('mana', { faceUp: true }) });
      items.push({ label: '魔力ゾーンに置く（裏）', fn: mv('mana', { faceUp: false }) });
    }
    if (zone === 'field') items.push({ label: '破壊する（遺業能力を誘発）', fn: () => run(ENG.manualDestroy(G, pi, inst.uid)) });
    if (zone !== 'grave') items.push({ label: zone === 'field' ? '墓地に置く（戦場から＝遺業能力を誘発）' : '墓地に置く（遺業なし）', fn: mv('grave') });
    items.push({ label: '山札の上に戻す', fn: mv('deckTop') });
    items.push({ label: '山札の下に戻す', fn: mv('deckBottom') });
    if (visible) { items.push('-'); items.push({ label: 'カード詳細を見る', fn: () => openCardDetail(card.id) }); }
    const title = visible ? card.name : (zone === 'field' ? 'ガーディアン（裏向き）' : '裏向きのカード');
    showMenu((pi === 1 ? '【CPU】' : '') + title, items, anchor);
  }

  /* 遁甲式：ガーディアン（山札の上に戻す）またはアタッカーを選んで発動 */
  function openTonkoMenu(o, anchor) {
    const G = VS.G, P = G.players[0], atkP = G.players[G.current];
    const go = opt => {
      const r = ENG.useTonko(G, 0, o.uid, opt);
      if (!r.ok) { flash(r.msg); return; }
      // いなくなったアタッカー・ブロッカーの指定を外す
      Object.keys(VS.assign).forEach(k => {
        if (!G.battle || !G.battle.attackers.includes(VS.assign[k]) || !P.field.some(x => x.uid === Number(k))) delete VS.assign[k];
      });
      if (VS.selBlocker != null && !P.field.some(x => x.uid === VS.selBlocker)) VS.selBlocker = null;
      render();
      if (r.noAttackers && G.winner === null) { VS.assign = {}; confirmBlocks(); }   // アタッカーがいなくなったらバトル終了へ
    };
    const items = [];
    if (o.needAttacker) {
      G.battle.attackers.forEach(u => {
        const a = atkP.field.find(x => x.uid === u);
        if (a) items.push({ label: `${a.faceUp ? CARDS_BY_ID[a.cardId].name : 'ガーディアン'}をアタッカーでない状態にする`, fn: () => go({ attackerUid: u }) });
      });
    } else {
      const gs = P.field.filter(x => !x.faceUp && x.isGuardian);
      gs.forEach((g, i) => items.push({ label: `ガーディアン${i + 1}（${CARDS_BY_ID[g.cardId].name}${g.tapped ? '・寝' : ''}）を山札の上に戻して発動`, fn: () => go({ guardianUid: g.uid }) }));
      if (!gs.length) items.push({ label: 'ガーディアンがいないので、戻さずに発動する', fn: () => go({}) });   // 戻すのはコストではなく効果の一部
    }
    items.push('-', { label: '🔍 カード詳細', fn: () => openCardDetail(CARDS_BY_ID[P.mana.find(m => m.uid === o.uid).cardId].id) });
    showMenu(`${o.name}：${o.label}`, items, anchor);
  }
  function openAdjustMenu(anchor) {
    const G = VS.G;
    showMenu('手動調整（カード効果の処理用）', [
      { label: 'あなたが1枚ドロー', fn: () => run(ENG.manualDraw(G, 0, 1)) },
      { label: '山札の上から1枚をガーディアンに追加', fn: () => run(ENG.manualGuardianFromDeck(G, 0)) },
      { label: '手札のイジンを戦場に置く（効果）…', fn: () => placeFromZone('hand', anchor) },
      { label: '墓地のイジンを戦場に置く（効果）…', fn: () => placeFromZone('grave', anchor) },
      { label: 'マリョク配置権 +1', fn: () => run(ENG.manualRights(G, 0, 'manaPlace', 1)) },
      { label: 'イジン召喚権 +1', fn: () => run(ENG.manualRights(G, 0, 'summon', 1)) },
      '-',
      { label: 'CPUの山札の上から1枚を墓地へ', fn: () => run(ENG.manualMill(G, 1, 1)) },
      { label: 'CPUの山札の上から1枚をガーディアンに追加', fn: () => run(ENG.manualGuardianFromDeck(G, 1)) },
      { label: 'CPUが1枚ドロー', fn: () => run(ENG.manualDraw(G, 1, 1)) },
      { label: 'あなたの山札の上から1枚を墓地へ', fn: () => run(ENG.manualMill(G, 0, 1)) }
    ], anchor);
  }

  /* ---------------- マホウ使用（魔力コストの支払い） ---------------- */
  function openPayModal(inst) {
    const G = VS.G, P = G.players[0], card = CARDS_BY_ID[inst.cardId];
    const cost = card.magic_cost || 0;
    const finish = (pay) => {
      closeModal();
      const r = ENG.useMahou(G, 0, inst.uid, pay);
      if (!r.ok) { flash(r.msg); return; }
      noteEffect(card);
      openCardDetail(card.id);
    };
    if (cost === 0) { finish([]); return; }

    const chosen = new Set();
    modalContent.classList.remove('detail-face');
    modalContent.innerHTML = '';
    modalContent.appendChild(el('h3', '', `${card.name}：魔力コスト${cost}`));
    modalContent.appendChild(el('div', 'm-meta', `墓地に置く魔力ゾーンのカードを${cost}枚選んでください（効果は使用後に手動で処理します）`));
    const okBtn = el('button', 'btn btn-primary', '使用する');
    const refreshOk = () => { okBtn.disabled = chosen.size !== cost; okBtn.textContent = `使用する（${chosen.size}/${cost}）`; };
    P.mana.forEach(m => {
      const c = CARDS_BY_ID[m.cardId];
      const b = el('button', 'pay-item', m.faceUp ? `表：${c.name}（Lv${c.level}・${c.color}）` : `裏向き：${c.name}`);
      b.addEventListener('click', () => {
        if (chosen.has(m.uid)) { chosen.delete(m.uid); b.classList.remove('is-selected'); }
        else if (chosen.size < cost) { chosen.add(m.uid); b.classList.add('is-selected'); }
        refreshOk();
      });
      modalContent.appendChild(b);
    });
    const row = el('div', 'btn-row');
    okBtn.addEventListener('click', () => finish([...chosen]));
    row.appendChild(okBtn);
    const cancel = el('button', 'btn btn-ghost', 'やめる');
    cancel.addEventListener('click', closeModal);
    row.appendChild(cancel);
    modalContent.appendChild(row);
    refreshOk();
    modalOverlay.classList.add('is-open');
  }

  /* ---------------- アンナ・パブロワの誘発（プレイヤー側のみ。CPUはエンジンが自動処理） ---------------- */
  function pumpTriggers(next) {
    const G = VS.G;
    G.triggers = (G.triggers || []).filter(t => ENG.triggerInfo(G, t).valid);
    if (!G.triggers.length || G.winner !== null) { G.triggers = []; next(); return; }
    if (VS.pumping || VS.mode === 'anna') {   // すでに誘発の処理中：終わってから続きを実行する
      const prev = VS.afterAnna;
      VS.afterAnna = () => { if (prev) prev(); next(); };
      return;
    }
    VS.pumping = true; VS.busy = true; render();
    setTimeout(() => {
      VS.pumping = false;
      if (VS.G !== G) return;
      VS.trig = G.triggers[0]; VS.annaSel = new Set(); VS.afterAnna = next;
      VS.annaPrev = (VS.mode === 'legacy' && VS.legacy.length) ? 'legacy' : 'normal';
      VS.mode = 'anna'; VS.busy = false; render();
    }, fxWait() + 100);
  }
  function finishAnna(use) {
    const G = VS.G, t = VS.trig, next = VS.afterAnna;
    const targets = use ? [...VS.annaSel].map(k => { const [pi, uid] = k.split(':'); return { pi: Number(pi), uid: Number(uid) }; }) : [];
    ENG.resolveAnna(G, t, targets);
    VS.mode = VS.annaPrev === 'legacy' && VS.legacy.length ? 'legacy' : 'normal';
    VS.trig = null; VS.annaSel = new Set(); VS.afterAnna = null;
    render();   // 先に盤面とメニューを通常表示へ戻す
    pumpTriggers(next || render);
  }

  /* ---------------- バトル操作 ---------------- */
  function startAttack() {
    VS.mode = 'attack';
    VS.selAtk = new Set();
    render();
  }

  function confirmAttack() {
    const G = VS.G;
    const r = ENG.declareAttack(G, 0, [...VS.selAtk]);
    if (!r.ok) { flash(r.msg); return; }
    VS.mode = 'normal'; VS.selAtk = new Set();
    const proceed = () => {
      VS.busy = true;
      render();
      setTimeout(() => {
        ENG.cpuAutoBlock(G);   // CPUがブロックを選んでバトル解決（ガーディアンが寝る誘発があれば先に処理）
        render();
        // 演出が終わるまで操作を止める。勝海舟などで自分のターンが終わっていたら、CPUのターンを始める
        const fin = () => setTimeout(() => { VS.busy = false; render(); if (G.winner === null && G.current === 1) runCpu(); }, fxWait() + 80);
        if (G.battle && G.battle.pending) pumpTriggers(() => { ENG.resolvePending(G); render(); fin(); });
        else fin();
      }, Math.max(900, fxWait() + 200));
    };
    pumpTriggers(proceed);   // アンナ・パブロワなどの誘発があれば先に処理
  }

  function enterBlockMode() {
    // 遺業能力の処理が残っているなら、先にそちらを済ませてからブロック指定へ
    if (VS.legacy.length) {
      VS.afterLegacy = () => enterBlockMode();
      if (VS.mode !== 'legacy') { VS.mode = 'legacy'; render(); }
      return;
    }
    VS.mode = 'block';
    VS.assign = {};
    VS.selBlocker = null;
    render();
  }

  /* アンナ・パブロワがいる状態で、ガーディアンをブロッカーに指定しているか（寝る→誘発して戻されるおそれ） */
  function annaRisk() {
    const G = VS.G;
    if (!ENG.annaOnField(G)) return false;
    return Object.keys(VS.assign).some(k => { const x = G.players[0].field.find(y => y.uid === Number(k)); return x && !x.faceUp; });
  }

  function confirmBlocks() {
    const G = VS.G;
    const atkP = G.players[G.current];
    const lacking = G.battle.attackers.some(u => {
      const a = atkP.field.find(x => x.uid === u);
      const n = Object.values(VS.assign).filter(v => v === u).length;
      return a && n < ENG.requiredBlockers(a, G);
    });
    if (lacking && !confirm('防ぎきれないアタッカーがいます。このまま確定するとあなたの負けになります。確定しますか？')) return;
    if (annaRisk() && !confirm('戦場にアンナ・パブロワがいます。ガーディアンでブロックすると寝て誘発し、ブロッカーのイジンを手札に戻されることがあります（戻されたブロックの分は防げず、他のカードで代わりにブロックすることもできません）。このまま確定しますか？')) return;
    const r = ENG.declareBlocks(G, 0, VS.assign);
    if (!r.ok) { flash(r.msg); return; }
    VS.mode = 'normal'; VS.assign = {}; VS.selBlocker = null;
    render();
    const after = () => { if (G.winner === null) runCpu(); };
    if (r.pending) pumpTriggers(() => { ENG.resolvePending(G); render(); after(); });
    else after();
  }

  /* ---------------- ターン進行 / CPU ---------------- */
  function endMyTurn() {
    const G = VS.G;
    const r = ENG.endTurn(G, 0);
    if (!r.ok) { flash(r.msg); return; }
    render();
    if (G.winner === null && G.current === 1) runCpu();
  }

  function runCpu() {
    const G = VS.G;
    if (!G || G.winner !== null || VS.busy) return;
    VS.busy = true;
    render();
    const step = () => {
      if (VS.G !== G) { VS.busy = false; return; }          // 対戦終了済み
      if (VS.legacy.length && VS.mode !== 'legacy' && fxWait() === 0 && G.winner === null) { VS.busy = false; VS.mode = 'legacy'; render(); VS.busy = true; }   // 遺業フェーズが表示されていなければ表示する（止まらないように）
      if (VS.legacy.length || VS.mode === 'legacy' || fxWait() > 0) { setTimeout(step, Math.max(250, fxWait() + 60)); return; }   // 演出・遺業フェーズが終わるまで待つ
      const r = ENG.cpuStep(G);
      if (r === 'continue') { render(); setTimeout(step, 700); return; }
      VS.busy = false;
      if (r === 'await_block') {
        render();
        pumpTriggers(() => { VS.busy = true; render(); setTimeout(() => { VS.busy = false; enterBlockMode(); }, fxWait() + 100); });
      }
      else render();
    };
    setTimeout(step, 600);
  }
})();
