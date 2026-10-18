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
    const kwOf = inst => (inst.faceUp && !inst.silenced ? parseCard(cardOf(inst)) : NEUTRAL_KW);   // 裏向き・能力禁止中は能力を持たない   // 裏向き（ガーディアン）は能力を持たない
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
    const powerOf = (inst, G) => basePower(cardOf(inst)) + kwOf(inst).power + auraPower(G, inst) + (inst.powerMod || 0);
    const attackPowerOf = (inst, G) => (inst.faceUp ? powerOf(inst, G) + kwOf(inst).attack : ARENA_POWER);
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
      const auto = onlyText ? false
        : kind === 'mana' ? autoManaFromDeck(G, pi, card, text)
        : staticOnly(card, text);   // 常在能力（パワー補正）やハイケイのレベル条件だけなら、エンジンが自動で計算している
      const autoCpu = !auto && G.aiPlayers.has(pi) && cpuResolve(G, pi, card, text, { inst, kind });   // CPUのカード効果（読める書式・対応済みカードだけ）
      G.fx.push({ type: 'ability', pi, kind, cardId: card.id, name: card.name, text, uid: inst ? inst.uid : null, auto: auto || autoCpu });
      if (!auto && !autoCpu) log(G, `　${card.name}の能力：${text.replace(/\n/g, ' ')}（自動処理されません）`);
    };
    // エンジンがルールとして自動で処理している文（どちらのプレイヤーでも）
    const ENFORCED = [
      /^自分のスタートフェイズが終了したとき、マリョク配置権\+1する$/,                                  // 巨大古墳
      /^バトル解決に際し、自分の戦場のガーディアンがブロッカーに含まれているなら、パワー\d+以下のアタッカーは破壊される$/,   // 魔除けの社
      /^自分のターンの間、自分の戦場のガーディアンは「即応」を持つパワー3000のイジンでもある$/,             // 円形闘技場
      /^この能力は戦場で発揮する$/, /^自分の戦場のハイケイは破壊されない$/,                                // 行基
    ];
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
      log(G, `　${card.name}の能力（自動処理）：山札の上から${k}枚を裏のまま魔力ゾーンに置きました（山札残り${P.deck.length}枚）` + (k < n ? '　※山札が足りません' : ''));
      return true;
    };
    /* 「破壊されない」：手動で付けたもの（このターン / 解除するまで）と、「「音楽」イジンが自分の戦場にいる間「破壊されない」を得る」型の常在能力 */
    function isIndestructible(G, inst) {
      if (inst.indestructible) return true;
      if (!inst.faceUp || inst.silenced || !G) return false;
      const pi = G.players.findIndex(P => P.field.includes(inst));
      if (pi < 0) return false;
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
        log(G, `　装備していたカード（${cardOf(e).name}）が${{ mana: '魔力ゾーン', grave: '墓地', hand: '手札' }[o.zone]}に戻りました`);
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
    function newGame(deckDef0, deckDef1, firstIdx, aiPlayers) {
      const G = {
        players: [newPlayer(deckDef0), newPlayer(deckDef1)],
        names: ['あなた', 'CPU'],
        turn: 1, current: firstIdx, firstIdx,
        phase: 'start', battle: null, battleUsed: false,
        winner: null, winReason: '', log: [],
        aiPlayers: new Set(aiPlayers || [1]), cpuStage: null, fx: [], triggers: []
      };
      log(G, `対戦開始（${nm(G, firstIdx)}の先攻）。手札6枚・ガーディアン4枚を準備しました`);
      beginTurn(G);
      return G;
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
      P.field.forEach(c => { c.tapped = false; });
      // 「自分のスタートフェイズが終了したとき、マリョク配置権+1する」（巨大古墳）
      P.field.filter(x => x.faceUp && !x.silenced && /自分のスタートフェイズが終了したとき、マリョク配置権\+1する/.test(cardOf(x).rule_text || '')).forEach(x => {
        P.manaPlace += 1; log(G, `　${cardOf(x).name}の効果：マリョク配置権+1（自動処理）`);
      });
      G.players.forEach(Q => Q.field.forEach(c => { c.powerMod = 0; c.noIjin = false; if (c.silenced === 'turn') c.silenced = false; if (c.indestructible === 'turn') c.indestructible = false; }));   // 手動で足した「このターン限り」のパワー補正を戻す
      G.phase = 'draw';
      if (G.turn === 1) {
        log(G, '先攻の最初のターンのためドローしません');
      } else {
        P.hand.push(mkInst(P.deck.pop()));
        G.fx.push({ type: 'draw', pi, n: 1, turn: true });
        log(G, `${nm(G, pi)}は1枚ドロー（山札残り${P.deck.length}枚）`);
      }
      G.phase = 'main';
      G.battleUsed = false;
      G.battle = null;
      G.cpuStage = G.aiPlayers.has(pi) ? 'start' : null;
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

    function endTurn(G, pi) {
      if (pi !== undefined && G.current !== pi) return fail('あなたのターンではありません');
      if (!canAct(G, G.current)) return fail('今はターンを終了できません');
      const P = G.players[G.current];
      log(G, `${nm(G, G.current)}：エンドフェイズ（未使用の配置権・召喚権は消滅）`);
      cpuPhaseTriggers(G, G.current, 'endPhase');
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
          if (/自分の墓地の色すべてを得る/.test(c.rule_text || '')) graveColors = true;   // カルドロン・プリズム
        } else down += 1;
      });
      if (graveColors) (P.grave || []).forEach(g => colorsOf(cardsById[g.cardId]).forEach(ch => colors.add(ch)));
      return { cap: sum + down, colors, faceUpSum: sum, faceDown: down };
    }

    /* 色条件: カードの持つ色すべてが、表向きマリョクの色にあること（複数色カードの扱いはここで調整できます） */
    /* 「これのハイケイ使用に際し、自分の戦場に「剣術」イジンがいれば、これはレベル1になる」（連なる天守閣など） */
    function haikeiLevel(P, card) {
      const m = normTxt(card.rule_text).match(/これのハイケイ使用に際し、自分の戦場に「([^」]+)」イジンがいれば、これはレベル(\d+)になる/);
      if (!m) return null;
      return P.field.some(x => x.faceUp && !x.silenced && cardOf(x).type === 'イジン' && hasTrait(cardOf(x), m[1])) ? Number(m[2]) : null;
    }
    function conditionProblems(P, card, red) {
      const { cap, colors } = manaInfo(P);
      const hl = card.type === 'ハイケイ' ? haikeiLevel(P, card) : null;
      const lv = hl !== null ? Math.min(hl, card.level) : SR.effectiveLevel(card.level, red);
      const p = [];
      if (lv > cap) p.push(red ? `レベル条件（Lv${card.level}→軽減後${lv} > 上限${cap}）` : `レベル条件（Lv${card.level} > 上限${cap}）`);
      const lack = colorsOf(card).filter(ch => !colors.has(ch));
      if (lack.length) p.push(`色条件（${lack.join('')}が不足）`);
      return p;
    }

    /* イジン召喚時のレベル軽減（サークル系などを自動で拾う）。extra は画面で手動入力した追加の軽減 */
    function summonInfo(G, pi, card) {
      const P = G.players[pi];
      const a = card.type === 'イジン' ? SR.analyze(card, P.mana, P.field, cardsById) : { auto: 0, parts: [], hints: [], flips: [] };
      // 「これのイジン召喚に際し、自分の戦場にイジンがいなければ、これはレベルNになる」（鴨長明）
      const m = card.type === 'イジン' && normTxt(card.rule_text).match(/これのイジン召喚に際し、自分の戦場にイジンがいなければ、これはレベル(\d+)になる/);
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
      const p = conditionProblems(P, card, red);
      if (card.type === 'イジン' && P.summon < 1) p.push('イジン召喚権なし');
      if (card.type === 'マホウ') {
        const cost = card.magic_cost || 0;
        if (P.mana.length < cost) p.push(`魔力コスト不足（${P.mana.length}/${cost}枚）`);
      }
      return p;
    }

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
      const inst = P.hand.find(x => x.uid === uid);
      if (!inst) return fail('手札にありません');
      const card = cardOf(inst);
      if (faceUp && card.type !== 'マリョク') return fail('表向きで置けるのはマリョクだけです');
      takeFromHand(P, uid);
      P.manaPlace -= 1;
      inst.faceUp = !!faceUp; inst.tapped = false;
      P.mana.push(inst);
      log(G, `${nm(G, pi)}：${cardLabel(G, pi, card, faceUp)}を${faceUp ? '表' : '裏'}向きでマリョク配置`);
      if (faceUp) abilityFx(G, pi, card, 'mana', inst);
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
      abilityFx(G, pi, card, 'field', inst);
      // 「イジンが自分の戦場に置かれたとき、これを裏にする」（サークル系）を自動で処理
      info.flips.forEach(f => {
        const m = P.mana.find(x => x.uid === f.uid);
        if (m && m.faceUp) { m.faceUp = false; log(G, `　${f.name}は裏向きになりました`); }
      });
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
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.placedTurn = G.turn;
      P.field.push(inst);
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
      const cost = card.magic_cost || 0;
      const pay = payUids || [];
      if (new Set(pay).size !== cost || !pay.every(u => P.mana.some(m => m.uid === u))) return fail(`魔力ゾーンからちょうど${cost}枚を選んでください`);
      takeFromHand(P, uid);
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
      return G.players[pi].field.filter(x =>
        (x.faceUp && cardOf(x).type === 'イジン' && !x.tapped &&
          (x.placedTurn < G.turn || kwOf(x).haste || x.hasteTurn === G.turn)) ||
        (arena && isGuardianInst(x) && !x.tapped));   // 円形闘技場：ガーディアンも（即応で）アタッカーになれる
    }
    function eligibleBlockers(G, pi) {
      return G.players[pi].field.filter(x =>
        (!x.faceUp && !x.tapped) ||
        (x.faceUp && cardOf(x).type === 'イジン' && !kwOf(x).cantBlock && (!x.tapped || kwOf(x).watcher)));
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
      // 「パワー5000以上の間「ダブルプレッシャー」を得る」（武帝など）：現在のパワーで判定する
      if (G && inst.faceUp && !inst.silenced) {
        const m = normTxt(cardOf(inst).rule_text).match(/パワー(\d+)以上の間「(ダブル|トリプル|クアドラプル)プレッシャー」を得る/);
        if (m && powerOf(inst, G) >= Number(m[1])) need = Math.max(need, PRESSURE[m[2] + 'プレッシャー']);
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
      G.battle = { attackers: uids.slice(), blocks: {} };
      G.battleUsed = true;
      const label = i => (i.faceUp ? cardOf(i).name : 'ガーディアン');
      log(G, `${nm(G, pi)}：バトル宣言！ アタッカー → ${insts.map(i => `${label(i)}(${attackPowerOf(i, G)})`).join('、')}`);
      G.fx.push({ type: 'attack', pi, names: insts.map(label) });
      // 「アタッカーになったとき」の能力（航海など）を演出・手動処理の対象にする
      insts.filter(i => i.faceUp).forEach(i => {
        const c = cardOf(i);
        const lines = String(c.rule_text || '').split(/\n+/).map(l => l.trim()).filter(l => /アタッカーになったとき/.test(l) && !/相手の戦場の[^、]*がアタッカーになったとき/.test(l));   // 「相手の〜がアタッカーになったとき」は自分のアタックでは発動しない
        if (lines.length) abilityFx(G, pi, c, 'attack', i, lines.join('\n'));
      });
      if (insts.some(i => !i.faceUp)) { log(G, '　円形闘技場の効果：ガーディアンがパワー3000のアタッカーになりました'); guardianTapped(G); }
      cpuOnAttack(G, pi, insts);
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
      // ブロッカーになったときの能力（CPU：フェルセンの1ドローなど）
      keys.forEach(k => { const b = G.players[defIdx].field.find(x => x.uid === Number(k)); if (b && b.faceUp) cpuTrigger(G, defIdx, b, /ブロッカーになったとき/, 'block'); });
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
        else if (kwOf(att).mortal) { winnerReason = `${cardOf(att).name}（モータル）がバトルに勝利`; break; }
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
          if (wasUp) onDestroyed(G, pi, inst);
          items.push({ name: c.name, cardId: c.id });
          if (hasLegacy(c)) legacyFx.push({ type: 'legacy', pi, uid: inst.uid, name: c.name, cardId: c.id, text: String(c.legacy_ability).trim() });
        });
        return items;
      };
      const dA = toGrave(A, destroyedA, atkIdx);
      const dD = toGrave(D, destroyedD, defIdx);
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
      G.battle = null;
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
      if (isIndestructible(G, P.field[i])) return fail(`${cardOf(P.field[i]).name}は「破壊されない」状態です（解除してから破壊してください）`);
      const inst = P.field.splice(i, 1)[0], c = cardOf(inst), wasUp = inst.faceUp;
      releaseEquips(G, pi, inst);
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.silenced = false; inst.indestructible = false;
      P.grave.push(inst);
      log(G, `${by ? '　' + by + '：' : '【手動】'}${nm(G, pi)}の${c.name}を破壊して墓地へ` + (hasLegacy(c) ? '　※遺業能力あり' : ''));
      if (wasUp) onDestroyed(G, pi, inst);
      G.fx.push({ type: 'destroy', pi, manual: true, items: [{ name: c.name, cardId: c.id }] });
      if (hasLegacy(c) && !(G.aiPlayers.has(pi) && cpuLegacy(G, pi, inst.uid))) G.fx.push({ type: 'legacy', pi, uid: inst.uid, name: c.name, cardId: c.id, text: String(c.legacy_ability).trim() });
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
      let k = 0;
      for (let i = 0; i < n && P.deck.length; i++) { P.hand.push(mkInst(P.deck.pop())); k++; }
      if (k > 0) G.fx.push({ type: 'draw', pi, n: k });
      log(G, `${by ? '　' + by + '：' : '【手動】'}${nm(G, pi)}が${k}枚ドロー（山札残り${P.deck.length}枚）`);
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
      const src = ['mana', 'grave', 'hand'].includes(fromZone) ? zoneArr(P, fromZone) : null;
      if (!src) return fail('この場所のカードは装備に使えません');
      const i = src.findIndex(x => x.uid === equipUid);
      const host = P.field.find(x => x.uid === hostUid);
      if (i < 0 || !host) return fail('カードが見つかりません');
      if (!host.faceUp || cardOf(host).type !== 'イジン') return fail('装備できるのは戦場の表向きのイジンだけです');
      const e = src.splice(i, 1)[0];
      e.origin = { zone: fromZone, faceUp: e.faceUp };
      e.faceUp = true;
      (host.equips = host.equips || []).push(e);
      log(G, `【手動】${nm(G, pi)}の${cardOf(host).name}に${cardOf(e).name}を装備させました（元の場所：${{ mana: '魔力ゾーン', grave: '墓地', hand: '手札' }[fromZone]}）`);
      const m = String(cardOf(e).rule_text || '').match(/装備\s*[:：]([\s\S]*)$/);   // 「装備：」以降の文（アシスト用）
      const body = m ? m[1].replace(/\s+/g, ' ').trim() : '';
      if (body && !body.split(/\s+/).every(t => KW_RE.test(t) || /^特性[:：]/.test(t) || /^「?特性[:：]/.test(t))) abilityFx(G, pi, cardOf(e), 'equip', host, `装備「${cardOf(e).name}」：${body}`);
      return { ok: true };
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
        (isIjinUp(x) && !kwOf(x).cantBlock && (!S.includes(x) || kwOf(x).watcher)));
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
        const keep = S.filter(x => !kwOf(x).watcher).sort((a, b) => (b.faceUp ? 1 : 0) - (a.faceUp ? 1 : 0) || blockPowerOf(b, G) - blockPowerOf(a, G))[0] || S[S.length - 1];
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
      const defIdx = 1 - G.current;
      return declareBlocks(G, defIdx, cpuChooseBlocks(G, defIdx));
    }

    /* ---------- CPUの効果で使う小さな処理 ---------- */
    function bounce(G, q, inst, by) {   // 戦場のイジンを持ち主の手札に戻す
      const P = G.players[q]; const i = P.field.indexOf(inst); if (i < 0) return;
      P.field.splice(i, 1); releaseEquips(G, q, inst);
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.silenced = false; inst.indestructible = false;
      P.hand.push(inst);
      log(G, `　${by}：${nm(G, q)}の${cardOf(inst).name}を手札に戻しました`);
    }
    function placeToField(G, pi, inst, by) {   // 効果でイジン・ハイケイを戦場に置く（置かれたときの能力も処理する）
      const P = G.players[pi], c = cardOf(inst);
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.placedTurn = G.turn;
      P.field.push(inst);
      log(G, `　${by}：${nm(G, pi)}の${c.name}を戦場に置きました`);
      if (c.type === 'イジン') { enterTapped(G, pi, inst); onIjinPlaced(G, pi, inst); }
      abilityFx(G, pi, c, 'field', inst);
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
      if (G.aiPlayers.has(1 - pi) && insts.some(a => a.faceUp && (kwOf(a).haste || a.hasteTurn === G.turn))) {
        D.field.filter(x => x.faceUp && !x.silenced && x.tapped && /相手の戦場の「即応」を持つイジンがアタッカーになったとき、これを起こす/.test(cardOf(x).rule_text || '')).forEach(x => {
          x.tapped = false; log(G, `　${cardOf(x).name}の効果：起きました`);
        });
      }
    }
    // CPUのメインフェイズ開始時・エンドフェイズ開始時の能力
    function cpuPhaseTriggers(G, pi, which) {
      if (!G.aiPlayers.has(pi)) return;
      const P = G.players[pi];
      const re = which === 'mainStart' ? /メインフェイズが開始したとき/ : /自分のエンドフェイズが開始したとき/;
      P.field.slice().forEach(x => {
        if (which === 'endPhase' && /これが寝ているなら発動する。?これを破壊する/.test(normTxt(cardOf(x).rule_text))) return;   // 織田信長はエンジンが処理
        if (re.test(cardOf(x).rule_text || '')) cpuTrigger(G, pi, x, re, which);
      });
      if (which === 'endPhase') P.mana.filter(x => x.faceUp).slice().forEach(x => { if (re.test(cardOf(x).rule_text || '')) cpuTrigger(G, pi, x, re, which); });
    }

    /* ---------- カードごとの処理（書式だけでは決められない「どれを選ぶか」「いつ使うか」があるもの） ----------
       want(G, pi): 使う価値があれば対象（ctx.target）を返す。timing: 'main'（メイン）| 'preAttack'（アタック宣言の直前）
       resolve(G, pi, ctx): 効果を処理する（ctx.target は want が返したもの） */
    const notIndestructible = G => x => !isIndestructible(G, x);
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
      '清少納言': {   // 戦場に置かれたとき：自分のマリョクと同じ色の相手のイジンを裏にして（持ち主の）魔力ゾーンへ。執筆は使わない
        resolve(G, pi, ctx) {
          if (ctx.kind === 'shippitsu') return 'declined';
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
          if (G.battleUsed || G.current === pi) return 'declined';
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
          const ms = P.grave.filter(x => cardOf(x).type === 'マホウ').sort((a, b) => (CARD_AI[cardOf(b).name] ? 1 : 0) - (CARD_AI[cardOf(a).name] ? 1 : 0)).slice(0, n);
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
      'フール': {   // 墓地のマホウのレベル合計が1以上なら手札の他のカード1つを墓地へ、そうでなければ1ドロー
        resolve(G, pi, ctx) {
          if (ctx.kind !== 'field') return false;
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
          if (ctx.kind === 'mana') return;   // 置いただけでは何も起きない（装備は使わない）
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
      '遁甲式水鏡': { resolve(G, pi, ctx) { return ctx.kind === 'field' ? undefined : false; } },      // 魔力ゾーンで裏向きのときの能力なので、戦場では何もしない
      'アイスソード': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? 'declined' : false; } },    // 装備は使わない
    };

    /* CPUの遺業能力（戦場から墓地に置かれたとき）。読めるものだけ処理して true を返す */
    function cpuLegacy(G, pi, uid) {
      if (G.cpuNoEffects && G.cpuNoEffects.has(pi)) return false;
      const P = G.players[pi], inst = P.grave.find(x => x.uid === uid);
      if (!inst) return true;   // すでに墓地を離れている（他の効果で動いた）ので、何もしない
      const c = cardOf(inst), t = normTxt(c.legacy_ability);
      const take = () => { P.grave.splice(P.grave.indexOf(inst), 1); inst.tapped = false; inst.isGuardian = false; };
      let what = '', m;
      if (/魔力化/.test(t)) { take(); inst.faceUp = false; P.mana.push(inst); what = '魔力化（魔力ゾーンに裏向きで置く）'; }
      else if (/復元/.test(t)) { take(); inst.faceUp = true; P.mana.push(inst); what = '復元（魔力ゾーンに表向きで置く）'; }
      else if ((m = t.match(/([1-3])ドローする/))) { manualDraw(G, pi, Number(m[1]), '遺業能力'); what = `${m[1]}ドロー`; }
      else if (/これを手札に戻す/.test(t)) { take(); inst.faceUp = true; P.hand.push(inst); what = '手札に戻す'; }
      else if (/これを山札の上か下に戻す/.test(t)) { take(); P.deck.push(inst.cardId); what = '山札の上に戻す'; }
      else if (/喪神/.test(t)) { what = '喪神（バトルは終わっているので効果なし）'; }
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
      if (/復元/.test(t)) abilityFx(G, pi, c, 'mana', inst);   // 表向きで魔力ゾーンに置かれたときの能力
      return true;
    }

    /* ---------- カード効果の自動処理（CPU用）。文を「。」で区切り、すべての文が既知の書式なら処理する ----------
       run が false を返したら（「〜なら発動する」の条件を満たさない等）、その後の文は処理しない */
    const myGuards = (G, pi) => G.players[pi].field.filter(isGuardianInst);
    const takeGuardian = (G, pi) => myGuards(G, pi).sort((a, b) => (a.tapped ? 0 : 1) - (b.tapped ? 0 : 1))[0];   // 寝ているガーディアンから使う
    function discardLowest(G, pi, n, by) {
      const P = G.players[pi], names = [];
      for (let k = 0; k < n && P.hand.length; k++) {
        const x = P.hand.slice().sort((a, b) => cardUsefulness(G, pi, a) - cardUsefulness(G, pi, b))[0];
        P.hand.splice(P.hand.indexOf(x), 1); x.faceUp = true; P.grave.push(x); names.push(cardOf(x).name);
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
      const P = G.players[pi]; let k = 0;
      for (; k < n && P.deck.length; k++) P.grave.push(mkInst(P.deck.pop()));
      log(G, `　${by || '効果'}：${nm(G, pi)}の山札の上から${k}枚を墓地に置きました（山札残り${P.deck.length}枚）`);
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
      { re: /^イジン召喚権\+([1-3])する$/, run: (G, pi, m) => { G.players[pi].summon += Number(m[1]); log(G, `　効果：${nm(G, pi)}のイジン召喚権+${m[1]}`); } },
      { re: /^マリョク配置権\+([1-3])する$/, run: (G, pi, m) => { G.players[pi].manaPlace += Number(m[1]); log(G, `　効果：${nm(G, pi)}のマリョク配置権+${m[1]}`); } },
      { re: /^([1-3])ドローして、イジン召喚権\+([1-3])する$/, run: (G, pi, m) => { manualDraw(G, pi, Number(m[1]), '効果'); G.players[pi].summon += Number(m[2]); log(G, `　効果：${nm(G, pi)}のイジン召喚権+${m[2]}`); } },
      { re: /^([1-3])ドローして、自分の手札([1-3])枚を墓地に置く$/, run: (G, pi, m) => { manualDraw(G, pi, Number(m[1]), '効果'); discardLowest(G, pi, Number(m[2])); } },
      { re: /^自分はイジン召喚権\+([1-3])して、自分の戦場のハイケイ1つにつき1ドローする$/, run: (G, pi, m) => {
        G.players[pi].summon += Number(m[1]); log(G, `　効果：${nm(G, pi)}のイジン召喚権+${m[1]}`);
        const n = G.players[pi].field.filter(x => x.faceUp && cardOf(x).type === 'ハイケイ').length; if (n) manualDraw(G, pi, n, '効果'); } },
      // 山札・墓地・手札
      { re: /^自分の山札の上から(?:カード)?([1-3１-３一二三])(?:枚|つ)を、?裏のまま魔力ゾーンに置く$/, run: (G, pi, m) => {
        const P = G.players[pi]; for (let k = 0; k < KNUM[m[1]] && P.deck.length; k++) P.mana.push(mkInst(P.deck.pop(), { faceUp: false }));
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
    const TRIG_PREFIX = /^(?:[^\s、。-]{1,6} - )?(?:この能力は、?)?(?:これが)?(?:マリョク配置によって)?(?:(?:魔力ゾーン|戦場)に置かれた|アタッカーになった|ブロッカーになった|破壊された)とき(?:に発動する)?、|^(?:[^\s、。-]{1,6} - )?(?:ハイケイが戦場に置かれる(?:たび|とき)|相手の戦場のイジンが破壊されるたび|ガーディアンが自分の戦場に置かれるたび)、/;
    const TRIG_ONLY = /^(?:この能力は、?)?(?:これが)?(?:マリョク配置によって)?(?:魔力ゾーン|戦場)に置かれたときに発動する$/;   // 「この能力は、これが〜に置かれたときに発動する。」だけの文
    const effectSentences = text => normTxt(text).replace(/（[^）]*）/g, '').split(/[。\n]+/).map(s => s.trim().replace(TRIG_PREFIX, '')).filter(s => s && !TRIG_ONLY.test(s));
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
      ctx = Object.assign({ target: G.cpuTarget }, ctx || {});
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
    function onDestroyed(G, pi, inst) {
      if (cardOf(inst).type === 'イジン') G.players[1 - pi].field.forEach(x => cpuTrigger(G, 1 - pi, x, /相手の戦場のイジンが破壊されるたび/, 'oppDestroyed'));
      if (G.aiPlayers.has(pi) && /破壊されたとき/.test(cardOf(inst).rule_text || '')) cpuTrigger(G, pi, inst, /破壊されたとき/, 'destroyed');
    }
    // ガーディアンが自分の戦場に置かれるたび（孔子）
    function onGuardianPlaced(G, pi) {
      G.players[pi].field.forEach(x => {
        if (!G.aiPlayers.has(pi) || !x.faceUp || x.silenced || !/ガーディアンが自分の戦場に置かれるたび、相手の戦場のガーディアン1体を寝かせる/.test(cardOf(x).rule_text || '')) return;
        const g = G.players[1 - pi].field.find(y => isGuardianInst(y) && !y.tapped);
        if (g) { g.tapped = true; log(G, `　${cardOf(x).name}の効果：相手のガーディアン1体を寝かせました`); guardianTapped(G); }
        G.fx.push({ type: 'ability', pi, kind: 'guardian', cardId: x.cardId, name: cardOf(x).name, text: '相手のガーディアン1体を寝かせる', uid: x.uid, auto: true });
      });
    }
    // ハイケイが戦場に置かれたとき（執筆）。裴松之がいる間は、他のカードの「執筆」は発動しない
    function onHaikeiPlaced(G, byPi, inst) {
      const peiOn = G.players.some(P => P.field.some(x => x.faceUp && !x.silenced && /他のカードの「執筆」は発動しない/.test(cardOf(x).rule_text || '')));
      [0, 1].forEach(q => G.players[q].field.slice().forEach(x => {
        if (!x.faceUp || !/執筆 - /.test(cardOf(x).rule_text || '')) return;
        if (peiOn && !/他のカードの「執筆」は発動しない/.test(cardOf(x).rule_text || '')) return;
        cpuTrigger(G, q, x, /執筆 - /, 'shippitsu');
      }));
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
      if (c.type === 'イジン') return (c.level <= cap + 2 ? 10 : 4) + (c.power || 0) / 2000 + dup;
      if (c.type === 'ハイケイ') return 7 + dup;
      if (c.type === 'マホウ') return (effectPlan(SR.abilityText(c, 'mahou') || '') ? 6 : 1) + dup;
      return 5;
    }
    function cpuPlaceMana(G, pi) {
      const P = G.players[pi];
      if (P.manaPlace < 1 || !P.hand.length) return false;
      const manaCards = P.hand.filter(i => cardOf(i).type === 'マリョク');
      if (manaCards.length) {
        const need = handNeedColors(P);
        const sc = i => colorsOf(cardOf(i)).reduce((s, ch) => s + (need[ch] ? 3 + need[ch] : 0), 0) + (cardOf(i).level || 0);
        const best = manaCards.slice().sort((a, b) => sc(b) - sc(a))[0];
        return placeMana(G, pi, best.uid, true).ok;
      }
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
      return s;
    }
    function cpuSummon(G, pi) {
      const P = G.players[pi];
      if (P.summon < 1) return false;
      const cands = P.hand.filter(i => cardOf(i).type === 'イジン' && playProblems(G, pi, cardOf(i)).length === 0);
      if (!cands.length) return false;
      const best = cands.sort((a, b) => ijinScore(G, pi, cardOf(b)) - ijinScore(G, pi, cardOf(a)))[0];
      return summon(G, pi, best.uid).ok;
    }
    function cpuHaikei(G, pi) {
      const P = G.players[pi];
      const names = new Set(P.field.filter(x => x.faceUp).map(x => cardOf(x).name));
      const c = P.hand.find(i => cardOf(i).type === 'ハイケイ' && !names.has(cardOf(i).name) && playProblems(G, pi, cardOf(i)).length === 0);
      return c ? useHaikei(G, pi, c.uid).ok : false;
    }
    /* 魔力コストの払い方：裏向き → 色が重複している表向き → レベルの低い表向き の順に墓地へ */
    function chooseMahouPay(P, cost) {
      const colorCount = {};
      P.mana.filter(m => m.faceUp).forEach(m => colorsOf(cardOf(m)).forEach(ch => { colorCount[ch] = (colorCount[ch] || 0) + 1; }));
      const sc = m => (!m.faceUp ? 0 : 10 + (colorsOf(cardOf(m)).some(ch => colorCount[ch] === 1) ? 20 : 0) + (cardOf(m).level || 0));
      return P.mana.slice().sort((a, b) => sc(a) - sc(b)).slice(0, cost).map(m => m.uid);
    }
    function cpuMahou(G, pi, timing) {
      const P = G.players[pi];
      for (const i of P.hand) {
        const c = cardOf(i);
        if (c.type !== 'マホウ' || playProblems(G, pi, c).length) continue;
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
        const cost = c.magic_cost || 0;
        // 魔力ゾーンを払うと、手札のイジンが出せなくなるほど減らさない（詰みを作るアタック直前は気にしない）
        if (timing === 'main' && cost > 0 && P.mana.length - cost < 4 && P.hand.some(x => cardOf(x).type === 'イジン' && cardOf(x).level > manaInfo(P).cap - cost)) continue;
        G.cpuTarget = target;
        const r = useMahou(G, pi, i.uid, chooseMahouPay(P, cost));
        G.cpuTarget = null;
        return r.ok;
      }
      return false;
    }

    /* 1手ずつ進める。戻り値: 'continue' | 'await_block' | 'turnEnded' | 'over' | 'idle' */
    function cpuStep(G) {
      if (G.winner !== null) return 'over';
      const pi = G.current;
      if (!G.aiPlayers.has(pi)) return 'idle';
      if (G.battle) return 'await_block';
      // 何もしなかった段階は飛ばして、行動が起きたところで1手として返す（画面の演出の間隔をそろえるため）
      for (;;) {
        switch (G.cpuStage) {
          case 'start':   // メインフェイズ開始時の能力（革命の広場など）
            G.cpuStage = 'mana';
            cpuPhaseTriggers(G, pi, 'mainStart');
            break;
          case 'mana':
            G.cpuStage = 'haikei';
            if (cpuPlaceMana(G, pi)) return 'continue';
            break;
          case 'haikei':
            if (cpuHaikei(G, pi)) return 'continue';
            G.cpuStage = 'summon';
            break;
          case 'summon':
            if (cpuSummon(G, pi)) return 'continue';
            G.cpuStage = 'mahou';
            break;
          case 'mahou':
            if (cpuMahou(G, pi, 'main')) return 'continue';
            G.cpuStage = 'summon2';
            break;
          case 'summon2':   // マホウで召喚権が増えた・ドローした場合にもう一度
            if (cpuSummon(G, pi)) return 'continue';
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
            if (cpuSummon(G, pi)) return 'continue';
            G.cpuStage = 'after';
            break;
          default:
            endTurn(G, pi);
            return G.winner !== null ? 'over' : 'turnEnded';
        }
        if (G.winner !== null) return 'over';
      }
    }

    return {
      addLog: log, newGame, endTurn, placeMana, summon, useHaikei, useMahou,
      declareAttack, declareBlocks, cpuAutoBlock, cpuStep, cpuChooseBlocks,
      manualNoIjin, manualEquip, manualUnequip, manualState, isIndestructible, annaOnField, eligibleAttackers, eligibleBlockers, requiredBlockers, canBlockAttacker, ijinUnblockable,
      playProblems, summonInfo, manaInfo, parseCard, kwOf, powerOf, attackPowerOf, blockPowerOf, canAct,
      manualMove, manualTap, manualFlip, manualDraw, manualMill, manualRights, manualGuardianFromDeck, manualDestroy, manualPower,
      arenaOn, triggerInfo, resolveAnna, resolvePending,
      effectPlan, cpuChooseAttack
    };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IjindenEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
