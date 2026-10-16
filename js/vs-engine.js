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
    const blockPowerOf = (inst, G) => powerOf(inst, G) + kwOf(inst).block;

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
      G.fx.push({ type: 'ability', pi, kind, cardId: card.id, name: card.name, text, uid: inst ? inst.uid : null });
      log(G, `　${card.name}の能力：${text.replace(/\n/g, ' ')}（自動処理されません）`);
    };
    /* 「破壊されない」：手動で付けたもの（このターン / 解除するまで）と、「「音楽」イジンが自分の戦場にいる間「破壊されない」を得る」型の常在能力 */
    function isIndestructible(G, inst) {
      if (inst.indestructible) return true;
      if (!inst.faceUp || inst.silenced || !G) return false;
      const pi = G.players.findIndex(P => P.field.includes(inst));
      if (pi < 0) return false;
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
      G.cpuStage = G.aiPlayers.has(pi) ? 'mana' : null;
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
      P.mana.forEach(m => {
        if (m.faceUp) {
          const c = cardsById[m.cardId];
          sum += c.level || 0;
          colorsOf(c).forEach(ch => colors.add(ch));
        } else down += 1;
      });
      return { cap: sum + down, colors, faceUpSum: sum, faceDown: down };
    }

    /* 色条件: カードの持つ色すべてが、表向きマリョクの色にあること（複数色カードの扱いはここで調整できます） */
    function conditionProblems(P, card, red) {
      const { cap, colors } = manaInfo(P);
      const lv = SR.effectiveLevel(card.level, red);
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
      log(G, `${nm(G, pi)}：ハイケイ「${card.name}」を使用（効果は自動処理されません）`);
      abilityFx(G, pi, card, 'field', inst);
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
          (x.placedTurn < G.turn || kwOf(x).haste)) ||
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
        const lines = String(c.rule_text || '').split(/\n+/).map(l => l.trim()).filter(l => /アタッカーになったとき/.test(l));
        if (lines.length) abilityFx(G, pi, c, 'attack', i, lines.join('\n'));
      });
      if (insts.some(i => !i.faceUp)) { log(G, '　円形闘技場の効果：ガーディアンがパワー3000のアタッカーになりました'); guardianTapped(G); }
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
        if (attLoses) destroyedA.push(att);
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
          inst.silenced = false; inst.indestructible = false;
          P.field.splice(i, 1);
          releaseEquips(G, pi, inst);
          inst.faceUp = true; inst.tapped = false; inst.isGuardian = false;
          P.grave.push(inst);
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
        zoneArr(P, to).push(inst);
      }
      if (to === 'mana' && inst.faceUp) abilityFx(G, pi, c, 'mana', inst);
      else if (to === 'field' && inst.faceUp && c.type !== 'マリョク') abilityFx(G, pi, c, 'field', inst);
      const label = (G.aiPlayers.has(pi) && !inst.faceUp && from !== 'grave') ? 'カード' : c.name;
      log(G, `【手動】${nm(G, pi)}の${label}を ${from} → ${to}` +
        (from === 'field' && to === 'grave' && hasLegacy(c) ? '　※遺業能力あり' : ''));
      // 戦場から墓地に置かれたときは、カード種類を問わず遺業能力が誘発する（ルールブック「遺業能力」）
      if (from === 'field' && to === 'grave' && hasLegacy(c)) G.fx.push({ type: 'legacy', pi, uid: inst.uid, name: c.name, cardId: c.id, text: String(c.legacy_ability).trim() });
      return { ok: true };
    }
    /* 戦場のカードを破壊して墓地へ（遺業能力があれば遺業フェーズの対象になる） */
    function manualDestroy(G, pi, uid) {
      const P = G.players[pi];
      const i = P.field.findIndex(x => x.uid === uid);
      if (i < 0) return fail('カードが見つかりません');
      if (isIndestructible(G, P.field[i])) return fail(`${cardOf(P.field[i]).name}は「破壊されない」状態です（解除してから破壊してください）`);
      const inst = P.field.splice(i, 1)[0], c = cardOf(inst);
      releaseEquips(G, pi, inst);
      inst.faceUp = true; inst.tapped = false; inst.isGuardian = false; inst.silenced = false; inst.indestructible = false;
      P.grave.push(inst);
      log(G, `【手動】${nm(G, pi)}の${c.name}を破壊して墓地へ` + (hasLegacy(c) ? '　※遺業能力あり' : ''));
      G.fx.push({ type: 'destroy', pi, manual: true, items: [{ name: c.name, cardId: c.id }] });
      if (hasLegacy(c)) G.fx.push({ type: 'legacy', pi, uid: inst.uid, name: c.name, cardId: c.id, text: String(c.legacy_ability).trim() });
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
    function manualDraw(G, pi, n) {
      const P = G.players[pi];
      let k = 0;
      for (let i = 0; i < n && P.deck.length; i++) { P.hand.push(mkInst(P.deck.pop())); k++; }
      if (k > 0) G.fx.push({ type: 'draw', pi, n: k });
      log(G, `【手動】${nm(G, pi)}が${k}枚ドロー（山札残り${P.deck.length}枚）`);
      return { ok: true };
    }
    /* 山札の上から1枚を、裏向きのガーディアンとして戦場に置く */
    function manualGuardianFromDeck(G, pi) {
      const P = G.players[pi];
      if (!P.deck.length) return fail('山札がありません');
      P.field.push(mkInst(P.deck.pop(), { faceUp: false, isGuardian: true, placedTurn: G.turn }));
      log(G, `【手動】${nm(G, pi)}が山札の上から1枚をガーディアンとして戦場に置いた（山札残り${P.deck.length}枚）`);
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

    /* ---------- CPU（ランダムに合法手を選ぶ） ---------- */
    function cpuChooseBlocks(G, defIdx) {
      const atks = G.battle.attackers.map(u => G.players[G.current].field.find(x => x.uid === u)).filter(Boolean);
      let pool = shuffle(eligibleBlockers(G, defIdx));
      // アンナ・パブロワが戦場にいるときは、ブロッカーのイジンを手札に戻されてしまうので、ガーディアン（裏向き）だけでブロックする。
      // （ガーディアンはイジンではないので戻されない。必要数に足りないときだけ、不足分をイジンで補う）
      const annaThreat = annaOnField(G) > 0;
      if (annaThreat) pool = pool.filter(b => !b.faceUp).concat(pool.filter(b => b.faceUp));
      const assign = {};
      // 必要ブロッカー数の多いアタッカーから先に埋める（防げないと負けるため）
      const order = atks.slice().sort((a, b) => requiredBlockers(b, G) - requiredBlockers(a, G));
      for (const a of order) {
        const need = requiredBlockers(a, G);
        for (let k = 0; k < need; k++) {
          const i = pool.findIndex(b => canBlockAttacker(G, b, a));
          if (i < 0) break;
          assign[pool.splice(i, 1)[0].uid] = a.uid;
        }
      }
      // 余ったブロッカーの加勢：ガーディアン（裏向き）は防御に使うと必ず破壊されるので、必要数を超えて出さない。
      // 表向きのイジンだけが、足し合わせてアタッカーに勝てる（パワー合計がアタッカー以上になる）場合に限って加勢する。
      const helpers = a => (annaThreat ? [] : pool.filter(b => b.faceUp && canBlockAttacker(G, b, a)));   // アンナがいるときは、イジンの加勢はしない
      for (const a of order) {
        const pa = attackPowerOf(a, G);
        const mine = () => Object.keys(assign).filter(k => assign[k] === a.uid).map(k => G.players[defIdx].field.find(x => x.uid === Number(k)));
        let sum = mine().reduce((t, b) => t + (b && b.faceUp ? blockPowerOf(b, G) : 0), 0);
        if (sum >= pa) continue;
        const cand = helpers(a).sort((x, y) => blockPowerOf(y, G) - blockPowerOf(x, G));
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

    function cpuPlaceMana(G, pi) {
      const P = G.players[pi];
      if (P.manaPlace < 1 || !P.hand.length) return;
      const manaCards = P.hand.filter(i => cardOf(i).type === 'マリョク');
      if (manaCards.length && rng() < 0.75) {
        placeMana(G, pi, rand(manaCards).uid, true);
      } else {
        // 裏向きに置くのは、CPUが使わないマホウ・ハイケイを優先
        const junk = P.hand.filter(i => !['イジン', 'マリョク'].includes(cardOf(i).type));
        placeMana(G, pi, rand(junk.length ? junk : P.hand).uid, false);
      }
    }

    /* 1手ずつ進める。戻り値: 'continue' | 'await_block' | 'turnEnded' | 'over' | 'idle' */
    function cpuStep(G) {
      if (G.winner !== null) return 'over';
      const pi = G.current;
      if (!G.aiPlayers.has(pi)) return 'idle';
      if (G.battle) return 'await_block';
      const P = G.players[pi];
      switch (G.cpuStage) {
        case 'mana':
          G.cpuStage = 'summon';
          cpuPlaceMana(G, pi);
          return 'continue';
        case 'summon': {
          const cands = P.hand.filter(i => cardOf(i).type === 'イジン' && playProblems(G, pi, cardOf(i)).length === 0);
          if (P.summon > 0 && cands.length) { summon(G, pi, rand(cands).uid); return 'continue'; }
          G.cpuStage = 'attack';
          return 'continue';
        }
        case 'attack': {
          G.cpuStage = 'after';
          const E = eligibleAttackers(G, pi);
          if (E.length && rng() < 0.65) {
            let chosen = E.filter(() => rng() < 0.6);
            if (!chosen.length) chosen = [rand(E)];
            declareAttack(G, pi, chosen.map(x => x.uid));
            if (G.aiPlayers.has(1 - pi)) cpuAutoBlock(G);
            else return 'await_block';
          }
          return 'continue';
        }
        default:
          endTurn(G, pi);
          return G.winner !== null ? 'over' : 'turnEnded';
      }
    }

    return {
      addLog: log, newGame, endTurn, placeMana, summon, useHaikei, useMahou,
      declareAttack, declareBlocks, cpuAutoBlock, cpuStep, cpuChooseBlocks,
      manualNoIjin, manualEquip, manualUnequip, manualState, isIndestructible, annaOnField, eligibleAttackers, eligibleBlockers, requiredBlockers, canBlockAttacker, ijinUnblockable,
      playProblems, summonInfo, manaInfo, parseCard, kwOf, powerOf, attackPowerOf, blockPowerOf, canAct,
      manualMove, manualTap, manualFlip, manualDraw, manualMill, manualRights, manualGuardianFromDeck, manualDestroy, manualPower,
      arenaOn, triggerInfo, resolveAnna, resolvePending
    };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IjindenEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
