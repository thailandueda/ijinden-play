/* ============================================================
   イジンデン CPU対戦エンジン（DOMに依存しない純粋ロジック）
   - 公式ルールカードに沿った: 準備 / フェイズ / 配置・召喚・使用の条件 /
     バトル（アタック→ブロック→解決）/ 勝利条件
   - カード効果の自動処理はしない（基本キーワードのみ対応）
       対応: 即応 / ウォッチャー / ダブル・トリプル・クアドラプルプレッシャー /
             モータル / パワー+N・アタック+N・ブロック+N（常時・無条件のもの）
   - プレイヤー番号: 0 = あなた, 1 = CPU
   ============================================================ */
(function (root) {
  'use strict';

  const KW_RE = /^(即応|ウォッチャー|ダブルプレッシャー|トリプルプレッシャー|クアドラプルプレッシャー|モータル|(?:パワー|アタック|ブロック)\+\d+)$/;
  const PRESSURE = { 'ダブルプレッシャー': 2, 'トリプルプレッシャー': 3, 'クアドラプルプレッシャー': 4 };
  const COLOR_CHARS = '赤青緑黄紫';

  const SR = (typeof module !== 'undefined' && module.exports) ? require('./summon-rules.js') : root.IjindenSummon;

  function create(cardsById, rngFn) {
    const rng = rngFn || Math.random;
    let uidSeq = 1;
    const parseCache = {};

    const cardOf = inst => cardsById[inst.cardId];
    const rand = arr => arr[Math.floor(rng() * arr.length)];
    function shuffle(a) {
      const r = a.slice();
      for (let i = r.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [r[i], r[j]] = [r[j], r[i]];
      }
      return r;
    }

    /* ---------- カードのキーワード解析（無条件のものだけ） ---------- */
    function parseCard(card) {
      if (parseCache[card.id]) return parseCache[card.id];
      const info = { haste: false, watcher: false, mortal: false, pressure: 1, power: 0, attack: 0, block: 0, noIjinBlock: false, noBlockMaxPower: -1, cantBlock: false };
      String(card.rule_text || '').split(/\n\s*\n/).forEach(para => {
        const tokens = para.replace(/[（(][^）)]*[）)]/g, ' ').trim().split(/\s+/).filter(Boolean);
        if (!tokens.length || !tokens.every(t => KW_RE.test(t))) return;
        tokens.forEach(t => {
          if (t === '即応') info.haste = true;
          else if (t === 'ウォッチャー') info.watcher = true;
          else if (t === 'モータル') info.mortal = true;
          else if (PRESSURE[t]) info.pressure = Math.max(info.pressure, PRESSURE[t]);
          else {
            const m = t.match(/^(パワー|アタック|ブロック)\+(\d+)$/);
            if (m) info[{ 'パワー': 'power', 'アタック': 'attack', 'ブロック': 'block' }[m[1]]] += Number(m[2]);
          }
        });
      });
      // ブロックに関する常在能力（キーワード以外の定型文）
      String(card.rule_text || '').split(/\n+/).forEach(raw => {
        const line = raw.trim();
        let m;
        if (/^イジン(から|に)ブロックされない。?$/.test(line)) info.noIjinBlock = true;
        else if ((m = line.match(/^パワー(\d+)以下のイジンにブロックされない。?$/))) info.noBlockMaxPower = Number(m[1]);
        else if (/^ブロッカーになれない。?$/.test(line)) info.cantBlock = true;
      });
      parseCache[card.id] = info;
      return info;
    }
    const NEUTRAL_KW = Object.freeze({ haste: false, watcher: false, mortal: false, pressure: 1, power: 0, attack: 0, block: 0 });
    /* ---------- 装備：装備しているイジンは「装備：」の文を得る（装備されたカードは、それ以外の特性をすべて失う） ---------- */
    const equipBody = c => { const m = String(c.rule_text || '').match(/(?:^|\n)\s*装備\s*(?:（[^）]*）)?\s*[:：]\s*([\s\S]*)$/); return m ? m[1].trim() : ''; };
    const equipCache = {};
    function equipInfo(c) {   // 装備の文から、キーワード・色・パワー・魔力レベルを読む
      if (equipCache[c.id]) return equipCache[c.id];
      const body = normTxt(equipBody(c)), out = { kw: { haste: false, watcher: false, mortal: false, pressure: 1, power: 0, attack: 0, block: 0 }, colors: [], perColor: 0, cap: 0 };
      body.replace(/（[^）]*）/g, ' ').split(/[\s　]+/).filter(Boolean).every(t => {
        if (!KW_RE.test(t)) return false;
        if (t === '即応') out.kw.haste = true; else if (t === 'ウォッチャー') out.kw.watcher = true; else if (t === 'モータル') out.kw.mortal = true;
        else if (PRESSURE[t]) out.kw.pressure = Math.max(out.kw.pressure, PRESSURE[t]);
        else { const m = t.match(/^(パワー|アタック|ブロック)\+(\d+)$/); if (m) out.kw[{ 'パワー': 'power', 'アタック': 'attack', 'ブロック': 'block' }[m[1]]] += Number(m[2]); }
        return true;
      });
      const cm = body.match(/「色\s*[:：]\s*([^」]+)」/); if (cm) out.colors = [...cm[1]].filter(ch => COLOR_CHARS.includes(ch));
      const pc = body.match(/これの色1つにつき「パワー\+(\d+)」を得る/); if (pc) out.perColor = Number(pc[1]);
      const cp = body.match(/自分の魔力ゾーンの合計レベル\+(\d+)する/); if (cp) out.cap = Number(cp[1]);
      return (equipCache[c.id] = out);
    }
    const equipsOf = inst => (inst.faceUp && !inst.silenced && inst.equips && inst.equips.length ? inst.equips.map(e => equipInfo(cardOf(e))) : []);
    const kwOf = inst => {
      if (!inst.faceUp || inst.silenced) return NEUTRAL_KW;
      const base = parseCard(cardOf(inst)), eq = equipsOf(inst);
      if (!eq.length) return base;
      const k = Object.assign({}, base);
      eq.forEach(e => { const q = e.kw; k.haste = k.haste || q.haste; k.watcher = k.watcher || q.watcher; k.mortal = k.mortal || q.mortal; k.pressure = Math.max(k.pressure, q.pressure); k.power += q.power; k.attack += q.attack; k.block += q.block; });
      return k;
    };   // 裏向き・能力禁止中は能力を持たない   // 裏向き（ガーディアン）は能力を持たない
    const ARENA_POWER = 3000;
    /* 円形闘技場：自分のターンの間、自分の戦場のガーディアンは「即応」を持つパワー3000のイジンでもある */
    const arenaOn = (G, pi) => G.current === pi && G.players[pi].field.some(x => x.faceUp && !x.silenced && cardOf(x).name === '円形闘技場');
    const isGuardianInst = x => !x.faceUp && x.isGuardian;
    const basePower = c => (typeof c.power === 'number' ? c.power : 0);
    /* 戦場の常在能力によるパワー増減（「これが戦場にいる間、自分の戦場の「剣術」イジンは「パワー+1000」を得る」など）。
       書式が決まっているものだけ自動で数え、それ以外は手動（カードメニューの「パワー±1000」）で足せる */
    const normTxt = t => String(t || '').replace(/＋/g, '+').replace(/[－−]/g, '-');
    const hasTrait = (card, k) => String(card.trait || '').includes(k);
    const auraCache = {};
    function aurasOf(card) {
      if (auraCache[card.id]) return auraCache[card.id];
      const out = [];
      String(card.rule_text || '').split(/\n+/).forEach(raw => {
        const line = normTxt(raw).trim();
        if (!line || /装備|躍進|なら|限り|たび|発動|とき|レベル/.test(line)) return;
        let m;
        if ((m = line.match(/^(?:これが戦場(?:に|に)?(?:いる|ある)間、|この能力は、?戦場で効果を発揮する。)?(自分|相手)の戦場の(他の)?(?:「([^」]+)」|([赤青緑黄紫])の)?イジン(?:すべて)?は「パワー([+-])(\d+)」を得る。?$/))) {
          out.push({ kind: 'static', side: m[1], others: !!m[2], trait: m[3], color: m[4], n: (m[5] === '-' ? -1 : 1) * Number(m[6]) });
        } else if ((m = line.match(/^相手のターンの間「パワー\+(\d+)」を得る。?$/)) || (m = line.match(/相手のターンに戦場で効果を発揮する。これは「パワー\+(\d+)」/))) {
          out.push({ kind: 'oppTurn', n: Number(m[1]) });
        } else if ((m = line.match(/(自分の|相手の|)(戦場|墓地|魔力ゾーン)(?:の|にある)(裏の)?(?:「([^」]+)」)?(イジン|ハイケイ|ガーディアン|カード|マリョク)(?:1体|1つ)につき(?:、これは)?「パワー([+-])(\d+)」を得る/))) {
          out.push({ kind: 'count', owner: m[1], zone: m[2], back: !!m[3], trait: m[4], what: m[5], n: (m[6] === '-' ? -1 : 1) * Number(m[7]) });
        }
      });
      auraCache[card.id] = out;
      return out;
    }
    function countFor(G, pi, a) {
      const owners = a.owner === '自分の' ? [pi] : a.owner === '相手の' ? [1 - pi] : [0, 1];
      let n = 0;
      owners.forEach(o => {
        const P = G.players[o];
        const arr = a.zone === '戦場' ? P.field : a.zone === '墓地' ? P.grave : P.mana;
        arr.forEach(x => {
          const c = cardOf(x);
          if (a.trait && !hasTrait(c, a.trait)) return;
          let ok;
          if (a.what === 'ガーディアン') ok = !x.faceUp;
          else if (a.what === 'カード') ok = a.back ? !x.faceUp : true;
          // 円形闘技場が有効な間は、戦場のガーディアンもイジンとして数える（例：武帝「自分の戦場のイジン1体につき」）
          else if (a.what === 'イジン' && a.zone === '戦場') ok = asIjin(G, o, x) && !(a.trait && !x.faceUp);
          else ok = x.faceUp && c.type === a.what;
          if (ok) n++;
        });
      });
      return n;
    }
    function auraPower(G, inst) {
      if (!G || !inst.faceUp) return 0;
      let loc = -1;
      for (let pi = 0; pi < 2; pi++) if (G.players[pi].field.includes(inst)) loc = pi;
      if (loc < 0) return 0;
      let total = 0;
      for (let pi = 0; pi < 2; pi++) {
        G.players[pi].field.forEach(src => {
          if (!src.faceUp || src.silenced) return;
          aurasOf(cardOf(src)).forEach(a => {
            if (a.kind === 'static') {
              if (cardOf(inst).type !== 'イジン') return;
              if ((a.side === '自分' ? pi : 1 - pi) !== loc) return;
              if (a.others && src === inst) return;
              if (a.trait && !hasTrait(cardOf(inst), a.trait)) return;
              if (a.color && !String(cardOf(inst).color || '').includes(a.color)) return;
              total += a.n;
            } else if (src === inst) {
              if (a.kind === 'oppTurn') { if (G.current !== pi) total += a.n; }
              else total += a.n * countFor(G, pi, a);
            }
          });
        });
      }
      return total;
    }
    /* 書式が特殊な常在能力（第2弾）：姜維「自分の戦場の他の黄のイジンは「即応 ウォッチャー パワー+3000」を得る」、
       ピョートル大帝「「航海」を持つイジンが自分の戦場にいる間「パワー+3000」」、仁王「イジンがちょうど2体いる間、ウォッチャー」 */
    const ownerOf = (G, inst) => (G ? G.players.findIndex(P => P.field.includes(inst)) : -1);
    /* ---------- 第5弾：常在ルール（両プレイヤー） ---------- */
    // ピラー「自分と相手は、戦場と魔力ゾーンの能力を発動できない。自分はマホウ使用できない」（魔力ゾーンで表のとき）
    const PILLAR_RE = /自分と相手は、戦場と魔力ゾーンの能力を発動できない/;
    const isPillar = c => PILLAR_RE.test(c.rule_text || '');
    const pillarOn = G => G.players.some(P => P.mana.some(m => m.faceUp && isPillar(cardOf(m))));
    const pillarMahouBan = (G, pi) => G.players[pi].mana.some(m => m.faceUp && isPillar(cardOf(m)) && /自分はマホウ使用できない/.test(cardOf(m).rule_text || ''));
    // オリーブの枝「自分と相手の戦場のレベル5以上でないイジンは、アタッカーにもブロッカーにもなれない」
    const oliveMin = G => { let n = 0; G.players.forEach(P => P.mana.forEach(m => { const mm = m.faceUp && normTxt(cardOf(m).rule_text).match(/自分と相手の戦場のレベル(\d+)以上でないイジンは、アタッカーにもブロッカーにもなれない/); if (mm) n = Math.max(n, Number(mm[1])); })); return n; };
    const fieldSrc = (G, q, re) => G.players[q].field.find(x => x.faceUp && x.silenced !== true && x.silenced !== 'turn' && re.test(normTxt(cardOf(x).rule_text)) && (x.silenced !== 'aura' || LOSE_IMMUNE.test(normTxt(cardOf(x).rule_text))));
    const LOSE_IMMUNE = /この能力は、?能力によって失われない/;
    /* 「能力すべてを失う」常在能力（黒田官兵衛・藤原不比等・小林虎三郎）。状態が変わるたびに付け直す（silenced = 'aura'） */
    function syncSilence(G) {
      if (!G || !G.players) return;
      [0, 1].forEach(o => {
        const q = 1 - o;   // q の戦場のカードが、o の能力の対象
        const kuroda = G.players[o].field.some(x => x.faceUp && !x.tapped && (!x.silenced || x.silenced === 'aura') && /この能力は、これが起きているなら、戦場で効果を発揮する。相手の戦場のハイケイは能力すべてを失う/.test(normTxt(cardOf(x).rule_text)));
        const fuhito = fieldSrc(G, o, /相手の戦場のレベル(\d+)以下の寝ているイジンは、能力すべてを失う/);
        const fLim = fuhito ? Number(normTxt(cardOf(fuhito).rule_text).match(/相手の戦場のレベル(\d+)以下の寝ているイジン/)[1]) : -1;
        const mozart = fieldSrc(G, o, /これが戦場にいる間、相手の戦場の「音楽」イジンと、相手の墓地のカードは能力すべてを失う/);
        const kobayashi = fieldSrc(G, o, /この能力は、相手の魔力ゾーンに裏のカードがあるなら、戦場で効果を発揮する。相手の戦場の起きているイジンは、能力すべてを失う/) && G.players[q].mana.some(m => !m.faceUp);
        const ezo = ezoOn(G, q);   // 蝦夷共和国は自分の戦場の「志願」イジンに効く
        G.players[q].field.forEach(y => {
          if (!y.faceUp) return;
          const c = cardOf(y), t = normTxt(c.rule_text);
          const should = !LOSE_IMMUNE.test(t) && ((kuroda && c.type === 'ハイケイ') || (ezo && c.type === 'イジン' && traitOn(G, y, '志願')) ||
            (c.type === 'イジン' && ((fLim >= 0 && y.tapped && (c.level || 0) <= fLim) || (kobayashi && !y.tapped) || (mozart && hasTrait(c, '音楽')))));
          if (should && !y.silenced) y.silenced = 'aura';
          else if (!should && y.silenced === 'aura') y.silenced = false;
        });
      });
    }
    // 「剣術」を持つか（武者の蔵「自分の戦場のレベル2以下のイジンは「特性：剣術」を得る」）
    const traitOn = (G, x, t) => { if (hasTrait(cardOf(x), t)) return true; const o = ownerOf(G, x); if (o < 0) return false;
      if (t === '剣術') return (cardOf(x).level || 0) <= 2 && !!fieldSrc(G, o, /自分の戦場のレベル2以下のイジンは「特性：剣術」を得る/);
      // 蝦夷共和国「ガーディアンが自分の戦場にいない間、自分の戦場のレベル4以下のイジンは「特性：志願」を得る」
      if (t === '志願') return (cardOf(x).level || 0) <= 4 && !G.players[o].field.some(isGuardianInst) && !!fieldSrc(G, o, /ガーディアンが自分の戦場にいない間、自分の戦場のレベル4以下のイジンは「特性：志願」を得る/);
      return false; };
    // 蝦夷共和国「自分の戦場の「志願」イジンは「モータル」を得て、他の能力すべてを失う」
    const ezoOn = (G, o) => !!fieldSrc(G, o, /これが戦場にある間、自分の戦場の「志願」イジンは「モータル」を得て、他の能力すべてを失う/);
    const ezoMortal = (G, x) => { const o = ownerOf(G, x); return o >= 0 && x.faceUp && cardOf(x).type === 'イジン' && ezoOn(G, o) && traitOn(G, x, '志願'); };
    // 勝鬨を持つか（風林火山「自分の戦場の「剣術」イジンは「勝鬨 - …」を得る」）
    const hasKachidoki = (G, x) => { if (!x.faceUp || x.silenced || cardOf(x).type !== 'イジン') return false; if (/勝鬨 - /.test(cardOf(x).rule_text || '')) return true;
      const o = ownerOf(G, x); return o >= 0 && traitOn(G, x, '剣術') && !!fieldSrc(G, o, /自分の戦場の「剣術」イジンは「勝鬨 - /); };
    function grantsTo(G, inst) {   // その他のカードから与えられるキーワード・パワー
      const out = { haste: false, watcher: false, power: 0 };
      if (!G || !inst.faceUp || cardOf(inst).type !== 'イジン') return out;
      const o = ownerOf(G, inst); if (o < 0) return out;
      const F = G.players[o].field;
      F.forEach(src => {
        if (!src.faceUp || src.silenced) return;
        const t = normTxt(cardOf(src).rule_text);
        const m = t.match(/自分の戦場の他の(赤|青|緑|黄|紫)のイジンは「([^」]*)」を得る/);
        if (m && src !== inst && ijinHasColor(G, inst, m[1])) {
          if (/即応/.test(m[2])) out.haste = true;
          if (/ウォッチャー/.test(m[2])) out.watcher = true;
          const pm = m[2].match(/パワー\+(\d+)/); if (pm) out.power += Number(pm[1]);
        }
        if (/イジンが自分の戦場に、?ちょうど2体いる間、自分の戦場のイジンは「ウォッチャー」を得る/.test(t) && F.filter(x => x.faceUp && cardOf(x).type === 'イジン').length === 2) out.watcher = true;
      });
      // 久坂玄瑞「赤か紫のカードが戦場にある間「即応」／緑か黄のカードが戦場にある間「ウォッチャー」」
      if (!inst.silenced && /赤か紫のカードが戦場にある間「即応」を得る/.test(cardOf(inst).rule_text || '')) {
        const has = chs => G.players.some(Q => Q.field.some(x => x.faceUp && chs.some(ch => String(cardOf(x).color || '').includes(ch))));
        if (has(['赤', '紫'])) out.haste = true;
        if (has(['緑', '黄'])) out.watcher = true;
      }
      if (fieldSrc(G, o, /自分の戦場の「航海」を持つイジンは「即応」を得る/) && /航海 - /.test(cardOf(inst).rule_text || '')) out.haste = true;   // フランソワ1世
      if (fieldSrc(G, o, /自分の戦場の「剣術」イジンは「即応」を得る/) && traitOn(G, inst, '剣術')) out.haste = true;   // 武者の蔵
      // 殿「自分のターンの間、相手の手札のカードが自分の手札のカードよりも多いなら、自分の戦場のイジンは「パワー+5000」を得る」
      const tono = fieldSrc(G, o, /この能力は、自分のターンの間、相手の手札のカードが自分の手札のカードよりも多いなら、戦場で効果を発揮する。自分の戦場のイジンは「パワー\+(\d+)」を得る/);
      if (tono && G.current === o && G.players[1 - o].hand.length > G.players[o].hand.length) out.power += Number(normTxt(cardOf(tono).rule_text).match(/自分の戦場のイジンは「パワー\+(\d+)」/)[1]);
      // 黄金時代「相手の手札のカードが3つ以下なら、相手の戦場のイジンは「パワー-1000」を得る」
      const gold = fieldSrc(G, 1 - o, /この能力は、相手の手札のカードが(\d+)つ以下なら、戦場で効果を発揮する。相手の戦場のイジンは「パワー-(\d+)」を得る/);
      if (gold) { const gm = normTxt(cardOf(gold).rule_text).match(/相手の手札のカードが(\d+)つ以下なら[^。]*。相手の戦場のイジンは「パワー-(\d+)」/); if (G.players[o].hand.length <= Number(gm[1])) out.power -= Number(gm[2]); }
      // 蒸気機関車（装備）「これが戦場にいる間、自分の戦場のイジンは、自分の戦場のハイケイ1つにつき「パワー+500」を得る」
      F.forEach(h => { if (!h.faceUp || h.silenced || !h.equips) return; h.equips.forEach(e => { const m = normTxt(equipBody(cardOf(e))).match(/自分の戦場のイジンは、自分の戦場のハイケイ1つにつき「パワー\+(\d+)」を得る/); if (m) out.power += Number(m[1]) * F.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ').length; }); });
      equipsOf(inst).forEach(e => { if (e.perColor) out.power += e.perColor * COLOR_CHARS.split('').filter(ch => ijinHasColor(G, inst, ch)).length; });   // シルククローク
      const gh = normTxt(cardOf(inst).rule_text).match(/カードが墓地に(\d+)枚以上ある間「即応/);   // レオニダス
      if (gh && !inst.silenced && G.players[o].grave.length >= Number(gh[1])) out.haste = true;
      const pt = normTxt(cardOf(inst).rule_text).match(/「航海」を持つイジンが自分の戦場にいる間「パワー\+(\d+)」を得る/);
      if (pt && !inst.silenced && F.some(x => x.faceUp && /航海 - /.test(cardOf(x).rule_text || ''))) out.power += Number(pt[1]);
      return out;
    }
    // イジンの色（英傑集う大河「自分の戦場の黄のイジンは「色：赤 青 緑」を得る」、曹丕の執筆「このターン「色：黄」」も含む）
    function ijinHasColor(G, inst, ch) {
      const c = cardOf(inst);
      if (String(c.color || '').includes(ch)) return true;
      if (equipsOf(inst).some(e => e.colors.includes(ch))) return true;   // 装備「色：黄」など
      if (!G) return false;
      // 火と氷の大地「相手の戦場のレベル2以下のイジンは「色：赤」を得る」
      if (ch === '赤' && c.type === 'イジン' && (c.level || 0) <= 2) { const ow = ownerOf(G, inst); if (ow >= 0 && fieldSrc(G, 1 - ow, /これが戦場にある間、相手の戦場のレベル2以下のイジンは「色：赤」を得る/)) return true; }
      if (G.yellowTurn === G.turn && ch === '黄') return true;
      const o = ownerOf(G, inst);
      if (o >= 0 && String(c.color || '').includes('黄') && ['赤', '青', '緑'].includes(ch) &&
        G.players[o].field.some(x => x.faceUp && !x.silenced && /自分の戦場の黄のイジンは「色：赤 青 緑」を得る/.test(normTxt(cardOf(x).rule_text)))) return true;
      return false;
    }
    const hasHaste = (G, x) => kwOf(x).haste || grantsTo(G, x).haste || x.hasteTurn === (G && G.turn);
    const hasWatcher = (G, x) => kwOf(x).watcher || grantsTo(G, x).watcher;
    // 足利義満「自分の戦場の他のイジンは「アタック+1000」を得る」
    function auraAttack(G, inst) {
      const o = ownerOf(G, inst); if (o < 0 || !inst.faceUp) return 0;
      // 天下分け目の主戦場「カードが魔力ゾーンに5つ以上ある間、自分の戦場のイジンは「アタック+2000」を得る」
      const tenka = cardOf(inst).type === 'イジン' ? G.players[o].field.filter(x => x.faceUp && !x.silenced && /カードが魔力ゾーンに(\d+)つ以上ある間、自分の戦場のイジンは「アタック\+(\d+)」を得る/.test(normTxt(cardOf(x).rule_text)))
        .reduce((t, x) => { const m = normTxt(cardOf(x).rule_text).match(/カードが魔力ゾーンに(\d+)つ以上ある間、自分の戦場のイジンは「アタック\+(\d+)」/); return t + (G.players[o].mana.length >= Number(m[1]) ? Number(m[2]) : 0); }, 0) : 0;
      return tenka + G.players[o].field.reduce((t, src) => {
        if (!src.faceUp || src.silenced) return t;
        if (src === inst) { const ms = normTxt(cardOf(src).rule_text).match(/これが戦場にいる間、自分の戦場の「([^」]+)」イジンは「アタック\+(\d+)」を得る/); return t + (ms && hasTrait(cardOf(inst), ms[1]) ? Number(ms[2]) : 0); }
        const m = normTxt(cardOf(src).rule_text).match(/これが戦場にいる間、自分の戦場の他のイジンは「アタック\+(\d+)」を得る/);
        const m2 = normTxt(cardOf(src).rule_text).match(/これが戦場にいる間、自分の戦場の「([^」]+)」イジンは「アタック\+(\d+)」を得る/);   // 直江兼続
        return t + (m ? Number(m[1]) : 0) + (m2 && hasTrait(cardOf(inst), m2[1]) ? Number(m2[2]) : 0);
      }, 0);
    }
    const powerOf = (inst, G) => basePower(cardOf(inst)) + kwOf(inst).power + auraPower(G, inst) + grantsTo(G, inst).power + (inst.powerMod || 0);
    const attackPowerOf = (inst, G) => (inst.faceUp ? powerOf(inst, G) + kwOf(inst).attack + (G ? auraAttack(G, inst) : 0) : ARENA_POWER);
    /* 「これが戦場にいる間、自分の戦場のイジンは「ブロック+1000」を得る」（孔子） */
    function auraBlock(G, inst) {
      if (!G || !inst.faceUp || cardOf(inst).type !== 'イジン') return 0;
      const loc = G.players.findIndex(P => P.field.includes(inst));
      if (loc < 0) return 0;
      let t = 0;
      G.players[loc].field.forEach(src => {
        if (!src.faceUp || src.silenced) return;
        const m = normTxt(cardOf(src).rule_text).match(/これが戦場にいる間、自分の戦場の(他の)?イジンは「ブロック\+(\d+)」を得る/);
        if (m && !(m[1] && src === inst)) t += Number(m[2]);
        const m2 = normTxt(cardOf(src).rule_text).match(/これが戦場にある間、自分の戦場のレベル(\d+)以下のイジンは「ブロック\+(\d+)」を得る/);
        if (m2 && (cardOf(inst).level || 0) <= Number(m2[1])) t += Number(m2[2]);
      });
      return t;
    }
    const blockPowerOf = (inst, G) => powerOf(inst, G) + kwOf(inst).block + auraBlock(G, inst);

    /* ---------- ログ ---------- */
    function stamp() {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    function log(G, msg) { G.log.push({ t: stamp(), m: msg }); }
    const nm = (G, pi) => G.names[pi];
    // 配置・召喚・使用のとき、能力があれば演出（トースト）用のイベントを積む
    const abilityFx = (G, pi, card, kind, inst, onlyText) => {
      if (inst && inst.silenced) { log(G, `　${card.name}は能力禁止中のため、能力は発動しません`); return; }
      const text = onlyText || SR.abilityText(card, kind);
      if (!text) return;
      if (kind !== 'mahou' && kind !== 'legacy' && pillarOn(G) && !staticOnly(card, text)) {   // ピラー：戦場と魔力ゾーンの能力は発動できない
        G.fx.push({ type: 'ability', pi, kind, cardId: card.id, name: card.name, text, uid: inst ? inst.uid : null, auto: true });
        log(G, `　${card.name}の能力は、ピラーの効果で発動できません`); return;
      }
      const auto = onlyText ? false
        : kind === 'mana' ? (autoManaFromDeck(G, pi, card, text) || staticOnly(card, text))
        : staticOnly(card, text);   // 常在能力（パワー補正）やハイケイのレベル条件だけなら、エンジンが自動で計算している
      const prevSrc = G.srcKind; G.srcKind = kind;   // 能力の出どころ（炎上がる天守閣「戦場の能力によって」の判定用）
      const autoCpu = !auto && G.aiPlayers.has(pi) && cpuResolve(G, pi, card, text, { inst, kind });
      G.srcKind = prevSrc;   // CPUのカード効果（読める書式・対応済みカードだけ）
      G.fx.push({ type: 'ability', pi, kind, cardId: card.id, name: card.name, text, uid: inst ? inst.uid : null, auto: auto || autoCpu });
      if (!auto && !autoCpu) log(G, `　${card.name}の能力：${text.replace(/\n/g, ' ')}（自動処理されません）`);
      if (!auto && !autoCpu && !onlyText) {   // 常在能力など自動で効いている文は除いて、手で処理が必要な文だけを見せる
        const rest = manualPart(card, text);
        const last = G.fx[G.fx.length - 1];
        if (last && last.type === 'ability' && last.cardId === card.id) { if (!rest) last.auto = true; else last.text = rest; }
      }
    };
    // エンジンがルールとして自動で処理している文（どちらのプレイヤーでも）
    const ENFORCED = [
      /^自分のスタートフェイズが終了したとき、マリョク配置権\+1する$/,                                  // 巨大古墳
      /^バトル解決に際し、自分の戦場のガーディアンがブロッカーに含まれているなら、パワー\d+以下のアタッカーは破壊される$/,   // 魔除けの社
      /^自分のターンの間、自分の戦場のガーディアンは「即応」を持つパワー3000のイジンでもある$/,             // 円形闘技場
      /^この能力は戦場で発揮する$/, /^自分の戦場のハイケイは破壊されない$/,                                // 行基
      // 第5弾
      /^この能力は魔力ゾーンで効果を発揮する$/, /^自分と相手は、戦場と魔力ゾーンの能力を発動できない$/, /^自分はマホウ使用できない$/, /^消耗$/,   // ピラー
      /^自分と相手の戦場のレベル\d+以上でないイジンは、アタッカーにもブロッカーにもなれない$/,             // オリーブの枝
      /^この能力は、?能力によって失われない$/, /^この能力は、これが起きているなら、戦場で効果を発揮する$/, /^相手の戦場のハイケイは能力すべてを失う$/,   // 黒田官兵衛
      /^能力によって、イジンが相手の戦場に置かれる際、そのイジンは寝ている状態で戦場に置かれる$/, /^相手の戦場のレベル\d+以下の寝ているイジンは、能力すべてを失う$/,   // 藤原不比等
      /^この能力は、相手の魔力ゾーンに裏のカードがあるなら、戦場で効果を発揮する$/, /^相手の戦場の起きているイジンは、能力すべてを失う$/,   // 小林虎三郎
      /^相手はマホウ使用に際し、魔力ゾーンの裏のカードを墓地に置くことができない$/,                         // マルティン・ルター
      /^この能力は戦場で効果を発揮する$/, /^相手は、マホウ使用とハイケイ使用を、合わせてターンに1回しかできない$/,   // ソクラテス
      /^相手は、自分と相手の墓地にあるカードと同じ名前のカードを、手札から使えない$/,                       // 和宮
      /^自分の戦場の「航海」を持つイジンは「即応」を得る$/,
      /^自分と相手の戦場のイジンは、能力によって手札に戻らない$/,
      // ハイケイの常在能力（エンジンが両プレイヤーに適用）
      /^これが戦場にある間、自分の戦場の『ブロック\+』能力を持つイジンと、自分の戦場のガーディアンは「能力によって破壊されない」を得る$/, /^これが戦場にある間、自分の戦場のレベル\d+以下のイジンは「ブロック\+\d+」を得る$/,   // 永遠の帝都
      /^自分のエンドフェイズが開始したとき、自分の戦場のカードすべてを起こす$/,                               // 毘盧遮那仏像（第1弾）
      /^能力によってこれを数える際、1つでなく2つと数える$/, /^イジンが自分の戦場に、?ちょうど2体いる間、自分の戦場のイジンは「ウォッチャー」を得る$/,   // 仁王
      /^これが戦場にある間、自分の戦場の黄のイジンは「色：赤\s?青\s?緑」を得る$/,                          // 英傑集う大河
      /^これが戦場にある間、自分の魔力ゾーンのマリョクは「戦場の能力によって魔力ゾーンを離れない」を得る$/, /^カードが魔力ゾーンに\d+つ以上ある間、自分の戦場のイジンは「アタック\+\d+」を得る$/,   // 天下分け目の主戦場
      /^これが戦場にある間、自分の戦場の青のイジンは「赤のイジンにブロックされない」を得る$/, /^これが戦場にある間、相手の戦場のレベル2以下のイジンは「色：赤」を得る$/,   // 火と氷の大地
      /^この能力は、自分のターンの間、相手の手札のカードが自分の手札のカードよりも多いなら、戦場で効果を発揮する$/, /^自分の戦場のイジンは「パワー\+\d+」を得る$/,   // 殿
      /^この能力は、相手の手札のカードが\d+つ以下なら、戦場で効果を発揮する$/, /^相手の戦場のイジンは「パワー-\d+」を得る$/,   // 黄金時代
      /^これが戦場にある間、自分の戦場の「志願」イジンは「モータル」を得て、他の能力すべてを失う$/, /^ガーディアンが自分の戦場にいない間、自分の戦場のレベル4以下のイジンは「特性：志願」を得る$/,   // 蝦夷共和国
      /^これが戦場にある間、自分の戦場の『アタック\+』能力を持つイジンと、自分の戦場のガーディアンは「戦場の能力によって戦場を離れない」を得る$/,   // 炎上がる天守閣
      /^自分がイジン召喚する際、そのイジンのレベルは、相手の戦場の色1つにつき1だけ下がる$/,                 // 遣外使節団
      /^自分のイジン召喚において、自分の手札の『プレッシャー』能力を持つイジンのレベルは、自分と相手の戦場のイジン1体につき1だけ下がる$/,   // 蘇る青の都
      /^この能力は、自分と相手の墓地にマホウが合わせて\d+つ以上あるなら、戦場で効果を発揮する$/, /^自分と相手の手札のマホウは魔力コストが1だけ増える$/, /^自分と相手の墓地のマホウは、能力によって墓地を離れない$/,   // 二重螺旋階段
      /^自分と相手は『ドロー』効果で山札からカードを引く際、1つだけ多く引く$/,                                 // モダンアートの殿堂
      /^戦場に「思想」カードがある間、自分の墓地にある「徴募」は、アタッカーが破壊されていなくても、バトルしているなら発動する$/,   // 凱旋門
      /^これが戦場にある間「冥府発動」でない遺業能力は発動しない$/,                                            // 森閑たる離宮
      /^特性[:：]\s*\S+$/, /^「特性[:：][^」]*」$/,                                                         // 「特性：美術」など
      /^これのハイケイ使用に際し、これのレベルは、戦場のハイケイのレベルの合計と同じだけ下がる$/,            // 大日本沿海輿地全図
      /^自分のメインフェイズが開始したとき、ハイケイの名前が戦場に\d+つ以上あるなら発動する$/, /^ゲームに勝利する$/,
      /^メインフェイズが開始したとき、ターンプレイヤーの戦場にイジンがいないなら、これを破壊する$/, /^そうでなければ、ターンプレイヤーの戦場のイジン1体を破壊する$/, /^そのイジンはターンプレイヤーが選ぶ$/,   // 喀血の流行り病
      /^自分はハイケイ使用に際し、色条件を満たしていなくても手札のカードを使える$/,                         // 伊能忠敬
      /^赤か紫のカードが戦場にある間「即応」を得る$/, /^緑か黄のカードが戦場にある間「ウォッチャー」を得る$/,   // 久坂玄瑞
      /^起きているイジンが相手の戦場にいる間、自分の戦場の「思想」イジンは「ダブルプレッシャー」を得る$/, /^これが戦場にいる間「決起」は発動しない$/,   // 吉田松陰                                         // 禁制の御殿（第6弾）                                                 // フランソワ1世
      /^これが戦場にある間、自分の戦場のレベル2以下のイジンは「特性：剣術」を得る$/, /^これが戦場にある間、自分の戦場の「剣術」イジンは「即応」を得る$/,   // 武者の蔵
      /^この能力は、自分の戦場に「勝鬨」を持つイジンが\d体以上いるなら、戦場で効果を発揮する$/, /^これは「(?:ダブル|トリプル|クアドラプル)プレッシャー」を得る$/, /^アタック\+\d+$/,   // 武田信玄
    ];
    /* 手で処理が必要な文だけを残す（自動で効く常在能力の文を除く）。全部自動なら '' */
    function manualPart(card, text) {
      const raw = normTxt(text).split(/\n+/).map(x => x.trim()).filter(Boolean);
      const keep = raw.filter(line => {
        const sents = line.replace(/（[^）]*）/g, '').split(/[。]+/).map(x => x.trim()).filter(Boolean);
        return !(sents.length && sents.every((x, i) => ENFORCED.some(re => re.test(x)) || aurasOf({ id: `__mp_${card.id}_${i}_${x.length}`, rule_text: x }).length > 0));
      });
      return keep.join('\n');
    }
    /* 能力の文がすべて「エンジンが自動で計算するもの」（パワーの常在能力・ハイケイのレベル条件）か */
    function staticOnly(card, text) {
      if (card.type === 'マホウ') return false;
      const sents = normTxt(text).replace(/（[^）]*）/g, '').split(/[。\n]+/).map(x => x.trim()).filter(Boolean);
      return sents.length > 0 && sents.every((x, i) => /^これのハイケイ使用に際し、自分の戦場に「[^」]+」イジンがいれば、これはレベル\d+になる$/.test(x) || ENFORCED.some(re => re.test(x)) ||
        aurasOf({ id: `__line_${card.id}_${i}`, rule_text: x }).length > 0);
    }
    /* 自動処理：「魔力ゾーンに置かれたとき、自分の山札の上から1枚（カード2つ）を裏のまま魔力ゾーンに置く。」（〇〇の種・キャビネットなど）
       任意（発動できる）や選択式（〜するか）の能力は対象外。山札が足りなければ置ける分だけ置く */
    const KNUM = { '1': 1, '2': 2, '3': 3, '１': 1, '２': 2, '３': 3, '一': 1, '二': 2, '三': 3 };
    function autoManaFromDeck(G, pi, card, text) {
      const t = normTxt(text);
      const m = t.match(/自分の山札の上から(?:カード)?([123１２３一二三])(?:枚|つ)を裏のまま魔力ゾーンに置く/);
      if (!m || /発動できる|するか/.test(t)) return false;
      const P = G.players[pi], n = KNUM[m[1]];
      let k = 0;
      for (; k < n && P.deck.length; k++) P.mana.push(mkInst(P.deck.pop(), { faceUp: false }));
      if (k) onFaceDownMana(G, pi);   // エリザベス1世
      log(G, `　${card.name}の能力（自動処理）：山札の上から${k}枚を裏のまま魔力ゾーンに置きました（山札残り${P.deck.length}枚）` + (k < n ? '　※山札が足りません' : ''));
      return true;
    };
    /* 「破壊されない」：手動で付けたもの（このターン / 解除するまで）と、「「音楽」イジンが自分の戦場にいる間「破壊されない」を得る」型の常在能力 */
    // 炎上がる天守閣「自分の戦場の『アタック+』能力を持つイジンと、自分の戦場のガーディアンは「戦場の能力によって戦場を離れない」を得る」
    function flameProtected(G, inst) {
      if (!G || !G.srcKind || ['mahou', 'legacy', 'manual'].includes(G.srcKind)) return false;   // 戦場（と魔力ゾーン）の能力のときだけ
      const o = G.players.findIndex(P => P.field.includes(inst)); if (o < 0) return false;
      if (!fieldSrc(G, o, /自分の戦場の『アタック\+』能力を持つイジンと、自分の戦場のガーディアンは「戦場の能力によって戦場を離れない」を得る/)) return false;
      return isGuardianInst(inst) || (inst.faceUp && cardOf(inst).type === 'イジン' && kwOf(inst).attack > 0);
    }
    function isIndestructible(G, inst, byAbility) {
      if (inst.indestructible) return true;
      if (byAbility && flameProtected(G, inst)) return true;
      // 永遠の帝都「自分の戦場の『ブロック+』能力を持つイジンと、自分の戦場のガーディアンは「能力によって破壊されない」を得る」
      if (byAbility && G) {
        const o = G.players.findIndex(P => P.field.includes(inst));
        if (o >= 0 && G.players[o].field.some(x => x.faceUp && !x.silenced && /自分の戦場の『ブロック\+』能力を持つイジンと、自分の戦場のガーディアンは「能力によって破壊されない」を得る/.test(normTxt(cardOf(x).rule_text))) &&
          (!inst.faceUp || (cardOf(inst).type === 'イジン' && /ブロック\+\d/.test(normTxt(cardOf(inst).rule_text))))) return true;
      }
      if (!inst.faceUp || inst.silenced || !G) return false;
      const pi = G.players.findIndex(P => P.field.includes(inst));
      if (pi < 0) return false;
      // 親鸞「カードが墓地に6つ以上ある間「破壊されない」を得る」（自分の墓地で数える）
      const gm = normTxt(cardOf(inst).rule_text).match(/カードが墓地に(\d+)つ以上ある間「破壊されない」を得る/);
      if (gm && G.players[pi].grave.length >= Number(gm[1])) return true;
      // 行基「自分の戦場のハイケイは破壊されない」
      if (cardOf(inst).type === 'ハイケイ' && G.players[pi].field.some(x => x.faceUp && !x.silenced && /自分の戦場のハイケイは破壊されない/.test(cardOf(x).rule_text || ''))) return true;
      return String(cardOf(inst).rule_text || '').split(/\n+/).some(raw => {
        const m = raw.trim().match(/^「([^」]+)」イジンが自分の戦場にいる間「破壊されない」を得る。?$/);
        return !!m && G.players[pi].field.some(x => x !== inst && x.faceUp && !x.silenced && cardOf(x).type === 'イジン' && hasTrait(cardOf(x), m[1]));
      });
    }
    /* 装備：装備されているカードは inst.equips（配列）にあり、元の場所（origin）を覚えている。
       装備しているイジンが戦場を離れる／裏になるときは、装備カードを元の場所に戻す（ルール：装備させる） */
    function releaseEquips(G, pi, host) {
      if (!host.equips || !host.equips.length) return;
      const P = G.players[pi];
      host.equips.splice(0).forEach(e => {
        const o = e.origin || { zone: 'mana', faceUp: true };
        delete e.origin;
        e.faceUp = o.faceUp; e.tapped = false; e.isGuardian = false;
        P[o.zone].push(e);
        log(G, `　装備していたカード（${cardOf(e).name}）が${{ mana: '魔力ゾーン', grave: '墓地', hand: '手札', field: '戦場' }[o.zone]}に戻りました`);
      });
    }
    const hasLegacy = c => !!c.legacy_ability && !['-', '（空欄）', ''].includes(String(c.legacy_ability).trim());

    /* ---------- 準備 ---------- */
    function mkInst(cardId, extra) {
      return Object.assign({ uid: uidSeq++, cardId, faceUp: true, tapped: false, isGuardian: false, placedTurn: 0 }, extra || {});
    }
    function newPlayer(deckDef) {
      const pool = [];
      Object.keys(deckDef).forEach(id => { for (let i = 0; i < deckDef[id]; i++) pool.push(id); });
      const P = { deck: shuffle(pool), hand: [], mana: [], field: [], grave: [], manaPlace: 0, summon: 0 };
      for (let i = 0; i < 6 && P.deck.length; i++) P.hand.push(mkInst(P.deck.pop()));
      for (let i = 0; i < 4 && P.deck.length; i++) P.field.push(mkInst(P.deck.pop(), { faceUp: false, isGuardian: true }));
      return P;
    }

    /* aiPlayers: CPUが操作するプレイヤー番号の配列（通常は [1]） */
    /* opts.mulligan: 手札の引き直し（1回だけ。手札6枚をすべて山札に戻してシャッフルし、6枚引き直す。ガーディアンはそのまま） */
    function newGame(deckDef0, deckDef1, firstIdx, aiPlayers, opts) {
      const G = {
        players: [newPlayer(deckDef0), newPlayer(deckDef1)],
        names: ['あなた', 'CPU'],
        turn: 1, current: firstIdx, firstIdx,
        phase: 'start', battle: null, battleUsed: false,
        winner: null, winReason: '', log: [],
        aiPlayers: new Set(aiPlayers || [1]), cpuStage: null, fx: [], triggers: []
      };
      log(G, `対戦開始（${nm(G, firstIdx)}の先攻）。手札6枚・ガーディアン4枚を準備しました`);
      if (opts && opts.mulligan) {
        G.mulligan = {};
        [0, 1].forEach(pi => {
          if (!G.aiPlayers.has(pi)) { G.mulligan[pi] = 'pending'; return; }
          G.mulligan[pi] = 'pending';
          mulligan(G, pi, cpuWantsMulligan(G, pi));
        });
      }
      beginTurn(G);
      return G;
    }
    // CPUの引き直し：マリョクがない、または序盤に出せるカード（レベル3以下のイジン・ハイケイ）がないとき
    function cpuWantsMulligan(G, pi) {
      const H = G.players[pi].hand.map(cardOf);
      return !H.some(c => c.type === 'マリョク') || !H.some(c => (c.type === 'イジン' || c.type === 'ハイケイ') && (c.level || 0) <= 3);
    }
    function mulligan(G, pi, redo) {
      if (!G.mulligan || G.mulligan[pi] !== 'pending') return fail('手札の引き直しはできません');
      const P = G.players[pi];
      G.mulligan[pi] = redo ? 'done' : 'kept';
      if (!redo) { log(G, `${nm(G, pi)}：手札をそのまま使います`); return { ok: true }; }
      const n = P.hand.length;
      P.hand.splice(0).forEach(x => P.deck.push(x.cardId));
      shuffle(P.deck);
      for (let i = 0; i < n && P.deck.length; i++) P.hand.push(mkInst(P.deck.pop()));
      log(G, `${nm(G, pi)}：手札を引き直しました（${n}枚を山札に戻してシャッフルし、${n}枚引き直し）`);
      return { ok: true };
    }

    /* ---------- ターン進行（スタート→ドロー→メイン を自動で行う） ---------- */
    function win(G, idx, reason) {
      if (G.winner !== null) return;
      G.winner = idx; G.winReason = reason; G.battle = null;
      G.fx.push({ type: 'win', winner: idx, reason });
      log(G, `★ ${nm(G, idx)}の勝利！（${reason}）`);
    }

    function beginTurn(G) {
      const pi = G.current, P = G.players[pi];
      G.phase = 'start';
      log(G, `──── ターン${G.turn}：${nm(G, pi)}のターン ────`);
      if (P.deck.length === 0) { win(G, 1 - pi, `${nm(G, pi)}の山札が0枚でターン開始`); return; }
      P.manaPlace = 1; P.summon = 1;
      // 消耗（自分のスタートフェイズで裏にする）：ピラー・オリーブの枝
      P.mana.filter(m => m.faceUp && /消耗（自分のスタートフェイズで裏にする）/.test(cardOf(m).rule_text || '')).forEach(m => { m.faceUp = false; log(G, `　${cardOf(m).name}は消耗で裏になりました`); });
      G.players.forEach(Q => Q.mana.forEach(m => { delete m.tempColor; }));   // チャルカ「このターンに限り選んだ色を得る」
      const wokeGreen = P.field.filter(c => c.tapped && !(c.frozenUntil >= G.turn) && c.faceUp && cardOf(c).type === 'イジン' && ijinHasColor(G, c, '緑')).length;
      P.field.forEach(c => { if (!(c.frozenUntil >= G.turn)) c.tapped = false; });   // ピーコック（青魔導）で起きないカードは寝たまま
      // 劉備「自分の戦場の緑のイジンが起きたとき、1ドローする」（CPU）
      if (wokeGreen && !pillarOn(G) && G.aiPlayers.has(pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) P.field.filter(x => x.faceUp && !x.silenced && /自分の戦場の緑のイジンが起きたとき、1ドローする/.test(cardOf(x).rule_text || '')).forEach(x => {
        for (let k = 0; k < wokeGreen && P.deck.length; k++) P.hand.push(mkInst(P.deck.pop()));
        log(G, `　${cardOf(x).name}の効果：緑のイジンが起きたので${wokeGreen}ドロー`);
      });
      // 「自分のスタートフェイズが終了したとき、マリョク配置権+1する」（巨大古墳）
      if (!pillarOn(G)) P.field.filter(x => x.faceUp && !x.silenced && /自分のスタートフェイズが終了したとき、マリョク配置権\+1する/.test(cardOf(x).rule_text || '')).forEach(x => {
        P.manaPlace += 1; log(G, `　${cardOf(x).name}の効果：マリョク配置権+1（自動処理）`);
      });
      G.players.forEach(Q => Q.field.forEach(c => { c.powerMod = 0; c.noIjin = false; if (c.silenced === 'turn') c.silenced = false; if (c.indestructible === 'turn') c.indestructible = false; }));   // 手動で足した「このターン限り」のパワー補正を戻す
      G.phase = 'draw';
      const newton = P.field.find(x => x.faceUp && !x.silenced && /自分のドローフェイズの間、自分は山札からカードを引くことができない/.test(cardOf(x).rule_text || ''));
      if (newton && P.hand.length >= 10) { win(G, pi, `${cardOf(newton).name}の効果（手札10枚以上）`); return; }
      if (G.turn === 1) {
        log(G, '先攻の最初のターンのためドローしません');
      } else if (newton) {
        log(G, `${cardOf(newton).name}の効果：ドローフェイズに山札から引けません`);
      } else if (!P.deck.length) {
        log(G, `${nm(G, pi)}の山札がないためドローできません`);
      } else {
        P.hand.push(mkInst(P.deck.pop()));
        G.fx.push({ type: 'draw', pi, n: 1, turn: true });
        log(G, `${nm(G, pi)}は1枚ドロー（山札残り${P.deck.length}枚）`);
        deckZero(G, pi);
      }
      G.phase = 'main';
      // 喀血の流行り病「メインフェイズが開始したとき、ターンプレイヤーの戦場にイジンがいないなら、これを破壊する。そうでなければ、ターンプレイヤーの戦場のイジン1体を破壊する（ターンプレイヤーが選ぶ）」
      if (!pillarOn(G)) G.players.forEach((Q, q) => Q.field.filter(x => x.faceUp && !x.silenced && /メインフェイズが開始したとき、ターンプレイヤーの戦場にイジンがいないなら、これを破壊する/.test(cardOf(x).rule_text || '')).forEach(x => {
        if (!Q.field.includes(x)) return;
        const mine = P.field.filter(isIjinUp).filter(notIndestructible(G)).sort((a, b) => instValue(G, a) - instValue(G, b));
        if (!P.field.some(isIjinUp)) { log(G, `　${cardOf(x).name}：ターンプレイヤーの戦場にイジンがいないので、これを破壊します`); manualDestroy(G, q, x.uid, cardOf(x).name); }
        else if (mine.length) { log(G, `　${cardOf(x).name}：${nm(G, pi)}は戦場のイジン1体（${cardOf(mine[0]).name}）を破壊します`); manualDestroy(G, pi, mine[0].uid, cardOf(x).name); }
        G.fx.push({ type: 'ability', pi: q, kind: 'mainStart', cardId: x.cardId, name: cardOf(x).name, text: 'ターンプレイヤーのイジン1体を破壊', uid: x.uid, auto: true });
      }));
      if (G.winner !== null) return;
      // 大日本沿海輿地全図「自分のメインフェイズが開始したとき、ハイケイの名前が戦場に6つ以上あるなら発動する。ゲームに勝利する」
      const yochi = P.field.find(x => x.faceUp && !x.silenced && /自分のメインフェイズが開始したとき、ハイケイの名前が戦場に(\d+)つ以上あるなら発動する。ゲームに勝利する/.test(normTxt(cardOf(x).rule_text)));
      if (yochi) {
        const need = Number(normTxt(cardOf(yochi).rule_text).match(/ハイケイの名前が戦場に(\d+)つ以上/)[1]);
        const names = new Set(G.players.flatMap(Q => Q.field.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ').map(x => cardOf(x).name)));
        log(G, `　${cardOf(yochi).name}：戦場のハイケイの名前は${names.size}種類（${need}種類以上で勝利）`);
        if (names.size >= need) { win(G, pi, `${cardOf(yochi).name}の効果（ハイケイの名前が戦場に${names.size}種類）`); return; }
      }
      G.battleUsed = false;
      G.battle = null;
      G.cpuStage = G.aiPlayers.has(pi) ? 'start' : null;
      syncSilence(G);
    }


    /* ---------- アンナ・パブロワ：戦場のガーディアンが寝たとき ---------- */
    const isAnna = x => x.faceUp && !x.silenced && cardOf(x).name === 'アンナ・パブロワ';
    const tappedGuardians = G => G.players.reduce((s, P) => s + P.field.filter(x => isGuardianInst(x) && x.tapped).length, 0);
    // 戦場のイジン。円形闘技場が有効な間は、そのプレイヤーのガーディアン（裏向き）もイジンとして数える
    const asIjin = (G, pi, x) => (x.faceUp && cardOf(x).type === 'イジン') || (isGuardianInst(x) && arenaOn(G, pi));
    const annaTargets = G => [0, 1].reduce((a, pi) => a.concat(G.players[pi].field.filter(x => asIjin(G, pi, x)).map(x => ({ pi, uid: x.uid, guardian: !x.faceUp }))), []);
    function triggerInfo(G, t) {
      const annas = t.uids.filter(u => G.players[t.pi].field.some(x => x.uid === u && isAnna(x))).length;
      const per = tappedGuardians(G);
      const n = per * annas;
      const targets = annaTargets(G);
      return { valid: annas > 0 && n > 0 && targets.length > 0, n, per, annas, targets };
    }
    /* 防御側のブロックでガーディアンが寝ると誘発するアンナ・パブロワ（どちらのプレイヤーのものでも）。戻り値: 戦場にいる枚数 */
    const annaOnField = G => G.players.reduce((n, P) => n + P.field.filter(isAnna).length, 0);
    function guardianTapped(G) {
      [0, 1].forEach(pi => {
        const annas = G.players[pi].field.filter(isAnna);
        if (!annas.length) return;
        const c = cardOf(annas[0]);
        G.fx.push({ type: 'ability', pi, kind: 'trigger', cardId: c.id, name: c.name, text: '', uid: null });
        log(G, `　${c.name}${annas.length > 1 ? `×${annas.length}` : ''}の能力が誘発しました（寝ているガーディアン${tappedGuardians(G)}体）`);
        const t = { kind: 'anna', pi, uids: annas.map(a => a.uid) };
        if (G.aiPlayers.has(pi)) aiAnna(G, t);
        else {
          const ex = G.triggers.find(x => x.pi === pi);   // 同じ持ち主の未処理の誘発があれば1つにまとめる
          if (ex) t.uids.forEach(u => { if (!ex.uids.includes(u)) ex.uids.push(u); });
          else G.triggers.push(t);
        }
      });
    }
    /* targets: [{pi, uid}] を持ち主の手札に戻す */
    function resolveAnna(G, t, targets) {
      const idx = G.triggers.indexOf(t);
      if (idx >= 0) G.triggers.splice(idx, 1);
      const info = triggerInfo(G, t);
      if (!info.valid) return { ok: true };
      const list = (targets || []).slice(0, info.n);
      const names = [];
      list.forEach(tg => {
        const P = G.players[tg.pi], i = P.field.findIndex(x => x.uid === tg.uid && asIjin(G, tg.pi, x));
        if (i < 0) return;
        if (P.field[i].faceUp && noBounce(G)) return;   // 禁制の御殿
        const inst = P.field.splice(i, 1)[0];
        releaseEquips(G, tg.pi, inst);
        const wasGuard = !inst.faceUp;
        inst.tapped = false; inst.isGuardian = false; inst.faceUp = true;
        P.hand.push(inst);
        names.push(`${nm(G, tg.pi)}の${wasGuard && G.aiPlayers.has(tg.pi) ? 'ガーディアン' : cardOf(inst).name}`);
      });
      log(G, names.length ? `アンナ・パブロワの能力：${names.join('、')}を手札に戻しました` : 'アンナ・パブロワの能力は発動しませんでした');
      return { ok: true };
    }
    function aiAnna(G, t) {
      const info = triggerInfo(G, t);
      if (!info.valid) return;
      const foes = info.targets.filter(x => x.pi !== t.pi)
        .map(x => G.players[x.pi].field.find(i => i.uid === x.uid))
        .sort((a, b) => powerOf(b, G) - powerOf(a, G));
      resolveAnna(G, t, foes.slice(0, info.n).map(i => ({ pi: 1 - t.pi, uid: i.uid })));
    }

    function canAct(G, pi) { return G.winner === null && G.current === pi && G.phase === 'main' && !G.battle; }
    const fail = msg => ({ ok: false, msg });

    /* skipEnd: 「残りのフェイズを行わずにターンを終了する」（勝海舟など）：エンドフェイズの能力は発動しない */
    function endTurn(G, pi, skipEnd) {
      if (pi !== undefined && G.current !== pi) return fail('あなたのターンではありません');
      if (!canAct(G, G.current)) return fail('今はターンを終了できません');
      const P = G.players[G.current];
      if (skipEnd) { log(G, `${nm(G, G.current)}：ターン終了（エンドフェイズは行いません）`); P.manaPlace = 0; P.summon = 0; G.phase = 'end'; G.current = 1 - G.current; G.turn += 1; beginTurn(G); return { ok: true }; }
      log(G, `${nm(G, G.current)}：エンドフェイズ（未使用の配置権・召喚権は消滅）`);
      cpuPhaseTriggers(G, G.current, 'endPhase');
      cpuPhaseTriggers(G, 1 - G.current, 'oppEnd');
      spinningMill(G);
      if (G.finalLose && G.finalLose.turn === G.turn && G.finalLose.pi === G.current) { win(G, 1 - G.current, 'ファイナルアタックの効果（エンドフェイズに敗北）'); return { ok: true }; }
      // 毘盧遮那仏像（第1弾）「自分のエンドフェイズが開始したとき、自分の戦場のカードすべてを起こす」（強制）
      if (!pillarOn(G) && P.field.some(x => x.faceUp && !x.silenced && /自分のエンドフェイズが開始したとき、自分の戦場のカードすべてを起こす/.test(cardOf(x).rule_text || ''))) {
        P.field.forEach(x => { x.tapped = false; }); log(G, '　毘盧遮那仏像の効果：自分の戦場のカードすべてを起こしました');
      }
      // 織田信長：自分のエンドフェイズが開始したとき、これが寝ているなら破壊する
      P.field.filter(x => x.faceUp && x.tapped && cardOf(x).name === '織田信長').forEach(x => {
        log(G, '　織田信長の効果：エンドフェイズに寝ているため破壊されます');
        manualDestroy(G, G.current, x.uid);
      });
      P.manaPlace = 0; P.summon = 0;
      G.phase = 'end';
      G.current = 1 - G.current;
      G.turn += 1;
      beginTurn(G);
      return { ok: true };
    }

    /* ---------- 使用条件 ---------- */
    const colorsOf = card => [...(card.color || '')].filter(ch => COLOR_CHARS.includes(ch));

    function manaInfo(P) {
      let sum = 0, down = 0;
      const colors = new Set();
      let graveColors = false;
      P.mana.forEach(m => {
        if (m.faceUp) {
          const c = cardsById[m.cardId];
          sum += c.level || 0;
          colorsOf(c).forEach(ch => colors.add(ch));
          if (m.tempColor) colors.add(m.tempColor);
          if (/自分の墓地の色すべてを得る/.test(c.rule_text || '')) graveColors = true;   // カルドロン・プリズム
        } else down += 1;
      });
      if (graveColors) (P.grave || []).forEach(g => colorsOf(cardsById[g.cardId]).forEach(ch => colors.add(ch)));
      // アリエノール・ダキテーヌ「自分の魔力ゾーンのマリョクは「色：赤 青」を得る」
      if (P.mana.some(m => m.faceUp && cardsById[m.cardId].type === 'マリョク') &&
        (P.field || []).some(x => x.faceUp && !x.silenced && /自分の魔力ゾーンのマリョクは「色：赤\s?青」を得る/.test(cardsById[x.cardId].rule_text || ''))) { colors.add('赤'); colors.add('青'); }
      const eqCap = (P.field || []).reduce((t, x) => t + equipsOf(x).reduce((u, e) => u + e.cap, 0), 0);   // 万葉集「自分の魔力ゾーンの合計レベル+2する」
      return { cap: sum + down + eqCap, colors, faceUpSum: sum, faceDown: down };
    }

    /* 色条件: カードの持つ色すべてが、表向きマリョクの色にあること（複数色カードの扱いはここで調整できます） */
    /* 「これのハイケイ使用に際し、自分の戦場に「剣術」イジンがいれば、これはレベル1になる」（連なる天守閣など） */
    function haikeiLevel(P, card, G) {
      // アイオン「これのレベルは、自分の手札の他のカード1つにつき1だけ下がる」
      if (/これのレベルは、自分の手札の他のカード1つにつき1だけ下がる/.test(normTxt(card.rule_text))) return Math.max(0, (card.level || 0) - Math.max(0, P.hand.length - 1));
      // 大日本沿海輿地全図「これのレベルは、戦場のハイケイのレベルの合計と同じだけ下がる」
      if (G && /これのハイケイ使用に際し、これのレベルは、戦場のハイケイのレベルの合計と同じだけ下がる/.test(normTxt(card.rule_text))) {
        const sum = G.players.reduce((t, Q) => t + Q.field.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ').reduce((u, x) => u + (cardOf(x).level || 0), 0), 0);
        return Math.max(0, (card.level || 0) - sum);
      }
      const m = normTxt(card.rule_text).match(/これのハイケイ使用に際し、自分の戦場に「([^」]+)」イジンがいれば、これはレベル(\d+)になる/);
      if (!m) return null;
      return P.field.some(x => x.faceUp && !x.silenced && cardOf(x).type === 'イジン' && hasTrait(cardOf(x), m[1])) ? Number(m[2]) : null;
    }
    function conditionProblems(P, card, red, G) {
      const { cap, colors } = manaInfo(P);
      const hl = card.type === 'ハイケイ' ? haikeiLevel(P, card, G) : null;
      // アイオン「これのマホウ使用に際し、これのレベルは、自分の手札の他のカード1つにつき1だけ下がる」
      if (card.type === 'マホウ' && /これのマホウ使用に際し、これのレベルは、自分の手札の他のカード1つにつき1だけ下がる/.test(normTxt(card.rule_text))) red = (red || 0) + Math.max(0, (P.hand || []).length - 1);
      const lv = hl !== null ? Math.min(hl, card.level) : SR.effectiveLevel(card.level, red);
      const p = [];
      if (lv > cap) p.push(red ? `レベル条件（Lv${card.level}→軽減後${lv} > 上限${cap}）` : `レベル条件（Lv${card.level} > 上限${cap}）`);
      const lack = colorsOf(card).filter(ch => !colors.has(ch));
      const inoh = card.type === 'ハイケイ' && (P.field || []).some(x => x.faceUp && !x.silenced && /自分はハイケイ使用に際し、色条件を満たしていなくても手札のカードを使える/.test(cardOf(x).rule_text || ''));   // 伊能忠敬
      if (lack.length && !inoh) p.push(`色条件（${lack.join('')}が不足）`);
      return p;
    }

    /* イジン召喚時のレベル軽減（サークル系などを自動で拾う）。extra は画面で手動入力した追加の軽減 */
    function summonInfo(G, pi, card) {
      const P = G.players[pi];
      const a = card.type === 'イジン' ? SR.analyze(card, P.mana, P.field, cardsById) : { auto: 0, parts: [], hints: [], flips: [] };
      // 「これのイジン召喚に際し、自分の戦場にイジンがいなければ、これはレベルNになる」（鴨長明）
      const m = card.type === 'イジン' && normTxt(card.rule_text).match(/これのイジン召喚に際し、自分の戦場にイジンがいなければ、これはレベル(\d+)になる/);
      // 姜維「これのレベルは自分の墓地の「反魂」を持つカードの最も高いレベルと同じだけ下がる」
      if (card.type === 'イジン' && /これのレベルは自分の墓地の「反魂」を持つカードの最も高いレベルと同じだけ下がる/.test(normTxt(card.rule_text))) {
        const n = Math.max(0, ...P.grave.filter(g => /反魂/.test(cardOf(g).legacy_ability || '')).map(g => cardOf(g).level || 0));
        if (n > 0) { a.auto += n; a.parts = a.parts.concat([{ name: card.name + '（墓地の「反魂」）', n }]); a.hints = a.hints.filter(h => !/反魂/.test(h.text)); }
      }
      // アルキメデス「これのレベルは、自分の墓地の『魔導』能力を持つマホウ1つにつき1だけ下がる」
      if (card.type === 'イジン' && /これのレベルは、自分の墓地の『魔導』能力を持つマホウ1つにつき1だけ下がる/.test(normTxt(card.rule_text))) {
        const n = P.grave.filter(g => cardOf(g).type === 'マホウ' && /魔導 - /.test(cardOf(g).rule_text || '')).length;
        if (n > 0) { a.auto += n; a.parts = a.parts.concat([{ name: card.name + '（墓地の『魔導』マホウ）', n }]); }
      }
      // 遣外使節団「自分がイジン召喚する際、そのイジンのレベルは、相手の戦場の色1つにつき1だけ下がる」
      if (card.type === 'イジン' && fieldSrc(G, pi, /自分がイジン召喚する際、そのイジンのレベルは、相手の戦場の色1つにつき1だけ下がる/)) {
        const n = fieldColors(G, 1 - pi);
        if (n > 0) { a.auto += n; a.parts = a.parts.concat([{ name: '遣外使節団（相手の戦場の色）', n }]); }
      }
      // 蘇る青の都「自分の手札の『プレッシャー』能力を持つイジンのレベルは、自分と相手の戦場のイジン1体につき1だけ下がる」
      if (card.type === 'イジン' && parseCard(card).pressure > 1 && fieldSrc(G, pi, /自分の手札の『プレッシャー』能力を持つイジンのレベルは、自分と相手の戦場のイジン1体につき1だけ下がる/)) {
        const n = G.players.reduce((t, Q) => t + Q.field.filter(isIjinUp).length, 0);
        if (n > 0) { a.auto += n; a.parts = a.parts.concat([{ name: '蘇る青の都（戦場のイジン）', n }]); }
      }
      // 豊臣秀吉「これのレベルは、自分の戦場のイジンの最も高いレベルと同じだけ下がる」
      if (card.type === 'イジン' && /これのレベルは、自分の戦場のイジンの最も高いレベルと同じだけ下がる/.test(normTxt(card.rule_text))) {
        const n = Math.max(0, ...P.field.filter(isIjinUp).map(x => cardOf(x).level || 0));
        if (n > 0) { a.auto += n; a.parts = a.parts.concat([{ name: card.name + '（戦場のイジンの最も高いレベル）', n }]); }
      }
      // 葛飾応為：手札のハイケイを墓地に置いた分（CPUが先に置いたとき：oiCut）
      if (card.type === 'イジン' && P.oiCut && P.oiCut.turn === G.turn && P.oiCut.name === card.name) { a.auto += P.oiCut.n; a.parts = a.parts.concat([{ name: card.name + '（手札のハイケイを墓地へ）', n: P.oiCut.n }]); }
      if (m && !P.field.some(isIjinUp) && card.level > Number(m[1])) {
        const n = card.level - Number(m[1]);
        a.auto += n; a.parts = a.parts.concat([{ name: card.name + '（自分の戦場にイジンがいない）', n }]);
        a.hints = a.hints.filter(h => !/これのイジン召喚に際し、自分の戦場にイジンがいなければ/.test(h.text));
      }
      return Object.assign({ base: card.level || 0 }, a);
    }

    function playProblems(G, pi, card, extra) {
      const P = G.players[pi];
      const red = card.type === 'イジン' ? summonInfo(G, pi, card).auto + (extra || 0) : 0;
      const p = conditionProblems(P, card, red, G);
      if (card.type === 'イジン' && P.summon < 1) p.push('イジン召喚権なし');
      if (P.noHandTurn === G.turn) p.push('このターンは手札を使用できない（スロース）');
      if (card.type === 'マホウ' && P.noMahouTurn === G.turn) p.push('このターンはマホウ使用できない（リンボ）');
      if (card.type === 'マホウ') {
        const cost = mahouCost(G, pi, card), avail = luther(G, pi) ? P.mana.filter(m => m.faceUp).length : P.mana.length;
        if (avail < cost) p.push(`魔力コスト不足（${avail}/${cost}枚）` + (luther(G, pi) ? '（マルティン・ルター：裏のカードでは払えない）' : ''));
        if (pillarMahouBan(G, pi)) p.push('ピラーの効果でマホウ使用できない');
      }
      const O = G.players[1 - pi];
      if (card.type !== 'マリョク' && fieldSrc(G, 1 - pi, /相手は、自分と相手の墓地にあるカードと同じ名前のカードを、手札から使えない/) &&
        G.players.some(Q => Q.grave.some(g => cardOf(g).name === card.name))) p.push('和宮の効果（墓地に同じ名前のカードがある）');
      if ((card.type === 'マホウ' || card.type === 'ハイケイ') && P.mhTurn === G.turn && fieldSrc(G, 1 - pi, /相手は、マホウ使用とハイケイ使用を、合わせてターンに1回しかできない/)) p.push('ソクラテスの効果（マホウ・ハイケイはターンに1回）');
      void O;
      return p;
    }
    // 天草四郎の決起「このターンのマホウ使用に際し、手札のマホウは「魔力コスト0」になる」
    const luther = (G, pi) => !!fieldSrc(G, 1 - pi, /相手はマホウ使用に際し、魔力ゾーンの裏のカードを墓地に置くことができない/);
    // 千利休「自分はマホウ使用に際し、自分の手札をすきなだけ墓地に置いてもよい。墓地に置いた1枚につき、手札のマホウの魔力コストは1減る」（CPUが先に手札を置いた分：costCut）
    const mahouCost = (G, pi, card) => { const P = G.players[pi]; if (P.freeMahouTurn === G.turn) return 0;
      const cut = P.costCut && P.costCut.turn === G.turn && P.costCut.name === card.name ? P.costCut.n : 0;
      // 二重螺旋階段「自分と相手の墓地にマホウが合わせて2つ以上あるなら、自分と相手の手札のマホウは魔力コストが1だけ増える」
      const helix = G.players.some(Q => Q.field.some(x => x.faceUp && !x.silenced && /自分と相手の墓地にマホウが合わせて(\d+)つ以上あるなら、戦場で効果を発揮する。自分と相手の手札のマホウは魔力コストが1だけ増える/.test(cardOf(x).rule_text || '')))
        && G.players.reduce((t, Q) => t + Q.grave.filter(g => cardOf(g).type === 'マホウ').length, 0) >= 2 ? 1 : 0;
      return Math.max(0, (card.magic_cost || 0) + helix - cut); };
    // 二重螺旋階段「自分と相手の墓地のマホウは、能力によって墓地を離れない」
    const graveMahouLocked = G => G.players.some(Q => Q.field.some(x => x.faceUp && !x.silenced && /自分と相手の墓地のマホウは、能力によって墓地を離れない/.test(cardOf(x).rule_text || '')));

    /* ---------- メインフェイズの行動 ---------- */
    function takeFromHand(P, uid) {
      const i = P.hand.findIndex(x => x.uid === uid);
      return i < 0 ? null : P.hand.splice(i, 1)[0];
    }
    function cardLabel(G, pi, card, faceUp) {
      return (faceUp || !G.aiPlayers.has(pi)) ? card.name : 'カード';
    }

    function placeMana(G, pi, uid, faceUp) {
      if (!canAct(G, pi)) return fail('今は行えません');
      const P = G.players[pi];
      if (P.manaPlace < 1) return fail('マリョク配置権がありません');
      if (P.noHandTurn === G.turn) return fail('このターンは手札を使用できません（スロース）');
      const inst = P.hand.find(x => x.uid === uid);
      if (!inst) return fail('手札にありません');
      const card = cardOf(inst);
      if (faceUp && card.type !== 'マリョク') return fail('表向きで置けるのはマリョクだけです');
      if (faceUp && P.mana.filter(m => m.faceUp && cardOf(m).type === 'マリョク').length >= 3 &&
        G.players[1 - pi].field.some(x => x.faceUp && !x.silenced && /マリョクが相手の魔力ゾーンに3つ以上ある間、相手は表向きでマリョク配置できない/.test(cardOf(x).rule_text || '')))
        return fail('エカチェリーナ2世の効果で、表向きでマリョク配置できません（裏向きなら置けます）');
      takeFromHand(P, uid);
      P.manaPlace -= 1;
      inst.faceUp = !!faceUp; inst.tapped = false;
      P.mana.push(inst);
      log(G, `${nm(G, pi)}：${cardLabel(G, pi, card, faceUp)}を${faceUp ? '表' : '裏'}向きでマリョク配置`);
      if (faceUp) abilityFx(G, pi, card, 'mana', inst); else onFaceDownMana(G, pi);
      if (faceUp) onStonePlaced(G, pi, inst);
      onManaPlaced(G, pi);
      syncSilence(G);
      return { ok: true };
    }

    /* グスタフ2世アドルフ「イジンが相手の戦場に置かれる際、そのイジンは寝ている状態で戦場に置かれる」 */
    function enterTapped(G, pi, inst) {
      if (!inst.faceUp || cardOf(inst).type !== 'イジン') return;
      const g = G.players[1 - pi].field.find(x => x.faceUp && !x.silenced && /イジンが相手の戦場に置かれる際、そのイジンは寝ている状態で戦場に置かれる/.test(cardOf(x).rule_text || ''));
      if (g) { inst.tapped = true; log(G, `　${cardOf(g).name}の効果：${cardOf(inst).name}は寝ている状態で戦場に置かれました`); }
    }
    function summon(G, pi, uid, extra) {
      if (!canAct(G, pi)) return fail('今は行えません');
      const P = G.players[pi];
      const inst = P.hand.find(x => x.uid === uid);
      if (!inst) return fail('手札にありません');
      const card = cardOf(inst);
      if (card.type !== 'イジン') return fail('イジンではありません');
      const prob = playProblems(G, pi, card, extra);
      if (prob.length) return fail(prob.join('／'));
      const info = summonInfo(G, pi, card);
      const red = info.auto + (extra || 0);
      takeFromHand(P, uid);
      P.summon -= 1;
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.placedTurn = G.turn;
      P.field.push(inst);
      enterTapped(G, pi, inst);
      onIjinPlaced(G, pi, inst);
      const lvNote = red > 0 ? `／召喚時Lv${SR.effectiveLevel(card.level, red)}（軽減${red}）` : '';
      log(G, `${nm(G, pi)}：${card.name}（Lv${card.level}・パワー${powerOf(inst, G)}${lvNote}）を召喚`);
      if (P.oiCut) P.oiCut = null;
      abilityFx(G, pi, card, 'field', inst);
      cpuEquipOnSummon(G, pi, inst);
      // 「イジンが自分の戦場に置かれたとき、これを裏にする」（サークル系）を自動で処理
      info.flips.forEach(f => {
        const m = P.mana.find(x => x.uid === f.uid);
        if (m && m.faceUp) { m.faceUp = false; log(G, `　${f.name}は裏向きになりました`); }
      });
      syncSilence(G);
      return { ok: true, card };
    }

    function useHaikei(G, pi, uid) {
      if (!canAct(G, pi)) return fail('今は行えません');
      const P = G.players[pi];
      const inst = P.hand.find(x => x.uid === uid);
      if (!inst) return fail('手札にありません');
      const card = cardOf(inst);
      if (card.type !== 'ハイケイ') return fail('ハイケイではありません');
      const prob = playProblems(G, pi, card);
      if (prob.length) return fail(prob.join('／'));
      takeFromHand(P, uid);
      P.mhTurn = G.turn;
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.placedTurn = G.turn;
      P.field.push(inst);
      syncSilence(G);
      log(G, `${nm(G, pi)}：ハイケイ「${card.name}」を使用`);
      abilityFx(G, pi, card, 'field', inst);
      onHaikeiPlaced(G, pi, inst);
      return { ok: true, card };
    }

    /* payUids: 魔力ゾーンから墓地に置くカード（魔力コストと同じ枚数） */
    function useMahou(G, pi, uid, payUids) {
      if (!canAct(G, pi)) return fail('今は行えません');
      const P = G.players[pi];
      const inst = P.hand.find(x => x.uid === uid);
      if (!inst) return fail('手札にありません');
      const card = cardOf(inst);
      if (card.type !== 'マホウ') return fail('マホウではありません');
      const prob = playProblems(G, pi, card);
      if (prob.length) return fail(prob.join('／'));
      const cost = mahouCost(G, pi, card);
      const pay = payUids || [];
      if (new Set(pay).size !== cost || !pay.every(u => P.mana.some(m => m.uid === u))) return fail(`魔力ゾーンからちょうど${cost}枚を選んでください`);
      if (luther(G, pi) && pay.some(u => !P.mana.find(m => m.uid === u).faceUp)) return fail('マルティン・ルターの効果で、裏のカードは魔力コストに使えません');
      takeFromHand(P, uid);
      P.mhTurn = G.turn; P.costCut = null;
      pay.forEach(u => {
        const i = P.mana.findIndex(m => m.uid === u);
        const m = P.mana.splice(i, 1)[0];
        m.faceUp = true; m.tapped = false;
        P.grave.push(m);
      });
      inst.faceUp = true;
      P.grave.push(inst);
      log(G, `${nm(G, pi)}：マホウ「${card.name}」を使用（魔力コスト${cost}枚を墓地へ）`);
      abilityFx(G, pi, card, 'mahou', inst);
      return { ok: true, card };
    }

    /* ---------- バトル ---------- */
    function eligibleAttackers(G, pi) {
      const arena = arenaOn(G, pi);
      const ol = oliveMin(G);
      return G.players[pi].field.filter(x =>
        (x.faceUp && cardOf(x).type === 'イジン' && !x.tapped && (cardOf(x).level || 0) >= ol &&
          (x.placedTurn < G.turn || hasHaste(G, x))) ||
        (arena && isGuardianInst(x) && !x.tapped));   // 円形闘技場：ガーディアンも（即応で）アタッカーになれる
    }
    function eligibleBlockers(G, pi) {
      const ol = oliveMin(G);
      return G.players[pi].field.filter(x =>
        (!x.faceUp && !x.tapped) ||
        (x.faceUp && cardOf(x).type === 'イジン' && !kwOf(x).cantBlock && (cardOf(x).level || 0) >= ol && (!x.tapped || hasWatcher(G, x))));
    }
    const ownerIdx = (G, inst) => G.players.findIndex(P => P.field.includes(inst));
    /* 「イジンにブロックされない」系（織田信長以外は常在能力。楊貴妃は手札5枚以上の間。チャンピオン等で付与された分は noIjin フラグ） */
    function ijinUnblockable(G, att) {
      if (!att.faceUp) return false;
      const k = kwOf(att), c = cardOf(att);
      if (k.noIjinBlock || att.noIjin) return true;
      if (c.name === '楊貴妃') { const o = ownerIdx(G, att); if (o >= 0 && G.players[o].hand.length >= 5) return true; }
      return false;
    }
    /* このブロッカーがこのアタッカーをブロックできるか */
    function canBlockAttacker(G, blocker, att) {
      if (!att) return true;
      const bIjin = blocker.faceUp && cardOf(blocker).type === 'イジン';
      if (bIjin && ijinUnblockable(G, att)) return false;                       // ガーディアン(裏向き)はイジンではないのでブロックできる
      // 火と氷の大地「自分の戦場の青のイジンは「赤のイジンにブロックされない」を得る」
      if (bIjin && G && att.faceUp && !att.silenced) { const ao = ownerIdx(G, att);
        if (ao >= 0 && ijinHasColor(G, att, '青') && ijinHasColor(G, blocker, '赤') && fieldSrc(G, ao, /これが戦場にある間、自分の戦場の青のイジンは「赤のイジンにブロックされない」を得る/)) return false; }
      const k = att.faceUp ? kwOf(att) : NEUTRAL_KW;
      if (bIjin && k.noBlockMaxPower >= 0 && blockPowerOf(blocker, G) <= k.noBlockMaxPower) return false;
      // 玄宗「自分の戦場のガーディアンはパワー6000以上のアタッカーを指定してブロッカーになれない」
      if (!blocker.faceUp && G) {
        const bo = ownerIdx(G, blocker);
        const m = bo >= 0 && G.players[bo].field.map(x => x.faceUp && !x.silenced && normTxt(cardOf(x).rule_text).match(/自分の戦場のガーディアンはパワー(\d+)以上のアタッカーを指定してブロッカーになれない/)).find(Boolean);
        if (m && attackPowerOf(att, G) >= Number(m[1])) return false;
      }
      return true;
    }
    /* 必要ブロッカー数。織田信長は相手の戦場のガーディアンが1体以下の間「ダブルプレッシャー」を失う */
    function requiredBlockers(inst, G) {
      if (G && inst.faceUp && cardOf(inst).name === '織田信長') {
        const o = ownerIdx(G, inst);
        if (o >= 0 && G.players[1 - o].field.filter(isGuardianInst).length <= 1) return 1;
      }
      let need = kwOf(inst).pressure;
      if (G && inst.pressureTurn === G.turn) need = Math.max(need, 2);
      // 「パワー5000以上の間「ダブルプレッシャー」を得る」（武帝など）：現在のパワーで判定する
      if (G && inst.faceUp && !inst.silenced) {
        const m = normTxt(cardOf(inst).rule_text).match(/パワー(\d+)以上の間「(ダブル|トリプル|クアドラプル)プレッシャー」を得る/);
        if (m && powerOf(inst, G) >= Number(m[1])) need = Math.max(need, PRESSURE[m[2] + 'プレッシャー']);
        const t = normTxt(cardOf(inst).rule_text), o = ownerIdx(G, inst);
        const m2 = t.match(/この能力は、相手の手札のカードが(\d+)つ以上なら、戦場で効果を発揮する。これは「(ダブル|トリプル|クアドラプル)プレッシャー」を得る/);   // 長宗我部元親
        if (m2 && o >= 0 && G.players[1 - o].hand.length >= Number(m2[1])) need = Math.max(need, PRESSURE[m2[2] + 'プレッシャー']);
        if (o >= 0 && hasTrait(cardOf(inst), '思想') && fieldSrc(G, o, /起きているイジンが相手の戦場にいる間、自分の戦場の「思想」イジンは「ダブルプレッシャー」を得る/) &&
          G.players[1 - o].field.some(x => isIjinUp(x) && !x.tapped)) need = Math.max(need, 2);   // 吉田松陰
        const m3 = t.match(/この能力は、自分の戦場に「勝鬨」を持つイジンが(\d+)体以上いるなら、戦場で効果を発揮する。これは「(ダブル|トリプル|クアドラプル)プレッシャー」を得る/);   // 武田信玄
        if (m3 && o >= 0 && G.players[o].field.filter(x => hasKachidoki(G, x)).length >= Number(m3[1])) need = Math.max(need, PRESSURE[m3[2] + 'プレッシャー']);
      }
      return need;
    }

    function declareAttack(G, pi, uids) {
      if (!canAct(G, pi)) return fail('今はバトルを宣言できません');
      if (G.battleUsed) return fail('バトルはターンに1回までです');
      if (G.noBattle && G.noBattle.turn === G.turn && G.noBattle.pi === pi) return fail('このターンはバトルできません（カードの効果）');
      if (!uids || !uids.length) return fail('アタッカーを1体以上選んでください');
      const P = G.players[pi];
      const ok = eligibleAttackers(G, pi).map(x => x.uid);
      if (!uids.every(u => ok.includes(u)) || new Set(uids).size !== uids.length) return fail('アタッカーにできないイジンが含まれています');
      const insts = uids.map(u => P.field.find(x => x.uid === u));
      insts.forEach(x => { x.tapped = true; });
      syncSilence(G);
      G.battle = { attackers: uids.slice(), blocks: {} };
      G.battleUsed = true;
      const label = i => (i.faceUp ? cardOf(i).name : 'ガーディアン');
      log(G, `${nm(G, pi)}：バトル宣言！ アタッカー → ${insts.map(i => `${label(i)}(${attackPowerOf(i, G)})`).join('、')}`);
      G.fx.push({ type: 'attack', pi, names: insts.map(label) });
      // 「アタッカーになったとき」の能力（航海など）を演出・手動処理の対象にする
      insts.filter(i => i.faceUp).forEach(i => {
        const c = cardOf(i);
        const lines = String(c.rule_text || '').split(/\n+/).map(l => l.trim()).filter(l => /アタッカーになったとき/.test(l) && !/(相手|自分)の戦場の[^、]*がアタッカーになったとき/.test(l) && !/^これが戦場にいる間/.test(l));   // 「相手の〜がアタッカーになったとき」は自分のアタックでは発動しない
        if (lines.length) abilityFx(G, pi, c, 'attack', i, lines.join('\n'));
      });
      if (insts.some(i => !i.faceUp)) { log(G, '　円形闘技場の効果：ガーディアンがパワー3000のアタッカーになりました'); guardianTapped(G); }
      // 栄西「自分が1体だけでアタックしたときに発動する。このターンの間、アタッカーは「ダブルプレッシャー」を得る」
      if (insts.length === 1 && P.field.some(x => x.faceUp && !x.silenced && /自分が1体だけでアタックしたときに発動する。このターンの間、アタッカーは「ダブルプレッシャー」を得る/.test(cardOf(x).rule_text || ''))) {
        insts[0].pressureTurn = G.turn; log(G, '　栄西の効果：アタッカーはこのターン「ダブルプレッシャー」を得ます');
      }
      cpuOnAttack(G, pi, insts);
      if (G.fogTurn === G.turn && G.battle) {   // 勝海舟：バトルを中断して、相手（ターンプレイヤー）は残りのフェイズを行わずにターン終了
        G.battle = null; G.phase = 'main';
        log(G, `　バトルを中断。${nm(G, pi)}は残りのフェイズを行わずにターンを終了します`);
        endTurn(G, pi, true);
        return { ok: true, turnEnded: true };
      }
      return { ok: true };
    }

    /* assignment: { ブロッカーのuid: 防ぐアタッカーのuid } */
    function declareBlocks(G, defIdx, assignment) {
      if (!G.battle) return fail('バトル中ではありません');
      if (defIdx !== 1 - G.current) return fail('防御側ではありません');
      const okIds = eligibleBlockers(G, defIdx).map(x => x.uid);
      const keys = Object.keys(assignment || {});
      for (const k of keys) {
        if (!okIds.includes(Number(k))) return fail('ブロッカーにできないカードが含まれています');
        if (!G.battle.attackers.includes(assignment[k])) return fail('指定先がアタッカーではありません');
        const bl = G.players[defIdx].field.find(x => x.uid === Number(k)), at = G.players[G.current].field.find(x => x.uid === assignment[k]);
        if (!canBlockAttacker(G, bl, at)) return fail(`${at && at.faceUp ? cardOf(at).name : 'このアタッカー'}はそのカードにブロックされません`);
      }
      G.battle.blocks = Object.assign({}, assignment);
      log(G, `${nm(G, defIdx)}：ブロック指定（${keys.length}体）`);
      // ブロックしたカードは寝る。ガーディアンが寝たときの能力（アンナ・パブロワ）が誘発する
      let guardTapped = false;
      keys.forEach(k => {
        const b = G.players[defIdx].field.find(x => x.uid === Number(k));
        if (b && !b.tapped) { b.tapped = true; if (isGuardianInst(b)) guardTapped = true; }
      });
      if (guardTapped) guardianTapped(G);
      cpuOnTapped(G, defIdx, keys.map(k => G.players[defIdx].field.find(x => x.uid === Number(k))).filter(Boolean));
      // ブロッカーになったときの能力（CPU：フェルセンの1ドローなど）
      keys.forEach(k => { const b = G.players[defIdx].field.find(x => x.uid === Number(k)); if (b && b.faceUp) cpuTrigger(G, defIdx, b, /ブロッカーになったとき/, 'block'); });
      syncSilence(G);
      cpuOnBlocked(G);
      if (G.triggers.length) { G.battle.pending = true; return { ok: true, pending: true }; }   // 誘発の処理が終わってからバトル解決
      return resolveBattle(G);
    }
    function resolvePending(G) {
      if (!G.battle || !G.battle.pending) return { ok: true };
      G.battle.pending = false;
      return resolveBattle(G);
    }

    // ログ表示用「あなたのイジン「織田信長」」「CPUのガーディアン」
    const who = (pi, inst) => `${pi === 0 ? 'あなた' : 'CPU'}の` + (inst.faceUp ? `${cardOf(inst).type}「${cardOf(inst).name}」` : 'ガーディアン');
    function resolveBattle(G) {
      const atkIdx = G.current, defIdx = 1 - atkIdx;
      const A = G.players[atkIdx], D = G.players[defIdx];
      const blocks = G.battle.blocks;
      const destroyedA = [], destroyedD = [];
      const records = [];   // ログ用：1体のアタッカーごとのバトルの中身
      let winnerReason = null;
      // バトル解決前に円形闘技場が戦場を離れていたら、ガーディアンはアタッカーでなくなり、それをブロックしていたカードもブロッカーでなくなる
      if (!A.field.some(x => x.faceUp && cardOf(x).name === '円形闘技場')) {
        const gone = G.battle.attackers.filter(u => { const a = A.field.find(x => x.uid === u); return a && isGuardianInst(a); });
        if (gone.length) {
          G.battle.attackers = G.battle.attackers.filter(u => !gone.includes(u));
          Object.keys(blocks).forEach(b => { if (gone.includes(blocks[b])) delete blocks[b]; });
          log(G, '　円形闘技場が戦場にないため、ガーディアンのアタックは取り消されました');
        }
      }

      for (const auid of G.battle.attackers) {
        const att = A.field.find(x => x.uid === auid);
        if (!att) continue;
        const blockers = Object.keys(blocks).filter(b => blocks[b] === auid)
          .map(b => D.field.find(x => x.uid === Number(b))).filter(Boolean);
        const need = requiredBlockers(att, G);
        const lost = Object.keys(blocks).filter(b => blocks[b] === auid).length - blockers.length;
        if (lost > 0) log(G, `　ブロッカーが${lost}体いなくなりました（ブロッカーの指定は終わっているため、他のカードでは代わりにブロックできません）`);
        if (blockers.length < need) {
          log(G, `【バトル】${who(atkIdx, att)}（アタック時パワー${attackPowerOf(att, G)}）` + (blockers.length ? ` vs ${blockers.map(b => who(defIdx, b)).join('＋')}` : '') +
            ` → ブロッカー${blockers.length}体／必要${need}体のため、${nm(G, defIdx)}は攻撃を防げませんでした`);
          winnerReason = `${att.faceUp ? cardOf(att).name : 'ガーディアン'}の攻撃を防げなかった` + (lost > 0 ? '（ブロッカーが外れて防がれなかった）' : need > 1 ? `（${need}体以上のブロッカーが必要）` : '');
          break;
        }
        const pa = attackPowerOf(att, G);
        const sumB = blockers.reduce((s, b) => s + (b.faceUp ? blockPowerOf(b, G) : 0), 0);
        const attLoses = pa <= sumB;
        const bl = blockers.map(b => ({ inst: b, label: who(defIdx, b), power: b.faceUp ? blockPowerOf(b, G) : null }));   // 名前は破壊で表向きになる前に確定
        log(G, `【バトル】${who(atkIdx, att)}（アタック時パワー${pa}） vs ` +
          bl.map(x => `${who(defIdx, x.inst)}（${x.power === null ? 'パワーなし' : 'ブロック時パワー' + x.power}）`).join('＋') +
          (bl.length > 1 ? `　ブロッカー合計${sumB}` : ''));
        bl.forEach(x => {
          x.lose = x.power === null ? pa > 0 : x.power <= pa;
          if (x.lose) destroyedD.push(x.inst);
        });
        records.push({ att, label: who(atkIdx, att), pa, sumB, attLoses, bl });
        // 魔除けの社「自分の戦場のガーディアンがブロッカーに含まれているなら、パワー4000以下のアタッカーは破壊される」
        const charm = D.field.map(x => x.faceUp && !x.silenced && normTxt(cardOf(x).rule_text).match(/自分の戦場のガーディアンがブロッカーに含まれているなら、パワー(\d+)以下のアタッカーは破壊される/)).find(Boolean);
        const charmKill = !attLoses && charm && blockers.some(b => !b.faceUp) && pa <= Number(charm[1]);
        if (charmKill) log(G, `　魔除けの社の効果：ガーディアンがブロックしたため、パワー${pa}のアタッカーは破壊されます`);
        if (attLoses || charmKill) destroyedA.push(att);
        else if (kwOf(att).mortal || ezoMortal(G, att)) { winnerReason = `${cardOf(att).name}（モータル）がバトルに勝利`; break; }
      }

      const legacyFx = [];
      const toGrave = (P, list, pi) => {
        const items = [];
        list.forEach(inst => {
          const i = P.field.findIndex(x => x.uid === inst.uid);
          if (i < 0) return;
          const c = cardOf(inst);
          if (isIndestructible(G, inst)) { log(G, `　${c.name}は「破壊されない」ため、破壊されません`); return; }
          const wasUp = inst.faceUp;
          inst.silenced = false; inst.indestructible = false;
          P.field.splice(i, 1);
          releaseEquips(G, pi, inst);
          inst.faceUp = true; inst.tapped = false; inst.isGuardian = false;
          P.grave.push(inst);
          if (G.battle && G.battle.attackers.includes(inst.uid)) G.atkDestroyedTurn = G.turn;
          if (wasUp && onDestroyed(G, pi, inst) === 'saved') return;   // アリエノール・ダキテーヌ：破壊されていない状態に
          items.push({ name: c.name, cardId: c.id });
          detachedPalace(G, pi, c);
          if (hasLegacy(c) && !legacyBlocked(G, c)) legacyFx.push({ type: 'legacy', pi, uid: inst.uid, name: c.name, cardId: c.id, text: String(c.legacy_ability).trim() });
        });
        return items;
      };
      const guardsLost = destroyedD.filter(x => !x.faceUp).length;
      const dA = toGrave(A, destroyedA, atkIdx);
      const dD = toGrave(D, destroyedD, defIdx);
      // ニコライ・レザノフの航海：「ガーディアンにブロックされたとき、これを起こす」
      records.forEach(r => { if (r.att.rezTurn === G.turn && A.field.includes(r.att) && r.bl.some(x => x.power === null)) { r.att.tapped = false; log(G, `　ニコライ・レザノフの航海：${cardOf(r.att).name}はガーディアンにブロックされたので起きます`); } });
      // ジョン・ロック「自分の戦場のガーディアンが破壊されるたびに発動できる。アタッカー1体を手札に戻す」（防御側CPU）
      if (guardsLost && !winnerReason && G.aiPlayers.has(defIdx) && !(G.cpuNoEffects && G.cpuNoEffects.has(defIdx)) && !pillarOn(G))
        D.field.filter(x => x.faceUp && !x.silenced && /自分の戦場のガーディアンが破壊されるたびに発動できる。アタッカー1体を手札に戻す/.test(cardOf(x).rule_text || '')).forEach(j => {
          for (let k = 0; k < guardsLost; k++) {
            const a = G.battle.attackers.map(u => A.field.find(x => x.uid === u)).filter(x => x && x.faceUp).sort((p, q) => instValue(G, q) - instValue(G, p))[0];
            if (!a || !bounce(G, atkIdx, a, cardOf(j).name)) break;
          }
        });
      // バトルごとの結果と理由（学習用：どちらのパワーが上回ったから、何が墓地へ行ったか）
      const gone = (P, inst) => P.grave.includes(inst);
      const legacyNote = inst => (gone(A, inst) || gone(D, inst)) && hasLegacy(cardOf(inst)) ? '　※遺業能力あり' : '';
      records.forEach(r => {
        r.bl.forEach(x => {
          const n = x.label;
          if (!x.lose) log(G, `　→ ${n}：ブロック時パワー${x.power} ＞ アタッカー${r.pa} なので生き残り`);
          else if (!gone(D, x.inst)) log(G, `　→ ${n}：負けたが「破壊されない」ため戦場に残る`);
          else log(G, `　→ ${n}：` + (x.power === null ? 'ガーディアンはパワーを持たないので' : `ブロック時パワー${x.power} ≦ アタッカー${r.pa} なので`) + `破壊されて墓地へ` + (x.power === null ? `（ガーディアンの正体：${cardOf(x.inst).name}）` : '') + legacyNote(x.inst));
        });
        const an = r.label;
        const onlyGuards = r.bl.every(x => x.power === null);
        if (!r.attLoses) log(G, `　→ ${an}：` + (onlyGuards ? 'ブロッカーがガーディアンだけ（パワー0）なので生き残り' : `アタック時パワー${r.pa} ＞ ブロッカー${r.bl.length > 1 ? '合計' : ''}${r.sumB} なので生き残り`));
        else if (!gone(A, r.att)) log(G, `　→ ${an}：負けたが「破壊されない」ため戦場に残る`);
        else log(G, `　→ ${an}：アタック時パワー${r.pa} ≦ ブロッカー${r.bl.length > 1 ? '合計' : ''}${r.sumB} なので破壊されて墓地へ${legacyNote(r.att)}`);
      });
      if (dA.length) G.fx.push({ type: 'destroy', pi: atkIdx, items: dA });
      if (dD.length) G.fx.push({ type: 'destroy', pi: defIdx, items: dD });
      if (!dA.length && !dD.length && !winnerReason) G.fx.push({ type: 'nodestroy' });
      [[dA, atkIdx], [dD, defIdx]].forEach(([d, p]) => {
        if (d.length) log(G, `バトルの結果、${nm(G, p)}の${d.map(x => x.name).join('、')}は破壊されて墓地へ`);
      });
      (winnerReason ? [] : legacyFx).forEach(f => {   // 勝敗が決まったバトルでは遺業能力を処理しない
        if (G.aiPlayers.has(f.pi) && cpuLegacy(G, f.pi, f.uid)) return;   // CPUの遺業能力は、読めるものなら自動処理
        G.fx.push(f);
        log(G, `遺業能力発動！ ${nm(G, f.pi)}の${f.name}：${f.text}（自動処理されません。手動で処理してください）`);
      });
      // 勝鬨「これがアタッカーなら、これがバトル解決で勝ったときに発動する。1ドローして、イジン召喚権+1する」（CPU）
      if (!winnerReason && G.aiPlayers.has(atkIdx) && !(G.cpuNoEffects && G.cpuNoEffects.has(atkIdx)) && !pillarOn(G)) records.forEach(r => {
        if (r.attLoses || !r.bl.some(x => x.lose) || !A.field.includes(r.att) || !hasKachidoki(G, r.att)) return;
        manualDraw(G, atkIdx, 1, `${cardOf(r.att).name}の勝鬨`); A.summon += 1; log(G, '　勝鬨：イジン召喚権+1');
        G.fx.push({ type: 'ability', pi: atkIdx, kind: 'kachidoki', cardId: r.att.cardId, name: cardOf(r.att).name, text: '勝鬨：1ドロー・イジン召喚権+1', uid: r.att.uid, auto: true });
      });
      G.battle = null;
      syncSilence(G);
      if (winnerReason) win(G, atkIdx, winnerReason);
      else log(G, 'バトル終了。メインフェイズを続けます');
      return { ok: true };
    }

    /* ---------- 手動操作（カード効果を自分で処理するための道具） ---------- */
    function zoneArr(P, z) { return { hand: P.hand, mana: P.mana, field: P.field, grave: P.grave }[z]; }
    function manualMove(G, pi, uid, from, to, opts) {
      opts = opts || {};
      const P = G.players[pi];
      const src = zoneArr(P, from);
      const i = src.findIndex(x => x.uid === uid);
      if (i < 0) return fail('カードが見つかりません');
      const inst = src.splice(i, 1)[0];
      const c = cardOf(inst);
      inst.silenced = false; inst.indestructible = false;   // 戦場を離れたら状態は消える
      if (from === 'field') releaseEquips(G, pi, inst);
      if (to === 'deckTop') P.deck.push(inst.cardId);
      else if (to === 'deckBottom') P.deck.unshift(inst.cardId);
      else {
        inst.tapped = false;
        if (to === 'hand') { inst.faceUp = true; inst.isGuardian = false; }
        if (to === 'grave') { inst.faceUp = true; inst.isGuardian = false; }
        if (to === 'mana') { inst.faceUp = !!opts.faceUp; inst.isGuardian = false; }
        if (to === 'field') { inst.faceUp = opts.faceUp !== false; inst.isGuardian = !inst.faceUp; inst.placedTurn = G.turn; }
        if (to === 'field') { enterTapped(G, pi, inst); if (inst.faceUp) onIjinPlaced(G, pi, inst); }
        zoneArr(P, to).push(inst);
      }
      if (from === 'field' && to === 'grave' && inst.faceUp) fieldToGraveLoss(G, pi, inst);
      if (to === 'mana' && inst.faceUp) abilityFx(G, pi, c, 'mana', inst);
      else if (to === 'field' && inst.faceUp && c.type !== 'マリョク') { abilityFx(G, pi, c, 'field', inst); if (c.type === 'ハイケイ') onHaikeiPlaced(G, pi, inst); }
      const label = (G.aiPlayers.has(pi) && !inst.faceUp && from !== 'grave') ? 'カード' : c.name;
      log(G, `【手動】${nm(G, pi)}の${label}を ${from} → ${to}` +
        (from === 'field' && to === 'grave' && hasLegacy(c) ? '　※遺業能力あり' : ''));
      // 戦場から墓地に置かれたときは、カード種類を問わず遺業能力が誘発する（ルールブック「遺業能力」）
      if (from === 'field' && to === 'grave' && hasLegacy(c)) G.fx.push({ type: 'legacy', pi, uid: inst.uid, name: c.name, cardId: c.id, text: String(c.legacy_ability).trim() });
      return { ok: true };
    }
    /* 戦場のカードを破壊して墓地へ（遺業能力があれば遺業フェーズの対象になる） */
    function manualDestroy(G, pi, uid, by) {
      const P = G.players[pi];
      const i = P.field.findIndex(x => x.uid === uid);
      if (i < 0) return fail('カードが見つかりません');
      if (isIndestructible(G, P.field[i], true)) return fail(`${cardOf(P.field[i]).name}は「破壊されない」状態です（解除してから破壊してください）`);
      const inst = P.field.splice(i, 1)[0], c = cardOf(inst), wasUp = inst.faceUp;
      releaseEquips(G, pi, inst);
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.silenced = false; inst.indestructible = false;
      P.grave.push(inst);
      log(G, `${by ? '　' + by + '：' : '【手動】'}${nm(G, pi)}の${c.name}を破壊して墓地へ` + (hasLegacy(c) ? '　※遺業能力あり' : ''));
      if (G.battle && G.battle.attackers.includes(inst.uid)) G.atkDestroyedTurn = G.turn;
      if (wasUp && onDestroyed(G, pi, inst) === 'saved') return { ok: true };
      if (wasUp && c.type === 'ハイケイ' && !pillarOn(G)) G.players.forEach((Q, q) => { if (!G.aiPlayers.has(q) || (G.cpuNoEffects && G.cpuNoEffects.has(q))) return;
        Q.field.filter(x => x.faceUp && !x.silenced && /ハイケイが破壊されるたび、1ドローする/.test(cardOf(x).rule_text || '')).forEach(x => { if (Q.deck.length > deckReserve(G, q)) manualDraw(G, q, 1, `${cardOf(x).name}（ハイケイが破壊された）`); }); });
      G.fx.push({ type: 'destroy', pi, manual: true, items: [{ name: c.name, cardId: c.id }] });
      detachedPalace(G, pi, c);
      if (hasLegacy(c) && !legacyBlocked(G, c) && !(G.aiPlayers.has(pi) && cpuLegacy(G, pi, inst.uid))) G.fx.push({ type: 'legacy', pi, uid: inst.uid, name: c.name, cardId: c.id, text: String(c.legacy_ability).trim() });
      return { ok: true };
    }
    function manualTap(G, pi, uid) {
      const inst = G.players[pi].field.find(x => x.uid === uid);
      if (!inst) return fail('カードが見つかりません');
      inst.tapped = !inst.tapped;
      log(G, `【手動】${nm(G, pi)}の${inst.faceUp ? cardOf(inst).name : 'カード'}を${inst.tapped ? '寝かせ' : '起こし'}ました`);
      if (inst.tapped && isGuardianInst(inst)) guardianTapped(G);
      return { ok: true };
    }
    function manualFlip(G, pi, uid, zone) {
      const inst = zoneArr(G.players[pi], zone).find(x => x.uid === uid);
      if (!inst) return fail('カードが見つかりません');
      inst.faceUp = !inst.faceUp;
      if (zone === 'field') { inst.isGuardian = !inst.faceUp; if (!inst.faceUp) releaseEquips(G, pi, inst); }
      log(G, `【手動】${nm(G, pi)}の${inst.faceUp ? cardOf(inst).name : 'カード'}を${inst.faceUp ? '表' : '裏'}にしました`);
      return { ok: true };
    }
    function manualDraw(G, pi, n, by) {
      const P = G.players[pi];
      // モダンアートの殿堂「自分と相手は『ドロー』効果で山札からカードを引く際、1つだけ多く引く」（効果のドロー＝ by あり）
      if (by && n > 0 && G.players.some(Q => Q.field.some(x => x.faceUp && !x.silenced && /自分と相手は『ドロー』効果で山札からカードを引く際、1つだけ多く引く/.test(cardOf(x).rule_text || '')))) { n += 1; by = by + '（モダンアートの殿堂で+1）'; }
      // 米百俵「自分が能力によってカードを引く際、カードを引く代わりに同じ数だけマリョク配置権を増やしてもよい」（CPU）
      if (by && G.aiPlayers.has(pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(pi)) && fieldSrc(G, pi, /自分が能力によってカードを引く際、カードを引く代わりに同じ数だけマリョク配置権を増やしてもよい/) && wantRightsInsteadOfDraw(G, pi)) {
        P.manaPlace += n; log(G, `　${by}：米百俵の効果で、${n}ドローの代わりにマリョク配置権+${n}`); return { ok: true };
      }
      let k = 0;
      for (let i = 0; i < n && P.deck.length; i++) { P.hand.push(mkInst(P.deck.pop())); k++; }
      if (k > 0) G.fx.push({ type: 'draw', pi, n: k });
      log(G, `${by ? '　' + by + '：' : '【手動】'}${nm(G, pi)}が${k}枚ドロー（山札残り${P.deck.length}枚）`);
      if (k > 0) deckZero(G, pi);
      return { ok: true };
    }
    /* 山札の上から1枚を、裏向きのガーディアンとして戦場に置く */
    function manualGuardianFromDeck(G, pi) {
      const P = G.players[pi];
      if (!P.deck.length) return fail('山札がありません');
      P.field.push(mkInst(P.deck.pop(), { faceUp: false, isGuardian: true, placedTurn: G.turn }));
      log(G, `【手動】${nm(G, pi)}が山札の上から1枚をガーディアンとして戦場に置いた（山札残り${P.deck.length}枚）`);
      onGuardianPlaced(G, pi);
      return { ok: true };
    }
    function manualPower(G, pi, uid, delta) {
      const inst = G.players[pi].field.find(x => x.uid === uid);
      if (!inst) return fail('カードが見つかりません');
      inst.powerMod = (inst.powerMod || 0) + delta;
      log(G, `【手動】${nm(G, pi)}の${inst.faceUp ? cardOf(inst).name : 'カード'}のパワーを${delta > 0 ? '+' : ''}${delta}（このターン・現在${inst.powerMod >= 0 ? '+' : ''}${inst.powerMod}）`);
      return { ok: true };
    }
    function manualNoIjin(G, pi, uid) {   // 「このターンの間「イジンにブロックされない」を得る」（チャンピオン・純白の塔など）
      const inst = G.players[pi].field.find(x => x.uid === uid);
      if (!inst) return fail('カードが見つかりません');
      inst.noIjin = !inst.noIjin;
      log(G, `【手動】${nm(G, pi)}の${inst.faceUp ? cardOf(inst).name : 'カード'}：「イジンにブロックされない」を${inst.noIjin ? '得ました' : '解除しました'}（このターン）`);
      return { ok: true };
    }
    /* 状態の手動付与。kind: 'indestructible'（破壊されない）/ 'silenced'（能力禁止中）。mode: 'turn'（このターンの間）/ 'keep'（解除するまで）/ 'off' */
    const STATE_NAME = { indestructible: '「破壊されない」', silenced: '「能力禁止中」' };
    function manualState(G, pi, uid, kind, mode) {
      const inst = G.players[pi].field.find(x => x.uid === uid);
      if (!inst || !STATE_NAME[kind]) return fail('カードが見つかりません');
      inst[kind] = mode === 'off' ? false : (mode === 'keep' ? true : 'turn');
      log(G, `【手動】${nm(G, pi)}の${inst.faceUp ? cardOf(inst).name : 'ガーディアン'}：${STATE_NAME[kind]}を` + (mode === 'off' ? '解除' : `得ました（${mode === 'keep' ? '解除するまで' : 'このターンの間'}）`));
      return { ok: true };
    }
    /* 装備（手動）：自分のカード（魔力ゾーン・墓地・手札）を、戦場の表向きイジンに装備させる。元の場所を覚えておく */
    function manualEquip(G, pi, equipUid, fromZone, hostUid) {
      const P = G.players[pi];
      const src = ['mana', 'grave', 'hand', 'field'].includes(fromZone) ? zoneArr(P, fromZone) : null;   // field：戦場のハイケイ（安宅船・蒸気機関車など）
      if (!src) return fail('この場所のカードは装備に使えません');
      const i = src.findIndex(x => x.uid === equipUid);
      const host = P.field.find(x => x.uid === hostUid);
      if (i < 0 || !host) return fail('カードが見つかりません');
      if (!host.faceUp || cardOf(host).type !== 'イジン') return fail('装備できるのは戦場の表向きのイジンだけです');
      if (host.uid === equipUid) return fail('自分自身には装備できません');
      const e = src.splice(i, 1)[0];
      e.origin = { zone: fromZone, faceUp: e.faceUp };
      e.faceUp = true;
      (host.equips = host.equips || []).push(e);
      log(G, `【手動】${nm(G, pi)}の${cardOf(host).name}に${cardOf(e).name}を装備させました（元の場所：${{ mana: '魔力ゾーン', grave: '墓地', hand: '手札', field: '戦場' }[fromZone]}）`);
      const m = String(cardOf(e).rule_text || '').match(/装備\s*[:：]([\s\S]*)$/);   // 「装備：」以降の文（アシスト用）
      const body = m ? m[1].replace(/\s+/g, ' ').trim() : '';
      if (body && !body.split(/\s+/).every(t => KW_RE.test(t) || /^特性[:：]/.test(t) || /^「?特性[:：]/.test(t))) abilityFx(G, pi, cardOf(e), 'equip', host, `装備「${cardOf(e).name}」：${body}`);
      return { ok: true };
    }
    /* イジン召喚でこのイジンが置かれる際に装備させられるカード：魔力ゾーンの表のマリョク・戦場の表のハイケイ・墓地の「冥装」 */
    function equipCandidates(G, pi, host) {
      const P = G.players[pi], hc = cardOf(host), out = [];
      if (!host || !host.faceUp || hc.type !== 'イジン') return out;
      const okFor = c => {
        const t = normTxt(c.rule_text), m = t.match(/イジン召喚によって(.*?)イジンが自分の戦場に置かれる際/);
        if (!m) return false;
        const cond = m[1];
        const tr = cond.match(/「([^」]+)」を持つ/); if (tr && !(new RegExp(tr[1] + ' - ').test(hc.rule_text || '') || hasTrait(hc, tr[1]))) return false;
        const cols = cond.match(/([赤青緑黄紫])(?:か([赤青緑黄紫]))?の$/); if (cols && ![cols[1], cols[2]].filter(Boolean).some(ch => String(hc.color || '').includes(ch))) return false;   // 色は他の能力で得た色ではなく、カードの色で判定
        return true;
      };
      P.mana.forEach(x => { if (x.faceUp && /装備させてもよい/.test(cardOf(x).rule_text || '') && !/冥装（/.test(cardOf(x).rule_text || '') && okFor(cardOf(x))) out.push({ uid: x.uid, zone: 'mana', name: cardOf(x).name }); });
      P.field.forEach(x => { if (x !== host && x.faceUp && cardOf(x).type === 'ハイケイ' && /装備させてもよい/.test(cardOf(x).rule_text || '') && okFor(cardOf(x))) out.push({ uid: x.uid, zone: 'field', name: cardOf(x).name }); });
      P.grave.forEach(x => { if (/冥装（/.test(cardOf(x).rule_text || '') && okFor(cardOf(x))) out.push({ uid: x.uid, zone: 'grave', name: cardOf(x).name + '（冥装）' }); });
      return out;
    }
    /* 装備を外す（元の場所に戻す） */
    function manualUnequip(G, pi, hostUid, equipUid) {
      const host = G.players[pi].field.find(x => x.uid === hostUid);
      if (!host || !host.equips) return fail('カードが見つかりません');
      const j = host.equips.findIndex(x => x.uid === equipUid);
      if (j < 0) return fail('装備カードが見つかりません');
      const keep = host.equips.filter((_, k) => k !== j);
      const one = host.equips[j];
      host.equips = [one];
      releaseEquips(G, pi, host);
      host.equips = keep;
      log(G, `【手動】${nm(G, pi)}の${cardOf(host).name}から${cardOf(one).name}を外しました`);
      return { ok: true };
    }
    function manualMill(G, pi, n) {
      const P = G.players[pi];
      let k = 0;
      for (let i = 0; i < n && P.deck.length; i++) { P.grave.push(mkInst(P.deck.pop())); k++; }
      log(G, `【手動】${nm(G, pi)}の山札の上から${k}枚を墓地へ（山札残り${P.deck.length}枚）`);
      return { ok: true };
    }
    function manualRights(G, pi, key, delta) {
      const P = G.players[pi];
      P[key] = Math.max(0, P[key] + delta);
      log(G, `【手動】${nm(G, pi)}の${key === 'manaPlace' ? 'マリョク配置権' : 'イジン召喚権'}を${delta > 0 ? '+' : ''}${delta}`);
      return { ok: true };
    }

    /* =====================================================================
       CPUの思考（ルールベース）
       - 勝ち筋：相手がアタッカー全員を必要数ブロックできなければ勝ち → 詰みがあれば全員でアタック
       - 安全なアタック：相手のイジンのブロックで倒されないアタッカーだけで殴る（ガーディアンを削る）
       - 守り：アタック後、次の相手ターンに相手の全イジンを防ぎきれる数のブロッカーを残す
       - 召喚・マリョク配置・ハイケイ・マホウは「点数」で選ぶ
       - カード効果は cpuResolve（決まった書式の文だけ自動処理）で処理できるものだけを当てにする
       ===================================================================== */
    const isIjinUp = x => x.faceUp && cardOf(x).type === 'イジン';
    const cardValue = c => (c.power || 0) + (c.level || 0) * 1000;
    const instValue = (G, x) => (x.faceUp ? (powerOf(x, G) || 0) + (cardOf(x).level || 0) * 1000 : 0);
    // 寝ているとエンドフェイズに破壊されるイジン（織田信長など）は、決め手のとき以外アタックさせない
    const diesIfTapped = x => x.faceUp && /エンドフェイズが開始したとき、これが寝ているなら破壊/.test(normTxt(cardOf(x).rule_text));

    /* 防御側がアタッカー全員を必要数ブロックできるか（できなければ攻撃側の勝ち）。
       atks: [{ inst, need }]、blockers: ブロックに使えるカード。制約の厳しいアタッカーから順に、融通の利かないブロッカーを当てる */
    function coverable(G, atks, blockers) {
      const pool = blockers.slice();
      const opts = a => pool.filter(b => canBlockAttacker(G, b, a.inst));
      const list = atks.slice().sort((x, y) => (opts(x).length - x.need) - (opts(y).length - y.need));
      for (const a of list) {
        for (let k = 0; k < a.need; k++) {
          const cand = opts(a);
          if (!cand.length) return false;
          cand.sort((p, q) => (p.faceUp ? 0 : 1) - (q.faceUp ? 0 : 1));   // ガーディアン（誰でもブロックできる）は後に取っておく
          pool.splice(pool.indexOf(cand[0]), 1);
        }
      }
      return true;
    }
    const asAtk = (G, list) => list.map(inst => ({ inst, need: requiredBlockers(inst, G) }));

    /* S でアタックしたあと、次の相手ターンに相手の全イジンのアタックを防ぎきれるか */
    function safeAfter(G, pi, S) {
      const me = G.players[pi], opp = G.players[1 - pi];
      const myBlk = me.field.filter(x =>
        (!x.faceUp && !S.includes(x)) ||
        (isIjinUp(x) && !kwOf(x).cantBlock && (!S.includes(x) || hasWatcher(G, x))));
      return coverable(G, asAtk(G, opp.field.filter(isIjinUp)), myBlk);
    }

    function cpuChooseAttack(G, pi) {
      if (G.noBattle && G.noBattle.turn === G.turn && G.noBattle.pi === pi) return { list: [], why: '' };   // バトルできない（ハリエット・ビーチャー・ストウなど）
      const E = eligibleAttackers(G, pi);
      if (!E.length) return { list: [], why: '' };
      const oppB = eligibleBlockers(G, 1 - pi);
      if (!coverable(G, asAtk(G, E), oppB)) return { list: E, why: '詰み（相手はブロックしきれない）' };
      const oppIjin = oppB.filter(b => b.faceUp);
      const safe = E.filter(a => {
        if (diesIfTapped(a)) return false;
        const pa = attackPowerOf(a, G);
        const t = oppIjin.filter(b => canBlockAttacker(G, b, a)).map(b => blockPowerOf(b, G)).sort((x, y) => y - x);
        return !t.length || (t[0] < pa && (t.length < 2 || t[0] + t[1] < pa));
      }).sort((a, b) => attackPowerOf(b, G) - attackPowerOf(a, G));
      if (!safe.length) return { list: [], why: '' };
      if (!safeAfter(G, pi, [])) return { list: safe, why: '守りきれないので攻める' };
      // 守りが足りなくなるなら、ブロックに強いイジンから順にアタッカーから外して残す
      const S = safe.slice();
      while (S.length && !safeAfter(G, pi, S)) {
        const keep = S.filter(x => !hasWatcher(G, x)).sort((a, b) => (b.faceUp ? 1 : 0) - (a.faceUp ? 1 : 0) || blockPowerOf(b, G) - blockPowerOf(a, G))[0] || S[S.length - 1];
        S.splice(S.indexOf(keep), 1);
      }
      return { list: S, why: S.length ? '安全なアタック' : '' };
    }

    /* ブロック：倒されずに勝てるイジン → ガーディアン（残りが多いとき）→ 相討ち → ガーディアン → 捨て身のイジン の順に選ぶ */
    function cpuChooseBlocks(G, defIdx) {
      const atks = G.battle.attackers.map(u => G.players[G.current].field.find(x => x.uid === u)).filter(Boolean);
      const D = G.players[defIdx];
      const pool = eligibleBlockers(G, defIdx);
      // アンナ・パブロワが戦場にいるときは、ブロッカーのイジンを手札に戻されてしまうので、ガーディアン（裏向き）を優先する
      const annaThreat = annaOnField(G) > 0;
      const guardsLeft = () => pool.filter(b => !b.faceUp).length;
      const assign = {};
      const order = atks.slice().sort((a, b) => requiredBlockers(b, G) - requiredBlockers(a, G));
      // 先に全体が守れるか確認：守れないなら（どうせ負け）少しでも多く防ぐ
      for (const a of order) {
        const need = requiredBlockers(a, G);
        const pa = attackPowerOf(a, G);
        const av = instValue(G, a) || 3000;
        let sum = 0;
        for (let k = 0; k < need; k++) {
          const cand = pool.filter(b => canBlockAttacker(G, b, a));
          if (!cand.length) break;
          const score = b => {
            if (!b.faceUp) return annaThreat ? 100 : (guardsLeft() > 2 ? 60 : 30);
            if (annaThreat) return 0;
            const bp = blockPowerOf(b, G), tot = sum + bp;
            if (bp > pa || (tot >= pa && bp > pa - sum)) return 90 - bp / 1000;        // 生き残って勝てる（小さい方を使う）
            if (tot >= pa) return instValue(G, b) <= av ? 50 : 20;                   // 相討ち：相手の方が価値が高ければ良い取引
            return 10 - instValue(G, b) / 10000;                                   // 捨て身（価値の低いイジンから）
          };
          cand.sort((x, y) => score(y) - score(x));
          const b = cand[0];
          pool.splice(pool.indexOf(b), 1);
          assign[b.uid] = a.uid;
          sum += b.faceUp ? blockPowerOf(b, G) : 0;
        }
      }
      // 余ったイジンの加勢：足し合わせてアタッカーに勝てる（パワー合計がアタッカー以上になる）場合に限る
      if (!annaThreat) for (const a of order) {
        const pa = attackPowerOf(a, G);
        const mine = () => Object.keys(assign).filter(k => assign[k] === a.uid).map(k => D.field.find(x => x.uid === Number(k)));
        let sum = mine().reduce((t, b) => t + (b && b.faceUp ? blockPowerOf(b, G) : 0), 0);
        if (sum >= pa) continue;
        const cand = pool.filter(b => b.faceUp && canBlockAttacker(G, b, a)).sort((x, y) => blockPowerOf(y, G) - blockPowerOf(x, G));
        const add = [];
        for (const h of cand) { if (sum >= pa) break; add.push(h); sum += blockPowerOf(h, G); }
        if (sum >= pa) add.forEach(h => { assign[h.uid] = a.uid; pool.splice(pool.indexOf(h), 1); });
      }
      return assign;
    }
    function cpuAutoBlock(G) {
      if (!G.battle) return { ok: true };   // バトルが中断された（勝海舟など）
      const defIdx = 1 - G.current;
      return declareBlocks(G, defIdx, cpuChooseBlocks(G, defIdx));
    }

    /* ---------- 第3弾：手札を墓地へ・相手にドローさせる・魔力ゾーンの出入り ---------- */
    // 能力で手札から墓地へ（緒方洪庵「能力によって手札から墓地にイジンが置かれるたび、そのカードのプレイヤーは1ドローする」）
    function handToGrave(G, q, inst) {
      const P = G.players[q]; const i = P.hand.indexOf(inst); if (i < 0) return;
      P.hand.splice(i, 1); inst.faceUp = true; P.grave.push(inst);
      // マシュー・ペリー「手札から墓地に置かれたとき、これを戦場に置く」（CPU）
      if (G.aiPlayers.has(q) && !(G.cpuNoEffects && G.cpuNoEffects.has(q)) && /手札から墓地に置かれたとき、これを戦場に置く/.test(cardOf(inst).rule_text || '')) {
        P.grave.splice(P.grave.indexOf(inst), 1); graveLeft(G, q); placeToField(G, q, inst, `${cardOf(inst).name}（手札から墓地に置かれた）`, true);
        return;
      }
      onHandDiscard(G, q, inst);
      if (cardOf(inst).type === 'イジン') G.players.forEach((Q, o) => Q.field.forEach(x => {
        if (x.faceUp && !x.silenced && /能力によって手札から墓地にイジンが置かれるたび、そのカードのプレイヤーは1ドローする/.test(cardOf(x).rule_text || '')) manualDraw(G, q, 1, cardOf(x).name);
      }));
    }
    // 相手に手札を捨てさせる（選ぶのは相手：一番使い道の薄いカードを選んだことにする）
    function forceDiscard(G, q, n, by) {
      const P = G.players[q], names = [];
      for (let k = 0; k < n && P.hand.length; k++) {
        const x = P.hand.slice().sort((a, b) => discardScore(G, q, b) - discardScore(G, q, a))[0];
        names.push(cardOf(x).name); handToGrave(G, q, x);
      }
      if (names.length) log(G, `　${by}：${nm(G, q)}は手札の${names.join('、')}を墓地に置きました`);
    }
    // 能力で相手にドローさせる（徳川慶喜「戦場の能力によって相手がドローしたとき、相手の手札のカード1つを墓地に置く」）
    function oppDraw(G, pi, n, by) {
      manualDraw(G, 1 - pi, n, by);
      G.players[pi].field.filter(x => x.faceUp && !x.silenced && /戦場の能力によって相手がドローしたとき、相手の手札のカード1つを墓地に置く/.test(cardOf(x).rule_text || '')).forEach(x => forceDiscard(G, 1 - pi, 1, cardOf(x).name));
    }
    // エリザベス1世「カードが裏向きで自分の魔力ゾーンに置かれたとき、1ドローする」「能力によってカードが自分の魔力ゾーンを離れるたび、相手のパワー3000以下のイジン1体を破壊（ターンに1回）」
    function onFaceDownMana(G, pi) {
      if (!G.aiPlayers.has(pi) || pillarOn(G)) return;
      G.players[pi].field.filter(x => x.faceUp && !x.silenced && /カードが裏向きで自分の魔力ゾーンに置かれたとき、1ドローする/.test(cardOf(x).rule_text || '')).forEach(x => manualDraw(G, pi, 1, cardOf(x).name));
    }
    function onManaLeft(G, pi) {
      if (!G.aiPlayers.has(pi) || pillarOn(G)) return;
      G.players[pi].field.filter(x => x.faceUp && !x.silenced && /能力によってカードが自分の魔力ゾーンを離れるたび、相手の戦場のパワー(\d+)以下のイジン1体を破壊する/.test(normTxt(cardOf(x).rule_text))).forEach(x => {
        if (x.eliTurn === G.turn) return; x.eliTurn = G.turn;
        const lim = Number(normTxt(cardOf(x).rule_text).match(/離れるたび、相手の戦場のパワー(\d+)以下/)[1]);
        destroyBest(G, pi, G.players[1 - pi].field.filter(y => isIjinUp(y) && powerOf(y, G) <= lim));
      });
    }
    // 自分の魔力ゾーンの裏のカード1つを手札に戻す（スチーブンソン・ホイットニー）
    function takeFaceDownMana(G, pi) {
      const P = G.players[pi], m = P.mana.find(x => !x.faceUp); if (!m) return false;
      P.mana.splice(P.mana.indexOf(m), 1); m.faceUp = true; P.hand.push(m); onManaLeft(G, pi); return true;
    }
    // LO（山札切れ）を狙うデッキか：相手の山札を削るカードが多い
    const loPlan = (G, pi) => { const P = G.players[pi]; const all = P.deck.map(id => cardsById[id]).concat(P.hand.map(cardOf));
      return all.filter(c => /相手の山札の上から\d枚を墓地に置/.test(normTxt(c.rule_text))).length >= 4; };

    /* ---------- CPUの効果で使う小さな処理 ---------- */
    const noBounce = G => G.players.some(Q => Q.field.some(x => x.faceUp && !x.silenced && /自分と相手の戦場のイジンは、能力によって手札に戻らない/.test(cardOf(x).rule_text || '')));
    function bounce(G, q, inst, by) {   // 戦場のイジンを持ち主の手札に戻す
      const P = G.players[q]; const i = P.field.indexOf(inst); if (i < 0) return false;
      if (inst.faceUp && cardOf(inst).type === 'イジン' && noBounce(G)) { log(G, `　${by}：禁制の御殿の効果で、${cardOf(inst).name}は手札に戻りません`); return false; }
      if (flameProtected(G, inst)) { log(G, `　${by}：炎上がる天守閣の効果で、${inst.faceUp ? cardOf(inst).name : 'ガーディアン'}は戦場を離れません`); return false; }
      P.field.splice(i, 1); releaseEquips(G, q, inst);
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.silenced = false; inst.indestructible = false;
      P.hand.push(inst);
      log(G, `　${by}：${nm(G, q)}の${cardOf(inst).name}を手札に戻しました`);
      return true;
    }
    function placeToField(G, pi, inst, by, fromGrave) {   // 効果でイジン・ハイケイを戦場に置く（置かれたときの能力も処理する）
      const P = G.players[pi], c = cardOf(inst);
      if (fromGrave === undefined) fromGrave = /反魂|木霊|リバイバル|ダ・ヴィンチ|ドシャカジ|徴募/.test(by || '');
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.placedTurn = G.turn;
      P.field.push(inst);
      log(G, `　${by}：${nm(G, pi)}の${c.name}を戦場に置きました`);
      if (c.type === 'イジン') {
        const fu = fieldSrc(G, 1 - pi, /能力によって、イジンが相手の戦場に置かれる際、そのイジンは寝ている状態で戦場に置かれる/);   // 藤原不比等
        if (fu && !inst.tapped) { inst.tapped = true; log(G, `　${cardOf(fu).name}の効果：${c.name}は寝ている状態で戦場に置かれました`); }
        enterTapped(G, pi, inst); onIjinPlaced(G, pi, inst);
      }
      syncSilence(G);
      G.cpuTrigCtx = { fromGrave: !!fromGrave };
      abilityFx(G, pi, c, 'field', inst);
      G.cpuTrigCtx = null;
      if (c.type === 'ハイケイ') onHaikeiPlaced(G, pi, inst);
    }
    // 墓地から戻す候補：レベル6以下のイジン（召喚の点数が高いもの）かレベル5以下のハイケイ
    function bestRevive(G, pi, except) {
      const P = G.players[pi];
      return P.grave.filter(x => x !== except && ((cardOf(x).type === 'イジン' && cardOf(x).level <= 6) || (cardOf(x).type === 'ハイケイ' && cardOf(x).level <= 5)))
        .sort((a, b) => (cardOf(b).type === 'イジン' ? ijinScore(G, pi, cardOf(b)) : 3000) - (cardOf(a).type === 'イジン' ? ijinScore(G, pi, cardOf(a)) : 3000))[0] || null;
    }
    // イジンが戦場に置かれたとき、相手の戦場の「イジンが相手の戦場に置かれるたび…」（玄宗）
    function onIjinPlaced(G, pi, inst) {
      if (pillarOn(G)) return;
      // ガレオン船「「航海」を持つイジンが自分の戦場に置かれたとき、イジン召喚権+1する」（戦場のハイケイ）
      if (G.aiPlayers.has(pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(pi)) && /航海 - /.test(cardOf(inst).rule_text || ''))
        G.players[pi].field.filter(m => m.faceUp && !m.silenced && /「航海」を持つイジンが自分の戦場に置かれたとき、イジン召喚権\+1する/.test(cardOf(m).rule_text || '')).forEach(m => { G.players[pi].summon += 1; log(G, `　${cardOf(m).name}：「航海」を持つイジンが置かれたので、イジン召喚権+1`); });
      // 足利義政「赤のイジンが自分の戦場に置かれたときに発動できる」など（自分の戦場のカード）
      G.players[pi].field.forEach(x => {
        if (!G.aiPlayers.has(pi) || !x.faceUp || x.silenced) return;
        const m = normTxt(cardOf(x).rule_text).match(/(赤|青|緑|黄|紫)のイジンが自分の戦場に置かれたときに発動できる/);
        if (m && ijinHasColor(G, inst, m[1])) cpuTrigger(G, pi, x, /のイジンが自分の戦場に置かれたときに発動できる/, 'ownIjin');
        const t = normTxt(cardOf(x).rule_text).match(/「([^」]+)」イジンが自分の戦場に置かれたときに発動できる/);   // 本居宣長
        if (t && hasTrait(cardOf(inst), t[1])) cpuTrigger(G, pi, x, /イジンが自分の戦場に置かれたときに発動できる/, 'ownIjin');
      });
      G.players[1 - pi].field.forEach(x => {
        if (!G.aiPlayers.has(1 - pi) || !x.faceUp || x.silenced) return;
        if (/イジンが相手の戦場に置かれるたび、自分の山札の上から1枚をガーディアンにして戦場に置く/.test(cardOf(x).rule_text || '')) {
          addGuardianFromDeck(G, 1 - pi, cardOf(x).name);
          G.fx.push({ type: 'ability', pi: 1 - pi, kind: 'oppIjin', cardId: x.cardId, name: cardOf(x).name, text: 'ガーディアンを1体追加', uid: x.uid, auto: true });
        }
      });
    }
    // アタック宣言時（CPUのアタック：純白の塔・毘盧遮那仏像 ／ 相手のアタック：フェルセンを起こす）
    function cpuOnAttack(G, pi, insts) {
      const P = G.players[pi], D = G.players[1 - pi];
      if (pillarOn(G)) return;
      // 防御側CPU：英傑集う大河「相手が3体以上でアタックしたとき、アタッカー1体をアタッカーでない状態にして、これを破壊する」
      if (G.aiPlayers.has(1 - pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(1 - pi)) && insts.length >= 3 && G.battle) {
        const t = D.field.find(x => x.faceUp && !x.silenced && /相手が3体以上でアタックしたとき、アタッカー1体を指定して発動できる。そのアタッカーをアタッカーでない状態にして、これを破壊する/.test(normTxt(cardOf(x).rule_text)));
        if (t) {
          const a = insts.slice().sort((x, y) => requiredBlockers(y, G) - requiredBlockers(x, G) || attackPowerOf(y, G) - attackPowerOf(x, G))[0];
          G.battle.attackers = G.battle.attackers.filter(u => u !== a.uid);
          log(G, `　${cardOf(t).name}の効果：${a.faceUp ? cardOf(a).name : 'ガーディアン'}はアタッカーでなくなりました`);
          manualDestroy(G, 1 - pi, t.uid, cardOf(t).name);
          G.fx.push({ type: 'ability', pi: 1 - pi, kind: 'attackDecl', cardId: t.cardId, name: cardOf(t).name, text: 'アタッカー1体をアタッカーでない状態に', uid: t.uid, auto: true });
        }
      }
      // 遁甲盤「これを表にして、アタッカー1体をアタッカーでない状態にする」・遁甲式木蓮「ガーディアン1体を山札の上に戻して、アタッカーすべてをアタッカーでない状態にする」
      // 遁甲式烈火「ガーディアン1体を山札の上に戻して、相手の戦場の起きているイジンすべてを破壊する」（魔力ゾーンで裏のとき）
      if (G.aiPlayers.has(1 - pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(1 - pi)) && G.battle) {
        const atks = () => G.battle.attackers.map(u => P.field.find(x => x.uid === u)).filter(Boolean);
        const danger = () => !coverable(G, asAtk(G, atks()), eligibleBlockers(G, 1 - pi));
        const tj = re => D.mana.find(m => !m.faceUp && re.test(normTxt(cardOf(m).rule_text)));
        const flip = (m, text) => { m.faceUp = true; log(G, `　${cardOf(m).name}：魔力ゾーンのこれを表にして発動します`); G.fx.push({ type: 'ability', pi: 1 - pi, kind: 'block', cardId: m.cardId, name: cardOf(m).name, text, uid: m.uid, auto: true }); };
        const mok = tj(/これを表にして発動できる。自分の戦場のガーディアン1体を山札の上に戻して、アタッカーすべてをアタッカーでない状態にする/);
        if (mok && danger() && takeGuardian(G, 1 - pi)) { const g = takeGuardian(G, 1 - pi); D.field.splice(D.field.indexOf(g), 1); D.deck.push(g.cardId); flip(mok, 'アタッカーすべてをアタッカーでない状態に'); G.battle.attackers = []; log(G, '　アタッカーすべてがアタッカーでなくなりました'); }
        const ban = G.battle.attackers.length && tj(/これが魔力ゾーンに裏で置かれているなら、これを表にして、アタッカー1体を指定して発動できる。そのアタッカーをアタッカーでない状態にする/);
        if (ban && danger()) { const a = atks().sort((x, y) => requiredBlockers(y, G) - requiredBlockers(x, G) || attackPowerOf(y, G) - attackPowerOf(x, G))[0]; flip(ban, `${a.faceUp ? cardOf(a).name : 'ガーディアン'}をアタッカーでない状態に`); G.battle.attackers = G.battle.attackers.filter(u => u !== a.uid); }
        const fire = tj(/これを表にして発動できる。自分の戦場のガーディアン1体を山札の上に戻して、相手の戦場の起きているイジンすべてを破壊する/);
        const up = P.field.filter(x => isIjinUp(x) && !x.tapped).filter(notIndestructible(G));
        if (fire && takeGuardian(G, 1 - pi) && up.reduce((t, x) => t + instValue(G, x), 0) >= 6000) { const g = takeGuardian(G, 1 - pi); D.field.splice(D.field.indexOf(g), 1); D.deck.push(g.cardId); flip(fire, '相手の起きているイジンすべてを破壊'); up.forEach(x => manualDestroy(G, pi, x.uid, cardOf(fire).name)); }
      }
      // 遁甲式水鏡「相手のターンのブロックステップが開始したとき、魔力ゾーンのこれを表にして発動できる。自分の戦場のガーディアン1体を山札の上に戻して、戦場の寝ているイジンすべてを手札に戻す」
      if (G.aiPlayers.has(1 - pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(1 - pi)) && G.battle) {
        const mirror = D.mana.find(m => !m.faceUp && /相手のターンのブロックステップが開始したとき、魔力ゾーンのこれを表にして発動できる。自分の戦場のガーディアン1体を山札の上に戻して、戦場の寝ているイジンすべてを手札に戻す/.test(cardOf(m).rule_text || ''));
        const atks = G.battle.attackers.map(u => P.field.find(x => x.uid === u)).filter(Boolean);
        const g = mirror && takeGuardian(G, 1 - pi);
        const gain = atks.filter(a => a.faceUp).reduce((t, a) => t + instValue(G, a), 0) - D.field.filter(x => isIjinUp(x) && x.tapped).reduce((t, a) => t + instValue(G, a), 0);
        if (mirror && g && !noBounce(G) && (!coverable(G, asAtk(G, atks), eligibleBlockers(G, 1 - pi)) || gain >= 9000)) {
          mirror.faceUp = true;
          D.field.splice(D.field.indexOf(g), 1); D.deck.push(g.cardId);
          log(G, `　${cardOf(mirror).name}：魔力ゾーンのこれを表にして、ガーディアン1体を山札の上に戻し、戦場の寝ているイジンすべてを手札に戻します`);
          [pi, 1 - pi].forEach(q => G.players[q].field.filter(x => isIjinUp(x) && x.tapped).slice().forEach(x => bounce(G, q, x, cardOf(mirror).name)));
          G.battle.attackers = G.battle.attackers.filter(u => P.field.some(x => x.uid === u));
          G.fx.push({ type: 'ability', pi: 1 - pi, kind: 'block', cardId: mirror.cardId, name: cardOf(mirror).name, text: '寝ているイジンすべてを手札に戻す', uid: mirror.uid, auto: true });
        }
      }
      if (G.aiPlayers.has(1 - pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(1 - pi)) && G.battle) {
        const kai = D.field.find(x => x.faceUp && !x.silenced && /相手のターンのブロックステップが開始したとき、自分の戦場の「志願」イジンかガーディアン1体を指定して発動できる。そのイジンかガーディアンと、これを破壊する/.test(normTxt(cardOf(x).rule_text)));
        const atks = G.battle.attackers.map(u => P.field.find(x => x.uid === u)).filter(Boolean);
        const g = kai && D.field.find(x => isGuardianInst(x) && x !== kai);
        if (kai && g && !coverable(G, asAtk(G, atks), eligibleBlockers(G, 1 - pi))) {
          log(G, `　${cardOf(kai).name}：このままでは防げないので、ガーディアン1体とこれを破壊してバトルを中断します`);
          manualDestroy(G, 1 - pi, g.uid, cardOf(kai).name); manualDestroy(G, 1 - pi, kai.uid, cardOf(kai).name);
          G.fogTurn = G.turn;
          G.fx.push({ type: 'ability', pi: 1 - pi, kind: 'block', cardId: kai.cardId, name: cardOf(kai).name, text: 'バトルを中断して相手のターンを終了', uid: kai.uid, auto: true });
        }
      }
      if (G.aiPlayers.has(pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) {
        // 航海：足利義満「自分の戦場のパワー3000以上のイジンは「航海 - アタッカーになったとき、1ドローする。」を得る」＋角倉了以「「航海」が発動したとき…」
        const yoshi = P.field.filter(x => x.faceUp && !x.silenced && /自分の戦場のパワー(\d+)以上のイジンは「航海 - アタッカーになったとき、1ドローする。?」を得る/.test(normTxt(cardOf(x).rule_text)));
        let voyages = insts.filter(a => a.faceUp && !a.silenced && /航海 - /.test(cardOf(a).rule_text || '')).length;
        yoshi.forEach(y => {
          const lim = Number(normTxt(cardOf(y).rule_text).match(/自分の戦場のパワー(\d+)以上のイジン/)[1]);
          insts.filter(a => a.faceUp && powerOf(a, G) >= lim).forEach(a => { manualDraw(G, pi, 1, `${cardOf(y).name}（${cardOf(a).name}の航海）`); voyages++; });
        });
        P.field.filter(x => x.faceUp && !x.silenced && /「航海」が発動したとき、相手の戦場のガーディアン1体を裏のまま魔力ゾーンに置く/.test(cardOf(x).rule_text || '')).forEach(k => {
          for (let i = 0; i < voyages; i++) {
            const g = D.field.filter(isGuardianInst).sort((a, b) => (a.tapped ? 1 : 0) - (b.tapped ? 1 : 0))[0]; if (!g) break;
            D.field.splice(D.field.indexOf(g), 1); g.isGuardian = false; g.tapped = false; D.mana.push(g);
            log(G, `　${cardOf(k).name}の効果：相手のガーディアン1体を裏のまま魔力ゾーンに置きました`);
            if (G.battle) Object.keys(G.battle.blocks).forEach(b => { if (Number(b) === g.uid) delete G.battle.blocks[b]; });
          }
        });
        // 曹操「自分の戦場の青のイジンがアタッカーになったとき、アタッカー1体を指定して発動できる。指定したアタッカーを破壊して、1ドローする」
        P.field.filter(x => x.faceUp && !x.silenced && /自分の戦場の青のイジンがアタッカーになったとき、アタッカー1体を指定して発動できる。指定したアタッカーを破壊して、1ドローする/.test(normTxt(cardOf(x).rule_text))).forEach(c => {
          if (!insts.some(a => a.faceUp && ijinHasColor(G, a, '青'))) return;
          const t = insts.filter(a => a.faceUp && P.field.includes(a)).filter(notIndestructible(G))
            .sort((a, b) => (instValue(G, a) - (hasLegacy(cardOf(a)) ? 1500 : 0)) - (instValue(G, b) - (hasLegacy(cardOf(b)) ? 1500 : 0)))[0];
          if (!t || instValue(G, t) - (hasLegacy(cardOf(t)) ? 1500 : 0) > 2500) return;
          manualDestroy(G, pi, t.uid, cardOf(c).name); manualDraw(G, pi, 1, cardOf(c).name);
          G.fx.push({ type: 'ability', pi, kind: 'attackDecl', cardId: c.cardId, name: cardOf(c).name, text: 'アタッカーを破壊して1ドロー', uid: c.uid, auto: true });
        });
      }
      cpuOnTapped(G, pi, insts.filter(a => P.field.includes(a)));
      if (G.aiPlayers.has(pi)) {
        if (insts.length >= 3) P.field.filter(x => x.faceUp && !x.silenced && cardOf(x).name === '純白の塔').slice(0, 1).forEach(t => {
          const a = insts.filter(x => x.faceUp && !ijinUnblockable(G, x)).sort((x, y) => requiredBlockers(y, G) - requiredBlockers(x, G) || attackPowerOf(y, G) - attackPowerOf(x, G))[0];
          if (a) { a.noIjin = true; log(G, `　純白の塔：${cardOf(a).name}はこのターン「イジンにブロックされない」`); G.fx.push({ type: 'ability', pi, kind: 'attackDecl', cardId: t.cardId, name: '純白の塔', text: `${cardOf(a).name}は「イジンにブロックされない」`, uid: t.uid, auto: true }); }
        });
        P.field.filter(x => x.faceUp && !x.silenced && cardOf(x).name === '毘盧遮那仏像').forEach(t => {
          const a = insts.filter(x => x.faceUp && x.tapped).sort((x, y) => blockPowerOf(y, G) - blockPowerOf(x, G))[0];
          if (a) { a.tapped = false; log(G, `　毘盧遮那仏像：${cardOf(a).name}を起こしました`); G.fx.push({ type: 'ability', pi, kind: 'attackDecl', cardId: t.cardId, name: '毘盧遮那仏像', text: `${cardOf(a).name}を起こす`, uid: t.uid, auto: true }); }
        });
      }
      if (G.aiPlayers.has(1 - pi) && insts.some(a => a.faceUp && hasHaste(G, a))) {
        D.field.filter(x => x.faceUp && !x.silenced && x.tapped && /相手の戦場の「即応」を持つイジンがアタッカーになったとき、これを起こす/.test(cardOf(x).rule_text || '')).forEach(x => {
          x.tapped = false; log(G, `　${cardOf(x).name}の効果：起きました`);
        });
      }
    }
    // CPUのメインフェイズ開始時・エンドフェイズ開始時の能力
    function cpuPhaseTriggers(G, pi, which) {
      if (!G.aiPlayers.has(pi)) return;
      const P = G.players[pi];
      const re = which === 'mainStart' ? /メインフェイズが開始したとき/ : which === 'oppEnd' ? /相手のエンドフェイズが開始したとき/ : /自分のエンドフェイズが開始したとき/;
      if (which === 'oppEnd') { if (!pillarOn(G)) P.field.slice().forEach(x => { if (re.test(cardOf(x).rule_text || '')) cpuTrigger(G, pi, x, re, which); }); return; }
      // 凱旋門「戦場に「思想」カードがある間、自分の墓地にある「徴募」は、アタッカーが破壊されていなくても、バトルしているなら発動する」
      const gaisen = G.battleUsed && !!fieldSrc(G, pi, /戦場に「思想」カードがある間、自分の墓地にある「徴募」は、アタッカーが破壊されていなくても、バトルしているなら発動する/) && G.players.some(Q => Q.field.some(x => x.faceUp && hasTrait(cardOf(x), '思想')));
      const condOk = x => !/このターンにアタッカーが破壊されているなら/.test(cardOf(x).rule_text || '') || G.atkDestroyedTurn === G.turn || (gaisen && P.grave.includes(x));   // 徴募の条件
      if (!pillarOn(G)) P.field.slice().forEach(x => {
        if (which === 'endPhase' && /これが寝ているなら発動する。?これを破壊する/.test(normTxt(cardOf(x).rule_text))) return;   // 織田信長はエンジンが処理
        if (re.test(cardOf(x).rule_text || '') && condOk(x)) cpuTrigger(G, pi, x, re, which);
      });
      // 徴募「この能力は墓地でも発動する」
      if (which === 'endPhase') P.grave.slice().forEach(x => {
        if (/徴募 - この能力は(?:墓地でも|戦場か墓地で)発動する/.test(cardOf(x).rule_text || '') && condOk(x) && P.grave.includes(x)) cpuTrigger(G, pi, x, /徴募 - /, 'endPhase');
      });
      if (which === 'endPhase' && !pillarOn(G)) P.mana.filter(x => x.faceUp).slice().forEach(x => { if (re.test(cardOf(x).rule_text || '')) cpuTrigger(G, pi, x, re, which); });
    }

    // カードの色（「これが戦場にある間「色：赤 青 緑」を得る」も含む）
    const cardColorsOn = (G, x) => {
      const c = cardOf(x), out = cardOf(x).type === 'イジン' ? COLOR_CHARS.split('').filter(ch => ijinHasColor(G, x, ch)) : colorsOf(c);
      const m = normTxt(c.rule_text).match(/これが戦場にある間「色：([^」]+)」を得る/);
      if (m && x.faceUp && !x.silenced) [...m[1]].forEach(ch => { if (COLOR_CHARS.includes(ch) && !out.includes(ch)) out.push(ch); });
      return out;
    };
    // 自分の戦場にある色の数（スカーレット・ピーコックなど）
    const fieldColors = (G, pi) => new Set(G.players[pi].field.filter(x => x.faceUp).flatMap(x => cardColorsOn(G, x))).size;
    // 「〇魔導 - 〇のカードが自分の戦場か自分の魔力ゾーンにあるなら」
    const redOnMine = (G, pi, ch) => G.players[pi].field.some(x => x.faceUp && cardColorsOn(G, x).includes(ch)) || G.players[pi].mana.some(x => x.faceUp && String(cardOf(x).color || '').includes(ch));
    // 仁王「能力によってこれを数える際、1つでなく2つと数える」
    const countAs = x => (x.faceUp && /能力によってこれを数える際、1つでなく2つと数える/.test(cardOf(x).rule_text || '') ? 2 : 1);

    // 大日本沿海輿地全図で勝つ準備：戦場のハイケイの名前の数、輿地全図が自分の戦場にあり条件を満たしているか
    const YOCHI_RE = /ハイケイの名前が戦場に(\d+)つ以上あるなら発動する。ゲームに勝利する/;
    const haikeiNames = G => new Set(G.players.flatMap(Q => Q.field.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ').map(x => cardOf(x).name)));
    const yochiPlan = (G, pi) => { const P = G.players[pi]; return P.hand.concat(P.field).concat(P.mana.filter(m => !m.faceUp)).some(x => YOCHI_RE.test(normTxt(cardOf(x).rule_text))) || P.deck.some(id => YOCHI_RE.test(normTxt(cardsById[id].rule_text))); };
    const winSetup = (G, pi) => { const y = G.players[pi].field.find(x => x.faceUp && !x.silenced && YOCHI_RE.test(normTxt(cardOf(x).rule_text))); return !!y && haikeiNames(G).size >= Number(normTxt(cardOf(y).rule_text).match(YOCHI_RE)[1]); };
    // 山札をどこまで引いてよいか（次の自分のターン開始時に山札が0枚だと負け。勝ちが決まっているなら1枚残せばよい）
    const deckReserve = (G, pi) => (winSetup(G, pi) ? 1 : 6);

    // 親鸞「カードが墓地から離れたときに発動できる。1ドローする」（自分の墓地）
    function graveLeft(G, pi) {
      if (!G.aiPlayers.has(pi) || (G.cpuNoEffects && G.cpuNoEffects.has(pi)) || pillarOn(G)) return;
      G.players[pi].field.filter(x => x.faceUp && !x.silenced && /カードが墓地から離れたときに発動できる。1ドローする/.test(normTxt(cardOf(x).rule_text))).forEach(x => {
        if (G.players[pi].deck.length > 5) manualDraw(G, pi, 1, `${cardOf(x).name}（カードが墓地から離れた）`);
      });
    }

    /* ---------- デッキコンテスト ---------- */
    // ストーンマスク「イジン召喚によってイジンが自分の戦場に置かれる際、そのイジンに装備させてもよい。装備：戦場に置かれたとき、1ドローする」
    const CARD_AI_EQUIP_SKIP = /^$/;
    function cpuEquipOnSummon(G, pi, host) {
      if (!G.aiPlayers.has(pi) || (G.cpuNoEffects && G.cpuNoEffects.has(pi)) || !host.faceUp) return;
      const P = G.players[pi];
      // 装備させるもの：ストーンマスク（1ドロー）と、キーワード・パワー・色を与えるもの（ファイアソード「アタック+2000」など）
      const cands = equipCandidates(G, pi, host).map(o => ({ o, x: zoneArr(P, o.zone).find(y => y.uid === o.uid) })).filter(({ x }) => x && !CARD_AI_EQUIP_SKIP.test(cardOf(x).name));
      const good = ({ x }) => { const c = cardOf(x), e = equipInfo(c), k = e.kw;
        if (/装備\s*[:：]\s*戦場に置かれたとき、1ドローする/.test(c.rule_text || '')) return P.deck.length > deckReserve(G, pi);
        return k.attack + k.power + k.block >= 1000 || k.haste || k.pressure > 1 || e.cap > 0 || e.perColor > 0; };
      const cap = manaInfo(P).cap, need = Math.max(0, ...P.hand.filter(x => cardOf(x).type !== 'マリョク').map(x => cardOf(x).level || 0));
      const pick = cands.filter(good).find(({ o, x }) => o.zone !== 'mana' || equipInfo(cardOf(x)).cap > 0 || cap - (cardOf(x).level || 0) >= Math.min(need, 6));   // 魔力ゾーンから外すとレベル上限が下がるので、足りなくなるなら装備しない
      if (pick) manualEquip(G, pi, pick.o.uid, pick.o.zone, host.uid);
    }
    // 紡績工場「エンドフェイズが開始したとき、裏のカードが魔力ゾーンにないなら、これを破壊する。そうでなければ、魔力ゾーンの裏のカード1つを手札に戻す」
    function spinningMill(G) {
      if (pillarOn(G)) return;
      G.players.forEach((Q, q) => Q.field.filter(x => x.faceUp && !x.silenced && /エンドフェイズが開始したとき、裏のカードが魔力ゾーンにないなら、これを破壊する/.test(cardOf(x).rule_text || '')).forEach(x => {
        if (!G.aiPlayers.has(q) || (G.cpuNoEffects && G.cpuNoEffects.has(q))) return;
        const O = G.players[1 - q], own = Q.mana.find(m => !m.faceUp), foe = O.mana.find(m => !m.faceUp);
        if (!own && !foe) { log(G, `　${cardOf(x).name}：魔力ゾーンに裏のカードがないので破壊されます`); manualDestroy(G, q, x.uid, cardOf(x).name); return; }
        const [tq, m] = foe ? [1 - q, foe] : [q, own], T = G.players[tq];
        T.mana.splice(T.mana.indexOf(m), 1); m.faceUp = true; T.hand.push(m);
        log(G, `　${cardOf(x).name}：${nm(G, tq)}の魔力ゾーンの裏のカード1つを手札に戻しました`); onManaLeft(G, tq);
      }));
    }
    // 「美術」カードか（「特性：美術」を文で持つハイケイ、俵屋宗達「自分の戦場のハイケイは「特性：美術」を得る」）
    const isArt = (G, x) => { const c = cardOf(x); if (hasTrait(c, '美術') || /特性[:：]\s*美術/.test(c.rule_text || '')) return true;
      const o = ownerOf(G, x); return c.type === 'ハイケイ' && o >= 0 && !!fieldSrc(G, o, /これが戦場にいる間、自分の戦場のハイケイは「特性：美術」を得る/); };

    /* ---------- 第6弾：手札から墓地に置かれたときに発動するマホウ ---------- */
    // 払暁の城壁「ターンに1回、自分の墓地の「冥府発動」は手札から墓地に置かれても発動する」（戦場か墓地で効果）
    const DAWN_RE = /自分の墓地の「冥府発動」は手札から墓地に置かれても発動する/;
    const dawnLeft = (G, q) => { const P = G.players[q]; const n = P.field.concat(P.grave).filter(x => x.faceUp && !x.silenced && DAWN_RE.test(cardOf(x).rule_text || '')).length; return n - (P.dawnTurn === G.turn ? P.dawnN : 0); };
    const SELF_DISCARD_RE = /この能力は、これが手札から墓地に置かれたときにも発動できる/;
    const hasMeifu = c => c.type === 'マホウ' && /冥府発動/.test(c.legacy_ability || '');
    // 手札から墓地に置いたとき、そのマホウが発動するか（エンビー自身／払暁の城壁で冥府発動）
    function discardFires(G, q, x) {
      const c = cardOf(x), h = CARD_AI[c.name];
      if (!G.aiPlayers.has(q) || (G.cpuNoEffects && G.cpuNoEffects.has(q)) || c.type !== 'マホウ' || !h || !h.want) return false;
      if (!SELF_DISCARD_RE.test(c.rule_text || '') && !(hasMeifu(c) && dawnLeft(G, q) > 0)) return false;
      if (G.dfBusy) return false;   // want の中から discardFires を呼び返さない（リンボが2枚あるときなど）
      G.dfBusy = true; try { return !!h.want(G, q); } finally { G.dfBusy = false; }
    }
    function onHandDiscard(G, q, inst) {
      const c = cardOf(inst), P = G.players[q], h = CARD_AI[c.name];
      if (!P.grave.includes(inst) || !discardFires(G, q, inst)) return;
      const self = SELF_DISCARD_RE.test(c.rule_text || '');
      if (!self) { if (P.dawnTurn === G.turn) P.dawnN++; else { P.dawnTurn = G.turn; P.dawnN = 1; } }
      log(G, `　${c.name}：手札から墓地に置かれたので発動します` + (self ? '' : '（払暁の城壁：冥府発動）'));
      const target = h.want(G, q);
      h.resolve(G, q, { target, inst, kind: 'mahou' });
      G.fx.push({ type: 'ability', pi: q, kind: 'discard', cardId: c.id, name: c.name, text: self ? '手札から墓地に置かれて発動' : '払暁の城壁：冥府発動', uid: inst.uid, auto: true });
    }
    // 自分で手札を捨てるときに先に選ぶカード：マシュー・ペリー（戦場に出る）＞ 捨てると発動するマホウ ＞ 使い道の薄いカード
    const discardScore = (G, q, x) => (/手札から墓地に置かれたとき、これを戦場に置く/.test(cardOf(x).rule_text || '') && G.aiPlayers.has(q) ? 100 : discardFires(G, q, x) ? 90 + (cardOf(x).level || 0) : -cardUsefulness(G, q, x));
    function discardSmart(G, q, n, by, except) {
      const P = G.players[q], names = [];
      for (let k = 0; k < n; k++) {
        const pool = P.hand.filter(x => x !== except); if (!pool.length) break;
        const x = pool.sort((a, b) => discardScore(G, q, b) - discardScore(G, q, a))[0];
        names.push(cardOf(x).name); handToGrave(G, q, x);
      }
      if (names.length) log(G, `　${by || '効果'}：${nm(G, q)}は手札の${names.join('、')}を墓地に置きました`);
    }

    /* ---------- 第5弾の誘発・CPUの判断 ---------- */
    const STONE_DRAW_RE = /この能力は、自分の魔力ゾーンに『ストーン』マリョクが置かれたときに魔力ゾーンで発動する。1ドローする/;
    const isStone = c => c.type === 'マリョク' && /ストーン/.test(c.name);
    // 『ストーン』マリョクが自分の魔力ゾーンに表で置かれたとき（ハースストーン：1ドロー／日野富子：1ドローか山札の上から裏で魔力ゾーンへ）
    function onStonePlaced(G, pi, inst) {
      if (!inst || !inst.faceUp || !isStone(cardOf(inst)) || pillarOn(G) || !G.aiPlayers.has(pi) || (G.cpuNoEffects && G.cpuNoEffects.has(pi))) return;
      const P = G.players[pi];
      P.mana.filter(m => m.faceUp && STONE_DRAW_RE.test(normTxt(cardOf(m).rule_text))).forEach(m => {
        if (P.deck.length > deckReserve(G, pi) || P.field.some(x => x.faceUp && !x.silenced && /自分が能力によってカードを引く際、カードを引く代わりに/.test(cardOf(x).rule_text || ''))) manualDraw(G, pi, 1, `${cardOf(m).name}`);
      });
      P.field.filter(x => x.faceUp && !x.silenced && /『ストーン』マリョクが自分の魔力ゾーンに置かれたときに発動できる。1ドローするか、自分の山札の上から1枚を裏のまま魔力ゾーンに置く/.test(cardOf(x).rule_text || '')).forEach(x => {
        if (P.deck.length <= deckReserve(G, pi)) return;
        if (manaInfo(P).cap < 6) { P.mana.push(mkInst(P.deck.pop(), { faceUp: false })); log(G, `　${cardOf(x).name}：山札の上から1枚を裏のまま魔力ゾーンに置きました`); onFaceDownMana(G, pi); }
        else manualDraw(G, pi, 1, cardOf(x).name);
      });
    }
    // 米百俵：ドローの代わりにマリョク配置権を増やすか（表で置けるマリョクが手札か墓地（地上の紫微垣）にあり、手札が足りている・山札が少ない）
    function faceUpManaSources(G, pi) {
      const P = G.players[pi];
      return P.hand.filter(x => cardOf(x).type === 'マリョク').length + (shibiReady(G, pi) ? P.grave.filter(x => cardOf(x).type === 'マリョク').length : 0);
    }
    const wantRightsInsteadOfDraw = (G, pi) => { const P = G.players[pi]; return faceUpManaSources(G, pi) > P.manaPlace && (P.hand.length >= 4 || P.deck.length <= 15); };
    // 精霊の島々「自分の山札のカードが0枚になったときに戦場か墓地で発動できる。自分の手札のカードすべてを山札に戻してシャッフルし、相手の手札のカードすべてを墓地に置く」
    function deckZero(G, pi) {
      const P = G.players[pi];
      if (P.deck.length || G.winner !== null || !G.aiPlayers.has(pi) || (G.cpuNoEffects && G.cpuNoEffects.has(pi)) || G.deckZeroBusy) return;
      const re = /自分の山札のカードが0枚になったときに戦場か墓地で発動できる。自分の手札のカードすべてを山札に戻してシャッフルし、相手の手札のカードすべてを墓地に置く/;
      const src = P.grave.find(x => re.test(cardOf(x).rule_text || '')) || (!pillarOn(G) && P.field.find(x => x.faceUp && !x.silenced && re.test(cardOf(x).rule_text || '')));
      if (!src) return;
      G.deckZeroBusy = true;
      const n = P.hand.length;
      P.hand.splice(0).forEach(x => P.deck.push(x.cardId)); shuffle(P.deck);
      log(G, `　${cardOf(src).name}：山札が0枚になったので、手札${n}枚を山札に戻してシャッフルし、相手の手札すべてを墓地に置きます`);
      const O = G.players[1 - pi]; O.hand.slice().forEach(x => handToGrave(G, 1 - pi, x));
      G.fx.push({ type: 'ability', pi, kind: 'deckZero', cardId: src.cardId, name: cardOf(src).name, text: '手札を山札に戻して、相手の手札すべてを墓地へ', uid: src.uid, auto: true });
      G.deckZeroBusy = false;
    }
    // アンリ4世「これがブロックされたときに発動できる。イジン召喚権+1して、これとこれをブロックしているブロッカーすべてを手札に戻す」（CPUのアタッカー）
    function cpuOnBlocked(G) {
      const pi = G.current, P = G.players[pi], D = G.players[1 - pi];
      if (!G.battle || pillarOn(G) || !G.aiPlayers.has(pi) || (G.cpuNoEffects && G.cpuNoEffects.has(pi))) return;
      G.battle.attackers.slice().forEach(u => {
        const a = P.field.find(x => x.uid === u);
        if (!a || !a.faceUp || a.silenced || !/これがブロックされたときに発動できる。イジン召喚権\+1して、これとこれをブロックしているブロッカーすべてを手札に戻す/.test(normTxt(cardOf(a).rule_text))) return;
        const bs = Object.keys(G.battle.blocks).filter(b => G.battle.blocks[b] === u).map(b => D.field.find(x => x.uid === Number(b))).filter(Boolean);
        if (!bs.length) return;
        const sumB = bs.reduce((t, b) => t + (b.faceUp ? blockPowerOf(b, G) : 0), 0);
        if (!(attackPowerOf(a, G) <= sumB || bs.some(b => b.faceUp && instValue(G, b) >= 4000))) return;
        log(G, `　${cardOf(a).name}の効果：ブロックされたので、イジン召喚権+1して、これとブロッカーすべてを手札に戻します`);
        P.summon += 1;
        bs.forEach(b => { Object.keys(G.battle.blocks).forEach(k => { if (Number(k) === b.uid) delete G.battle.blocks[k]; }); bounce(G, 1 - pi, b, cardOf(a).name); });
        G.battle.attackers = G.battle.attackers.filter(x => x !== u);
        bounce(G, pi, a, cardOf(a).name);
        G.fx.push({ type: 'ability', pi, kind: 'blocked', cardId: a.cardId, name: cardOf(a).name, text: 'これとブロッカーを手札に戻す', uid: a.uid, auto: true });
      });
    }
    // 戦場のカードを墓地に置く（破壊ではない：ドッペルゲンガー）
    function fieldToGrave(G, q, x) {
      const Q = G.players[q], i = Q.field.indexOf(x); if (i < 0) return;
      Q.field.splice(i, 1); releaseEquips(G, q, x);
      x.faceUp = true; x.tapped = false; x.isGuardian = false; x.silenced = false; x.indestructible = false; Q.grave.push(x);
      fieldToGraveLoss(G, q, x);
    }
    // 墓地のカードから、手札に戻す（山札の上に置く）ならどれか
    const bestFromGrave = (G, pi, filt) => G.players[pi].grave.filter(x => !(graveMahouLocked(G) && cardOf(x).type === 'マホウ')).filter(filt || (() => true)).sort((a, b) => cardUsefulness(G, pi, b) - cardUsefulness(G, pi, a))[0];

    /* ---------- カードごとの処理（書式だけでは決められない「どれを選ぶか」「いつ使うか」があるもの） ----------
       want(G, pi): 使う価値があれば対象（ctx.target）を返す。timing: 'main'（メイン）| 'preAttack'（アタック宣言の直前）
       resolve(G, pi, ctx): 効果を処理する（ctx.target は want が返したもの） */
    const notIndestructible = G => x => !isIndestructible(G, x, true);
    // リンボで墓地から手札に加えるカード：出せるイジン・使えるマホウを優先。払暁の城壁は墓地に残す
    function limboValue(G, pi, x) {
      const c = cardOf(x), P = G.players[pi], cap = manaInfo(P).cap;
      if (DAWN_RE.test(c.rule_text || '') || c.name === 'リンボ') return 0;
      if (c.type === 'イジン') return (c.level || 0) <= cap ? 9 + (c.power || 0) / 2000 : 4;
      if (c.type === 'マホウ') { const h = CARD_AI[c.name]; return h && h.want ? (h.want(G, pi) ? 10 : 4) : 3; }
      if (c.type === 'マリョク') return /2ドローして/.test(c.rule_text || '') ? 6 : 3;
      return /魔力ゾーンのこれを表にして発動できる/.test(c.rule_text || '') ? 3 : 5;
    }
    // サーベイングで墓地に置くハイケイ：すぐ使えないもの（輿地全図は1枚は手札に残す）
    function surveyPick(G, pi) {
      const P = G.players[pi], hs = P.hand.filter(x => cardOf(x).type === 'ハイケイ' && playProblems(G, pi, cardOf(x)).length);
      const yochi = hs.filter(x => YOCHI_RE.test(normTxt(cardOf(x).rule_text)));
      return hs.filter(x => !(yochi.length && x === yochi[0]));
    }
    const limboPicks = (G, pi, me) => G.players[pi].grave.filter(x => x !== me && !(graveMahouLocked(G) && cardOf(x).type === 'マホウ')).sort((a, b) => limboValue(G, pi, b) - limboValue(G, pi, a)).slice(0, 4);
    // ドッペルゲンガーの対象：相手の手札・戦場・墓地で同じ名前を持つ、マリョクでないカード（手札と戦場のもの）
    function doppelTargets(G, pi) {
      const Q = G.players[1 - pi], cnt = {};
      Q.hand.concat(Q.field.filter(x => x.faceUp), Q.grave).forEach(x => { if (cardOf(x).type !== 'マリョク') cnt[cardOf(x).name] = (cnt[cardOf(x).name] || 0) + 1; });
      return Q.hand.concat(Q.field.filter(x => x.faceUp)).filter(x => cardOf(x).type !== 'マリョク' && cnt[cardOf(x).name] >= 2);
    }
    const CARD_AI = {
      // 自分のイジン1体と相手のイジン1体を破壊：価値の低い自分のイジンで、価値の高い相手のイジンを取る
      'バレット': {
        timing: 'main',
        want(G, pi) {
          const mine = G.players[pi].field.filter(isIjinUp).filter(notIndestructible(G)).sort((a, b) => instValue(G, a) - instValue(G, b));
          const foe = G.players[1 - pi].field.filter(isIjinUp).filter(notIndestructible(G)).sort((a, b) => instValue(G, b) - instValue(G, a));
          if (!mine.length || !foe.length) return null;
          return instValue(G, foe[0]) - instValue(G, mine[0]) >= 1500 ? { mine: mine[0].uid, foe: foe[0].uid } : null;
        },
        resolve(G, pi, ctx) {
          const t = ctx.target; if (!t) return false;
          manualDestroy(G, pi, t.mine, 'バレット'); manualDestroy(G, 1 - pi, t.foe, 'バレット');
        }
      },
      // このターン「イジンにブロックされない」を与える：それで相手がブロックしきれなくなる（詰み）ときだけ使う
      'チャンピオン': {
        timing: 'preAttack',
        want(G, pi) {
          if (G.battleUsed) return null;
          const E = eligibleAttackers(G, pi), oppB = eligibleBlockers(G, 1 - pi);
          if (!E.length || !coverable(G, asAtk(G, E), oppB)) return null;   // すでに詰みなら不要
          for (const a of E.filter(x => x.faceUp && !x.noIjin).sort((x, y) => requiredBlockers(y, G) - requiredBlockers(x, G))) {
            a.noIjin = true;
            const lethal = !coverable(G, asAtk(G, E), oppB);
            a.noIjin = false;
            if (lethal) return { att: a.uid };
          }
          return null;
        },
        resolve(G, pi, ctx) {
          const a = ctx.target && G.players[pi].field.find(x => x.uid === ctx.target.att); if (!a) return false;
          a.noIjin = true;
          log(G, `　チャンピオン：${cardOf(a).name}はこのターン「イジンにブロックされない」`);
        }
      },
      // ===== 第1弾プリセット（青単闘技場〜道長ループ）のカード =====
      'ストーム': {   // 戦場のイジン1体を手札に戻す：相手の一番価値の高いイジン（4000以上）を戻す
        timing: 'main',
        want(G, pi) { const f = G.players[1 - pi].field.filter(isIjinUp).sort((a, b) => instValue(G, b) - instValue(G, a))[0]; return f && instValue(G, f) >= 4000 ? { uid: f.uid } : null; },
        resolve(G, pi, ctx) { const f = ctx.target && G.players[1 - pi].field.find(x => x.uid === ctx.target.uid); if (!f) return false; bounce(G, 1 - pi, f, 'ストーム'); }
      },
      'リバイバル': {   // 墓地のレベル6以下のイジンかレベル5以下のハイケイを手札へ（「美術」イジンがいれば戦場へ）
        timing: 'main',
        want(G, pi) { const t = bestRevive(G, pi); return t ? { uid: t.uid } : null; },
        resolve(G, pi, ctx) {
          const P = G.players[pi], t = ctx.target && P.grave.find(x => x.uid === ctx.target.uid); if (!t) return false;
          const toField = P.field.some(x => isIjinUp(x) && hasTrait(cardOf(x), '美術'));
          P.grave.splice(P.grave.indexOf(t), 1);
          if (toField) placeToField(G, pi, t, 'リバイバル（「美術」イジンがいるので戦場へ）');
          else { t.faceUp = true; P.hand.push(t); log(G, `　リバイバル：${cardOf(t).name}を墓地から手札に戻しました`); }
        }
      },
      'ギャザリング': {   // ガーディアンすべてを手札に戻して、山札から2枚をガーディアンに：ガーディアンが1体以下のときだけ得
        timing: 'main',
        want(G, pi) { return myGuards(G, pi).length <= 1 && G.players[pi].deck.length >= 6 ? {} : null; },
        resolve(G, pi) {
          const P = G.players[pi], gs = myGuards(G, pi);
          gs.forEach(g => { P.field.splice(P.field.indexOf(g), 1); g.faceUp = true; g.isGuardian = false; g.tapped = false; P.hand.push(g); });
          log(G, `　ギャザリング：ガーディアン${gs.length}体を手札に戻しました`);
          addGuardianFromDeck(G, pi, 'ギャザリング'); addGuardianFromDeck(G, pi, 'ギャザリング');
        }
      },
      'デスペラード': {   // 自分のイジン1体と相手のガーディアン1体を破壊：それで詰みになるときだけ
        timing: 'preAttack',
        want(G, pi) {
          if (G.battleUsed) return null;
          const E = eligibleAttackers(G, pi), oppB = eligibleBlockers(G, 1 - pi);
          const g = oppB.find(isGuardianInst);
          if (!g || !E.length || !coverable(G, asAtk(G, E), oppB)) return null;
          const mine = G.players[pi].field.filter(isIjinUp).filter(notIndestructible(G)).sort((a, b) => (E.includes(a) ? 1 : 0) - (E.includes(b) ? 1 : 0) || instValue(G, a) - instValue(G, b));
          for (const m of mine) {
            const E2 = E.filter(x => x !== m);
            if (E2.length && !coverable(G, asAtk(G, E2), oppB.filter(x => x !== g))) return { mine: m.uid, guard: g.uid };
          }
          return null;
        },
        resolve(G, pi, ctx) {
          const t = ctx.target; if (!t) return false;
          manualDestroy(G, pi, t.mine, 'デスペラード'); manualDestroy(G, 1 - pi, t.guard, 'デスペラード');
        }
      },
      'メアリー1世': {   // 相手の手札を見てマリョクでないカード1つを墓地へ：一番価値の高いもの
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const O = G.players[1 - pi], c = O.hand.filter(x => cardOf(x).type !== 'マリョク').sort((a, b) => cardValue(cardOf(b)) - cardValue(cardOf(a)))[0];
          if (!c) { log(G, '　メアリー1世：相手の手札にマリョクでないカードはありません'); return; }
          O.hand.splice(O.hand.indexOf(c), 1); c.faceUp = true; O.grave.push(c);
          log(G, `　メアリー1世：${nm(G, 1 - pi)}の手札から${cardOf(c).name}を墓地に置きました`);
        }
      },
      '中臣鎌足': {   // 山札の上から5枚を墓地に置いて、このターン「即応」：山札に余裕があるときだけ
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          if (G.players[pi].deck.length < 18 || !ctx.inst) return 'declined';
          millN(G, pi, 5, '中臣鎌足'); ctx.inst.hasteTurn = G.turn; log(G, '　中臣鎌足はこのターン「即応」を得ました');
        }
      },
      'レオナルド・ダ・ヴィンチ': {   // 墓地のレベル6以下のイジンかレベル5以下のハイケイを戦場に置く
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const t = bestRevive(G, pi, ctx.inst); if (!t) return 'declined';
          G.players[pi].grave.splice(G.players[pi].grave.indexOf(t), 1);
          placeToField(G, pi, t, 'レオナルド・ダ・ヴィンチ');
        }
      },
      'チンギス・ハン': {   // 自分と相手の魔力ゾーンの裏のカードすべてを戦場に置く（ガーディアンとして）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          G.players.forEach((P, q) => {
            const ds = P.mana.filter(x => !x.faceUp);
            ds.forEach(x => { P.mana.splice(P.mana.indexOf(x), 1); x.isGuardian = true; x.tapped = false; x.placedTurn = G.turn; P.field.push(x); });
            if (ds.length) { log(G, `　チンギス・ハン：${nm(G, q)}の魔力ゾーンの裏のカード${ds.length}枚を戦場に置きました（ガーディアン）`); onGuardianPlaced(G, q); }
          });
        }
      },
      '楊貴妃': {   // 自分のイジン1体を破壊して3ドロー：価値の低い他のイジンがいるときだけ
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const t = G.players[pi].field.filter(x => isIjinUp(x) && x !== ctx.inst).filter(notIndestructible(G))
            .sort((a, b) => instValue(G, a) - instValue(G, b))[0];
          if (!t || instValue(G, t) > 4000) return 'declined';
          manualDestroy(G, pi, t.uid, '楊貴妃'); manualDraw(G, pi, 3, '楊貴妃');
        }
      },
      '清少納言': {   // 戦場に置かれたとき：自分のマリョクと同じ色の相手のイジンを裏にして（持ち主の）魔力ゾーンへ。執筆：相手の魔力ゾーンのカードを手札に戻す（マリョクを縛る）
        resolve(G, pi, ctx) {
          if (ctx.kind === 'shippitsu') {
            const O = G.players[1 - pi];
            const cnt = {}; O.mana.filter(m => m.faceUp).forEach(m => colorsOf(cardOf(m)).forEach(ch => { cnt[ch] = (cnt[ch] || 0) + 1; }));
            const t = O.mana.slice().sort((a, b) => {
              const sc = m => (m.faceUp ? 10 + (colorsOf(cardOf(m)).some(ch => cnt[ch] === 1) ? 10 : 0) + (cardOf(m).level || 0) : 0);
              return sc(b) - sc(a); })[0];
            if (!t) return 'declined';
            O.mana.splice(O.mana.indexOf(t), 1); t.faceUp = true; O.hand.push(t);
            log(G, `　清少納言（執筆）：${nm(G, 1 - pi)}の魔力ゾーンのカード1つを手札に戻しました（残り${O.mana.length}枚）`);
            return;
          }
          if (ctx.kind !== 'field') return false;
          const cols = manaInfo(G.players[pi]).colors, O = G.players[1 - pi];
          const t = O.field.filter(x => isIjinUp(x) && colorsOf(cardOf(x)).some(ch => cols.has(ch))).sort((a, b) => instValue(G, b) - instValue(G, a))[0];
          if (!t) return 'declined';
          O.field.splice(O.field.indexOf(t), 1); releaseEquips(G, 1 - pi, t); t.faceUp = false; t.tapped = false; t.isGuardian = false; O.mana.push(t);
          log(G, `　清少納言：${nm(G, 1 - pi)}の${cardOf(t).name}を裏にして魔力ゾーンに置きました`);
        }
      },
      '鴨長明': { resolve(G, pi, ctx) { return ctx.kind === 'shippitsu' ? 'declined' : false; } },
      'ハリエット・ビーチャー・ストウ': {   // 執筆：ターンプレイヤーは1ドローして、このターンはバトルできない → 相手のターン（まだバトル前）に使う
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'shippitsu') return false;
          if (G.battleUsed) return 'declined';
          // 自分のターンは、どうせアタックしない（できない）ときだけ使う（1ドローのため）
          if (G.current === pi && (cpuChooseAttack(G, pi).list.length || G.players[pi].deck.length <= deckReserve(G, pi) + 1)) return 'declined';   // 山札切れに注意
          manualDraw(G, G.current, 1, 'ハリエット・ビーチャー・ストウ');
          G.noBattle = { turn: G.turn, pi: G.current };
          log(G, `　ハリエット・ビーチャー・ストウ：${nm(G, G.current)}はこのターン、バトルできません`);
        }
      },
      '裴松之': {   // 執筆：戦場の「執筆」を持つカード1つにつき1体まで、相手のイジンを手札に戻す
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'shippitsu') return false;
          const n = G.players.reduce((t, P) => t + P.field.filter(x => x.faceUp && /執筆 - /.test(cardOf(x).rule_text || '')).length, 0);
          G.players[1 - pi].field.filter(isIjinUp).sort((a, b) => instValue(G, b) - instValue(G, a)).slice(0, n).forEach(x => bounce(G, 1 - pi, x, '裴松之'));
        }
      },
      '徳川家光': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? 'declined' : false; } },
      'マルクス・アントニウス': {   // ガーディアン1体を裏のまま魔力ゾーンに置いて召喚権+1：ガーディアンに余裕があり、次に出すイジンがあるとき
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi], g = takeGuardian(G, pi);
          const next = P.hand.some(x => cardOf(x).type === 'イジン' && conditionProblems(P, cardOf(x), summonInfo(G, pi, cardOf(x)).auto - 1).length === 0);
          if (!g || myGuards(G, pi).length < 3 || !next) return 'declined';
          P.field.splice(P.field.indexOf(g), 1); g.isGuardian = false; g.faceUp = false; P.mana.push(g); P.summon += 1;
          log(G, `　マルクス・アントニウス：ガーディアン1体を魔力ゾーンに置いて、イジン召喚権+1`);
        }
      },
      '藤原道長': {   // 魔力ゾーンのマリョク1色につき、墓地のマホウ1つを手札に戻す
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi], n = manaInfo(P).colors.size;
          const mill = c => /相手の山札の上から\d枚を墓地に置/.test(normTxt(cardOf(c).rule_text)) ? 2 : 0;
          const loop = c => (rikyuDeck(G, pi) && rikyuOn(G, pi) ? Math.max(0, 10 - RIKYU_LOOP.indexOf(cardOf(c).name)) * (RIKYU_LOOP.includes(cardOf(c).name) ? 1 : 0) : 0);   // 利休ループで使うマホウを優先
          if (graveMahouLocked(G)) { log(G, '　二重螺旋階段の効果で、墓地のマホウは墓地を離れません'); return; }
          let ms = P.grave.filter(x => cardOf(x).type === 'マホウ').sort((a, b) => (loop(b) + mill(b) + (CARD_AI[cardOf(b).name] ? 1 : 0)) - (loop(a) + mill(a) + (CARD_AI[cardOf(a).name] ? 1 : 0)));
          if (rikyuDeck(G, pi) && rikyuOn(G, pi)) {   // 利休ループ：ドシャカジ・グラトニーは手札に1枚あればよい。残りは魔力レベルを上げるΩ・チャージに回す
            const pick = [], seen = {};
            P.hand.forEach(x => { if (['ドシャカジ', 'グラトニー'].includes(cardOf(x).name)) seen[cardOf(x).name] = 1; });
            ms.forEach(x => { const k = cardOf(x).name; if (pick.length < n && !(['ドシャカジ', 'グラトニー'].includes(k) && seen[k])) { pick.push(x); seen[k] = 1; } });
            ms.forEach(x => { if (pick.length < n && !pick.includes(x) && !['ドシャカジ', 'グラトニー'].includes(cardOf(x).name)) pick.push(x); });
            ms = pick;
          } else ms = ms.slice(0, n);
          ms.forEach(x => { P.grave.splice(P.grave.indexOf(x), 1); x.faceUp = true; P.hand.push(x); });
          log(G, `　藤原道長：墓地のマホウ${ms.length}枚（${ms.map(x => cardOf(x).name).join('、') || 'なし'}）を手札に戻しました`);
        }
      },
      'カルドロン': {   // 魔力ゾーンに置かれたとき：手札の一番使い道の薄いカードを裏向きで魔力ゾーンへ
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'mana') return false;
          const P = G.players[pi]; if (P.hand.length < 2) return 'declined';
          const x = P.hand.slice().sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b))[0];
          P.hand.splice(P.hand.indexOf(x), 1); x.faceUp = false; P.mana.push(x);
          log(G, '　カルドロン：手札1枚を裏向きで魔力ゾーンに置きました');
        }
      },
      'フール': {   // 墓地のマホウのレベル合計が1以上なら手札の他のカード1つを墓地へ、そうでなければ1ドロー（マホウ）
        timing: 'main',
        want(G, pi) { const P = G.players[pi], lv = P.grave.filter(x => cardOf(x).type === 'マホウ').reduce((t, x) => t + (cardOf(x).level || 0), 0);
          return lv >= 1 ? (P.hand.some(x => cardOf(x).name !== 'フール' && discardScore(G, pi, x) >= 90) ? {} : null) : (P.deck.length > deckReserve(G, pi) ? {} : null); },
        resolve(G, pi, ctx) {
          if (ctx.kind && ctx.kind !== 'mahou') return false;
          const P = G.players[pi], lv = P.grave.filter(x => cardOf(x).type === 'マホウ').reduce((t, x) => t + (cardOf(x).level || 0), 0);
          if (lv >= 1) discardLowest(G, pi, 1, 'フール'); else manualDraw(G, pi, 1, 'フール');
        }
      },
      '革命の広場': {   // メインフェイズ開始時：価値の低い自分のイジンを破壊して2ドロー
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;   // 置いただけでは何も起きない（メインフェイズ開始時に判断）
          if (ctx.kind !== 'mainStart') return false;
          const t = G.players[pi].field.filter(isIjinUp).filter(notIndestructible(G))
            .sort((a, b) => (instValue(G, a) - (hasLegacy(cardOf(a)) ? 1500 : 0)) - (instValue(G, b) - (hasLegacy(cardOf(b)) ? 1500 : 0)))[0];
          if (!t || instValue(G, t) - (hasLegacy(cardOf(t)) ? 1500 : 0) > 2000) return 'declined';
          manualDestroy(G, pi, t.uid, '革命の広場'); manualDraw(G, pi, 2, '革命の広場');
        }
      },
      '阿弥陀堂': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : ctx.kind === 'mainStart' ? 'declined' : false; } },
      'ジャン・カルヴァン': { resolve(G, pi, ctx) { return ctx.kind === 'mainStart' ? 'declined' : false; } },
      '三層の舎利殿': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : ctx.kind === 'endPhase' ? 'declined' : false; } },
      '蒸気機関車': {   // エンドフェイズ開始時：山札の上から2枚を見て、ハイケイを戦場に、残りを手札に
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field' || ctx.kind === 'equip') return;   // 装備の「即応」「ハイケイ1つにつきパワー+500」はエンジンが計算
          if (ctx.kind !== 'endPhase') return false;
          const P = G.players[pi], top = [];
          for (let k = 0; k < 2 && P.deck.length; k++) top.push(mkInst(P.deck.pop()));
          top.forEach(x => {
            if (cardOf(x).type === 'ハイケイ') { placeToField(G, pi, x, '蒸気機関車'); }
            else { P.hand.push(x); }
          });
          log(G, `　蒸気機関車：山札の上から${top.length}枚を見て、ハイケイは戦場に、残りは手札に加えました`);
        }
      },
      '純白の塔': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },        // アタック宣言時に処理（cpuOnAttack）
      '毘盧遮那仏像': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },    // アタック宣言時に処理（cpuOnAttack）。パワー+1000は自動計算
      '遁甲式水鏡': { resolve(G, pi, ctx) { return ctx.kind === 'field' || ctx.kind === 'mana' ? undefined : false; } },   // 魔力ゾーンに裏で置いておくカード（表で置いても何もしない）
      '遁甲盤': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? undefined : false; } },
      '遁甲式烈火': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? undefined : false; } },
      '遁甲式木蓮': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? undefined : false; } },      // 魔力ゾーンで裏向きのときの能力なので、戦場では何もしない
      'アイスソード': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? 'declined' : false; } },    // 装備は使わない
      // ===== 第2弾プリセットのカード =====
      '親鸞': {   // エンドフェイズ：墓地のマリョクでないカード1つを山札の下へ → 「カードが墓地から離れたとき」1ドロー（墓地6枚以上は保つ）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'endPhase') return false;
          const P = G.players[pi];
          const keep = ctx.inst && P.field.includes(ctx.inst) ? 6 : 0;
          const c = P.grave.filter(x => cardOf(x).type !== 'マリョク').sort((a, b) => cardValue(cardOf(a)) - cardValue(cardOf(b)))[0];
          if (!c || P.grave.length <= keep) return 'declined';
          P.grave.splice(P.grave.indexOf(c), 1); P.deck.unshift(c.cardId);
          log(G, `　親鸞：墓地の${cardOf(c).name}を山札の下に戻しました`);
          graveLeft(G, pi);
        }
      },
      '足利義政': {   // 赤のイジンが自分の戦場に置かれたとき：2ドローかイジン召喚権+2（書式ルールで処理）
      },
      '諸葛亮': {   // 戦場に置かれたとき：山札の下から1枚を見て、ハイケイなら戦場に置く
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi]; if (!P.deck.length) return 'declined';
          const id = P.deck[0];
          if (cardsById[id].type !== 'ハイケイ') { log(G, '　諸葛亮：山札の下のカードはハイケイではありませんでした'); return; }
          P.deck.shift(); placeToField(G, pi, mkInst(id), '諸葛亮');
        }
      },
      '英傑集う大河': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },   // 色の付与はエンジン、3体アタックへの対応は cpuOnAttack
      '籠城戦': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },         // 反魂の代わりは cpuLegacy、決起は onManaPlaced
      '遠征軍': {
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'endPhase') return false;
          const P = G.players[pi];
          if (P.deck.length >= 1 || !ctx.inst || !P.field.includes(ctx.inst)) return 'declined';
          P.field.splice(P.field.indexOf(ctx.inst), 1); P.deck.push(ctx.inst.cardId);
          log(G, '　遠征軍：山札が0枚なので、これを山札の上に戻しました');
        }
      },
      '大日本沿海輿地全図': { resolve(G, pi, ctx) { return ctx.kind === 'field' || ctx.kind === 'mainStart' ? undefined : false; } },   // 勝利判定はエンジン（メインフェイズ開始時）
      '仁王': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      '地上の紫微垣': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      '茅葺き屋根の張出し舞台': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? 'declined' : false; } },
      '志士の藩校': { resolve(G, pi, ctx) { return ctx.kind === 'field' || ctx.kind === 'shippitsu' ? undefined : false; } },   // 「思想」付与は勝敗にほぼ影響しないので省略
      'アリエノール・ダキテーヌ': { resolve(G, pi, ctx) { return ctx.kind === 'destroyed' ? 'declined' : false; } },   // 山札が少ないときは使わない（使うときは onDestroyed で処理）
      '曹丕': { resolve(G, pi, ctx) { if (ctx.kind !== 'shippitsu') return false; G.yellowTurn = G.turn; log(G, '　曹丕：このターン、戦場のイジンは「色：黄」を得ます'); } },
      '藤原頼通': {   // 執筆：そのハイケイのレベル以下のレベルの墓地のマホウ1つを手札へ
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'shippitsu') return false;
          const P = G.players[pi], lv = ctx.haikei ? (cardOf(ctx.haikei).level || 0) : 0;
          const m = P.grave.filter(x => cardOf(x).type === 'マホウ' && (cardOf(x).level || 0) <= lv).sort((a, b) => (CARD_AI[cardOf(b).name] ? 1 : 0) - (CARD_AI[cardOf(a).name] ? 1 : 0))[0];
          if (!m) return 'declined';
          P.grave.splice(P.grave.indexOf(m), 1); m.faceUp = true; P.hand.push(m);
          log(G, `　藤原頼通：墓地の${cardOf(m).name}を手札に戻しました`);
        }
      },
      'ジャン＝ジャック・ルソー': {   // 手札1枚を墓地に置いて、戦場で最も高いパワーを持つイジン1体を破壊（同じなら相手のもの）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          discardLowest(G, pi, 1, 'ジャン＝ジャック・ルソー');
          const all = G.players.flatMap((P, q) => P.field.filter(isIjinUp).map(x => ({ x, q })));
          const top = Math.max(...all.map(o => powerOf(o.x, G)));
          const t = all.filter(o => powerOf(o.x, G) === top).sort((a, b) => (a.q === pi ? 1 : 0) - (b.q === pi ? 1 : 0))[0];
          if (t && !isIndestructible(G, t.x)) manualDestroy(G, t.q, t.x.uid, 'ジャン＝ジャック・ルソー');
        }
      },
      // 徴募（エンドフェイズ。このターンにアタッカーが破壊されていれば。条件は呼び出し側で確認済み）
      '曹操': {
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'endPhase') return false;
          const P = G.players[pi];
          const c = P.grave.filter(x => x !== ctx.inst).sort((a, b) => cardValue(cardOf(a)) - cardValue(cardOf(b)))[0] ||
            P.hand.slice().sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b))[0];
          if (!c) return 'declined';
          const from = P.grave.includes(c) ? P.grave : P.hand; from.splice(from.indexOf(c), 1);
          c.faceUp = false; c.isGuardian = true; c.tapped = false; c.placedTurn = G.turn; P.field.push(c);
          log(G, '　曹操（徴募）：カード1つをガーディアンにして戦場に置きました'); onGuardianPlaced(G, pi);
        }
      },
      '洪秀全': {
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'endPhase') return false;
          const O = G.players[1 - pi], c = O.hand.filter(x => ['マホウ', 'ハイケイ'].includes(cardOf(x).type)).sort((a, b) => (cardOf(b).level || 0) - (cardOf(a).level || 0))[0];
          if (!c) { log(G, '　洪秀全（徴募）：相手の手札にマホウ・ハイケイはありません'); return; }
          O.hand.splice(O.hand.indexOf(c), 1); c.faceUp = true; O.grave.push(c);
          log(G, `　洪秀全（徴募）：${nm(G, 1 - pi)}の手札の${cardOf(c).name}を墓地に置きました`);
        }
      },
      'ナポレオン・ボナパルト': {
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'endPhase') return false;
          const P = G.players[pi];
          if (ctx.inst && P.grave.includes(ctx.inst)) { P.grave.splice(P.grave.indexOf(ctx.inst), 1); placeToField(G, pi, ctx.inst, 'ナポレオン・ボナパルト（徴募）'); }
          else addGuardianFromDeck(G, pi, 'ナポレオン・ボナパルト（徴募）');
        }
      },
      '高杉晋作': {
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'endPhase') return false;
          const P = G.players[pi], c = P.hand.filter(x => cardOf(x).type === 'イジン' && (cardOf(x).power || 0) <= 2000).sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
          if (!c) return 'declined';
          P.hand.splice(P.hand.indexOf(c), 1); placeToField(G, pi, c, '高杉晋作（徴募）'); manualDraw(G, pi, 1, '高杉晋作（徴募）');
        }
      },
      'ピョートル大帝': {
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'endPhase') return false;
          const P = G.players[pi], c = P.hand.concat(P.grave.filter(x => x !== ctx.inst)).filter(x => cardOf(x).type === 'イジン' && (cardOf(x).level || 0) <= 5)
            .sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
          if (!c) return 'declined';
          const from = P.hand.includes(c) ? P.hand : P.grave; from.splice(from.indexOf(c), 1); placeToField(G, pi, c, 'ピョートル大帝（徴募）');
        }
      },
      // ----- 第2弾のマホウ -----
      'チャージ': {   // マリョク配置権+1：置くマリョクがあるとき（紫微垣チャージ：払ったドローマリョクを墓地から置き直す）
        timing: 'main',
        want(G, pi) {
          const P = G.players[pi];
          if (P.manaPlace > 0 || P.deck.length <= 8) return null;
          const handMana = P.hand.some(x => cardOf(x).type === 'マリョク');
          const recycle = shibiReady(G, pi) && (P.grave.some(x => cardOf(x).type === 'マリョク') || P.mana.some(m => m.faceUp && isDrawMana(cardOf(m))));
          // 裏で置いてレベル上限を上げたい：手札にレベル上限より重いカードがあり、捨ててよいカードもある
          const cap = manaInfo(P).cap, ramp = P.hand.length >= 3 && P.hand.some(x => cardOf(x).type !== 'マリョク' && (cardOf(x).level || 0) > cap && (cardOf(x).level || 0) <= cap + 5);
          return handMana || recycle || ramp ? {} : null;
        },
        resolve(G, pi) { G.players[pi].manaPlace += 1; log(G, `　チャージ：${nm(G, pi)}のマリョク配置権+1`); }
      },
      'メロウ': {   // 戦場のレベル7以下のカードをガーディアンに（裏に）：相手の価値の高いイジン
        timing: 'main',
        want(G, pi) { const f = G.players[1 - pi].field.filter(x => isIjinUp(x) && (cardOf(x).level || 0) <= 7).sort((a, b) => instValue(G, b) - instValue(G, a))[0]; return f && instValue(G, f) >= 5000 ? { uid: f.uid } : null; },
        resolve(G, pi, ctx) { const f = ctx.target && G.players[1 - pi].field.find(x => x.uid === ctx.target.uid); if (!f) return false; releaseEquips(G, 1 - pi, f); f.faceUp = false; f.isGuardian = true; log(G, `　メロウ：${cardOf(f).name}をガーディアンにしました`); }
      },
      'カタストロフィ': {   // 自分のガーディアン1体を山札の下に戻して、イジンすべてを破壊：相手の盤面の方がずっと強いとき
        timing: 'main',
        want(G, pi) {
          const v = q => G.players[q].field.filter(isIjinUp).filter(notIndestructible(G)).reduce((t, x) => t + instValue(G, x), 0);
          return myGuards(G, pi).length >= 2 && v(1 - pi) - v(pi) >= 7000 ? {} : null;
        },
        resolve(G, pi) {
          const P = G.players[pi], g = takeGuardian(G, pi); if (!g) return false;
          P.field.splice(P.field.indexOf(g), 1); P.deck.unshift(g.cardId);
          G.players.forEach((Q, q) => Q.field.filter(isIjinUp).slice().forEach(x => { if (!isIndestructible(G, x)) manualDestroy(G, q, x.uid, 'カタストロフィ'); }));
        }
      },
      'スカーレット': {   // 自分の戦場の色の数まで、戦場のハイケイを破壊（赤魔導：破壊した数だけドロー）
        // 相手のハイケイを優先。赤魔導が使えるなら、自分のハイケイも壊して大量ドロー（スカーレット執筆）。山札切れには注意
        timing: 'main',
        pick(G, pi) {
          const n = fieldColors(G, pi), red = redOnMine(G, pi, '赤'), P = G.players[pi];
          const ok = x => x.faceUp && cardOf(x).type === 'ハイケイ' && !isIndestructible(G, x);
          const foe = G.players[1 - pi].field.filter(ok).map(x => ({ x, q: 1 - pi }));
          // 自分のハイケイは、遺業能力で戻ってくるもの・数え方が2つのもの（仁王）を優先して壊す
          // 大日本沿海輿地全図で勝つデッキでは、名前が1枚しかないハイケイは壊さない（名前の数を減らさない）。輿地全図自身も壊さない
          const plan = yochiPlan(G, pi);
          const nameCount = n2 => P.field.filter(y => y.faceUp && cardOf(y).name === n2).length;
          const keepIt = x => plan && (nameCount(cardOf(x).name) <= 1 || YOCHI_RE.test(normTxt(cardOf(x).rule_text)));
          const mine = red ? P.field.filter(ok).filter(x => !keepIt(x)).sort((a, b) => (countAs(b) + (hasLegacy(cardOf(b)) ? 1 : 0)) - (countAs(a) + (hasLegacy(cardOf(a)) ? 1 : 0))).map(x => ({ x, q: pi })) : [];
          const list = foe.concat(mine).slice(0, n);
          const draws = red ? list.reduce((t, o) => t + countAs(o.x), 0) : 0;
          return { list, draws };
        },
        want(G, pi) {
          const { list, draws } = this.pick(G, pi), P = G.players[pi];
          if (!list.length) return null;
          const foeHit = list.some(o => o.q !== pi);
          if (P.deck.length <= draws + deckReserve(G, pi)) return foeHit && !draws ? {} : null;   // 山札切れになりそうなら控える
          return foeHit || draws >= 2 ? {} : null;
        },
        resolve(G, pi) {
          const { list, draws } = this.pick(G, pi);
          list.forEach(o => manualDestroy(G, o.q, o.x.uid, 'スカーレット'));
          if (draws) manualDraw(G, pi, draws, 'スカーレット（赤魔導）');
        }
      },
      'ピーコック': {   // 自分の戦場の色の数まで、イジンを寝かせる：それで詰みになるときにアタック直前に使う（青魔導：次のターンも起きない）
        timing: 'preAttack',
        want(G, pi) {
          if (G.battleUsed) return null;
          const E = eligibleAttackers(G, pi); if (!E.length) return null;
          const n = fieldColors(G, pi), oppB = eligibleBlockers(G, 1 - pi);
          if (!coverable(G, asAtk(G, E), oppB)) return null;
          const tgt = oppB.filter(x => x.faceUp).sort((a, b) => blockPowerOf(b, G) - blockPowerOf(a, G)).slice(0, n);
          if (!tgt.length) return null;
          return !coverable(G, asAtk(G, E), oppB.filter(x => !tgt.includes(x))) ? { uids: tgt.map(x => x.uid) } : null;
        },
        resolve(G, pi, ctx) {
          const t = ctx.target; if (!t) return false;
          const frozen = redOnMine(G, pi, '青');
          G.players[1 - pi].field.filter(x => t.uids.includes(x.uid)).forEach(x => { x.tapped = true; if (frozen) x.frozenUntil = G.turn + 1; });
          log(G, `　ピーコック：相手のイジン${t.uids.length}体を寝かせました` + (frozen ? '（青魔導：次のターンも起きない）' : ''));
        }
      },
      'エクスキューション': {   // 戦場のレベル4以下のイジン1体を破壊
        timing: 'main',
        want(G, pi) { const f = G.players[1 - pi].field.filter(x => isIjinUp(x) && (cardOf(x).level || 0) <= 4).filter(notIndestructible(G)).sort((a, b) => instValue(G, b) - instValue(G, a))[0]; return f && instValue(G, f) >= 4000 ? { uid: f.uid } : null; },
        resolve(G, pi, ctx) { if (!ctx.target) return false; manualDestroy(G, 1 - pi, ctx.target.uid, 'エクスキューション'); }
      },
      'クイック': {   // 自分のレベル5以下のイジンに「即応」：それで詰みになるとき
        timing: 'preAttack',
        want(G, pi) {
          if (G.battleUsed) return null;
          const P = G.players[pi], oppB = eligibleBlockers(G, 1 - pi), E = eligibleAttackers(G, pi);
          const c = P.field.find(x => isIjinUp(x) && !x.tapped && !E.includes(x) && (cardOf(x).level || 0) <= 5);
          if (!c || !coverable(G, asAtk(G, E), oppB)) return null;
          return !coverable(G, asAtk(G, E.concat([c])), oppB) ? { uid: c.uid } : null;
        },
        resolve(G, pi, ctx) { const c = ctx.target && G.players[pi].field.find(x => x.uid === ctx.target.uid); if (!c) return false; c.hasteTurn = G.turn; log(G, `　クイック：${cardOf(c).name}はこのターン「即応」`); }
      },
      'ロイヤリティ': {   // 自分の「剣術」イジンかガーディアンを墓地に置いて3ドロー：手札が少なく、ガーディアンに余裕があるとき
        timing: 'main',
        want(G, pi) { const P = G.players[pi]; return P.hand.length <= 3 && myGuards(G, pi).length >= 4 ? {} : null; },
        resolve(G, pi) {
          const P = G.players[pi], g = takeGuardian(G, pi); if (!g) return false;
          P.field.splice(P.field.indexOf(g), 1); P.deck.push(g.cardId);   // 「自分の戦場のガーディアン1体を山札の上に戻す」
          log(G, '　ロイヤリティ：ガーディアン1体を山札の上に戻しました'); manualDraw(G, pi, 3, 'ロイヤリティ');
        }
      },
      'スペクター': {   // 戦場のガーディアン1体を破壊（黄魔導：山札の下へ）：詰みになるとき、または相手のガーディアンが2体以下
        timing: 'preAttack',
        want(G, pi) {
          const oppB = eligibleBlockers(G, 1 - pi), E = eligibleAttackers(G, pi);
          const g = G.players[1 - pi].field.filter(isGuardianInst).sort((a, b) => (a.tapped ? 1 : 0) - (b.tapped ? 1 : 0))[0];
          if (!g) return null;
          const lethal = !G.battleUsed && E.length && coverable(G, asAtk(G, E), oppB) && !coverable(G, asAtk(G, E), oppB.filter(x => x !== g));
          return lethal || myGuards(G, 1 - pi).length <= 2 ? { uid: g.uid } : null;
        },
        resolve(G, pi, ctx) {
          const O = G.players[1 - pi], g = ctx.target && O.field.find(x => x.uid === ctx.target.uid); if (!g) return false;
          if (redOnMine(G, pi, '黄')) { O.field.splice(O.field.indexOf(g), 1); O.deck.unshift(g.cardId); log(G, '　スペクター（黄魔導）：相手のガーディアン1体を破壊して山札の下に戻しました'); }
          else manualDestroy(G, 1 - pi, g.uid, 'スペクター');
        }
      },
      'レクイエム': {   // 墓地のマリョクでないカード4つを山札の下に戻して1ドロー：山札が減ってきたとき
        timing: 'main',
        want(G, pi) { const P = G.players[pi]; return P.grave.filter(x => cardOf(x).type !== 'マリョク').length >= 4 && P.deck.length <= 12 ? {} : null; },
        resolve(G, pi) {
          const P = G.players[pi];
          P.grave.filter(x => cardOf(x).type !== 'マリョク').slice(0, 4).forEach(x => { P.grave.splice(P.grave.indexOf(x), 1); P.deck.unshift(x.cardId); });
          log(G, '　レクイエム：墓地のカード4つを山札の下に戻しました'); manualDraw(G, pi, 1, 'レクイエム');
        }
      },
      'コーザリティ': {   // 相手の山札の上から2枚を墓地に置いて、自分の墓地のイジン1体を手札に
        timing: 'main',
        want(G, pi) { return loPlan(G, pi) || G.players[pi].grave.some(x => cardOf(x).type === 'イジン' && cardValue(cardOf(x)) >= 5000) ? {} : null; },
        resolve(G, pi) {
          millN(G, 1 - pi, 2, 'コーザリティ');
          const P = G.players[pi], c = P.grave.filter(x => cardOf(x).type === 'イジン').sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
          if (c) { P.grave.splice(P.grave.indexOf(c), 1); P.hand.push(c); log(G, `　コーザリティ：墓地の${cardOf(c).name}を手札に戻しました`); }
        }
      },
      'ドロレス': {   // 相手の手札を見てレベル3以上のカード1つを墓地へ
        timing: 'main',
        want(G, pi) { return G.players[1 - pi].hand.some(x => (cardOf(x).level || 0) >= 3) ? {} : null; },
        resolve(G, pi) {
          const O = G.players[1 - pi], c = O.hand.filter(x => (cardOf(x).level || 0) >= 3).sort((a, b) => cardValue(cardOf(b)) - cardValue(cardOf(a)))[0]; if (!c) return;
          O.hand.splice(O.hand.indexOf(c), 1); c.faceUp = true; O.grave.push(c); log(G, `　ドロレス：${nm(G, 1 - pi)}の手札の${cardOf(c).name}を墓地に置きました`);
        }
      },
      'ソリッドビジョンβ': { timing: 'main', want(G, pi) { return G.players[pi].hand.length <= 4 ? {} : null; }, resolve(G, pi) { manualDraw(G, pi, 1, 'ソリッドビジョンβ'); } },
      'ワールド': {   // 相手のマリョク1つを裏に：相手がその色を1つしか持っていないもの
        timing: 'main',
        want(G, pi) {
          const O = G.players[1 - pi], up = O.mana.filter(m => m.faceUp && cardOf(m).type === 'マリョク');
          const cnt = {}; up.forEach(m => colorsOf(cardOf(m)).forEach(ch => { cnt[ch] = (cnt[ch] || 0) + 1; }));
          const t = up.find(m => colorsOf(cardOf(m)).some(ch => cnt[ch] === 1)) || (up.length >= 4 ? up[0] : null);
          return t ? { uid: t.uid } : null;
        },
        resolve(G, pi, ctx) { const m = ctx.target && G.players[1 - pi].mana.find(x => x.uid === ctx.target.uid); if (!m) return false; m.faceUp = false; log(G, `　ワールド：${nm(G, 1 - pi)}の${cardOf(m).name}を裏にしました`); }
      },
      'ルーナ': {   // 相手のレベル3以下のイジンかハイケイを裏に（青魔導：相手のガーディアン1体を手札へ）
        timing: 'main',
        want(G, pi) {
          const f = G.players[1 - pi].field.filter(x => x.faceUp && ((cardOf(x).type === 'イジン' && (cardOf(x).level || 0) <= 3) || cardOf(x).type === 'ハイケイ'))
            .sort((a, b) => (cardOf(b).type === 'ハイケイ' ? 4000 : instValue(G, b)) - (cardOf(a).type === 'ハイケイ' ? 4000 : instValue(G, a)))[0];
          return f && (cardOf(f).type === 'ハイケイ' || instValue(G, f) >= 3000) ? { uid: f.uid } : null;
        },
        resolve(G, pi, ctx) {
          const O = G.players[1 - pi], f = ctx.target && O.field.find(x => x.uid === ctx.target.uid); if (!f) return false;
          releaseEquips(G, 1 - pi, f); f.faceUp = false; f.isGuardian = true; log(G, `　ルーナ：${cardOf(f).name}を裏にしました`);
          if (redOnMine(G, pi, '青')) { const g = O.field.find(x => isGuardianInst(x) && x !== f); if (g) { O.field.splice(O.field.indexOf(g), 1); g.faceUp = true; g.isGuardian = false; O.hand.push(g); log(G, '　ルーナ（青魔導）：相手のガーディアン1体を手札に戻しました'); } }
        }
      },
      'ドシャカジ': {   // 山札の上から5枚を墓地に置き、自分の魔力レベル以下のイジンかハイケイ1つを墓地から戦場へ
        timing: 'main',
        want(G, pi) { return G.players[pi].deck.length >= 15 ? {} : null; },
        resolve(G, pi) {
          millN(G, pi, 5, 'ドシャカジ');
          const P = G.players[pi], cap = manaInfo(P).cap;
          const ok = x => ['イジン', 'ハイケイ'].includes(cardOf(x).type) && (cardOf(x).level || 0) <= cap;
          const pref = (G.cpuTarget && G.cpuTarget.prefer || []).map(n => P.grave.find(x => ok(x) && cardOf(x).name === n)).find(Boolean);   // 利休ループ：藤原道長／エイブラハム・リンカン
          const c = pref || P.grave.filter(ok)
            .sort((a, b) => (cardOf(b).type === 'イジン' ? ijinScore(G, pi, cardOf(b)) : 3000) - (cardOf(a).type === 'イジン' ? ijinScore(G, pi, cardOf(a)) : 3000))[0];
          if (c) { P.grave.splice(P.grave.indexOf(c), 1); placeToField(G, pi, c, 'ドシャカジ'); }
        }
      },
      'テンペスト': {   // 相手の寝ているイジンすべてを手札に戻す
        timing: 'main',
        want(G, pi) { return G.players[1 - pi].field.filter(x => isIjinUp(x) && x.tapped).reduce((t, x) => t + instValue(G, x), 0) >= 5000 ? {} : null; },
        resolve(G, pi) { G.players[1 - pi].field.filter(x => isIjinUp(x) && x.tapped).slice().forEach(x => bounce(G, 1 - pi, x, 'テンペスト')); }
      },
      'ファイナルアタック': {   // 次のエンドフェイズに敗北。イジンすべてを起こして追加でバトル：それで勝てるときだけ
        timing: 'post',
        want(G, pi) {
          if (G.finalLose || !G.battleUsed) return null;
          const P = G.players[pi], was = P.field.map(x => x.tapped);
          P.field.forEach(x => { if (isIjinUp(x)) x.tapped = false; });
          G.battleUsed = false;
          const E = eligibleAttackers(G, pi), lethal = E.length && !coverable(G, asAtk(G, E), eligibleBlockers(G, 1 - pi));
          P.field.forEach((x, i) => { x.tapped = was[i]; }); G.battleUsed = true;
          return lethal ? {} : null;
        },
        resolve(G, pi) {
          G.players[pi].field.forEach(x => { if (isIjinUp(x)) x.tapped = false; });
          G.battleUsed = false; G.finalLose = { pi, turn: G.turn };
          log(G, '　ファイナルアタック：イジンすべてを起こして、追加でバトルします（このターンのエンドフェイズに敗北）');
        }
      },
      // ===== 種類の修正で追加（森閑たる離宮・マザーグース＝ハイケイ、デュエル・フリート＝マホウ） =====
      '森閑たる離宮': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },   // 常在（エンジン）
      'マザーグース': {   // 執筆：自分の戦場の黄のカード3つにつき1ドローして、これを破壊する
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'shippitsu') return false;
          const P = G.players[pi], n = Math.floor(P.field.filter(x => x.faceUp && String(cardOf(x).color || '').includes('黄')).length / 3);
          if (n < 1 || P.deck.length <= n + deckReserve(G, pi) || !ctx.inst || !P.field.includes(ctx.inst)) return 'declined';
          manualDraw(G, pi, n, 'マザーグース'); manualDestroy(G, pi, ctx.inst.uid, 'マザーグース');
        }
      },
      'デュエル': {   // 自分の起きているイジン1体と相手のイジン1体：パワーが高い方を寝かせ、低い方を墓地へ
        timing: 'main',
        want(G, pi) {
          const mine = G.players[pi].field.filter(x => isIjinUp(x) && !x.tapped).sort((a, b) => powerOf(b, G) - powerOf(a, G))[0];
          if (!mine) return null;
          const foe = G.players[1 - pi].field.filter(x => isIjinUp(x) && powerOf(x, G) < powerOf(mine, G)).sort((a, b) => instValue(G, b) - instValue(G, a))[0];
          return foe && instValue(G, foe) >= 3000 ? { mine: mine.uid, foe: foe.uid } : null;
        },
        resolve(G, pi, ctx) {
          const P = G.players[pi], O = G.players[1 - pi], t = ctx.target || {};
          const a = P.field.find(x => x.uid === t.mine), b = O.field.find(x => x.uid === t.foe);
          if (!a || !b) return false;
          const pa = powerOf(a, G), pb = powerOf(b, G);
          if (pa === pb) { a.tapped = b.tapped = true; log(G, '　デュエル：パワーが同じなので、どちらも寝かせました'); return; }
          const [hi, hq, lo, lq] = pa > pb ? [a, pi, b, 1 - pi] : [b, 1 - pi, a, pi];
          hi.tapped = true; log(G, `　デュエル：${cardOf(hi).name}を寝かせて、${cardOf(lo).name}を墓地に置きます`); fieldToGrave(G, lq, lo); void hq;
        }
      },
      'フリート': { timing: 'preAttack', want() { return null; }, resolve() { } },   // バトルの補助：CPUは使わない
      // ===== デッキコンテストのプリセットのカード =====
      '伊能忠敬': {   // 「マリョク配置権+1」か「墓地のハイケイすべてを手札に戻す」
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi], hs = P.grave.filter(x => cardOf(x).type === 'ハイケイ');
          if (hs.length >= 2) { hs.forEach(x => { P.grave.splice(P.grave.indexOf(x), 1); x.faceUp = true; P.hand.push(x); }); log(G, `　伊能忠敬：墓地のハイケイ${hs.length}つを手札に戻しました`); graveLeft(G, pi); }
          else { P.manaPlace += 1; log(G, '　伊能忠敬：マリョク配置権+1'); }
        }
      },
      'クレオパトラ': {   // 戦場のハイケイすべてを破壊（ハイケイが破壊されるたび1ドロー）：相手のハイケイの方が多い／自分のハイケイが壊れて得をするとき
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const mine = G.players[pi].field.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ'), foe = G.players[1 - pi].field.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ');
          const bonus = mine.filter(x => /(^|\n)\s*破壊されたとき/.test(cardOf(x).rule_text || '')).length;
          if (!foe.length && !bonus) return 'declined';
          if (foe.length + bonus < mine.length) return 'declined';
          if (G.players[pi].deck.length <= mine.length + foe.length + deckReserve(G, pi)) return 'declined';
          [[pi, mine], [1 - pi, foe]].forEach(([q, l]) => l.forEach(x => { if (G.players[q].field.includes(x) && !isIndestructible(G, x, true)) manualDestroy(G, q, x.uid, 'クレオパトラ'); }));
        }
      },
      '炎上がる天守閣': {
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'destroyed') return false;
          manualDraw(G, pi, Math.min(3, Math.max(0, G.players[pi].deck.length - deckReserve(G, pi))), '炎上がる天守閣');
        }
      },
      'ミューテイション': {   // 自分のガーディアンか魔力ゾーンの裏のカード（中身がレベル6以下のイジン）を墓地に置いて、戦場に出す
        timing: 'main',
        want(G, pi) {
          const P = G.players[pi], ok = x => cardOf(x).type === 'イジン' && (cardOf(x).level || 0) <= 6;
          const c = P.field.filter(x => isGuardianInst(x) && ok(x)).concat(P.mana.filter(x => !x.faceUp && ok(x)))
            .sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
          return c && ijinScore(G, pi, cardOf(c)) >= 6000 ? { uid: c.uid } : null;
        },
        resolve(G, pi, ctx) {
          const P = G.players[pi], tg = (ctx.target && ctx.target.uid) ? ctx.target : CARD_AI['ミューテイション'].want(G, pi), u = tg && tg.uid;
          let x = P.field.find(y => y.uid === u), from = 'field';
          if (!x) { x = P.mana.find(y => y.uid === u); from = 'mana'; }
          if (!x) { log(G, '　ミューテイション：対象にできるカードがありません'); return; }
          if (from === 'field') { P.field.splice(P.field.indexOf(x), 1); } else { P.mana.splice(P.mana.indexOf(x), 1); onManaLeft(G, pi); }
          x.isGuardian = false; x.tapped = false;
          log(G, `　ミューテイション：${from === 'field' ? 'ガーディアン' : '魔力ゾーンの裏のカード'}（${cardOf(x).name}）を墓地に置いて、戦場に置きます`);
          placeToField(G, pi, x, 'ミューテイション', true);
        }
      },
      'ジョン・ロック': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      'シャルル・ド・モンテスキュー': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      '久坂玄瑞': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      '吉田松陰': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      'ポンパドゥール夫人': {   // 手札のカード1つを裏向きで戦場に（ガーディアンを増やす）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi];
          if (!P.field.concat(P.grave).some(x => x.faceUp && hasTrait(cardOf(x), '思想')) || !P.hand.length) return 'declined';
          const x = P.hand.slice().sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b))[0];
          P.hand.splice(P.hand.indexOf(x), 1); x.faceUp = false; x.isGuardian = true; x.tapped = false; x.placedTurn = G.turn; P.field.push(x);
          log(G, '　ポンパドゥール夫人：手札のカード1つを裏向きで戦場に置きました（ガーディアン）'); onGuardianPlaced(G, pi);
        }
      },
      'ヴォルフガング・アマデウス・モーツァルト': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      '滝沢馬琴': {   // 執筆：黄のハイケイが戦場に置かれるたび1ドロー
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'shippitsu') return false;
          const h = ctx.haikei;
          if (!h || !String(cardOf(h).color || '').includes('黄') || G.players[pi].deck.length <= deckReserve(G, pi)) return 'declined';
          manualDraw(G, pi, 1, '滝沢馬琴');
        }
      },
      '葛飾北斎': {   // 墓地のハイケイ1つか2つを手札に戻す
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi], hs = P.grave.filter(x => cardOf(x).type === 'ハイケイ').sort((a, b) => (cardOf(b).level || 0) - (cardOf(a).level || 0) + (YOCHI_RE.test(normTxt(cardOf(b).rule_text)) ? 50 : 0) - (YOCHI_RE.test(normTxt(cardOf(a).rule_text)) ? 50 : 0)).slice(0, 2);
          if (!hs.length) return 'declined';
          hs.forEach(x => { P.grave.splice(P.grave.indexOf(x), 1); x.faceUp = true; P.hand.push(x); });
          log(G, `　葛飾北斎：墓地の${hs.map(x => cardOf(x).name).join('、')}を手札に戻しました`); graveLeft(G, pi);
        }
      },
      '葛飾応為': {   // 戦場のレベル6以下の「美術」カードすべてを手札に戻して、イジン召喚権+1
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const names = [];
          [0, 1].forEach(q => G.players[q].field.filter(x => x.faceUp && x !== ctx.inst && (cardOf(x).level || 0) <= 6 && isArt(G, x)).slice().forEach(x => {
            if (cardOf(x).type === 'イジン') { if (bounce(G, q, x, '葛飾応為')) names.push(cardOf(x).name); }
            else { const Q = G.players[q]; Q.field.splice(Q.field.indexOf(x), 1); x.tapped = false; Q.hand.push(x); names.push(cardOf(x).name); }
          }));
          G.players[pi].summon += 1;
          log(G, `　葛飾応為：戦場の「美術」カード（${names.join('、') || 'なし'}）を手札に戻して、イジン召喚権+1`);
        }
      },
      'シャクシャイン': {   // 決起：相手のイジン1体につき、相手のガーディアン1体を寝かせる
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'kekki') return false;
          const O = G.players[1 - pi], n = O.field.filter(isIjinUp).length;
          const gs = O.field.filter(x => isGuardianInst(x) && !x.tapped).slice(0, n);
          if (!gs.length) return 'declined';
          gs.forEach(g => { g.tapped = true; }); log(G, `　シャクシャイン：${nm(G, 1 - pi)}のガーディアン${gs.length}体を寝かせました`); guardianTapped(G);
        }
      },
      '風神雷神図': {   // 自分の戦場に黄の「美術」カードが3つ以上：山札の上と下から1枚ずつ裏のまま魔力ゾーンへ
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi];
          if (P.field.filter(x => x.faceUp && String(cardOf(x).color || '').includes('黄') && isArt(G, x)).length < 3 || P.deck.length < 2 + deckReserve(G, pi)) return 'declined';
          P.mana.push(mkInst(P.deck.pop(), { faceUp: false })); P.mana.push(mkInst(P.deck.shift(), { faceUp: false }));
          log(G, '　風神雷神図：山札の上と下から1枚ずつ裏のまま魔力ゾーンに置きました'); onFaceDownMana(G, pi); onFaceDownMana(G, pi);
        }
      },
      '冨嶽三十六景': {   // メインフェイズ開始時：遺業能力を持つ墓地のハイケイ1つを戦場に置く
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'mainStart') return false;
          const P = G.players[pi], names = new Set(P.field.filter(x => x.faceUp).map(x => cardOf(x).name));
          const h = P.grave.filter(x => cardOf(x).type === 'ハイケイ' && hasLegacy(cardOf(x)) && !names.has(cardOf(x).name)).sort((a, b) => (cardOf(b).level || 0) - (cardOf(a).level || 0))[0];
          if (!h) return 'declined';
          P.grave.splice(P.grave.indexOf(h), 1); graveLeft(G, pi); placeToField(G, pi, h, '冨嶽三十六景', true);
        }
      },
      'サーベイング': {   // 手札のハイケイを墓地に置いて、レベルの合計5につき1ドロー
        timing: 'main',
        want(G, pi) { const hs = surveyPick(G, pi); return hs.reduce((t, x) => t + (cardOf(x).level || 0), 0) >= 5 ? {} : null; },
        resolve(G, pi) {
          const P = G.players[pi], hs = surveyPick(G, pi), lv = hs.reduce((t, x) => t + (cardOf(x).level || 0), 0);
          if (!hs.length) { log(G, '　サーベイング：墓地に置けるハイケイがありません'); return; }
          hs.forEach(x => handToGrave(G, pi, x));
          const n = Math.min(Math.floor(lv / 5), Math.max(0, P.deck.length - deckReserve(G, pi)));
          log(G, `　サーベイング：ハイケイ${hs.length}つ（レベル合計${lv}）を墓地に置きました`); manualDraw(G, pi, n, 'サーベイング');
        }
      },
      '喀血の流行り病': { resolve(G, pi, ctx) { return ctx.kind === 'field' || ctx.kind === 'mainStart' ? undefined : false; } },   // エンジン（メインフェイズ開始時）
      '紡績工場': {   // 戦場に置かれたとき、魔力ゾーンに裏のカードが2つ以上なら1ドロー（エンドフェイズは spinningMill）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          if (G.players.reduce((t, Q) => t + Q.mana.filter(m => !m.faceUp).length, 0) >= 2) manualDraw(G, pi, 1, '紡績工場');
        }
      },
      'ストーンマスク': { resolve(G, pi, ctx) { if (ctx.kind === 'equip') { manualDraw(G, pi, 1, 'ストーンマスク'); return; } return ctx.kind === 'mana' ? undefined : false; } },
      '雪舟': {   // 手札1枚を山札の下に戻して1ドロー
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi]; if (!P.hand.length) return 'declined';
          const x = P.hand.slice().sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b))[0];
          if (cardUsefulness(G, pi, x) >= 8) return 'declined';
          P.hand.splice(P.hand.indexOf(x), 1); P.deck.unshift(x.cardId); log(G, '　雪舟：手札1枚を山札の下に戻しました'); manualDraw(G, pi, 1, '雪舟');
        }
      },
      '尾形光琳': {   // 魔力ゾーンの裏のハイケイ（レベル4以下）を表で戦場に、相手のイジン1体を山札の下へ、イジン召喚権+1
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi], O = G.players[1 - pi];
          const h = P.mana.filter(m => !m.faceUp && cardOf(m).type === 'ハイケイ' && (cardOf(m).level || 0) <= 4).sort((a, b) => (cardOf(b).level || 0) - (cardOf(a).level || 0))[0];
          if (!h) return 'declined';
          P.mana.splice(P.mana.indexOf(h), 1); onManaLeft(G, pi); placeToField(G, pi, h, '尾形光琳', false);
          const t = O.field.filter(isIjinUp).sort((a, b) => instValue(G, b) - instValue(G, a))[0];
          if (t) { O.field.splice(O.field.indexOf(t), 1); releaseEquips(G, 1 - pi, t); t.silenced = false; O.deck.unshift(t.cardId); log(G, `　尾形光琳：${nm(G, 1 - pi)}の${cardOf(t).name}を山札の下に戻しました`); }
          P.summon += 1; log(G, '　尾形光琳：イジン召喚権+1');
        }
      },
      '俵屋宗達': {   // 戦場の「美術」ハイケイ1つを山札の上に戻して、イジン召喚権+1：手札に出せるイジンがあるとき
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi];
          const h = P.field.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ' && isArt(G, x)).sort((a, b) => (cardOf(a).level || 0) - (cardOf(b).level || 0))[0];
          const next = P.hand.some(x => cardOf(x).type === 'イジン' && conditionProblems(P, cardOf(x), summonInfo(G, pi, cardOf(x)).auto, G).length === 0);
          if (!h || !next) return 'declined';
          P.field.splice(P.field.indexOf(h), 1); P.deck.push(h.cardId); P.summon += 1;
          log(G, `　俵屋宗達：${cardOf(h).name}を山札の上に戻して、イジン召喚権+1`);
        }
      },
      'モナ・リザ': {   // メインフェイズ開始時：手札の「美術」カード1つを墓地に置いて1ドロー
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'mainStart') return false;
          const P = G.players[pi], cap = manaInfo(P).cap;
          const arts = P.hand.filter(x => hasTrait(cardOf(x), '美術') || /特性[:：]\s*美術/.test(cardOf(x).rule_text || ''));
          const x = arts.filter(a => (cardOf(a).level || 0) > cap + 2 || arts.filter(b => cardOf(b).name === cardOf(a).name).length > 1).sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b))[0];
          if (!x || P.deck.length <= deckReserve(G, pi)) return 'declined';
          handToGrave(G, pi, x); log(G, `　モナ・リザ：手札の${cardOf(x).name}を墓地に置きました`); manualDraw(G, pi, 1, 'モナ・リザ');
        }
      },
      'アイオン': {   // 手札すべてを山札に戻してシャッフルし、7ドロー（このターン、マホウ使用できない）：最後に使う
        timing: 'post',
        want(G, pi) { const P = G.players[pi]; return P.deck.length >= 12 && P.hand.length <= 7 ? {} : null; },
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field' && ctx.kind !== 'mahou') return false;
          const P = G.players[pi];
          P.hand.splice(0).forEach(x => P.deck.push(x.cardId)); shuffle(P.deck);
          manualDraw(G, pi, Math.min(7, Math.max(0, P.deck.length - 1)), 'アイオン'); P.noMahouTurn = G.turn;
        }
      },
      'ニコライ・レザノフ': {   // 航海：『ブロック+』を持つアタッカーは「ガーディアンにブロックされたとき、これを起こす」
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'attack' || !G.battle) return false;
          const P = G.players[pi];
          G.battle.attackers.map(u => P.field.find(x => x.uid === u)).filter(x => x && x.faceUp && (kwOf(x).block > 0 || auraBlock(G, x) > 0)).forEach(x => { x.rezTurn = G.turn; });
        }
      },
      'バルトロメウ=ディアス': {   // 航海：戦場のイジン1体かハイケイ1つを手札に戻す（強制）
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'attack') return false;
          const O = G.players[1 - pi], P = G.players[pi];
          const v = x => (cardOf(x).type === 'ハイケイ' ? 2500 + (cardOf(x).level || 0) * 500 : instValue(G, x) + (x.tapped ? 0 : 1500));
          const foe = O.field.filter(x => x.faceUp && (cardOf(x).type === 'ハイケイ' || (cardOf(x).type === 'イジン' && !noBounce(G)))).sort((a, b) => v(b) - v(a))[0];
          if (foe) { if (cardOf(foe).type === 'イジン') bounce(G, 1 - pi, foe, 'バルトロメウ=ディアス'); else { O.field.splice(O.field.indexOf(foe), 1); foe.tapped = false; O.hand.push(foe); log(G, `　バルトロメウ=ディアス：${nm(G, 1 - pi)}の${cardOf(foe).name}を手札に戻しました`); } return; }
          const own = P.field.filter(x => isIjinUp(x) && !(G.battle && G.battle.attackers.includes(x.uid)) && SR.abilityText(cardOf(x), 'field')).sort((a, b) => instValue(G, a) - instValue(G, b))[0];
          if (own && !noBounce(G)) bounce(G, pi, own, 'バルトロメウ=ディアス（自分のイジン）');
        }
      },
      '豊臣秀吉': {   // 戦場に置かれたとき：追加でバトルする
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          if (G.current !== pi) return 'declined';
          if (!G.extraBattle || G.extraBattle.turn !== G.turn) G.extraBattle = { turn: G.turn, n: 0 };
          G.extraBattle.n += 1; log(G, '　豊臣秀吉：このターン、追加でバトルできます');
        }
      },
      'ガレオン船': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },   // 召喚権は onIjinPlaced。装備は使わない
      '安宅船': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : ctx.kind === 'mainStart' ? 'declined' : false; } },   // イジンを寝かせて召喚権を増やすのは使わない（アタックできなくなる）
      '黒船': {   // 戦場に置かれたとき：手札1枚を墓地に置いて、相手のハイケイ1つを破壊
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi], h = G.players[1 - pi].field.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ').filter(notIndestructible(G)).sort((a, b) => (cardOf(b).level || 0) - (cardOf(a).level || 0))[0];
          const junk = P.hand.slice().sort((a, b) => discardScore(G, pi, b) - discardScore(G, pi, a))[0];
          if (!h || !junk || (discardScore(G, pi, junk) < 0 && cardUsefulness(G, pi, junk) >= 8)) return 'declined';
          handToGrave(G, pi, junk); log(G, `　黒船：手札の${cardOf(junk).name}を墓地に置きました`); manualDestroy(G, 1 - pi, h.uid, '黒船');
        }
      },
      // ===== 第6弾プリセットのカード =====
      'ヒエロスガモス': {   // 魔力ゾーンに置かれたとき：2ドローして、手札2つを墓地へ（捨てると発動するマホウ・ペリーを選ぶ）
        resolve(G, pi, ctx) { if (ctx.kind !== 'mana') return false; manualDraw(G, pi, 2, 'ヒエロスガモス'); discardSmart(G, pi, 2, 'ヒエロスガモス'); }
      },
      '払暁の城壁': { timing: 'main', want(G, pi) { const P = G.players[pi]; return P.field.concat(P.grave).some(x => DAWN_RE.test(cardOf(x).rule_text || '')) ? null : {}; }, resolve() { } },   // 墓地に置いておく
      'リンボ': {   // 手札の他のカードすべてを墓地へ、墓地のカード4つを手札に（このターン、マホウ使用できない）
        timing: 'main',
        want(G, pi) {
          const P = G.players[pi], me = P.hand.find(x => cardOf(x).name === 'リンボ'), others = P.hand.filter(x => x !== me);
          const fires = others.filter(x => discardScore(G, pi, x) >= 90).length;
          const gain = limboPicks(G, pi, me).reduce((t, x) => t + limboValue(G, pi, x), 0);
          const loss = others.filter(x => discardScore(G, pi, x) < 90).reduce((t, x) => t + Math.max(0, cardUsefulness(G, pi, x)), 0);
          return gain - loss + fires * 6 >= 12 ? {} : null;
        },
        resolve(G, pi, ctx) {
          const P = G.players[pi], me = ctx.inst;
          const n = P.hand.filter(x => x !== me).length;
          discardSmart(G, pi, n, 'リンボ', me);
          const pick = limboPicks(G, pi, me);
          pick.forEach(x => { P.grave.splice(P.grave.indexOf(x), 1); x.faceUp = true; P.hand.push(x); });
          if (pick.length) { log(G, `　リンボ：墓地の${pick.map(x => cardOf(x).name).join('、')}を手札に加えました`); graveLeft(G, pi); }
          if (G.current === pi) P.noMahouTurn = G.turn;
        }
      },
      'ラース': {   // 戦場のイジンすべてを墓地へ（遺業能力は発動しない）、このターン自分はバトルを開始できない
        timing: 'main',
        want(G, pi) {
          const v = q => G.players[q].field.filter(isIjinUp).reduce((t, x) => t + instValue(G, x), 0);
          const foe = G.players[1 - pi].field.filter(isIjinUp);
          const danger = foe.length && !coverable(G, asAtk(G, foe), eligibleBlockers(G, pi).filter(x => !isIjinUp(x)));   // イジンがいなくなったあと、ガーディアンだけで守れるか
          return v(1 - pi) - v(pi) >= 5000 || (danger && v(1 - pi) >= v(pi)) ? {} : null;
        },
        resolve(G, pi) {
          const names = [];
          [pi, 1 - pi].forEach(q => G.players[q].field.filter(isIjinUp).slice().forEach(x => { names.push(cardOf(x).name); fieldToGrave(G, q, x); }));
          log(G, `　ラース：戦場のイジン（${names.join('、') || 'なし'}）をすべて墓地に置きました（遺業能力は発動しない）`);
          if (G.current === pi) G.noBattle = { turn: G.turn, pi };
        }
      },
      'エンビー': {   // 相手の手札が多い分だけドロー（このターン、バトルを開始できない）
        timing: 'main',
        want(G, pi) {
          const P = G.players[pi], me = P.hand.find(x => cardOf(x).name === 'エンビー');
          const d = G.players[1 - pi].hand.length - P.hand.filter(x => x !== me).length;
          return d >= 2 && P.deck.length > d + deckReserve(G, pi) ? {} : null;
        },
        resolve(G, pi) {
          const P = G.players[pi], d = G.players[1 - pi].hand.length - P.hand.length;
          if (d <= 0) { log(G, '　エンビー：相手の手札の方が多くないので発動しません'); return; }
          manualDraw(G, pi, d, 'エンビー');
          if (G.current === pi) G.noBattle = { turn: G.turn, pi };
        }
      },
      'グラトニー': {   // 戦場で最もレベルが高いカード1つを手札に戻す：それが相手のカードなら
        timing: 'main',
        want(G, pi) {
          const all = [0, 1].flatMap(q => G.players[q].field.filter(x => x.faceUp && cardOf(x).type !== 'マリョク').map(x => ({ q, x })));
          if (!all.length) return null;
          const top = Math.max(...all.map(o => cardOf(o.x).level || 0));
          const t = all.filter(o => (cardOf(o.x).level || 0) === top && o.q !== pi && !(cardOf(o.x).type === 'イジン' && noBounce(G))).sort((a, b) => instValue(G, b.x) - instValue(G, a.x))[0];
          return t && top >= 3 ? { uid: t.x.uid } : null;
        },
        resolve(G, pi, ctx) {
          const q = ctx.target && G.players[pi].field.some(x => x.uid === ctx.target.uid) ? pi : 1 - pi;
          const t = ctx.target && G.players[q].field.find(x => x.uid === ctx.target.uid);
          if (!t) return false;
          if (cardOf(t).type === 'イジン') bounce(G, q, t, 'グラトニー');
          else { const Q = G.players[q]; Q.field.splice(Q.field.indexOf(t), 1); t.tapped = false; Q.hand.push(t); log(G, `　グラトニー：${nm(G, q)}の${cardOf(t).name}を手札に戻しました`); }
        }
      },
      'ピースメーカー': {   // 自分のイジンかガーディアン1体と、相手の戦場のカード1つを破壊
        timing: 'main',
        want(G, pi) {
          const P = G.players[pi], O = G.players[1 - pi];
          const own = myGuards(G, pi).length >= 3 ? takeGuardian(G, pi) : P.field.filter(isIjinUp).filter(notIndestructible(G)).sort((a, b) => instValue(G, a) - instValue(G, b))[0];
          const v = x => (cardOf(x).type === 'ハイケイ' ? 3000 + (cardOf(x).level || 0) * 500 : instValue(G, x));
          const foe = O.field.filter(x => x.faceUp).filter(notIndestructible(G)).sort((a, b) => v(b) - v(a))[0];
          if (!own || !foe || v(foe) < 4000 || (own.faceUp && instValue(G, own) >= v(foe))) return null;
          return { own: own.uid, foe: foe.uid };
        },
        resolve(G, pi, ctx) {
          if (!ctx.target) return false;
          manualDestroy(G, pi, ctx.target.own, 'ピースメーカー'); manualDestroy(G, 1 - pi, ctx.target.foe, 'ピースメーカー');
        }
      },
      '司馬遷': {   // 執筆（ターンに1回）：1ドロー・イジン召喚権+1・マリョク配置権+1
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'shippitsu') return false;
          const me = ctx.inst; if (!me || me.shibaTurn === G.turn) return 'declined';
          if (G.players[pi].deck.length <= deckReserve(G, pi)) return 'declined';
          me.shibaTurn = G.turn;
          manualDraw(G, pi, 1, '司馬遷'); G.players[pi].summon += 1; G.players[pi].manaPlace += 1; log(G, '　司馬遷：イジン召喚権+1・マリョク配置権+1');
        }
      },
      '禁制の御殿': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      'スロース': {   // 魔力ゾーンのマリョクすべてを手札に戻す（このターン手札を使用できない）：相手の表のマリョクがずっと多いとき、ターンの最後に
        timing: 'post',
        want(G, pi) {
          const up = q => G.players[q].mana.filter(m => m.faceUp && cardOf(m).type === 'マリョク').length;
          return up(1 - pi) >= 3 && up(1 - pi) >= up(pi) + 2 ? {} : null;
        },
        resolve(G, pi) {
          G.players.forEach((Q, q) => { const ms = Q.mana.filter(m => m.faceUp && cardOf(m).type === 'マリョク'); ms.forEach(m => { Q.mana.splice(Q.mana.indexOf(m), 1); Q.hand.push(m); }); if (ms.length) { log(G, `　スロース：${nm(G, q)}の魔力ゾーンのマリョク${ms.length}つを手札に戻しました`); onManaLeft(G, q); } });
          if (G.current === pi) G.players[pi].noHandTurn = G.turn;
        }
      },
      'エイジング': {   // 相手のイジン1体を裏にして魔力ゾーンへ
        timing: 'main',
        want(G, pi) { const t = G.players[1 - pi].field.filter(isIjinUp).sort((a, b) => instValue(G, b) - instValue(G, a))[0]; return t && instValue(G, t) >= 5000 ? { uid: t.uid } : null; },
        resolve(G, pi, ctx) {
          const O = G.players[1 - pi], t = ctx.target && O.field.find(x => x.uid === ctx.target.uid);
          if (!t) return false;
          O.field.splice(O.field.indexOf(t), 1); releaseEquips(G, 1 - pi, t);
          t.faceUp = false; t.tapped = false; t.isGuardian = false; t.silenced = false; O.mana.push(t);
          log(G, `　エイジング：${nm(G, 1 - pi)}の${cardOf(t).name}を裏にして魔力ゾーンに置きました`); onFaceDownMana(G, 1 - pi);
        }
      },
      // ===== 第5弾プリセットのカード =====
      'ねね': {   // メインフェイズ開始時：手札のレベル5以下の赤のイジンを戦場に置いて、これを手札に戻す
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'mainStart') return false;
          const P = G.players[pi], me = ctx.inst;
          const c = P.hand.filter(x => cardOf(x).type === 'イジン' && cardOf(x).name !== 'ねね' && (cardOf(x).level || 0) <= 5 && String(cardOf(x).color || '').includes('赤'))
            .sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
          if (!c || !me || !P.field.includes(me)) return 'declined';
          P.hand.splice(P.hand.indexOf(c), 1); placeToField(G, pi, c, 'ねね', false);
          if (P.field.includes(me)) bounce(G, pi, me, 'ねね');
        }
      },
      '黒田官兵衛': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },   // 常在（エンジン）
      'リチャード・アークライト': {
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') {   // 魔力ゾーンのレベル2以上のマリョクすべてを裏にする（両プレイヤー）
            let n = 0; G.players.forEach(Q => Q.mana.forEach(m => { if (m.faceUp && cardOf(m).type === 'マリョク' && (cardOf(m).level || 0) >= 2) { m.faceUp = false; n++; } }));
            log(G, `　リチャード・アークライト：魔力ゾーンのレベル2以上のマリョク${n}つを裏にしました`); return;
          }
          if (ctx.kind !== 'attack') return false;
          // 魔力ゾーンの裏のカード1つを手札に戻す：自分の裏のピラー（もう一度置ける）＞ 相手の裏のカード（相手のレベル上限を下げる）
          const P = G.players[pi], O = G.players[1 - pi];
          const own = P.mana.find(m => !m.faceUp && isPillar(cardOf(m)));
          const foe = O.mana.find(m => !m.faceUp);
          if (own) { P.mana.splice(P.mana.indexOf(own), 1); own.faceUp = true; P.hand.push(own); log(G, `　リチャード・アークライト：自分の魔力ゾーンの裏の${cardOf(own).name}を手札に戻しました`); onManaLeft(G, pi); return; }
          if (foe) { O.mana.splice(O.mana.indexOf(foe), 1); foe.faceUp = true; O.hand.push(foe); log(G, `　リチャード・アークライト：${nm(G, 1 - pi)}の魔力ゾーンの裏のカード1つを手札に戻しました`); onManaLeft(G, 1 - pi); return; }
          return 'declined';
        }
      },
      '武田信玄': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      '武者の蔵': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      '風林火山': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },   // 勝鬨はバトル解決で処理
      'ホプロン': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? 'declined' : false; } },   // 装備は使わない
      'ブリッツ': {   // 手札のレベル5以下のイジンを「即応」で戦場に置く
        timing: 'main',
        want(G, pi) {
          const P = G.players[pi];
          const c = P.hand.filter(x => cardOf(x).type === 'イジン' && (cardOf(x).level || 0) <= 5).sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
          return c ? { uid: c.uid } : null;
        },
        resolve(G, pi, ctx) {
          const P = G.players[pi], c = ctx.target && P.hand.find(x => x.uid === ctx.target.uid);
          if (!c) return false;
          P.hand.splice(P.hand.indexOf(c), 1); placeToField(G, pi, c, 'ブリッツ', false); c.hasteTurn = G.turn;
          log(G, `　ブリッツ：${cardOf(c).name}はこのターン「即応」を得ます`);
        }
      },
      'フランソワ1世': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      'マシュー・カルブレイス・ペリー': { resolve(G, pi, ctx) { return ctx.kind === 'attack' || ctx.kind === 'field' ? undefined : false; } },   // 表を見るだけ／手札から墓地へは handToGrave
      'ソリッドビジョンΩ': {   // 1ドロー（緑魔導：これを裏にして魔力ゾーンに置く）
        timing: 'main',
        want(G, pi) { const P = G.players[pi]; return P.deck.length > deckReserve(G, pi) + 2 && (P.hand.length <= 5 || redOnMine(G, pi, '緑')) ? {} : null; },
        resolve(G, pi, ctx) {
          const P = G.players[pi];
          manualDraw(G, pi, 1, 'ソリッドビジョンΩ');
          const me = ctx.inst;
          if (me && P.grave.includes(me) && redOnMine(G, pi, '緑')) {
            P.grave.splice(P.grave.indexOf(me), 1); me.faceUp = false; P.mana.push(me); graveLeft(G, pi); onFaceDownMana(G, pi);
            log(G, '　ソリッドビジョンΩ（緑魔導）：これを裏にして魔力ゾーンに置きました');
          }
        }
      },
      '長宗我部元親': {   // エンドフェイズ：自分のガーディアン1体を破壊して3ドロー（強制）
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'endPhase') return false;
          const g = takeGuardian(G, pi);
          if (!g || isIndestructible(G, g, true)) return;
          manualDestroy(G, pi, g.uid, '長宗我部元親'); manualDraw(G, pi, 3, '長宗我部元親');
        }
      },
      '和宮': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      'アンリ4世': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },   // ブロックされたときは cpuOnBlocked
      '落日の王宮': {
        resolve(G, pi, ctx) {
          const P = G.players[pi];
          if (ctx.kind === 'field') {   // 山札の上から3枚を墓地に置いて、墓地のカード1つを山札の上に戻す
            if (P.deck.length < 14) return 'declined';
            millN(G, pi, 3, '落日の王宮');
            const b = bestFromGrave(G, pi, x => cardOf(x).type !== 'マリョク');
            if (b) { P.grave.splice(P.grave.indexOf(b), 1); P.deck.push(b.cardId); graveLeft(G, pi); log(G, `　落日の王宮：墓地の${cardOf(b).name}を山札の上に戻しました`); }
            return;
          }
          if (ctx.kind !== 'mainStart') return false;
          if (P.deck.length <= deckReserve(G, pi) + 3) return 'declined';
          millN(G, pi, 1, '落日の王宮');
          const b = bestFromGrave(G, pi, x => cardOf(x).type !== 'マリョク' || !P.hand.some(h => cardOf(h).type === 'マリョク'));
          if (b) { P.grave.splice(P.grave.indexOf(b), 1); b.faceUp = true; P.hand.push(b); graveLeft(G, pi); log(G, `　落日の王宮：墓地の${cardOf(b).name}を手札に戻しました`); }
        }
      },
      'ショーダウン': {   // 手札のレベルの合計（これも加える）が低い方の手札すべてを墓地へ
        timing: 'main',
        want(G, pi) {
          const P = G.players[pi], O = G.players[1 - pi], me = P.hand.find(x => cardOf(x).name === 'ショーダウン');
          const mine = P.hand.filter(x => x !== me).reduce((t, x) => t + (cardOf(x).level || 0), 0) + 4, foe = O.hand.reduce((t, x) => t + (cardOf(x).level || 0), 0);
          return O.hand.length >= 2 && mine > foe ? {} : null;
        },
        resolve(G, pi, ctx) {
          const P = G.players[pi], O = G.players[1 - pi], lv = ctx.inst ? cardOf(ctx.inst).level || 0 : 4;
          const mine = P.hand.reduce((t, x) => t + (cardOf(x).level || 0), 0) + lv, foe = O.hand.reduce((t, x) => t + (cardOf(x).level || 0), 0);
          log(G, `　ショーダウン：手札のレベルの合計 ${nm(G, pi)} ${mine} ／ ${nm(G, 1 - pi)} ${foe}`);
          const q = mine < foe ? pi : foe < mine ? 1 - pi : -1;
          if (q < 0) { log(G, '　同じなので、どちらの手札も墓地に置かれません'); return; }
          const n = G.players[q].hand.length; G.players[q].hand.slice().forEach(x => handToGrave(G, q, x));
          log(G, `　ショーダウン：${nm(G, q)}の手札${n}枚を墓地に置きました`);
        }
      },
      'ドッペルゲンガー': {   // 相手の手札・戦場・墓地で同じ名前のマリョクでないカード（手札と戦場のもの）を墓地へ
        timing: 'main',
        want(G, pi) { const n = doppelTargets(G, pi).length; return n >= 2 ? {} : null; },
        resolve(G, pi) {
          const q = 1 - pi, list = doppelTargets(G, pi), Q = G.players[q];
          if (!list.length) { log(G, '　ドッペルゲンガー：同じ名前のカードはありませんでした'); return; }
          log(G, `　ドッペルゲンガー：${nm(G, q)}の${list.map(x => cardOf(x).name).join('、')}を墓地に置きます`);
          list.forEach(x => { if (Q.hand.includes(x)) handToGrave(G, q, x); else fieldToGrave(G, q, x); });
        }
      },
      '藤原不比等': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      '小林虎三郎': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      'マルティン・ルター': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      '伊藤博文': {   // 相手のイジンかハイケイ1つを裏にして相手の魔力ゾーンへ、イジン召喚権+1
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const O = G.players[1 - pi];
          const v = x => (cardOf(x).type === 'ハイケイ' ? 2500 + (cardOf(x).level || 0) * 500 : instValue(G, x));
          const t = O.field.filter(x => x.faceUp && (cardOf(x).type === 'イジン' || cardOf(x).type === 'ハイケイ')).sort((a, b) => v(b) - v(a))[0];
          if (!t || v(t) < 2500) return 'declined';
          O.field.splice(O.field.indexOf(t), 1); releaseEquips(G, 1 - pi, t);
          t.faceUp = false; t.tapped = false; t.isGuardian = false; t.silenced = false; O.mana.push(t);
          G.players[pi].summon += 1;
          log(G, `　伊藤博文：${nm(G, 1 - pi)}の${cardOf(t).name}を裏にして魔力ゾーンに置き、イジン召喚権+1`);
          onFaceDownMana(G, 1 - pi);
        }
      },
      '四面楚歌': {   // 相手のエンドフェイズ：自分の山札の上から1枚を墓地へ（遺業能力の発動を狙う）
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'oppEnd') return false;
          if (G.players[pi].deck.length <= 10) return 'declined';
          millN(G, pi, 1, '四面楚歌');
        }
      },
      '精霊の島々': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },   // 山札が0枚になったときは deckZero
      'デストルドー': {   // 相手の戦場の遺業能力を持たないイジンすべてを山札の下へ
        timing: 'main',
        want(G, pi) { const t = G.players[1 - pi].field.filter(x => isIjinUp(x) && !hasLegacy(cardOf(x))); return t.reduce((s, x) => s + instValue(G, x), 0) >= 4000 ? {} : null; },
        resolve(G, pi) {
          const O = G.players[1 - pi], t = O.field.filter(x => isIjinUp(x) && !hasLegacy(cardOf(x)));
          t.forEach(x => { O.field.splice(O.field.indexOf(x), 1); releaseEquips(G, 1 - pi, x); x.silenced = false; O.deck.unshift(x.cardId); });
          log(G, t.length ? `　デストルドー：${nm(G, 1 - pi)}の${t.map(x => cardOf(x).name).join('、')}を山札の下に戻しました` : '　デストルドー：対象のイジンはいませんでした');
        }
      },
      'ソクラテス': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      'アルキメデス': {   // 戦場に置かれたとき：墓地の『魔導』マホウすべてを手札に戻す
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi], t = graveMahouLocked(G) ? [] : P.grave.filter(g => cardOf(g).type === 'マホウ' && /魔導 - /.test(cardOf(g).rule_text || ''));
          t.forEach(x => { P.grave.splice(P.grave.indexOf(x), 1); x.faceUp = true; P.hand.push(x); });
          log(G, `　アルキメデス：墓地の『魔導』マホウ${t.length}枚を手札に戻しました`); if (t.length) graveLeft(G, pi);
        }
      },
      '米百俵': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },   // ドローのときに manualDraw が判断
      'オリーブの枝': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? undefined : false; } },
      '日野富子': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },
      'ハースストーン': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? undefined : false; } },   // ドローは onStonePlaced
      'トランスポーター': {   // 手札のレベル2以下のイジンを戦場に置く か 1ドロー
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'mana') return false;
          const P = G.players[pi];
          const c = P.hand.filter(x => cardOf(x).type === 'イジン' && (cardOf(x).level || 0) <= 2).sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
          if (c) { P.hand.splice(P.hand.indexOf(c), 1); placeToField(G, pi, c, 'トランスポーター', false); }
          else manualDraw(G, pi, 1, 'トランスポーター');
        }
      },
      'チャルカ': {   // 魔力ゾーンに置かれたとき：選んだ色をこのターン得る
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'mana' || !ctx.inst) return false;
          const need = handNeedColors(G.players[pi]);
          const ch = Object.keys(need).sort((a, b) => need[b] - need[a])[0] || '黄';
          ctx.inst.tempColor = ch; log(G, `　チャルカ：このターン「色：${ch}」を得ます`);
        }
      },
      // ===== 第4弾プリセットのカード =====
      'フローレンス・ナイチンゲール': {   // 墓地から戦場に置かれたとき：山札の上から1枚を裏のまま戦場に（ガーディアン）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          if (!ctx.fromGrave) return;   // 手札から召喚したときは何も起きない
          addGuardianFromDeck(G, pi, 'フローレンス・ナイチンゲール');
        }
      },
      'リユニオン': {   // 自分のイジンを手札に戻して、戻した数だけ召喚権+：置かれたときの能力を持つイジンを出し直す
        timing: 'main',
        want(G, pi) {
          const P = G.players[pi], cap = manaInfo(P).cap;
          const t = P.field.filter(x => isIjinUp(x) && SR.abilityText(cardOf(x), 'field') && (cardOf(x).level || 0) <= cap && !/ゲームに敗北/.test(cardOf(x).rule_text || ''));
          return t.length ? { uids: t.map(x => x.uid) } : null;
        },
        resolve(G, pi, ctx) {
          const P = G.players[pi], ts = (ctx.target ? ctx.target.uids : []).map(u => P.field.find(x => x.uid === u)).filter(Boolean);
          if (!ts.length) return false;
          ts.forEach(x => bounce(G, pi, x, 'リユニオン')); P.summon += ts.length; log(G, `　リユニオン：イジン召喚権+${ts.length}`);
        }
      },
      'ソリッドビジョンδ': {   // 1ドロー（青魔導：さらに1ドローして、手札の他のカード2つを墓地へ：マシュー・ペリーを捨てて戦場に出す）
        timing: 'main',
        want(G, pi) { const P = G.players[pi]; return P.deck.length > 8 && (P.hand.length <= 4 || (redOnMine(G, pi, '青') && P.hand.some(x => /手札から墓地に置かれたとき、これを戦場に置く/.test(cardOf(x).rule_text || '')))) ? {} : null; },
        resolve(G, pi) {
          const P = G.players[pi];
          manualDraw(G, pi, 1, 'ソリッドビジョンδ');
          const perry = P.hand.filter(x => /手札から墓地に置かれたとき、これを戦場に置く/.test(cardOf(x).rule_text || ''));
          if (!redOnMine(G, pi, '青') || P.hand.length < 2 || P.deck.length <= deckReserve(G, pi) || !(perry.length || P.hand.length >= 6)) return;
          manualDraw(G, pi, 1, 'ソリッドビジョンδ（青魔導）');
          const out = perry.slice(0, 2);
          while (out.length < 2 && P.hand.length > out.length) out.push(P.hand.filter(x => !out.includes(x)).sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b))[0]);
          log(G, `　ソリッドビジョンδ（青魔導）：手札の${out.map(x => cardOf(x).name).join('、')}を墓地に置きます`);
          out.forEach(x => handToGrave(G, pi, x));
        }
      },
      'ラ・コロール': {   // 魔力ゾーンに置かれたとき：レベル2以下のイジンを山札の下へ（このターン自分はバトルできない）：アタックしないときに相手の価値の高いイジンへ
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'mana') return false;
          const t = G.players[1 - pi].field.filter(x => isIjinUp(x) && (cardOf(x).level || 0) <= 2).sort((a, b) => instValue(G, b) - instValue(G, a))[0];
          if (!t || instValue(G, t) < 2500 || eligibleAttackers(G, pi).length) return 'declined';
          const O = G.players[1 - pi]; O.field.splice(O.field.indexOf(t), 1); releaseEquips(G, 1 - pi, t); O.deck.unshift(t.cardId);
          G.noBattle = { turn: G.turn, pi };
          log(G, `　ラ・コロール：${nm(G, 1 - pi)}の${cardOf(t).name}を山札の下に戻しました（このターン、バトルできない）`);
        }
      },
      'ジョバンニ＝ディ＝メディチ': {},
      // ===== 第3弾プリセットのカード =====
      '浪士集う長屋': {   // メインフェイズ開始時：山札の上から3枚まで墓地へ → 1枚以上:配置権+1、2枚以上:召喚権+1、3枚:1ドロー
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'mainStart') return false;
          const d = G.players[pi].deck.length, n = d >= 15 ? 3 : d >= 10 ? 2 : d >= 7 ? 1 : 0;
          if (!n) return 'declined';
          millN(G, pi, n, '浪士集う長屋');
          const P = G.players[pi];
          P.manaPlace += 1; if (n >= 2) P.summon += 1; if (n >= 3) manualDraw(G, pi, 1, '浪士集う長屋');
          log(G, `　浪士集う長屋：配置権+1${n >= 2 ? '・召喚権+1' : ''}${n >= 3 ? '・1ドロー' : ''}`);
        }
      },
      '土方歳三': {   // 「志願」イジンとガーディアンの数だけ、自分か相手がドロー（LOデッキなら相手）／ガーディアンがいなければ召喚権+2
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi];
          const n = P.field.filter(x => (isIjinUp(x) && hasTrait(cardOf(x), '志願')) || isGuardianInst(x)).length;
          if (n) {
            if (loPlan(G, pi) || P.deck.length < n + 8) oppDraw(G, pi, n, '土方歳三');
            else manualDraw(G, pi, Math.min(n, 3), '土方歳三');
          }
          if (!P.field.some(isGuardianInst)) { P.summon += 2; log(G, '　土方歳三：ガーディアンがいないのでイジン召喚権+2'); }
        }
      },
      '李成桂': {   // 自分の墓地の一番価値の高いイジンを山札の上へ（次に引く）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi], c = P.grave.filter(x => cardOf(x).type === 'イジン').sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
          if (!c || cardValue(cardOf(c)) < 5000) return 'declined';
          P.grave.splice(P.grave.indexOf(c), 1); P.deck.push(c.cardId); log(G, `　李成桂：墓地の${cardOf(c).name}を山札の上に戻しました`); graveLeft(G, pi);
        }
      },
      '本居宣長': {   // 「医術」イジンが置かれたとき：1ドロー、相手も1ドロー（手札が少ないときだけ）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'ownIjin') return false;
          if (G.players[pi].hand.length > 4 && !loPlan(G, pi)) return 'declined';
          manualDraw(G, pi, 1, '本居宣長'); oppDraw(G, pi, 1, '本居宣長');
        }
      },
      'ジョージ・スチーブンソン': {   // 魔力ゾーンの裏のカードを手札に戻して配置権+1：手札にマリョクがあるとき（裏を表のマリョクに入れ替える）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const P = G.players[pi];
          if (!P.mana.some(x => !x.faceUp) || !P.hand.some(x => cardOf(x).type === 'マリョク')) return 'declined';
          takeFaceDownMana(G, pi); P.manaPlace += 1; log(G, '　ジョージ・スチーブンソン：裏のカードを手札に戻して、マリョク配置権+1');
        }
      },
      'イーライ・ホイットニー': {   // 魔力ゾーンの裏のカードを手札に戻して、相手のパワー3000以下のイジン1体を破壊
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const t = G.players[1 - pi].field.filter(x => isIjinUp(x) && powerOf(x, G) <= 3000).filter(notIndestructible(G)).sort((a, b) => instValue(G, b) - instValue(G, a))[0];
          if (!t || instValue(G, t) < 2500 || !G.players[pi].mana.some(x => !x.faceUp)) return 'declined';
          takeFaceDownMana(G, pi); manualDestroy(G, 1 - pi, t.uid, 'イーライ・ホイットニー');
        }
      },
      'マリ・キュリー': {   // 相手の手札が自分より多いなら、同じ枚数になるまで相手が墓地に置く
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const n = G.players[1 - pi].hand.length - G.players[pi].hand.length;
          if (n > 0) forceDiscard(G, 1 - pi, n, 'マリ・キュリー'); else log(G, '　マリ・キュリー：相手の手札は自分より多くありません');
        }
      },
      '芹沢鴨': {   // 相手の手札1枚（相手が選ぶ）と自分の手札1枚を墓地へ
        resolve(G, pi, ctx) { if (ctx.kind !== 'field') return false; forceDiscard(G, 1 - pi, 1, '芹沢鴨'); discardLowest(G, pi, 1, '芹沢鴨'); }
      },
      '渡辺崋山': {
        resolve(G, pi, ctx) {
          const P = G.players[pi];
          if (ctx.kind === 'field') { const n = P.field.filter(x => isIjinUp(x) && hasTrait(cardOf(x), '美術')).length; if (n) manualDraw(G, pi, Math.min(n, Math.max(0, P.deck.length - 6)), '渡辺崋山'); return; }
          if (ctx.kind === 'destroyed') { const n = P.field.filter(x => isIjinUp(x) && hasTrait(cardOf(x), '医術')).length; if (n) forceDiscard(G, G.current, n, '渡辺崋山'); return; }
          return false;
        }
      },
      'サンダーボルト': {   // 相手のパワー4000以下のイジンすべてと、相手のハイケイすべてを破壊
        timing: 'main',
        want(G, pi) {
          const O = G.players[1 - pi];
          const v = O.field.filter(x => (isIjinUp(x) && powerOf(x, G) <= 4000) || (x.faceUp && cardOf(x).type === 'ハイケイ')).filter(notIndestructible(G)).reduce((t, x) => t + (cardOf(x).type === 'ハイケイ' ? 3000 : instValue(G, x)), 0);
          return v >= 7000 ? {} : null;
        },
        resolve(G, pi) {
          const O = G.players[1 - pi];
          O.field.filter(x => (isIjinUp(x) && powerOf(x, G) <= 4000) || (x.faceUp && cardOf(x).type === 'ハイケイ')).slice().forEach(x => { if (!isIndestructible(G, x, true)) manualDestroy(G, 1 - pi, x.uid, 'サンダーボルト'); });
        }
      },
      'スピリットアウェイ': {   // 自分のガーディアン1体を手札に戻し、相手の山札の上から2枚を墓地へ、配置権+1：LOデッキ、またはガーディアンに余裕があり置くマリョクがあるとき
        timing: 'main',
        want(G, pi) {
          const P = G.players[pi], gs = myGuards(G, pi).length;
          if (loPlan(G, pi)) return gs >= 1 ? {} : null;   // LOデッキ：相手の山札を削るのが勝ち筋
          if (gs < 2) return null;
          return gs >= 4 && P.manaPlace < 1 && P.hand.some(x => cardOf(x).type === 'マリョク') ? {} : null;
        },
        resolve(G, pi) {
          const P = G.players[pi], g = takeGuardian(G, pi);
          if (g) { P.field.splice(P.field.indexOf(g), 1); g.faceUp = true; g.isGuardian = false; g.tapped = false; P.hand.push(g); log(G, '　スピリットアウェイ：ガーディアン1体を手札に戻しました'); }
          millN(G, 1 - pi, 2, 'スピリットアウェイ'); P.manaPlace += 1;
        }
      },
      'エアロオーラ': { timing: 'main', want(G, pi) { return G.players[pi].hand.length <= 4 && G.players[pi].deck.length > 8 ? {} : null; }, resolve(G, pi) { manualDraw(G, pi, 1, 'エアロオーラ'); } },
      '永遠の帝都': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },   // エンジンが処理
      '暴風岬': {   // エンドフェイズ：置かれたときの能力を持つ自分のイジン1体を手札に戻して1ドロー（次のターンにまた使う）
        resolve(G, pi, ctx) {
          if (ctx.kind === 'field') return;
          if (ctx.kind !== 'endPhase') return false;
          const P = G.players[pi];
          const t = P.field.filter(x => isIjinUp(x) && SR.abilityText(cardOf(x), 'field') && cardOf(x).level <= manaInfo(P).cap).sort((a, b) => instValue(G, a) - instValue(G, b))[0];
          if (!t || P.deck.length <= 6) return 'declined';
          bounce(G, pi, t, '暴風岬'); manualDraw(G, pi, 1, '暴風岬');
        }
      },
      'タイムディレイション': {   // これを裏にして魔力ゾーンに置き、ターンを終える：バトルの後に使えば、魔力ゾーンが1枚増えるだけ
        timing: 'post',
        want() { return {}; },
        resolve(G, pi) {
          const P = G.players[pi], me = P.grave.slice().reverse().find(x => cardOf(x).name === 'タイムディレイション');
          if (me) { P.grave.splice(P.grave.indexOf(me), 1); me.faceUp = false; P.mana.push(me); log(G, '　タイムディレイション：これを裏にして魔力ゾーンに置きました'); onFaceDownMana(G, pi); }
          if (G.current === pi) G.cpuStage = 'after';
        }
      },
      '商館並ぶ人工島': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : ctx.kind === 'mainStart' ? 'declined' : false; } },
      '松平定信': {   // 相手の寝ているイジンすべてを山札の下へ → 自分の山札の下から1枚を手札に（ターンに1回）
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
          const O = G.players[1 - pi], ts = O.field.filter(x => isIjinUp(x) && x.tapped);
          ts.forEach(x => { O.field.splice(O.field.indexOf(x), 1); releaseEquips(G, 1 - pi, x); O.deck.unshift(x.cardId); });
          log(G, `　松平定信：${nm(G, 1 - pi)}の寝ているイジン${ts.length}体を山札の下に戻しました`);
          const P = G.players[pi];
          if (ts.length && P.deck.length) { P.hand.push(mkInst(P.deck.shift())); log(G, '　松平定信：自分の山札の下から1枚を手札に加えました'); }
        }
      },
      '井伊直弼': {   // メインフェイズ開始時：山札の下から2枚を見て、レベル7以下のイジンを戦場に、残りを手札に
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'mainStart') return false;
          const P = G.players[pi], got = [];
          for (let k = 0; k < 2 && P.deck.length; k++) got.push(mkInst(P.deck.shift()));
          got.forEach(x => { if (cardOf(x).type === 'イジン' && (cardOf(x).level || 0) <= 7) placeToField(G, pi, x, '井伊直弼'); else P.hand.push(x); });
          log(G, `　井伊直弼：山札の下から${got.length}枚を見ました`);
        }
      },
      'ダンダラ羽織': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? 'declined' : false; } },   // 装備は使わない
      '虎狼痢': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },        // 手札を見せ合う効果は省略
      'ルイス・キャロル': { resolve(G, pi, ctx) { return ctx.kind === 'shippitsu' ? undefined : false; } },   // 執筆は効果を持たない
      '勝海舟': {},   // 防御側の処理は cpuOnAttack
    };

    /* CPUの遺業能力（戦場から墓地に置かれたとき）。読めるものだけ処理して true を返す */
    // 森閑たる離宮「これが戦場にある間「冥府発動」でない遺業能力は発動しない」
    const rikyuuOn = G => G.players.some(Q => Q.field.some(x => x.faceUp && !x.silenced && /これが戦場にある間「冥府発動」でない遺業能力は発動しない/.test(cardOf(x).rule_text || '')));
    const legacyBlocked = (G, c) => rikyuuOn(G) && !/冥府発動/.test(c.legacy_ability || '');
    // 森閑たる離宮「カードが戦場から墓地に置かれるたび、そのカードが「冥府発動」を持っていないなら、そのカードのプレイヤーの手札1枚を墓地に置く（そのプレイヤーが選ぶ）」
    function detachedPalace(G, q, c) {
      if (!rikyuuOn(G) || /冥府発動/.test(c.legacy_ability || '') || !G.players[q].hand.length) return;
      if (G.aiPlayers.has(q)) discardLowest(G, q, 1, '森閑たる離宮');
      else log(G, `　森閑たる離宮：${nm(G, q)}は手札1枚を墓地に置いてください（手動）`);
    }
    function cpuLegacy(G, pi, uid) {
      if (G.cpuNoEffects && G.cpuNoEffects.has(pi)) return false;
      const P = G.players[pi], inst = P.grave.find(x => x.uid === uid);
      if (!inst) return true;   // すでに墓地を離れている（他の効果で動いた）ので、何もしない
      const c = cardOf(inst), t = normTxt(c.legacy_ability);
      if (legacyBlocked(G, c)) { log(G, `　森閑たる離宮の効果：${c.name}の遺業能力は発動しません`); return true; }
      // ヴォルフガング・アマデウス・モーツァルト「相手の墓地のカードは能力すべてを失う」
      const moz = G.players[1 - pi].field.find(x => x.faceUp && !x.silenced && /これが戦場にいる間、相手の戦場の「音楽」イジンと、相手の墓地のカードは能力すべてを失う/.test(cardOf(x).rule_text || ''));
      if (moz) { log(G, `　${cardOf(moz).name}の効果：${c.name}の遺業能力は発動しません`); return true; }
      const take = () => { P.grave.splice(P.grave.indexOf(inst), 1); inst.tapped = false; inst.isGuardian = false; graveLeft(G, pi); };   // 墓地から離れる → 親鸞
      let what = '', m;
      if (/魔力化/.test(t)) { take(); inst.faceUp = false; P.mana.push(inst); what = '魔力化（魔力ゾーンに裏向きで置く）'; }
      else if (/復元/.test(t)) { take(); inst.faceUp = true; P.mana.push(inst); what = '復元（魔力ゾーンに表向きで置く）'; }
      else if ((m = t.match(/([1-3])ドローする/))) { manualDraw(G, pi, Number(m[1]), '遺業能力'); what = `${m[1]}ドロー`; }
      else if (/これを手札に戻す|^手札に加える/.test(t)) { take(); inst.faceUp = true; P.hand.push(inst); what = '手札に戻す'; }
      else if (/山札の上か下に戻す/.test(t)) { take(); P.deck.push(inst.cardId); what = '山札の上に戻す'; }
      else if (/喪神/.test(t)) { what = '喪神（バトルは終わっているので効果なし）'; }
      else if (/反魂/.test(t) && c.type === 'イジン') {
        // 反魂：自分のガーディアン1体を山札の下に戻して、これを戦場に置く（籠城戦が墓地にあれば代わりに使える）
        const ro = P.grave.find(x => x !== inst && /自分の墓地にある「反魂」は、ガーディアンを山札の下に戻す代わりに、これを山札の下に戻しても発動する/.test(cardOf(x).rule_text || ''));
        const gs = myGuards(G, pi).length;
        if (!ro && !(gs >= 3 || (gs >= 2 && cardValue(c) >= 8000))) { log(G, `　遺業能力（CPU）：${c.name}の反魂は、ガーディアンが少ないので使いません`); return true; }
        if (ro) { P.grave.splice(P.grave.indexOf(ro), 1); P.deck.unshift(ro.cardId); log(G, `　反魂：墓地の${cardOf(ro).name}を山札の下に戻しました`); }
        else { const g = takeGuardian(G, pi); P.field.splice(P.field.indexOf(g), 1); P.deck.unshift(g.cardId); log(G, '　反魂：ガーディアン1体を山札の下に戻しました'); }
        take(); placeToField(G, pi, inst, '反魂'); what = '反魂（戦場に戻る）';
      }
      else if (/木霊/.test(t)) {
        // 木霊：自分の手札か墓地の、これより低いレベルを持つイジン1体を戦場に置く
        const lv = c.level || 0;
        const cand = P.hand.concat(P.grave.filter(x => x !== inst)).filter(x => cardOf(x).type === 'イジン' && (cardOf(x).level || 0) < lv)
          .sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
        if (!cand) { what = '木霊（対象なし）'; }
        else { const from = P.hand.includes(cand) ? P.hand : P.grave; from.splice(from.indexOf(cand), 1); placeToField(G, pi, cand, '木霊'); what = `木霊（${cardOf(cand).name}を戦場へ）`; }
      }
      else if (/冥府発動/.test(t) && c.type === 'マホウ') {
        // 冥府発動：マホウコストを払わずにこのマホウを発動できる（使う価値がなければ発動しない）
        const h = CARD_AI[c.name], text = SR.abilityText(c, 'mahou') || '';
        if (h && h.want) {
          const target = h.want(G, pi);
          if (!target) { log(G, `　遺業能力（CPU）：${c.name}の冥府発動は、使う価値がないので発動しません`); return true; }
          log(G, `　遺業能力（CPUが自動処理）：${nm(G, pi)}の${c.name} → 冥府発動`);
          h.resolve(G, pi, { target });
        } else if (effectPlan(text)) { log(G, `　遺業能力（CPUが自動処理）：${nm(G, pi)}の${c.name} → 冥府発動`); cpuResolve(G, pi, c, text, {}); }
        else return false;
        G.fx.push({ type: 'ability', pi, kind: 'legacy', cardId: c.id, name: `${c.name}（遺業）`, text: '冥府発動', uid: inst.uid, auto: true });
        return true;
      }
      else return false;
      log(G, `　遺業能力（CPUが自動処理）：${nm(G, pi)}の${c.name} → ${what}`);
      G.fx.push({ type: 'ability', pi, kind: 'legacy', cardId: c.id, name: `${c.name}（遺業）`, text: what, uid: inst.uid, auto: true });
      if (/復元/.test(t)) { abilityFx(G, pi, c, 'mana', inst); onStonePlaced(G, pi, inst); }   // 表向きで魔力ゾーンに置かれたときの能力
      return true;
    }

    /* ---------- カード効果の自動処理（CPU用）。文を「。」で区切り、すべての文が既知の書式なら処理する ----------
       run が false を返したら（「〜なら発動する」の条件を満たさない等）、その後の文は処理しない */
    const myGuards = (G, pi) => G.players[pi].field.filter(isGuardianInst);
    const takeGuardian = (G, pi) => myGuards(G, pi).sort((a, b) => (a.tapped ? 0 : 1) - (b.tapped ? 0 : 1))[0];   // 寝ているガーディアンから使う
    function discardLowest(G, pi, n, by) {
      const P = G.players[pi], names = [];
      for (let k = 0; k < n && P.hand.length; k++) {
        const x = P.hand.slice().sort((a, b) => discardScore(G, pi, b) - discardScore(G, pi, a))[0];
        names.push(cardOf(x).name); handToGrave(G, pi, x);
      }
      if (names.length) log(G, `　${by || '効果'}：${nm(G, pi)}は手札の${G.aiPlayers.has(pi) ? names.join('、') : names.length + '枚'}を墓地に置きました`);
    }
    function addGuardianFromDeck(G, pi, by) {
      const P = G.players[pi];
      if (!P.deck.length) return false;
      P.field.push(mkInst(P.deck.pop(), { faceUp: false, isGuardian: true, placedTurn: G.turn }));
      log(G, `　${by || '効果'}：${nm(G, pi)}の山札の上から1枚をガーディアンにして戦場に置きました（山札残り${P.deck.length}枚）`);
      onGuardianPlaced(G, pi);
      return true;
    }
    function millN(G, pi, n, by) {
      const P = G.players[pi]; let k = 0; const milled = [];
      for (; k < n && P.deck.length; k++) { const x = mkInst(P.deck.pop()); P.grave.push(x); milled.push(x); }
      log(G, `　${by || '効果'}：${nm(G, pi)}の山札の上から${k}枚を墓地に置きました（山札残り${P.deck.length}枚）`);
      // 四面楚歌「相手のターンに戦場か墓地で効果を発揮する。自分の墓地の遺業能力は山札から墓地に置かれても発動する」（CPU）
      if (G.current !== pi && G.aiPlayers.has(pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(pi)) &&
        P.field.concat(P.grave).some(x => x.faceUp && !x.silenced && /自分の墓地の遺業能力は山札から墓地に置かれても発動する/.test(cardOf(x).rule_text || '')))
        milled.filter(x => hasLegacy(cardOf(x)) && P.grave.includes(x)).forEach(x => { log(G, `　四面楚歌：${cardOf(x).name}の遺業能力が発動します`); cpuLegacy(G, pi, x.uid); });
      if (k > 0) deckZero(G, pi);
    }
    const destroyBest = (G, pi, list, by) => {   // list の中から価値の高いものを破壊
      const t = list.filter(notIndestructible(G)).sort((a, b) => instValue(G, b) - instValue(G, a))[0];
      if (t) manualDestroy(G, 1 - pi, t.uid, by || '効果'); else log(G, '　破壊できる相手のイジンがいません');
    };
    const EFFECT_RULES = [
      // 条件（満たさなければ以降を処理しない）
      { re: /^自分の戦場のイジンが(\d)体以下なら発動する$/, run: (G, pi, m) => G.players[pi].field.filter(isIjinUp).length <= Number(m[1]) },
      { re: /^戦場に(赤|青|緑|黄|紫)のイジンがいるなら発動する$/, run: (G, pi, m) => G.players.some(P => P.field.some(x => isIjinUp(x) && String(cardOf(x).color).includes(m[1]))) },
      // ドロー・権利
      { re: /^(?:自分は)?([1-3１-３一二三])ドローする$/, run: (G, pi, m) => { manualDraw(G, pi, KNUM[m[1]], '効果'); } },
      { re: /^イジン召喚権\+([1-3])する$/, run: (G, pi, m) => { G.players[pi].summon += Number(m[1]); log(G, `　効果：${nm(G, pi)}のイジン召喚権+${m[1]}`); },
        ok: (G, pi) => { const P = G.players[pi]; return P.summon < 1 && P.hand.some(x => cardOf(x).type === 'イジン' && conditionProblems(P, cardOf(x), summonInfo(G, pi, cardOf(x)).auto).length === 0); } },
      { re: /^マリョク配置権\+([1-3])する$/, run: (G, pi, m) => { G.players[pi].manaPlace += Number(m[1]); log(G, `　効果：${nm(G, pi)}のマリョク配置権+${m[1]}`); },
        ok: (G, pi) => G.players[pi].manaPlace < 1 && G.players[pi].hand.length >= 3 },
      { re: /^([1-3])ドローして、イジン召喚権\+([1-3])する$/, run: (G, pi, m) => { manualDraw(G, pi, Number(m[1]), '効果'); G.players[pi].summon += Number(m[2]); log(G, `　効果：${nm(G, pi)}のイジン召喚権+${m[2]}`); } },
      { re: /^([1-3])ドローして、自分の手札([1-3])枚を墓地に置く$/, run: (G, pi, m) => { manualDraw(G, pi, Number(m[1]), '効果'); discardLowest(G, pi, Number(m[2])); } },
      { re: /^自分はイジン召喚権\+([1-3])して、自分の戦場のハイケイ1つにつき1ドローする$/, run: (G, pi, m) => {
        G.players[pi].summon += Number(m[1]); log(G, `　効果：${nm(G, pi)}のイジン召喚権+${m[1]}`);
        const n = G.players[pi].field.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ').length; if (n) manualDraw(G, pi, n, '効果'); } },
      // 山札・墓地・手札
      { re: /^自分の山札の上から(?:カード)?([1-3１-３一二三])(?:枚|つ)を、?裏のまま魔力ゾーンに置く$/, run: (G, pi, m) => {
        const P = G.players[pi]; for (let k = 0; k < KNUM[m[1]] && P.deck.length; k++) P.mana.push(mkInst(P.deck.pop(), { faceUp: false })); onFaceDownMana(G, pi);
        log(G, `　効果：${nm(G, pi)}の山札の上から${KNUM[m[1]]}枚を裏のまま魔力ゾーンに置きました`); } },
      { re: /^自分の山札の上から([1-9])枚を墓地に置く$/, run: (G, pi, m) => { millN(G, pi, Number(m[1])); } },
      { re: /^自分の手札([1-3])枚を墓地に置く$/, run: (G, pi, m) => { discardLowest(G, pi, Number(m[1])); } },
      // ガーディアン
      { re: /^自分の山札の上から(?:カード)?([1-3１-３一二三])(?:枚|つ)を(?:裏向きの)?ガーディアン(?:にして|として)戦場に置く$/, run: (G, pi, m) => {
        for (let k = 0; k < KNUM[m[1]]; k++) addGuardianFromDeck(G, pi); } },
      { re: /^自分の戦場のガーディアン([1-3])体を山札の上に戻す$/, run: (G, pi, m) => {
        const P = G.players[pi];
        for (let k = 0; k < Number(m[1]); k++) {
          const g = takeGuardian(G, pi); if (!g) break;
          P.field.splice(P.field.indexOf(g), 1); P.deck.push(g.cardId);
          log(G, `　${nm(G, pi)}のガーディアン1体を山札の上に戻しました（残りのガーディアン${myGuards(G, pi).length}体）`);
        } } },
      // マーブルオーブ「赤か黄の他のマリョクが自分の魔力ゾーンにないなら、自分の戦場のガーディアン1体を山札の上に戻す」
      { re: /^(赤|青|緑|黄|紫)か(赤|青|緑|黄|紫)の他のマリョクが自分の魔力ゾーンにないなら、自分の戦場のガーディアン1体を山札の上に戻す$/, run: (G, pi, m, ctx) => {
        const P = G.players[pi];
        const has = P.mana.some(x => x !== ctx.inst && x.faceUp && cardOf(x).type === 'マリョク' && (String(cardOf(x).color).includes(m[1]) || String(cardOf(x).color).includes(m[2])));
        if (has) { log(G, `　${m[1]}か${m[2]}の他のマリョクがあるので、ガーディアンは戻しません`); return; }
        const g = takeGuardian(G, pi); if (!g) return;
        P.field.splice(P.field.indexOf(g), 1); P.deck.push(g.cardId);
        log(G, `　${nm(G, pi)}のガーディアン1体を山札の上に戻しました（残りのガーディアン${myGuards(G, pi).length}体）`); } },
      { re: /^自分の墓地のカード1つをガーディアンにして戦場に置く$/, run: (G, pi) => {
        const P = G.players[pi]; if (!P.grave.length) return;
        // 遺業能力を持つカード（破壊されたときに得をする）→ 価値の低いカードの順にガーディアンにする
        const g = P.grave.slice().sort((a, b) => (hasLegacy(cardOf(b)) ? 1 : 0) - (hasLegacy(cardOf(a)) ? 1 : 0) || cardValue(cardOf(a)) - cardValue(cardOf(b)))[0];
        P.grave.splice(P.grave.indexOf(g), 1); g.faceUp = false; g.isGuardian = true; g.tapped = false; g.placedTurn = G.turn; P.field.push(g);
        log(G, `　効果：${nm(G, pi)}の墓地のカード1つをガーディアンにして戦場に置きました`); onGuardianPlaced(G, pi); } },
      { re: /^自分の戦場のガーディアン1体を墓地に置いて、自分の山札の上から1枚をガーディアンにして戦場に置く$/, run: (G, pi) => {
        const P = G.players[pi], g = takeGuardian(G, pi); if (!g) return;
        P.field.splice(P.field.indexOf(g), 1); g.faceUp = true; g.isGuardian = false; g.tapped = false; P.grave.push(g);
        log(G, `　効果：${nm(G, pi)}のガーディアン（${cardOf(g).name}）を墓地に置きました`); addGuardianFromDeck(G, pi); } },
      { re: /^戦場のガーディアンすべてを手札に戻す$/, run: (G) => {
        G.players.forEach((P, q) => { const gs = P.field.filter(isGuardianInst); gs.forEach(g => { P.field.splice(P.field.indexOf(g), 1); g.faceUp = true; g.isGuardian = false; g.tapped = false; P.hand.push(g); });
          if (gs.length) log(G, `　効果：${nm(G, q)}のガーディアン${gs.length}体を手札に戻しました`); }); } },
      { re: /^戦場のガーディアンすべてを寝かせる$/, run: (G) => {
        G.players.forEach(P => P.field.filter(isGuardianInst).forEach(g => { g.tapped = true; })); log(G, '　効果：戦場のガーディアンすべてを寝かせました'); guardianTapped(G); } },
      // 第4弾
      { re: /^自分の山札の上から1枚を裏のまま魔力ゾーンに置いて、([1-3])ドローする$/, run: (G, pi, m) => {
        const P = G.players[pi]; if (P.deck.length) { P.mana.push(mkInst(P.deck.pop(), { faceUp: false })); onFaceDownMana(G, pi); }
        manualDraw(G, pi, Number(m[1]), '効果'); } },
      { re: /^相手の山札の上から(\d+)枚を墓地に置く$/, run: (G, pi, m) => { millN(G, 1 - pi, Number(m[1]), '効果'); } },
      // 第2弾
      { re: /^自分の魔力ゾーンのマリョクが(\d)つ以上なら発動できる$/, run: () => true },   // 決起の条件（呼び出し側で判定済み）
      { re: /^([1-3])ドローするか、イジン召喚権\+([1-3])する$/, run: (G, pi, m) => {   // 出せるイジンが手札にあれば召喚権、なければドロー
        const P = G.players[pi];
        const can = P.hand.some(x => cardOf(x).type === 'イジン' && conditionProblems(P, cardOf(x), summonInfo(G, pi, cardOf(x)).auto).length === 0);
        if (can) { P.summon += Number(m[2]); log(G, `　効果：${nm(G, pi)}のイジン召喚権+${m[2]}`); } else manualDraw(G, pi, Number(m[1]), '効果'); } },
      { re: /^([1-3])ドローして、このターンのマホウ使用に際し、手札のマホウは「魔力コスト0」になる$/, run: (G, pi, m) => {
        manualDraw(G, pi, Number(m[1]), '効果'); G.players[pi].freeMahouTurn = G.turn; log(G, '　効果：このターン、手札のマホウは魔力コスト0'); } },
      { re: /^([1-3])ドローして、これを破壊する$/, run: (G, pi, m, ctx) => { manualDraw(G, pi, Number(m[1]), '効果'); if (ctx.inst) manualDestroy(G, pi, ctx.inst.uid, '効果'); } },
      { re: /^自分のイジン召喚権1つにつき1ドローする$/, run: (G, pi) => { const n = G.players[pi].summon; if (n) manualDraw(G, pi, n, '効果'); } },
      // 相手のイジンを裏にして（持ち主の）魔力ゾーンへ（紫式部の執筆）：一番価値の高いもの
      { re: /^相手の戦場のイジン1体を裏にして魔力ゾーンに置く$/, run: (G, pi) => {
        const O = G.players[1 - pi], t = O.field.filter(isIjinUp).sort((a, b) => instValue(G, b) - instValue(G, a))[0];
        if (!t) { log(G, '　対象になる相手のイジンがいません'); return; }
        O.field.splice(O.field.indexOf(t), 1); releaseEquips(G, 1 - pi, t); t.faceUp = false; t.tapped = false; t.isGuardian = false; O.mana.push(t);
        log(G, `　効果：${nm(G, 1 - pi)}の${cardOf(t).name}を裏にして魔力ゾーンに置きました`); } },
      // 破壊
      { re: /^これのパワー以下のパワーを持つ相手の戦場のイジン1体を破壊する$/, run: (G, pi, m, ctx) => {
        const lim = ctx.inst ? powerOf(ctx.inst, G) : 0;
        destroyBest(G, pi, G.players[1 - pi].field.filter(x => isIjinUp(x) && powerOf(x, G) <= lim)); } },
      { re: /^(?:相手の戦場のパワー(\d+)以下のイジン|パワー(\d+)以下の相手の戦場のイジン)1体を破壊する$/, run: (G, pi, m) => {
        destroyBest(G, pi, G.players[1 - pi].field.filter(x => isIjinUp(x) && powerOf(x, G) <= Number(m[1] || m[2]))); },
        ok: (G, pi, m) => G.players[1 - pi].field.some(x => isIjinUp(x) && powerOf(x, G) <= Number(m[1] || m[2]) && !isIndestructible(G, x)) },
      // 自分のイジン1体を破壊（ビスマルクなど）：価値の低いもの（遺業能力持ちを優先）
      { re: /^自分の戦場のイジン1体を破壊する$/, run: (G, pi) => {
        const t = G.players[pi].field.filter(isIjinUp).filter(notIndestructible(G))
          .sort((a, b) => (instValue(G, a) - (hasLegacy(cardOf(a)) ? 1500 : 0)) - (instValue(G, b) - (hasLegacy(cardOf(b)) ? 1500 : 0)))[0];
        if (t) manualDestroy(G, pi, t.uid, '効果'); } },
    ];
    // 誘発の書き出し（「戦場に置かれたとき、」「航海 - アタッカーになったとき、」など）は、呼び出し側（どのタイミングで呼ばれたか）で判定済みなので外す
    const TRIG_PREFIX = /^(?:[^\s、。-]{1,6} - )?(?:この能力は、?)?(?:これが)?(?:マリョク配置によって)?(?:(?:魔力ゾーン|戦場)に置かれた|アタッカーになった|ブロッカーになった|破壊された)とき(?:に発動する)?、|^(?:[^\s、。-]{1,6} - )?(?:ハイケイが戦場に置かれる(?:たび|とき)|相手の戦場のイジンが破壊されるたび|ガーディアンが自分の戦場に置かれるたび|マリョク配置によってカードが自分の魔力ゾーンに置かれたとき|自分のエンドフェイズが開始したとき)、/;
    const TRIG_ONLY = /^(?:この能力は、?)?(?:これが)?(?:マリョク配置によって)?(?:魔力ゾーン|戦場)に置かれたときに発動する$/;   // 「この能力は、これが〜に置かれたときに発動する。」だけの文
    const TRIG_ONLY2 = /^[^、]*(?:とき|たび)に発動(?:する|できる)$/;   // 「赤のイジンが自分の戦場に置かれたときに発動できる。」など、条件だけの文
    const effectSentences = text => normTxt(text).replace(/（[^）]*）/g, '').split(/[。\n]+/).map(s => s.trim().replace(TRIG_PREFIX, '')).filter(s => s && !TRIG_ONLY.test(s) && !TRIG_ONLY2.test(s));
    /* 能力テキストをCPUが自動処理できるか（できるなら、その文ごとの処理を返す） */
    function effectPlan(text) {
      const sents = effectSentences(text);
      if (!sents.length) return null;
      const plan = [];
      for (const s of sents) {
        const r = EFFECT_RULES.find(x => x.re.test(s));
        if (!r) return null;
        plan.push({ r, m: s.match(r.re) });
      }
      return plan;
    }
    /* CPUのカード効果を処理する。カードごとの処理（CARD_AI）→ 書式ルール（EFFECT_RULES）の順に試す */
    function cpuResolve(G, pi, card, text, ctx) {
      if (G.cpuNoEffects && G.cpuNoEffects.has(pi)) return false;   // 検証用：そのプレイヤーのCPU効果処理を止める
      ctx = Object.assign({ target: G.cpuTarget }, G.cpuTrigCtx || {}, ctx || {});
      const h = CARD_AI[card.name];
      if (h && h.resolve) {
        const r = h.resolve(G, pi, ctx);
        if (r === 'declined') { log(G, `　${card.name}の能力：CPUは使わないことにしました`); return true; }
        if (r !== false) { log(G, `　${card.name}の能力をCPUが自動処理しました`); return true; }
      }
      const plan = effectPlan(text);
      if (!plan) return false;
      log(G, `　${card.name}の能力をCPUが自動処理します`);
      for (const { r, m } of plan) if (r.run(G, pi, m, ctx) === false) { log(G, '　（条件を満たさないので、ここから先は発動しません）'); break; }
      return true;
    }

    /* ---------- CPUの誘発（戦場に置かれた・魔力ゾーン・マホウ以外のタイミング） ----------
       カードの文章から該当する段落を取り出して cpuResolve に渡す。処理できなければ「自動処理されません」として表示 */
    const paraOf = (card, re) => String(card.rule_text || '').split(/\n\s*\n|\n/).map(x => x.trim()).filter(x => re.test(x)).join('\n');
    function cpuTrigger(G, pi, inst, re, kind) {
      if (!G.aiPlayers.has(pi) || !inst || !inst.faceUp || inst.silenced) return;
      const card = cardOf(inst), text = paraOf(card, re);
      if (text) abilityFx(G, pi, card, kind, inst, text);
    }
    // 破壊されたとき（自分のカード）＋「相手の戦場のイジンが破壊されるたび」（相手側のカード）
    // ジョバンニ＝ディ＝メディチ「戦場から墓地に置かれたとき、カードが自分の墓地に5つ以上あるなら、ゲームに敗北する」
    function fieldToGraveLoss(G, pi, inst) {
      const m = normTxt(cardOf(inst).rule_text).match(/戦場から墓地に置かれたとき、カードが自分の墓地に(\d+)つ以上あるなら、ゲームに敗北する/);
      if (m && G.players[pi].grave.includes(inst) && G.players[pi].grave.length >= Number(m[1])) win(G, 1 - pi, `${cardOf(inst).name}の効果（墓地に${G.players[pi].grave.length}枚あるときに戦場から墓地へ）`);
    }
    function onDestroyed(G, pi, inst) {
      fieldToGraveLoss(G, pi, inst);
      const P = G.players[pi], t = normTxt(cardOf(inst).rule_text);
      // アリエノール・ダキテーヌ「破壊されたとき、自分の山札の上から2枚を墓地に置いて発動できる。これを破壊されていない状態にする」
      if (G.aiPlayers.has(pi) && /破壊されたとき、自分の山札の上から(\d)枚を墓地に置いて発動できる。これを破壊されていない状態にする/.test(t) && P.deck.length >= 10 && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) {
        millN(G, pi, 2, cardOf(inst).name);
        P.grave.splice(P.grave.indexOf(inst), 1); inst.faceUp = true; inst.tapped = false; P.field.push(inst);
        log(G, `　${cardOf(inst).name}は破壊されていない状態になりました（戦場に残る）`);
        G.fx.push({ type: 'ability', pi, kind: 'destroyed', cardId: inst.cardId, name: cardOf(inst).name, text: '破壊されていない状態にする', uid: inst.uid, auto: true });
        return 'saved';
      }
      if (cardOf(inst).type === 'イジン') G.players[1 - pi].field.forEach(x => cpuTrigger(G, 1 - pi, x, /相手の戦場のイジンが破壊されるたび/, 'oppDestroyed'));
      if (G.aiPlayers.has(pi) && /(^|\n)\s*破壊されたとき/.test(cardOf(inst).rule_text || '')) cpuTrigger(G, pi, inst, /^破壊されたとき/, 'destroyed');
      // カトリーヌ・ド・メディシス「自分の戦場のイジンが破壊されたときに戦場で発動できる。相手の戦場のガーディアンすべてを寝かせる」
      if (cardOf(inst).type === 'イジン' && G.aiPlayers.has(pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) P.field.forEach(x => {
        if (!x.faceUp || x.silenced || !/自分の戦場のイジンが破壊されたときに戦場で発動できる。相手の戦場のガーディアンすべてを寝かせる/.test(normTxt(cardOf(x).rule_text))) return;
        G.players[1 - pi].field.filter(isGuardianInst).forEach(g => { g.tapped = true; });
        log(G, `　${cardOf(x).name}の効果：相手のガーディアンすべてを寝かせました`); guardianTapped(G);
        G.fx.push({ type: 'ability', pi, kind: 'destroyed', cardId: x.cardId, name: cardOf(x).name, text: '相手のガーディアンすべてを寝かせる', uid: x.uid, auto: true });
      });
    }
    // ガーディアンが自分の戦場に置かれるたび（孔子）
    function onGuardianPlaced(G, pi) {
      if (pillarOn(G)) return;
      G.players[pi].field.forEach(x => {
        if (!G.aiPlayers.has(pi) || !x.faceUp || x.silenced || !/ガーディアンが自分の戦場に置かれるたび、相手の戦場のガーディアン1体を寝かせる/.test(cardOf(x).rule_text || '')) return;
        const g = G.players[1 - pi].field.find(y => isGuardianInst(y) && !y.tapped);
        if (g) { g.tapped = true; log(G, `　${cardOf(x).name}の効果：相手のガーディアン1体を寝かせました`); guardianTapped(G); }
        G.fx.push({ type: 'ability', pi, kind: 'guardian', cardId: x.cardId, name: cardOf(x).name, text: '相手のガーディアン1体を寝かせる', uid: x.uid, auto: true });
      });
    }
    // ハイケイが戦場に置かれたとき（執筆）。裴松之がいる間は、他のカードの「執筆」は発動しない
    function onHaikeiPlaced(G, byPi, inst) {
      if (pillarOn(G)) return;
      const peiOn = G.players.some(P => P.field.some(x => x.faceUp && !x.silenced && /他のカードの「執筆」は発動しない/.test(cardOf(x).rule_text || '')));
      // 茅葺き屋根の張出し舞台「相手のターンの間、黄でないカードの「執筆」は発動しない」（その持ち主の相手のターン）
      const kayabuki = [0, 1].some(r => G.current !== r && G.players[r].field.some(x => x.faceUp && !x.silenced && /相手のターンの間、黄でないカードの「執筆」は発動しない/.test(cardOf(x).rule_text || '')));
      G.cpuTrigCtx = { haikei: inst };
      [0, 1].forEach(q => G.players[q].field.slice().forEach(x => {
        if (!x.faceUp || !/執筆 - /.test(cardOf(x).rule_text || '')) return;
        if (peiOn && !/他のカードの「執筆」は発動しない/.test(cardOf(x).rule_text || '')) return;
        if (kayabuki && !String(cardOf(x).color || '').includes('黄')) return;
        cpuTrigger(G, q, x, /執筆 - /, 'shippitsu');
      }));
      G.cpuTrigCtx = null;
      // 諸葛亮「黄のハイケイが自分の戦場に置かれるたび、1ドローする」
      if (inst && String(cardOf(inst).color || '').includes('黄') && G.aiPlayers.has(byPi) && !(G.cpuNoEffects && G.cpuNoEffects.has(byPi)))
        G.players[byPi].field.forEach(x => {
          if (x.faceUp && !x.silenced && /黄のハイケイが自分の戦場に置かれるたび、1ドローする/.test(cardOf(x).rule_text || '')) {
            manualDraw(G, byPi, 1, cardOf(x).name);
            G.fx.push({ type: 'ability', pi: byPi, kind: 'haikei', cardId: x.cardId, name: cardOf(x).name, text: '1ドロー', uid: x.uid, auto: true });
          }
        });
    }
    // 決起：マリョク配置によってカードが自分の魔力ゾーンに置かれたとき（自分の魔力ゾーンのマリョクが4つ以上・張角がいれば3つ以上なら）
    function onManaPlaced(G, pi) {
      if (!G.aiPlayers.has(pi) || pillarOn(G)) return;
      const P = G.players[pi];
      const n = P.mana.filter(m => m.faceUp && cardOf(m).type === 'マリョク').length;
      const need = P.field.some(x => x.faceUp && !x.silenced && /自分の戦場にある「決起」は、自分の魔力ゾーンのマリョクが3つ以上でも発動する/.test(cardOf(x).rule_text || '')) ? 3 : 4;
      if (n < need) return;
      if (G.players.some(Q => Q.field.some(x => x.faceUp && !x.silenced && /これが戦場にいる間「決起」は発動しない/.test(cardOf(x).rule_text || '')))) return;   // 吉田松陰
      P.field.filter(x => x.faceUp).concat(P.mana.filter(x => x.faceUp)).forEach(x => { if (/決起 - /.test(cardOf(x).rule_text || '')) cpuTrigger(G, pi, x, /決起 - /, 'kekki'); });
    }
    // CPUのイジンが寝たとき（曹丕「戦場の黄のイジンは「寝たとき、パワー4000以下のイジン1体を破壊する」を得る」）
    function cpuOnTapped(G, owner, insts) {
      if (pillarOn(G) || !G.aiPlayers.has(owner) || (G.cpuNoEffects && G.cpuNoEffects.has(owner))) return;
      // 岡田以蔵「これのパワーが6000以上なら、これが寝たときに発動する。自分か相手の戦場のイジンかガーディアン1体を破壊する」
      insts.filter(x => x.faceUp && !x.silenced && /これのパワーが(\d+)以上なら、これが寝たときに発動する。自分か相手の戦場のイジンかガーディアン1体を破壊する/.test(normTxt(cardOf(x).rule_text))).forEach(x => {
        const lim = Number(normTxt(cardOf(x).rule_text).match(/これのパワーが(\d+)以上/)[1]);
        if (powerOf(x, G) < lim) return;
        const O = G.players[1 - owner];
        const t = O.field.filter(isIjinUp).filter(notIndestructible(G)).sort((a, b) => instValue(G, b) - instValue(G, a))[0] || O.field.filter(isGuardianInst).filter(notIndestructible(G))[0];
        if (t) manualDestroy(G, 1 - owner, t.uid, cardOf(x).name);
      });
      const src = G.players.map(P => P.field.find(x => x.faceUp && !x.silenced && /戦場の黄のイジンは「寝たとき、パワー(\d+)以下のイジン1体を破壊する」を得る/.test(normTxt(cardOf(x).rule_text)))).find(Boolean);
      if (!src) return;
      const lim = Number(normTxt(cardOf(src).rule_text).match(/寝たとき、パワー(\d+)以下のイジン1体を破壊する/)[1]);
      insts.filter(x => x.faceUp && ijinHasColor(G, x, '黄')).forEach(() => {
        const foe = G.players[1 - owner].field.filter(x => isIjinUp(x) && powerOf(x, G) <= lim).filter(notIndestructible(G)).sort((a, b) => instValue(G, b) - instValue(G, a))[0];
        const mine = G.players[owner].field.filter(x => isIjinUp(x) && powerOf(x, G) <= lim).filter(notIndestructible(G)).sort((a, b) => instValue(G, a) - instValue(G, b))[0];
        if (foe) manualDestroy(G, 1 - owner, foe.uid, '曹丕の効果'); else if (mine) manualDestroy(G, owner, mine.uid, '曹丕の効果');
      });
    }

    /* ---------- マリョク配置：足りない色を補う表のマリョク → なければ一番使い道の薄いカードを裏で ---------- */
    function handNeedColors(P) {
      const have = manaInfo(P).colors, need = {};
      P.hand.forEach(i => { const c = cardOf(i); if (c.type !== 'マリョク') colorsOf(c).forEach(ch => { if (!have.has(ch)) need[ch] = (need[ch] || 0) + 1; }); });
      return need;
    }
    function cardUsefulness(G, pi, inst) {
      const P = G.players[pi], c = cardOf(inst), cap = manaInfo(P).cap;
      const dup = P.hand.filter(x => cardOf(x).name === c.name).length > 1 ? -2 : 0;
      if (/手札から墓地に置かれたとき、これを戦場に置く/.test(c.rule_text || '')) return -5;   // マシュー・ペリー：墓地に置かれると戦場に出る
      if (c.type === 'イジン') return (c.level <= cap + 2 ? 10 : 4) + (c.power || 0) / 2000 + dup;
      if (/魔力ゾーンのこれを表にして発動できる|これが魔力ゾーンに裏で置かれているなら、これを表にして/.test(c.rule_text || '')) return 2;   // 遁甲式：裏で魔力ゾーンに置くカード
      if (c.type === 'ハイケイ') return 7 + dup;
      if (c.type === 'マホウ') return (effectPlan(SR.abilityText(c, 'mahou') || '') ? 6 : 1) + dup;
      return 5;
    }
    // ピラー・オリーブの枝を表で置くのは、自分の置かれたときの能力やマホウを使い終えてから（メインフェイズの最後）
    const lockMana = c => isPillar(c) || /アタッカーにもブロッカーにもなれない/.test(c.rule_text || '');
    function oliveGood(G, pi) {   // オリーブの枝：レベル5未満のイジンが動けなくなって得をするか
      const low = q => G.players[q].field.filter(x => isIjinUp(x) && (cardOf(x).level || 0) < 5).length;
      return low(1 - pi) > low(pi);
    }
    function cpuPlaceMana(G, pi, late) {
      const P = G.players[pi];
      if (P.manaPlace < 1 || (!P.hand.length && !shibiReady(G, pi))) return false;
      const stoneDraw = P.mana.some(m => m.faceUp && STONE_DRAW_RE.test(normTxt(cardOf(m).rule_text)));
      const okLock = c => !lockMana(c) || (isPillar(c) ? late : (late && oliveGood(G, pi)));
      const TONKO = /魔力ゾーンのこれを表にして発動できる|これが魔力ゾーンに裏で置かれているなら、これを表にして/;   // 遁甲式：裏で置く
      const manaCards = P.hand.filter(i => cardOf(i).type === 'マリョク' && okLock(cardOf(i)) && !TONKO.test(cardOf(i).rule_text || ''));
      if (late && !manaCards.length && !(shibiReady(G, pi) && P.grave.some(x => cardOf(x).type === 'マリョク' && okLock(cardOf(x))))) return false;   // 最後は表のマリョクだけ
      // 地上の紫微垣「自分のマリョク配置において、表で置く限り、ターンに1回だけ自分の墓地のマリョクも選べる」（戦場か墓地で効果）
      const gm = P.grave.filter(x => cardOf(x).type === 'マリョク' && okLock(cardOf(x)));
      const goodGrave = x => isDrawMana(cardOf(x)) || (stoneDraw && isStone(cardOf(x))) || (isStone(cardOf(x)) && STONE_DRAW_RE.test(normTxt(cardOf(x).rule_text)));
      if ((!manaCards.length || gm.some(goodGrave)) && shibiReady(G, pi) && gm.length && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) {
        const need = handNeedColors(P);
        const sc = i => colorsOf(cardOf(i)).reduce((t, ch) => t + (need[ch] ? 3 + need[ch] : 0), 0) + (cardOf(i).level || 0) + (goodGrave(i) ? 10 : 0) + (STONE_DRAW_RE.test(normTxt(cardOf(i).rule_text)) ? 5 : 0);
        const best = gm.sort((a, b) => sc(b) - sc(a))[0];
        P.grave.splice(P.grave.indexOf(best), 1); P.hand.push(best); if (!shibiUnlimited(G, pi)) P.shibiTurn = G.turn;
        log(G, '　地上の紫微垣の効果：墓地のマリョクを配置します');
        const r = placeMana(G, pi, best.uid, true);
        if (!r.ok) { P.hand.splice(P.hand.indexOf(best), 1); P.grave.push(best); }
        else graveLeft(G, pi);
        return r.ok;
      }
      if (manaCards.length) {
        const need = handNeedColors(P);
        const sc = i => colorsOf(cardOf(i)).reduce((s, ch) => s + (need[ch] ? 3 + need[ch] : 0), 0) + (cardOf(i).level || 0) +
          (isStone(cardOf(i)) && (stoneDraw || STONE_DRAW_RE.test(normTxt(cardOf(i).rule_text))) ? 8 : 0) + (lockMana(cardOf(i)) ? 20 : 0);
        const best = manaCards.slice().sort((a, b) => sc(b) - sc(a))[0];
        return placeMana(G, pi, best.uid, true).ok;
      }
      if (late || !P.hand.length) return false;
      // ピラー／オリーブの枝しかないなら、メインフェイズの最後に表で置く
      if (P.hand.some(i => cardOf(i).type === 'マリョク' && lockMana(cardOf(i)) && isPillar(cardOf(i)))) return false;
      // 手札1枚で、それが今すぐ使えるなら置かない
      if (P.hand.length === 1 && playProblems(G, pi, cardOf(P.hand[0])).length === 0) return false;
      const junk = P.hand.slice().sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b))[0];
      return placeMana(G, pi, junk.uid, false).ok;
    }

    /* ---------- 召喚・ハイケイ・マホウの選び方 ---------- */
    function ijinScore(G, pi, c) {
      const k = parseCard(c), P = G.players[pi];
      const t = normTxt(SR.abilityText(c, 'field') || '');
      let s = cardValue(c) + (k.pressure - 1) * 1500 + (k.haste ? 800 : 0) + (k.watcher ? 400 : 0) + (k.noIjinBlock ? 800 : 0);
      // 置かれたときの効果を見込む
      if (/自分の戦場のガーディアン\d体を山札の上に戻す/.test(t)) s -= P.field.filter(isGuardianInst).length <= 2 ? 4000 : 1000;
      if (/イジン召喚権\+\d/.test(t) && P.hand.filter(x => cardOf(x).type === 'イジン').length >= 2) s += 2500;
      if (/これのパワー以下のパワーを持つ相手の戦場のイジン1体を破壊/.test(t) &&
        G.players[1 - pi].field.some(x => isIjinUp(x) && powerOf(x, G) <= (c.power || 0))) s += 3000;
      if (/ドローする/.test(t)) s += 800;
      // ジャン＝ジャック・ルソー：戦場で最も高いパワーのイジンを破壊（自分のイジンが一番強いなら出さない）
      if (/戦場で最も高いパワーを持つイジン1体を破壊/.test(t)) {
        const mine = Math.max(0, ...P.field.filter(isIjinUp).map(x => powerOf(x, G))), foe = Math.max(0, ...G.players[1 - pi].field.filter(isIjinUp).map(x => powerOf(x, G)));
        s += foe > mine ? 3000 : -6000;
      }
      return s;
    }
    function cpuSummon(G, pi) {
      const P = G.players[pi];
      // ルイス・キャロル「自分がイジン召喚をする際、イジン召喚権でなくマリョク配置権を使ってもよい」：配置権が残っていて、手札にマリョクがないとき
      if (P.summon < 1 && P.manaPlace > 0 && !P.hand.some(x => cardOf(x).type === 'マリョク') &&
        P.field.some(x => x.faceUp && !x.silenced && /自分がイジン召喚をする際、イジン召喚権でなくマリョク配置権を使ってもよい/.test(cardOf(x).rule_text || '')) &&
        P.hand.some(x => cardOf(x).type === 'イジン' && conditionProblems(P, cardOf(x), summonInfo(G, pi, cardOf(x)).auto, G).length === 0)) {
        P.manaPlace -= 1; P.summon += 1; log(G, '　ルイス・キャロル：マリョク配置権をイジン召喚に使います');
      }
      if (P.summon < 1) return false;
      // 葛飾応為「これのイジン召喚に際し、自分の手札のハイケイをすきなだけ墓地に置いてもよい。これのレベルは、墓地に置いた1つにつき1だけ下がる」
      if (!(G.cpuNoEffects && G.cpuNoEffects.has(pi))) P.hand.filter(x => /これのイジン召喚に際し、自分の手札のハイケイをすきなだけ墓地に置いてもよい/.test(cardOf(x).rule_text || '')).slice(0, 1).forEach(x => {
        if (!playProblems(G, pi, cardOf(x)).length) return;
        const k = cardOf(x).level - manaInfo(P).cap - summonInfo(G, pi, cardOf(x)).auto;
        const hs = P.hand.filter(h => cardOf(h).type === 'ハイケイ' && playProblems(G, pi, cardOf(h)).length).sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b));
        if (k > 0 && hs.length >= k && conditionProblems(P, cardOf(x), 99, G).length === 0) {
          log(G, `　${cardOf(x).name}：手札のハイケイ${k}つを墓地に置いて、レベルを${k}下げます`);
          hs.slice(0, k).forEach(h => handToGrave(G, pi, h)); P.oiCut = { turn: G.turn, name: cardOf(x).name, n: k };
        }
      });
      const cands = P.hand.filter(i => cardOf(i).type === 'イジン' && playProblems(G, pi, cardOf(i)).length === 0);
      // 劉備「自分のイジン召喚に際し、自分の戦場のイジンを3体まで寝かせてもよい。寝かせた1体につき、手札のイジンは「レベル-1」される」
      if (!cands.length && P.field.some(x => x.faceUp && !x.silenced && /自分のイジン召喚に際し、自分の戦場のイジンを3体まで寝かせてもよい/.test(cardOf(x).rule_text || '')) && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) {
        const tappable = P.field.filter(x => isIjinUp(x) && !x.tapped).sort((a, b) => (a.placedTurn === G.turn ? 0 : 1) - (b.placedTurn === G.turn ? 0 : 1) || powerOf(a, G) - powerOf(b, G));
        for (const i of P.hand.filter(x => cardOf(x).type === 'イジン').sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))) {
          for (let k = 1; k <= Math.min(3, tappable.length); k++) {
            if (playProblems(G, pi, cardOf(i), k).length === 0) {
              tappable.slice(0, k).forEach(x => { x.tapped = true; });
              log(G, `　劉備の効果：イジン${k}体を寝かせて、${cardOf(i).name}のレベルを${k}下げます`);
              return summon(G, pi, i.uid, k).ok;
            }
          }
        }
      }
      if (!cands.length) return false;
      const best = cands.sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
      return summon(G, pi, best.uid).ok;
    }
    function cpuHaikei(G, pi) {
      const P = G.players[pi];
      const names = new Set(P.field.filter(x => x.faceUp).map(x => cardOf(x).name));
      const scarlet = P.hand.some(x => cardOf(x).name === 'スカーレット');   // スカーレットで壊して引くための燃料
      // 「ハイケイが置かれるたび1ドロー」などで山札が切れないように（戦場の執筆のドローを数える）
      const drawsPerHaikei = G.players.reduce((t, Q) => t + Q.field.filter(x => x.faceUp && /執筆 - [^。]*ドロー/.test(cardOf(x).rule_text || '')).length, 0);
      if (drawsPerHaikei && P.deck.length <= drawsPerHaikei + deckReserve(G, pi) - 1) return false;
      // 置く順番：配置権が増える（巨大古墳）・2つと数える（仁王）・色が増えるハイケイを先に、回収系（茅葺き屋根など）は最後に
      const plan = yochiPlan(G, pi), bfNames = haikeiNames(G);
      const prio = i => { const t = normTxt(cardOf(i).rule_text);
        return (YOCHI_RE.test(t) ? 100 : 0) + (plan && !bfNames.has(cardOf(i).name) ? 25 : 0) +
          (/マリョク配置権\+1/.test(t) ? 30 : 0) + (/2つと数える/.test(t) ? 20 : 0) + (/「色：[^」]+」を得る/.test(t) ? 10 : 0) - (/手札に戻して発動できる/.test(t) ? 40 : 0); };
      const c = P.hand.filter(i => cardOf(i).type === 'ハイケイ' && (scarlet || !names.has(cardOf(i).name)) && playProblems(G, pi, cardOf(i)).length === 0)
        .sort((a, b) => prio(b) - prio(a))[0];
      return c ? useHaikei(G, pi, c.uid).ok : false;
    }
    /* 魔力コストの払い方：裏向き → 色が重複している表向き → レベルの低い表向き の順に墓地へ */
    const isDrawMana = c => c.type === 'マリョク' && /魔力ゾーンに置かれたとき(?:に発動する)?[。、]\s*1ドローする/.test(normTxt(c.rule_text));
    const shibiUnlimited = (G, pi) => !pillarOn(G) && G.players[pi].field.some(x => x.faceUp && !x.silenced && /自分のマリョク配置に際し、表向きで置く限り、自分の墓地のマリョクも選べる/.test(cardOf(x).rule_text || ''));
    const shibiReady = (G, pi) => { const P = G.players[pi]; return shibiUnlimited(G, pi) || (P.shibiTurn !== G.turn && P.field.concat(P.grave).some(x => x.faceUp && /表で置く限り、ターンに1回だけ自分の墓地のマリョクも選べる/.test(cardOf(x).rule_text || ''))); };
    function chooseMahouPay(P, cost, G, pi) {
      const colorCount = {};
      P.mana.filter(m => m.faceUp).forEach(m => colorsOf(cardOf(m)).forEach(ch => { colorCount[ch] = (colorCount[ch] || 0) + 1; }));
      // 紫微垣チャージ：地上の紫微垣で墓地から置き直せるなら、ドローマリョクで払う（置き直してまたドロー）
      const recycle = G && shibiReady(G, pi);
      const sc = m => (recycle && m.faceUp && isDrawMana(cardOf(m)) ? -1 : !m.faceUp ? 0 : 10 + (colorsOf(cardOf(m)).some(ch => colorCount[ch] === 1) ? 20 : 0) + (cardOf(m).level || 0));
      const pool = G && luther(G, pi) ? P.mana.filter(m => m.faceUp) : P.mana;
      return pool.slice().sort((a, b) => sc(a) - sc(b)).slice(0, cost).map(m => m.uid);
    }
    const rikyuOn = (G, pi) => !!fieldSrc(G, pi, /自分はマホウ使用に際し、自分の手札をすきなだけ墓地に置いてもよい。墓地に置いた1枚につき、手札のマホウの魔力コストは1減る/);
    /* 利休ループ（利休エンビー）：千利休の「手札を墓地に置いてマホウのコストを下げる」で、マリョクを使わずにマホウを回す。
       藤原道長（墓地のマホウを手札へ）→ グラトニー（道長を手札へ）→ ドシャカジ（道長を捨ててコスト0、5枚削って墓地の道長を戦場へ）→ … の繰り返しで、
       ソリッドビジョンΩ（裏で魔力ゾーンへ）とチャージで魔力レベルを上げ、レベル9でドシャカジからエイブラハム・リンカンを出す */
    const RIKYU_LOOP = ['ドシャカジ', 'グラトニー', 'ソリッドビジョンΩ', 'チャージ', 'ロイヤリティ', 'エンビー'];
    const RIKYU_KEEP = ['千利休', '藤原道長', 'エイブラハム・リンカン', '精霊の島々'].concat(RIKYU_LOOP);
    // 利休ループで捨ててよいカード（捨てると発動するもの → 部品でないもの → 2枚目以降の部品）
    function rikyuSpares(G, pi, inst, prefer) {
      const P = G.players[pi], others = P.hand.filter(x => x !== inst);
      const toss = (prefer || []).filter(x => others.includes(x));
      const fire = others.filter(x => !toss.includes(x) && discardScore(G, pi, x) >= 90);
      // 手札に2枚目以上ある部品（ドシャカジ・グラトニー・千利休など）や、戦場にすでにある精霊の島々も捨ててよい
      const spare = x => { const k = cardOf(x).name; if (!RIKYU_KEEP.includes(k)) return true; if (['ソリッドビジョンΩ', 'チャージ', 'ロイヤリティ', 'エンビー'].includes(k)) return k !== cardOf(inst).name && others.filter(y => cardOf(y).name === k).indexOf(x) > 0;   // 2枚目以降は捨ててよい
        if ((k === '千利休' || k === '精霊の島々') && P.field.some(y => y.faceUp && cardOf(y).name === k)) return true;
        return others.filter(y => cardOf(y).name === k).indexOf(x) > 0 || (k === cardOf(inst).name); };
      const junk = others.filter(x => !toss.includes(x) && !fire.includes(x) && spare(x))
        .sort((a, b) => (cardOf(a).type === 'マリョク' ? 5 : 0) - (cardOf(b).type === 'マリョク' ? 5 : 0) || cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b));
      return toss.concat(fire, junk);
    }
    function rikyuCast(G, pi, inst, target, prefer, noMana) {
      const P = G.players[pi], c = cardOf(inst), base = c.magic_cost || 0;
      if (conditionProblems(P, c, 0, G).length || pillarMahouBan(G, pi) || P.noMahouTurn === G.turn || P.noHandTurn === G.turn) return false;
      const list = rikyuSpares(G, pi, inst, prefer).slice(0, base);
      const rest = base - list.length;
      if (rest > 0 && (noMana || P.mana.length - rest < 2 || (luther(G, pi) && P.mana.filter(m => m.faceUp).length < rest))) return false;
      if (list.length) { log(G, `　千利休：${c.name}の使用に際し、手札の${list.map(x => cardOf(x).name).join('、')}を墓地に置いて魔力コストを${list.length}減らします`); list.forEach(x => handToGrave(G, pi, x)); }
      P.costCut = { turn: G.turn, name: c.name, n: list.length };
      if (!P.hand.includes(inst)) return true;
      G.cpuTarget = target || {};
      const r = useMahou(G, pi, inst.uid, chooseMahouPay(P, mahouCost(G, pi, c), G, pi));
      G.cpuTarget = null;
      return r.ok;
    }
    // 利休ループのデッキか（藤原道長とドシャカジが入っている）
    const rikyuDeck = (G, pi) => { const P = G.players[pi]; if (P.rikyuDeck === undefined) { const ns = new Set(P.deck.map(id => cardsById[id].name).concat(P.hand.map(x => cardOf(x).name), P.field.map(x => cardOf(x).name), P.grave.map(x => cardOf(x).name), P.mana.map(x => cardOf(x).name))); P.rikyuDeck = ns.has('藤原道長') && ns.has('ドシャカジ') && ns.has('千利休'); } return P.rikyuDeck; };
    function rikyuLoopStep(G, pi) {
      const P = G.players[pi];
      if (!rikyuDeck(G, pi) || !rikyuOn(G, pi) || (G.cpuNoEffects && G.cpuNoEffects.has(pi))) return false;
      const cnt = G.rlTurn === G.turn ? G.rlCnt : 0; if (cnt >= 40) return false; G.rlTurn = G.turn; G.rlCnt = cnt + 1;
      // 精霊の島々（戦場か墓地）があれば、山札が0枚になっても手札を山札に戻せる（相手の手札も墓地へ）ので、山札を掘り切ってよい
      const islands = P.field.concat(P.grave).some(x => x.faceUp && /自分の山札のカードが0枚になったときに戦場か墓地で発動できる/.test(cardOf(x).rule_text || ''));
      const hand = n => P.hand.find(x => cardOf(x).name === n), cap = manaInfo(P).cap, res = islands ? -4 : deckReserve(G, pi);
      const michi = P.field.find(x => x.faceUp && cardOf(x).name === '藤原道長');
      const dosha = hand('ドシャカジ'), glut = hand('グラトニー');
      const top = Math.max(0, ...[0, 1].flatMap(q => G.players[q].field.filter(x => x.faceUp && cardOf(x).type !== 'マリョク').map(x => cardOf(x).level || 0)));
      const lincolnReady = cap >= 9 && P.grave.some(x => cardOf(x).name === 'エイブラハム・リンカン') && !P.field.some(x => x.faceUp && cardOf(x).name === 'エイブラハム・リンカン');
      // 1) レベル9：ドシャカジで墓地のリンカンを出す
      if (dosha && lincolnReady && P.deck.length >= 5 + 1 && rikyuCast(G, pi, dosha, { prefer: ['エイブラハム・リンカン'] })) return true;
      // 2) 魔力レベルを上げる：ソリッドビジョンΩ（1ドローして裏で魔力ゾーンへ）・チャージ（置くカードがあるとき）。コストは手札を捨てて払う
      const om = hand('ソリッドビジョンΩ');
      if (om && cap < 9 && P.deck.length > res + 2 && redOnMine(G, pi, '緑') && rikyuCast(G, pi, om, {}, [], true)) return true;
      const ch = hand('チャージ');
      const chSp = ch && rikyuSpares(G, pi, ch);
      if (ch && cap < 9 && P.manaPlace < 1 && (chSp.length >= 2 || (chSp.length && discardScore(G, pi, chSp[0]) >= 90)) && rikyuCast(G, pi, ch, {}, [], true)) return true;   // 1枚はコスト、1枚は置く用（捨てたエンビーで引くならそれでもよい）   // 1枚はコスト、1枚は置く用
      // 戦場の道長をグラトニーで手札へ（次のドシャカジで捨てて、墓地から出し直す）
      const lincolnInDeck = P.deck.some(id => cardsById[id].name === 'エイブラハム・リンカン');
      const gainNext = (P.grave.some(x => ['ソリッドビジョンΩ', 'チャージ'].includes(cardOf(x).name)) && cap < 9) || lincolnInDeck;   // 道長を出し直して得るものがあるか
      if (michi && glut && dosha && cap >= (cardOf(dosha).level || 5) && gainNext && (cardOf(michi).level || 0) >= top && P.deck.length >= 5 + res && !noBounce(G) &&
        rikyuCast(G, pi, glut, { uid: michi.uid })) return true;
      // 3) 手札の道長を捨ててドシャカジ：墓地の道長を戦場へ（墓地のマホウを回収）
      const mh = hand('藤原道長');
      if (dosha && (mh || P.grave.some(x => cardOf(x).name === '藤原道長')) && !michi && cap >= 5 && P.deck.length >= 5 + res &&
        rikyuCast(G, pi, dosha, { prefer: ['藤原道長'] }, mh ? [mh] : [])) return true;
      // 6) ロイヤリティ：ガーディアンを山札の上に戻して3ドロー
      const ro = hand('ロイヤリティ');
      if (ro && myGuards(G, pi).length >= 2 && P.deck.length > res + 4 && P.hand.length <= 6 && rikyuCast(G, pi, ro, {})) return true;
      return false;
    }
    function cpuMahou(G, pi, timing) {
      const P = G.players[pi];
      for (const i of P.hand.slice()) {
        const c = cardOf(i);
        if (c.type !== 'マホウ' || !P.hand.includes(i)) continue;
        if (rikyuDeck(G, pi) && rikyuOn(G, pi) && ['ソリッドビジョンΩ', 'チャージ', 'ドシャカジ', 'グラトニー'].includes(c.name) && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) continue;   // 利休ループの部品は rikyuLoopStep で（マリョクを使わずに）使う
        // 千利休：捨てると得をするカード（ペリー・払暁の城壁で冥府発動）や、コストが足りない分の不要なカードを墓地に置いて軽くする
        if (rikyuOn(G, pi) && (c.magic_cost || 0) > 0 && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) {
          const h0 = CARD_AI[c.name];
          const useful = h0 && h0.want ? (h0.timing || 'main') === timing && h0.want(G, pi) : timing === 'main' && effectPlan(SR.abilityText(c, 'mahou') || '');
          if (useful) {
            const others = P.hand.filter(x => x !== i), base = c.magic_cost || 0;
            const fire = others.filter(x => discardScore(G, pi, x) >= 90).slice(0, base);
            const short = Math.max(0, base - fire.length - P.mana.length);
            const junk = others.filter(x => !fire.includes(x) && cardUsefulness(G, pi, x) < 6).sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b)).slice(0, short);
            const toss = fire.concat(junk);
            if (toss.length) {
              log(G, `　千利休：${c.name}の使用に際し、手札${toss.length}枚を墓地に置いて魔力コストを${toss.length}減らします`);
              toss.forEach(x => handToGrave(G, pi, x));
              P.costCut = { turn: G.turn, name: c.name, n: toss.length };
            }
          }
        }
        if (playProblems(G, pi, c).length) continue;
        const h = CARD_AI[c.name];
        let target = null;
        if (h && h.want) {
          if ((h.timing || 'main') !== timing) continue;
          target = h.want(G, pi);
          if (!target) continue;
        } else {
          if (timing !== 'main') continue;
          const plan = effectPlan(SR.abilityText(c, 'mahou') || '');
          if (!plan || plan.some(p => p.r.ok && !p.r.ok(G, pi, p.m))) continue;   // 自動処理できない／対象がいない
        }
        const cost = mahouCost(G, pi, c);
        // 魔力ゾーンを払うと、手札のイジンが出せなくなるほど減らさない（詰みを作るアタック直前は気にしない）
        if (timing === 'main' && cost > 0 && P.mana.length - cost < 4 && P.hand.some(x => cardOf(x).type === 'イジン' && cardOf(x).level > manaInfo(P).cap - cost)) continue;
        G.cpuTarget = target;
        const r = useMahou(G, pi, i.uid, chooseMahouPay(P, cost, G, pi));
        G.cpuTarget = null;
        return r.ok;
      }
      return false;
    }

    /* 1手ずつ進める。戻り値: 'continue' | 'await_block' | 'turnEnded' | 'over' | 'idle' */
    // アイザック・ニュートンが自分の戦場にいる：手札を10枚以上ためて勝つ（召喚権は残してエンドフェイズのドローに回す）
    const newtonMode = (G, pi) => G.players[pi].field.some(x => x.faceUp && !x.silenced && /自分のドローフェイズが開始したとき、自分の手札が10枚以上なら発動する。ゲームに勝利する/.test(normTxt(cardOf(x).rule_text)));
    function cpuStep(G) {
      if (G.winner !== null) return 'over';
      const pi = G.current;
      if (!G.aiPlayers.has(pi)) return 'idle';
      if (G.battle) return 'await_block';
      syncSilence(G);
      // 何もしなかった段階は飛ばして、行動が起きたところで1手として返す（画面の演出の間隔をそろえるため）
      for (;;) {
        switch (G.cpuStage) {
          case 'start':   // メインフェイズ開始時の能力（革命の広場など）
            G.cpuStage = 'mana';
            cpuPhaseTriggers(G, pi, 'mainStart');
            break;
          case 'mana':
            G.cpuStage = 'haikei';
            if (newtonMode(G, pi) && G.players[pi].hand.length <= 10) break;   // ニュートン：手札をためる
            if (cpuPlaceMana(G, pi)) {
              // 配置権が残っていて、表で置けるマリョク（手札・地上の紫微垣で墓地）があるなら続けて置く（米百俵・巨大古墳など）
              const P = G.players[pi], cnt = G.mlTurn === G.turn ? G.mlCnt : 0; G.mlTurn = G.turn; G.mlCnt = cnt + 1;
              if (P.manaPlace > 0 && cnt < 40 && faceUpManaSources(G, pi) > 0) G.cpuStage = 'mana';
              return 'continue';
            }
            break;
          case 'haikei':
            // ニュートン：ハイケイを置いても手札が減らない（ハリエットのドローがある）ときだけ置く
            if (newtonMode(G, pi) && G.players[pi].hand.length <= 10 && !G.players[pi].field.some(x => x.faceUp && cardOf(x).name === 'ハリエット・ビーチャー・ストウ')) { G.cpuStage = 'summon'; break; }
            if (cpuHaikei(G, pi)) return 'continue';
            G.cpuStage = 'summon';
            break;
          case 'summon':
            if (newtonMode(G, pi)) { G.cpuStage = 'mahou'; break; }   // ニュートン：召喚権を残してエンドフェイズにドロー
            if (cpuSummon(G, pi)) return 'continue';
            G.cpuStage = 'mahou';
            break;
          case 'mahou':
            if (rikyuLoopStep(G, pi)) { if (G.players[pi].manaPlace > 0) G.cpuStage = 'mana'; return 'continue'; }
            if (cpuMahou(G, pi, 'main')) { if (G.players[pi].manaPlace > 0) G.cpuStage = 'mana'; return 'continue'; }
            G.cpuStage = 'summon2';
            break;
          case 'summon2':   // マホウで召喚権が増えた・ドローした場合にもう一度
            if (!newtonMode(G, pi) && cpuSummon(G, pi)) return 'continue';
            G.cpuStage = 'attack';
            break;
          case 'attack': {
            if (!G.battleUsed && cpuMahou(G, pi, 'preAttack')) return 'continue';   // チャンピオンなど、アタックの直前に使うマホウ
            G.cpuStage = 'post';
            if (G.battleUsed || G.winner !== null) break;
            const { list, why } = cpuChooseAttack(G, pi);
            if (!list.length) break;
            log(G, `${nm(G, pi)}の判断：${why}`);
            if (!declareAttack(G, pi, list.map(x => x.uid)).ok || !G.battle) break;   // 念のため（宣言できなかったら何もしない）
            if (G.aiPlayers.has(1 - pi)) { cpuAutoBlock(G); return G.winner !== null ? 'over' : 'continue'; }
            return 'await_block';
          }
          case 'post':   // バトル後：召喚権が増えていれば（コロンブスの航海など）もう一度召喚
            if (G.extraBattle && G.extraBattle.turn === G.turn && G.extraBattle.n > 0 && G.battleUsed) { G.extraBattle.n--; G.battleUsed = false; G.cpuStage = 'attack'; log(G, `　${nm(G, pi)}：追加でバトルします`); break; }
            if (cpuSummon(G, pi)) return 'continue';
            if (cpuMahou(G, pi, 'post')) { if (G.cpuStage === 'post' && !G.battleUsed) G.cpuStage = 'attack'; return 'continue'; }   // ファイナルアタックで追加のバトル／タイムディレイション
            G.cpuStage = 'after';
            break;
          case 'after':   // メインフェイズの最後：ピラーなど、ロックするマリョクを表で置く
            if (G.players[pi].manaPlace > 0 && !(G.cpuNoEffects && G.cpuNoEffects.has(pi)) && cpuPlaceMana(G, pi, true)) return 'continue';
            G.cpuStage = 'end';
            break;
          default:
            endTurn(G, pi);
            return G.winner !== null ? 'over' : 'turnEnded';
        }
        if (G.winner !== null) return 'over';
      }
    }

    const API = {
      addLog: log, newGame, endTurn, placeMana, summon, useHaikei, useMahou,
      declareAttack, declareBlocks, cpuAutoBlock, cpuStep, cpuChooseBlocks,
      manualNoIjin, manualEquip, manualUnequip, manualState, isIndestructible, annaOnField, eligibleAttackers, eligibleBlockers, requiredBlockers, canBlockAttacker, ijinUnblockable,
      playProblems, summonInfo, manaInfo, parseCard, kwOf, powerOf, attackPowerOf, blockPowerOf, canAct,
      manualMove, manualTap, manualFlip, manualDraw, manualMill, manualRights, manualGuardianFromDeck, manualDestroy, manualPower,
      arenaOn, triggerInfo, resolveAnna, resolvePending,
      effectPlan, cpuChooseAttack, equipCandidates, mulligan
    };
    // 画面からの操作のあとにも「能力すべてを失う」常在能力を付け直す
    Object.keys(API).forEach(k => { const f = API[k]; if (typeof f !== 'function' || k === 'newGame') return; API[k] = function (G) { const r = f.apply(null, arguments); if (G && G.players) syncSilence(G); return r; }; });
    API.syncSilence = syncSilence;
    return API;
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IjindenEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
