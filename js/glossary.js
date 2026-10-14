/* ============================================================
   能力名の注記（用語集）
   - カード詳細・トースト・遺業フェーズなど、能力名が出てくる場所で説明を添えるための共通モジュール
   - ブラウザでは window.IjindenGlossary、Node では module.exports
   - 説明を直したいときは、下の ENTRIES の desc を編集するだけです
   ============================================================ */
(function (root) {
  'use strict';
  // re: 文章中で探すパターン / term: 表示名 / desc: 説明 / legacyOnly: 遺業能力の欄でだけ注記する
  const ENTRIES = [
    { term: 'ダブルプレッシャー', re: /ダブルプレッシャー/, desc: '2体以上からしかブロックされない能力。' },
    { term: 'トリプルプレッシャー', re: /トリプルプレッシャー/, desc: '3体以上からしかブロックされない能力。' },
    { term: '即応', re: /即応/, desc: '戦場に置かれたターンでもアタッカーになれる能力。' },
    { term: 'ウォッチャー', re: /ウォッチャー/, desc: '寝ている状態でもブロッカーになれる能力。' },
    { term: 'モータル', re: /モータル/, desc: 'バトル解決で勝ったなら、アタッカーのままでバトル解決を続ける能力。' },
    { term: 'アタック＋○○', re: /アタック[+＋]\d+/, desc: 'アタッカーになったとき、パワーが○○上がる能力。' },
    { term: 'ブロック＋○○', re: /ブロック[+＋]\d+/, desc: 'ブロッカーになったとき、パワーが○○上がる能力。' },
    { term: '徴募', re: /徴募/, desc: 'ターン中に自分のアタッカーが破壊されていたなら、エンドフェイズ時に墓地から発動する能力。' },
    { term: '執筆', re: /執筆/, desc: 'ハイケイが戦場に置かれると発動する能力。ハイケイが置かれるたびに発動する。' },
    { term: '決起', re: /決起/, desc: 'カードが魔力ゾーンに置かれたとき、マリョクが4以上あれば発動する能力。裏向きで置かれたカードは数えない。' },
    { term: '航海', re: /航海/, desc: 'アタッカーになったときに発動する能力。' },
    { term: 'スタンド', re: /スタンド/, desc: '相手のアタックに反応して、魔力ゾーンからブロッカーを戦場に置ける能力。色条件を満たす必要がある。' },
    { term: '冥装', re: /冥装/, desc: '一度マホウとして使ったカードを、墓地から装備カードとして使える能力。イジンが召喚されたとき、墓地の冥装カードを装備できる。' },
    { term: '遺業能力', re: /遺業能力/, desc: 'カードが戦場から墓地に置かれるときに発動する能力のグループ（復元・冥府発動・魔力化・反魂・木霊など）。' },
    { term: '復元', re: /復元/, desc: '戦場から墓地に置かれるとき、表向きで魔力ゾーンに置く。マリョク配置権は使わない。' },
    { term: '冥府発動', re: /冥府発動/, desc: '戦場から墓地に置かれるとき、マホウコストを払わずに発動できる。' },
    { term: '魔力化', re: /魔力化/, desc: '戦場から墓地に置かれるとき、裏向きで魔力ゾーンに置く。' },
    { term: '反魂', re: /反魂/, desc: '戦場から墓地に置かれるとき、自分のガーディアン1枚を山札の下に戻し、これを戦場に戻す。' },
    { term: '木霊', re: /木霊/, desc: '自分の手札か墓地から、これよりコストが低いカードを戦場に置ける。' },
    { term: '1ドローする', re: /1ドローする/, desc: '戦場から墓地に置かれるとき、山札から1枚ドローする。', legacyOnly: true }
  ];

  // text 中に出てくる用語を、出現順に重複なしで返す。opts.legacy が真なら legacyOnly の用語も対象
  function find(text, opts) {
    const t = String(text || '');
    const legacy = !!(opts && opts.legacy);
    const hits = [];
    ENTRIES.forEach(e => {
      if (e.legacyOnly && !legacy) return;
      const m = e.re.exec(t);
      if (m) hits.push({ term: e.term, desc: e.desc, index: m.index });
    });
    hits.sort((a, b) => a.index - b.index);
    return hits;
  }
  // 1行にまとめた注記（トースト等で使う）
  function noteLine(text, opts) {
    return find(text, opts).map(h => `【${h.term}】${h.desc}`).join('\n');
  }
  // 名前から説明を引く（title属性用）
  function descOf(matchedText) {
    const e = ENTRIES.find(x => x.re.test(matchedText));
    return e ? e.desc : '';
  }

  const api = { ENTRIES, find, noteLine, descOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IjindenGlossary = api;
})(typeof window !== 'undefined' ? window : globalThis);
