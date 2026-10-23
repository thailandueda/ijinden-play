/* ============================================================
   初手・展開チェッカー（ソロプレイタブ）
   デッキを何千回もシャッフルして、初手のマリョク枚数・ターンごとの魔力ゾーン上限・
   イジンを召喚できる確率・色がそろう確率・キーカードを引ける確率を集計する。
   相手の妨害やカード効果は考えない「一人回し」の目安。
   プレイ方針（簡易）：毎ターン 1枚マリョク配置 → 出せるイジンのうち一番レベルの高いものを1体召喚
   ============================================================ */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const TURNS = 6;
  const COLORS = ['赤', '青', '緑', '黄', '紫'];
  const TONKO = /魔力ゾーンのこれを表にして|これが魔力ゾーンに裏で置かれている/;   // 裏で置くのが前提のカード
  const colorsOf = c => [...String(c.color || '')].filter(ch => COLORS.includes(ch));
  const SR = window.IjindenSummon;

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function manaState(mana) {
    let cap = 0; const colors = new Set();
    mana.forEach(m => { if (m.faceUp) { const c = CARDS_BY_ID[m.cardId]; cap += c.level || 0; colorsOf(c).forEach(ch => colors.add(ch)); } else cap += 1; });
    return { cap, colors };
  }

  /* 1回分のシミュレーション。first: 先攻か / mull: マリョク0枚なら1回引き直す */
  function runOnce(list, first, mull, keyNames) {
    let uid = 1;
    const mk = (cardId, faceUp) => ({ uid: uid++, cardId, faceUp });
    const deck = shuffle(list.slice());
    let hand = deck.splice(-6);
    const guardians = deck.splice(-4);
    const isMaryoku = id => CARDS_BY_ID[id].type === 'マリョク';
    const opening = hand.slice();
    let mulled = false;
    if (mull && !hand.some(isMaryoku)) {   // 手札6枚を山札に戻してシャッフルし、6枚引き直す（ガーディアンはそのまま）
      deck.push(...hand); shuffle(deck); hand = deck.splice(-6); mulled = true;
    }
    const out = {
      openMaryoku: opening.filter(isMaryoku).length,
      openIjin: opening.filter(id => CARDS_BY_ID[id].type === 'イジン').length,
      mulled,
      guardKeys: keyNames.map(n => guardians.some(id => CARDS_BY_ID[id].name === n)),
      turns: []
    };
    const mana = [], field = [];
    const seenKey = keyNames.map(n => hand.some(id => CARDS_BY_ID[id].name === n));
    out.openKeys = seenKey.slice();   // 初手（引き直したあとの6枚）にあるか
    out.handMaryoku = hand.filter(isMaryoku).length;   // 引き直したあとの初手のマリョク枚数
    let summoned = 0;
    for (let t = 1; t <= TURNS; t++) {
      if (!(first && t === 1) && deck.length) hand.push(deck.pop());
      keyNames.forEach((n, i) => { if (!seenKey[i] && hand.some(id => CARDS_BY_ID[id].name === n)) seenKey[i] = true; });
      // マリョク配置：足りない色を足せるマリョク → レベルの高いマリョク → なければ一番レベルの高いカードを裏で
      if (hand.length) {
        const st = manaState(mana);
        const need = new Set(hand.filter(id => CARDS_BY_ID[id].type === 'イジン').flatMap(id => colorsOf(CARDS_BY_ID[id])).filter(ch => !st.colors.has(ch)));
        let best = -1, bestScore = -Infinity, faceUp = false;
        hand.forEach((id, i) => {
          const c = CARDS_BY_ID[id];
          if (c.type !== 'マリョク' || TONKO.test(c.rule_text || '')) return;
          const cs = colorsOf(c);
          const score = (cs.some(ch => need.has(ch)) ? 100 : cs.some(ch => !st.colors.has(ch)) ? 50 : 0) + (c.level || 0);
          if (score > bestScore) { bestScore = score; best = i; faceUp = true; }
        });
        if (best < 0) {
          hand.forEach((id, i) => {
            const c = CARDS_BY_ID[id];
            const score = (TONKO.test(c.rule_text || '') ? 100 : 0) + (c.level || 0);
            if (score > bestScore) { bestScore = score; best = i; faceUp = false; }
          });
        }
        mana.push(mk(hand.splice(best, 1)[0], faceUp));
      }
      // イジン召喚：出せるもののうちレベルが一番高いもの
      const st = manaState(mana);
      let pick = -1, pickLv = -1;
      hand.forEach((id, i) => {
        const c = CARDS_BY_ID[id];
        if (c.type !== 'イジン') return;
        const red = SR ? SR.analyze(c, mana, field, CARDS_BY_ID).auto : 0;
        const lv = Math.max(0, (c.level || 0) - red);
        if (lv > st.cap || colorsOf(c).some(ch => !st.colors.has(ch))) return;
        if ((c.level || 0) > pickLv) { pickLv = c.level || 0; pick = i; }
      });
      let did = false;
      if (pick >= 0) {
        const c = CARDS_BY_ID[hand[pick]];
        const flips = SR ? SR.analyze(c, mana, field, CARDS_BY_ID).flips : [];
        field.push(mk(hand.splice(pick, 1)[0], true));
        flips.forEach(f => { const m = mana.find(x => x.uid === f.uid); if (m) m.faceUp = false; });
        summoned++; did = true;
      }
      const after = manaState(mana);
      out.turns.push({ cap: after.cap, colors: after.colors, did, summoned, keys: seenKey.slice(), hand: hand.length });
    }
    return out;
  }

  const pct = (n, d) => d ? Math.round(n / d * 1000) / 10 : 0;
  const bar = p => `<span class="hc-bar"><span style="width:${Math.min(100, p)}%"></span></span>`;
  const cell = p => `<td>${p.toFixed(1)}%${bar(p)}</td>`;

  function render(res, opts) {
    const N = res.length;
    const deckColors = COLORS.filter(ch => opts.list.some(id => CARDS_BY_ID[id].type === 'イジン' && colorsOf(CARDS_BY_ID[id]).includes(ch)));
    const counts = Array(7).fill(0); res.forEach(r => counts[r.openMaryoku]++);
    const avgIjin = res.reduce((s, r) => s + r.openIjin, 0) / N;
    const mulRate = pct(res.filter(r => r.mulled).length, N);
    const nMar = opts.list.filter(id => CARDS_BY_ID[id].type === 'マリョク').length;
    let h = `<div class="hc-summary">${N.toLocaleString()}回シャッフルした結果（${opts.first ? '先攻' : '後攻'}・デッキ${opts.list.length}枚・うちマリョク${nMar}枚${opts.mull ? `・マリョク0枚なら引き直し（${mulRate}%で引き直し）` : ''}）</div>`
      + (!opts.first && $('hcMull').checked ? '<p class="hc-note">※ 手札の引き直しは先攻だけなので、後攻では引き直しなしで数えています。</p>' : '');
    h += '<h3 class="hc-h">初手6枚のマリョク枚数</h3><table class="vs-stats-table hc-table"><tr><th>枚数</th><th>確率</th></tr>';
    counts.forEach((c, k) => { if (k <= 5 || c) h += `<tr><td class="vs-stats-name">${k}枚${k === 0 ? '（事故）' : ''}</td>${cell(pct(c, N))}</tr>`; });
    h += `</table><p class="hc-note">初手のイジンは平均${avgIjin.toFixed(1)}枚。マリョク0枚の初手は${pct(counts[0], N)}%です。${opts.mull ? `引き直したあとも0枚のままになるのは${pct(res.filter(r => r.handMaryoku === 0).length, N)}%です。` : ''}</p>`;
    h += '<h3 class="hc-h">ターンごとの展開</h3><div class="hc-scroll"><table class="vs-stats-table hc-table"><tr><th>ターン</th><th>魔力上限<br>（平均）</th><th>イジンを<br>召喚できた</th><th>召喚数<br>（累計平均）</th>'
      + deckColors.map(ch => `<th>${ch}が使える</th>`).join('') + '</tr>';
    for (let t = 0; t < TURNS; t++) {
      const ts = res.map(r => r.turns[t]).filter(Boolean);
      const avgCap = ts.reduce((s, x) => s + x.cap, 0) / ts.length;
      const avgSum = ts.reduce((s, x) => s + x.summoned, 0) / ts.length;
      h += `<tr><td class="vs-stats-name">${t + 1}ターン目</td><td>${avgCap.toFixed(1)}</td>${cell(pct(ts.filter(x => x.did).length, ts.length))}<td>${avgSum.toFixed(1)}体</td>`
        + deckColors.map(ch => cell(pct(ts.filter(x => x.colors.has(ch)).length, ts.length))).join('') + '</tr>';
    }
    h += '</table></div>';
    if (opts.keys.length) {
      h += '<h3 class="hc-h">キーカードを手札に引けている確率（累計）</h3><div class="hc-scroll"><table class="vs-stats-table hc-table"><tr><th>カード</th><th>初手</th>'
        + Array.from({ length: TURNS }, (_, t) => `<th>${t + 1}T</th>`).join('') + '<th>1枚以上が<br>ガーディアンに</th></tr>';
      opts.keys.forEach((n, i) => {
        const copies = opts.list.filter(id => CARDS_BY_ID[id].name === n).length;
        h += `<tr><td class="vs-stats-name">${n}（${copies}枚）</td>${cell(pct(res.filter(r => r.openKeys[i]).length, N))}`
          + Array.from({ length: TURNS }, (_, t) => cell(pct(res.filter(r => r.turns[t] && r.turns[t].keys[i]).length, N))).join('')
          + `${cell(pct(res.filter(r => r.guardKeys[i]).length, N))}</tr>`;
      });
      h += '</table></div>';
    }
    h += '<p class="hc-note">※ 毎ターン「マリョク1枚配置 → 出せるうちで一番レベルの高いイジンを1体召喚」とした場合の目安です。カード効果（ドロー・サーチなど）や相手の妨害は含みません。サークル系のレベル軽減は計算に入れています。ガーディアンになったカードは手札に来ません。</p>';
    $('hcResult').innerHTML = h;
  }

  function fillKeys(list) {
    const names = [...new Set(list.map(id => CARDS_BY_ID[id].name))].sort((a, b) => a.localeCompare(b, 'ja'));
    ['hcKey1', 'hcKey2', 'hcKey3'].forEach(k => {
      const sel = $(k), prev = sel.value;
      sel.innerHTML = '<option value="">（なし）</option>' + names.map(n => `<option>${n}</option>`).join('');
      if (names.includes(prev)) sel.value = prev;
    });
  }
  function deckList() {
    const d = getDeckByKey($('soloDeckSelect').value);
    if (!d) return null;
    const list = [];
    Object.entries(d.cards).forEach(([id, n]) => { if (CARDS_BY_ID[id]) for (let i = 0; i < n; i++) list.push(id); });
    return list;
  }

  function run() {
    const list = deckList();
    if (!list || list.length < 10) { $('hcResult').innerHTML = '<p class="hc-note">デッキを選んでください（10枚以上）。</p>'; return; }
    const first = $('fFirst').querySelector('.is-active') ? $('fFirst').querySelector('.is-active').dataset.val === 'first' : true;
    const mull = $('hcMull').checked && first;   // 手札の引き直しは先攻のプレイヤーだけ
    const keys = ['hcKey1', 'hcKey2', 'hcKey3'].map(k => $(k).value).filter(Boolean);
    const N = Number($('hcTrials').value) || 3000;
    $('hcResult').innerHTML = '<p class="hc-note">計算中…</p>';
    setTimeout(() => {
      const res = [];
      for (let i = 0; i < N; i++) res.push(runOnce(list, first, mull, keys));
      render(res, { list, first, mull, keys });
    }, 30);
  }

  function init() {
    if (!$('hcRun')) return;
    $('hcRun').addEventListener('click', run);
    const refresh = () => { const l = deckList(); if (l) fillKeys(l); $('hcResult').innerHTML = ''; };
    $('soloDeckSelect').addEventListener('change', refresh);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
