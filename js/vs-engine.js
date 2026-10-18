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
    /* 書式が特殊な常在能力（第2弾）：姜維「自分の戦場の他の黄のイジンは「即応 ウォッチャー パワー+3000」を得る」、
       ピョートル大帝「「航海」を持つイジンが自分の戦場にいる間「パワー+3000」」、仁王「イジンがちょうど2体いる間、ウォッチャー」 */
    const ownerOf = (G, inst) => (G ? G.players.findIndex(P => P.field.includes(inst)) : -1);
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
      const pt = normTxt(cardOf(inst).rule_text).match(/「航海」を持つイジンが自分の戦場にいる間「パワー\+(\d+)」を得る/);
      if (pt && !inst.silenced && F.some(x => x.faceUp && /航海 - /.test(cardOf(x).rule_text || ''))) out.power += Number(pt[1]);
      return out;
    }
    // イジンの色（英傑集う大河「自分の戦場の黄のイジンは「色：赤 青 緑」を得る」、曹丕の執筆「このターン「色：黄」」も含む）
    function ijinHasColor(G, inst, ch) {
      const c = cardOf(inst);
      if (String(c.color || '').includes(ch)) return true;
      if (!G) return false;
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
      return G.players[o].field.reduce((t, src) => {
        if (src === inst || !src.faceUp || src.silenced) return t;
        const m = normTxt(cardOf(src).rule_text).match(/これが戦場にいる間、自分の戦場の他のイジンは「アタック\+(\d+)」を得る/);
        return t + (m ? Number(m[1]) : 0);
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
      const wokeGreen = P.field.filter(c => c.tapped && !(c.frozenUntil >= G.turn) && c.faceUp && cardOf(c).type === 'イジン' && ijinHasColor(G, c, '緑')).length;
      P.field.forEach(c => { if (!(c.frozenUntil >= G.turn)) c.tapped = false; });   // ピーコック（青魔導）で起きないカードは寝たまま
      // 劉備「自分の戦場の緑のイジンが起きたとき、1ドローする」（CPU）
      if (wokeGreen && G.aiPlayers.has(pi) && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) P.field.filter(x => x.faceUp && !x.silenced && /自分の戦場の緑のイジンが起きたとき、1ドローする/.test(cardOf(x).rule_text || '')).forEach(x => {
        for (let k = 0; k < wokeGreen && P.deck.length; k++) P.hand.push(mkInst(P.deck.pop()));
        log(G, `　${cardOf(x).name}の効果：緑のイジンが起きたので${wokeGreen}ドロー`);
      });
      // 「自分のスタートフェイズが終了したとき、マリョク配置権+1する」（巨大古墳）
      P.field.filter(x => x.faceUp && !x.silenced && /自分のスタートフェイズが終了したとき、マリョク配置権\+1する/.test(cardOf(x).rule_text || '')).forEach(x => {
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
      if (G.finalLose && G.finalLose.turn === G.turn && G.finalLose.pi === G.current) { win(G, 1 - G.current, 'ファイナルアタックの効果（エンドフェイズに敗北）'); return { ok: true }; }
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
      // アリエノール・ダキテーヌ「自分の魔力ゾーンのマリョクは「色：赤 青」を得る」
      if (P.mana.some(m => m.faceUp && cardsById[m.cardId].type === 'マリョク') &&
        (P.field || []).some(x => x.faceUp && !x.silenced && /自分の魔力ゾーンのマリョクは「色：赤\s?青」を得る/.test(cardsById[x.cardId].rule_text || ''))) { colors.add('赤'); colors.add('青'); }
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
      // 姜維「これのレベルは自分の墓地の「反魂」を持つカードの最も高いレベルと同じだけ下がる」
      if (card.type === 'イジン' && /これのレベルは自分の墓地の「反魂」を持つカードの最も高いレベルと同じだけ下がる/.test(normTxt(card.rule_text))) {
        const n = Math.max(0, ...P.grave.filter(g => /反魂/.test(cardOf(g).legacy_ability || '')).map(g => cardOf(g).level || 0));
        if (n > 0) { a.auto += n; a.parts = a.parts.concat([{ name: card.name + '（墓地の「反魂」）', n }]); a.hints = a.hints.filter(h => !/反魂/.test(h.text)); }
      }
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
        const cost = mahouCost(G, pi, card);
        if (P.mana.length < cost) p.push(`魔力コスト不足（${P.mana.length}/${cost}枚）`);
      }
      return p;
    }
    // 天草四郎の決起「このターンのマホウ使用に際し、手札のマホウは「魔力コスト0」になる」
    const mahouCost = (G, pi, card) => (G.players[pi].freeMahouTurn === G.turn ? 0 : (card.magic_cost || 0));

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
      if (faceUp && P.mana.filter(m => m.faceUp && cardOf(m).type === 'マリョク').length >= 3 &&
        G.players[1 - pi].field.some(x => x.faceUp && !x.silenced && /マリョクが相手の魔力ゾーンに3つ以上ある間、相手は表向きでマリョク配置できない/.test(cardOf(x).rule_text || '')))
        return fail('エカチェリーナ2世の効果で、表向きでマリョク配置できません（裏向きなら置けます）');
      takeFromHand(P, uid);
      P.manaPlace -= 1;
      inst.faceUp = !!faceUp; inst.tapped = false;
      P.mana.push(inst);
      log(G, `${nm(G, pi)}：${cardLabel(G, pi, card, faceUp)}を${faceUp ? '表' : '裏'}向きでマリョク配置`);
      if (faceUp) abilityFx(G, pi, card, 'mana', inst);
      onManaPlaced(G, pi);
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
      const cost = mahouCost(G, pi, card);
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
          (x.placedTurn < G.turn || hasHaste(G, x))) ||
        (arena && isGuardianInst(x) && !x.tapped));   // 円形闘技場：ガーディアンも（即応で）アタッカーになれる
    }
    function eligibleBlockers(G, pi) {
      return G.players[pi].field.filter(x =>
        (!x.faceUp && !x.tapped) ||
        (x.faceUp && cardOf(x).type === 'イジン' && !kwOf(x).cantBlock && (!x.tapped || hasWatcher(G, x))));
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
      if (G && inst.pressureTurn === G.turn) need = Math.max(need, 2);
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
        const lines = String(c.rule_text || '').split(/\n+/).map(l => l.trim()).filter(l => /アタッカーになったとき/.test(l) && !/(相手|自分)の戦場の[^、]*がアタッカーになったとき/.test(l) && !/^これが戦場にいる間/.test(l));   // 「相手の〜がアタッカーになったとき」は自分のアタックでは発動しない
        if (lines.length) abilityFx(G, pi, c, 'attack', i, lines.join('\n'));
      });
      if (insts.some(i => !i.faceUp)) { log(G, '　円形闘技場の効果：ガーディアンがパワー3000のアタッカーになりました'); guardianTapped(G); }
      // 栄西「自分が1体だけでアタックしたときに発動する。このターンの間、アタッカーは「ダブルプレッシャー」を得る」
      if (insts.length === 1 && P.field.some(x => x.faceUp && !x.silenced && /自分が1体だけでアタックしたときに発動する。このターンの間、アタッカーは「ダブルプレッシャー」を得る/.test(cardOf(x).rule_text || ''))) {
        insts[0].pressureTurn = G.turn; log(G, '　栄西の効果：アタッカーはこのターン「ダブルプレッシャー」を得ます');
      }
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
      cpuOnTapped(G, defIdx, keys.map(k => G.players[defIdx].field.find(x => x.uid === Number(k))).filter(Boolean));
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
          if (G.battle && G.battle.attackers.includes(inst.uid)) G.atkDestroyedTurn = G.turn;
          if (wasUp && onDestroyed(G, pi, inst) === 'saved') return;   // アリエノール・ダキテーヌ：破壊されていない状態に
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
      if (G.battle && G.battle.attackers.includes(inst.uid)) G.atkDestroyedTurn = G.turn;
      if (wasUp && onDestroyed(G, pi, inst) === 'saved') return { ok: true };
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
      // 足利義政「赤のイジンが自分の戦場に置かれたときに発動できる」など（自分の戦場のカード）
      G.players[pi].field.forEach(x => {
        if (!G.aiPlayers.has(pi) || !x.faceUp || x.silenced) return;
        const m = normTxt(cardOf(x).rule_text).match(/(赤|青|緑|黄|紫)のイジンが自分の戦場に置かれたときに発動できる/);
        if (m && ijinHasColor(G, inst, m[1])) cpuTrigger(G, pi, x, /のイジンが自分の戦場に置かれたときに発動できる/, 'ownIjin');
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
      const re = which === 'mainStart' ? /メインフェイズが開始したとき/ : /自分のエンドフェイズが開始したとき/;
      const condOk = x => !/このターンにアタッカーが破壊されているなら/.test(cardOf(x).rule_text || '') || G.atkDestroyedTurn === G.turn;   // 徴募の条件
      P.field.slice().forEach(x => {
        if (which === 'endPhase' && /これが寝ているなら発動する。?これを破壊する/.test(normTxt(cardOf(x).rule_text))) return;   // 織田信長はエンジンが処理
        if (re.test(cardOf(x).rule_text || '') && condOk(x)) cpuTrigger(G, pi, x, re, which);
      });
      // 徴募「この能力は墓地でも発動する」
      if (which === 'endPhase') P.grave.slice().forEach(x => {
        if (/徴募 - この能力は(?:墓地でも|戦場か墓地で)発動する/.test(cardOf(x).rule_text || '') && condOk(x) && P.grave.includes(x)) cpuTrigger(G, pi, x, /徴募 - /, 'endPhase');
      });
      if (which === 'endPhase') P.mana.filter(x => x.faceUp).slice().forEach(x => { if (re.test(cardOf(x).rule_text || '')) cpuTrigger(G, pi, x, re, which); });
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

    // 親鸞「カードが墓地から離れたときに発動できる。1ドローする」（自分の墓地）
    function graveLeft(G, pi) {
      if (!G.aiPlayers.has(pi) || (G.cpuNoEffects && G.cpuNoEffects.has(pi))) return;
      G.players[pi].field.filter(x => x.faceUp && !x.silenced && /カードが墓地から離れたときに発動できる。1ドローする/.test(normTxt(cardOf(x).rule_text))).forEach(x => {
        if (G.players[pi].deck.length > 5) manualDraw(G, pi, 1, `${cardOf(x).name}（カードが墓地から離れた）`);
      });
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
          if (G.battleUsed) return 'declined';
          // 自分のターンは、どうせアタックしない（できない）ときだけ使う（1ドローのため）
          if (G.current === pi && (cpuChooseAttack(G, pi).list.length || G.players[pi].deck.length <= 12)) return 'declined';   // 山札切れに注意
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
      '籠城戦': { resolve(G, pi, ctx) { return ctx.kind === 'mana' ? undefined : false; } },         // 反魂の代わりは cpuLegacy、決起は onManaPlaced
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
          return handMana || recycle ? {} : null;
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
          const mine = red ? P.field.filter(ok).sort((a, b) => (countAs(b) + (hasLegacy(cardOf(b)) ? 1 : 0)) - (countAs(a) + (hasLegacy(cardOf(a)) ? 1 : 0))).map(x => ({ x, q: pi })) : [];
          const list = foe.concat(mine).slice(0, n);
          const draws = red ? list.reduce((t, o) => t + countAs(o.x), 0) : 0;
          return { list, draws };
        },
        want(G, pi) {
          const { list, draws } = this.pick(G, pi), P = G.players[pi];
          if (!list.length) return null;
          const foeHit = list.some(o => o.q !== pi);
          if (P.deck.length <= draws + 6) return foeHit && !draws ? {} : null;   // 山札切れになりそうなら控える
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
          P.field.splice(P.field.indexOf(g), 1); g.faceUp = true; g.isGuardian = false; g.tapped = false; P.grave.push(g);
          log(G, '　ロイヤリティ：ガーディアン1体を墓地に置きました'); manualDraw(G, pi, 3, 'ロイヤリティ');
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
        want(G, pi) { return G.players[pi].grave.some(x => cardOf(x).type === 'イジン' && cardValue(cardOf(x)) >= 5000) ? {} : null; },
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
          const c = P.grave.filter(x => ['イジン', 'ハイケイ'].includes(cardOf(x).type) && (cardOf(x).level || 0) <= cap)
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
          if (G.finalLose) return null;
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
    };

    /* CPUの遺業能力（戦場から墓地に置かれたとき）。読めるものだけ処理して true を返す */
    function cpuLegacy(G, pi, uid) {
      if (G.cpuNoEffects && G.cpuNoEffects.has(pi)) return false;
      const P = G.players[pi], inst = P.grave.find(x => x.uid === uid);
      if (!inst) return true;   // すでに墓地を離れている（他の効果で動いた）ので、何もしない
      const c = cardOf(inst), t = normTxt(c.legacy_ability);
      const take = () => { P.grave.splice(P.grave.indexOf(inst), 1); inst.tapped = false; inst.isGuardian = false; graveLeft(G, pi); };   // 墓地から離れる → 親鸞
      let what = '', m;
      if (/魔力化/.test(t)) { take(); inst.faceUp = false; P.mana.push(inst); what = '魔力化（魔力ゾーンに裏向きで置く）'; }
      else if (/復元/.test(t)) { take(); inst.faceUp = true; P.mana.push(inst); what = '復元（魔力ゾーンに表向きで置く）'; }
      else if ((m = t.match(/([1-3])ドローする/))) { manualDraw(G, pi, Number(m[1]), '遺業能力'); what = `${m[1]}ドロー`; }
      else if (/これを手札に戻す/.test(t)) { take(); inst.faceUp = true; P.hand.push(inst); what = '手札に戻す'; }
      else if (/これを山札の上か下に戻す/.test(t)) { take(); P.deck.push(inst.cardId); what = '山札の上に戻す'; }
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
    function onDestroyed(G, pi, inst) {
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
      if (!G.aiPlayers.has(pi)) return;
      const P = G.players[pi];
      const n = P.mana.filter(m => m.faceUp && cardOf(m).type === 'マリョク').length;
      const need = P.field.some(x => x.faceUp && !x.silenced && /自分の戦場にある「決起」は、自分の魔力ゾーンのマリョクが3つ以上でも発動する/.test(cardOf(x).rule_text || '')) ? 3 : 4;
      if (n < need) return;
      P.field.filter(x => x.faceUp).concat(P.mana.filter(x => x.faceUp)).forEach(x => { if (/決起 - /.test(cardOf(x).rule_text || '')) cpuTrigger(G, pi, x, /決起 - /, 'kekki'); });
    }
    // CPUのイジンが寝たとき（曹丕「戦場の黄のイジンは「寝たとき、パワー4000以下のイジン1体を破壊する」を得る」）
    function cpuOnTapped(G, owner, insts) {
      if (!G.aiPlayers.has(owner) || (G.cpuNoEffects && G.cpuNoEffects.has(owner))) return;
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
      if (c.type === 'イジン') return (c.level <= cap + 2 ? 10 : 4) + (c.power || 0) / 2000 + dup;
      if (c.type === 'ハイケイ') return 7 + dup;
      if (c.type === 'マホウ') return (effectPlan(SR.abilityText(c, 'mahou') || '') ? 6 : 1) + dup;
      return 5;
    }
    function cpuPlaceMana(G, pi) {
      const P = G.players[pi];
      if (P.manaPlace < 1 || !P.hand.length) return false;
      const manaCards = P.hand.filter(i => cardOf(i).type === 'マリョク');
      // 地上の紫微垣「自分のマリョク配置において、表で置く限り、ターンに1回だけ自分の墓地のマリョクも選べる」（戦場か墓地で効果）
      const shibi = P.field.concat(P.grave).some(x => x.faceUp && /表で置く限り、ターンに1回だけ自分の墓地のマリョクも選べる/.test(cardOf(x).rule_text || ''));
      const gm = P.grave.filter(x => cardOf(x).type === 'マリョク');
      if ((!manaCards.length || gm.some(x => isDrawMana(cardOf(x)))) && shibi && gm.length && P.shibiTurn !== G.turn && !(G.cpuNoEffects && G.cpuNoEffects.has(pi))) {
        const need = handNeedColors(P);
        const sc = i => colorsOf(cardOf(i)).reduce((t, ch) => t + (need[ch] ? 3 + need[ch] : 0), 0) + (cardOf(i).level || 0) + (isDrawMana(cardOf(i)) ? 10 : 0);
        const best = gm.sort((a, b) => sc(b) - sc(a))[0];
        P.grave.splice(P.grave.indexOf(best), 1); P.hand.push(best); P.shibiTurn = G.turn;
        log(G, '　地上の紫微垣の効果：墓地のマリョクを配置します');
        const r = placeMana(G, pi, best.uid, true);
        if (!r.ok) { P.hand.splice(P.hand.indexOf(best), 1); P.grave.push(best); }
        else graveLeft(G, pi);
        return r.ok;
      }
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
      // ジャン＝ジャック・ルソー：戦場で最も高いパワーのイジンを破壊（自分のイジンが一番強いなら出さない）
      if (/戦場で最も高いパワーを持つイジン1体を破壊/.test(t)) {
        const mine = Math.max(0, ...P.field.filter(isIjinUp).map(x => powerOf(x, G))), foe = Math.max(0, ...G.players[1 - pi].field.filter(isIjinUp).map(x => powerOf(x, G)));
        s += foe > mine ? 3000 : -6000;
      }
      return s;
    }
    function cpuSummon(G, pi) {
      const P = G.players[pi];
      if (P.summon < 1) return false;
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
      if (drawsPerHaikei && P.deck.length <= drawsPerHaikei + 5) return false;
      // 置く順番：配置権が増える（巨大古墳）・2つと数える（仁王）・色が増えるハイケイを先に、回収系（茅葺き屋根など）は最後に
      const prio = i => { const t = normTxt(cardOf(i).rule_text);
        return (/マリョク配置権\+1/.test(t) ? 30 : 0) + (/2つと数える/.test(t) ? 20 : 0) + (/「色：[^」]+」を得る/.test(t) ? 10 : 0) - (/手札に戻して発動できる/.test(t) ? 40 : 0); };
      const c = P.hand.filter(i => cardOf(i).type === 'ハイケイ' && (scarlet || !names.has(cardOf(i).name)) && playProblems(G, pi, cardOf(i)).length === 0)
        .sort((a, b) => prio(b) - prio(a))[0];
      return c ? useHaikei(G, pi, c.uid).ok : false;
    }
    /* 魔力コストの払い方：裏向き → 色が重複している表向き → レベルの低い表向き の順に墓地へ */
    const isDrawMana = c => c.type === 'マリョク' && /魔力ゾーンに置かれたとき(?:に発動する)?[。、]\s*1ドローする/.test(normTxt(c.rule_text));
    const shibiReady = (G, pi) => { const P = G.players[pi]; return P.shibiTurn !== G.turn && P.field.concat(P.grave).some(x => x.faceUp && /表で置く限り、ターンに1回だけ自分の墓地のマリョクも選べる/.test(cardOf(x).rule_text || '')); };
    function chooseMahouPay(P, cost, G, pi) {
      const colorCount = {};
      P.mana.filter(m => m.faceUp).forEach(m => colorsOf(cardOf(m)).forEach(ch => { colorCount[ch] = (colorCount[ch] || 0) + 1; }));
      // 紫微垣チャージ：地上の紫微垣で墓地から置き直せるなら、ドローマリョクで払う（置き直してまたドロー）
      const recycle = G && shibiReady(G, pi);
      const sc = m => (recycle && m.faceUp && isDrawMana(cardOf(m)) ? -1 : !m.faceUp ? 0 : 10 + (colorsOf(cardOf(m)).some(ch => colorCount[ch] === 1) ? 20 : 0) + (cardOf(m).level || 0));
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
            if (cpuMahou(G, pi, 'main')) { if (G.players[pi].manaPlace > 0) G.cpuStage = 'mana'; return 'continue'; }
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
            if (G.battleUsed && cpuMahou(G, pi, 'post')) { if (!G.battleUsed) G.cpuStage = 'attack'; return 'continue'; }   // ファイナルアタックで追加のバトル
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
