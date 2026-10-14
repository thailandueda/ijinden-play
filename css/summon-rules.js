/* ============================================================
   イジン召喚まわりのルール補助（レベル軽減など）
   - ソロプレイ(app.js)とCPU対戦(vs-engine.js)の両方から使う共通モジュール
   - ブラウザでは window.IjindenSummon、Node では module.exports
   - カード効果は基本的に自動処理しないが、次の2つだけは自動で扱う:
       ① 「自分がイジン召喚する際、そのイジンのレベルは N だけ下がる。」
          （サークル系マリョク／魔力ゾーンの表向きのカード、戦場のハイケイなど）
       ② 「イジンが自分の戦場に置かれたとき、これを裏にする。」
          （①とセットで書かれているサークル系。召喚後に自動で裏向きにする）
     それ以外の召喚時レベル効果（「これのイジン召喚に際し…」「戦場の色1つにつき…」など）は
     数え方がカードごとに違うため、該当カードの文章を「要確認」として表示し、
     軽減値は画面上で手動入力してもらう。
   ============================================================ */
(function (root) {
  'use strict';

  const RE_FLAT = /自分がイジン召喚する際、そのイジンのレベルは(\d+)だけ下がる/;
  const RE_FLIP = /イジンが自分の戦場に置かれたとき、これを裏にする/;
  // 召喚時のレベルに関係しそうな、自動処理しない効果（盤面側のカード）
  const RE_RELATED = /(自分がイジン召喚する際|自分(の|は)イジン召喚(に際し|において))/;
  // 召喚するカード自身の効果
  const RE_SELF = /これのイジン召喚に際し/;

  const paragraphs = text => String(text || '').split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean);

  // そのカードの効果が「いま働く」場所にあるか
  function isActive(card, zone, faceUp) {
    if (!faceUp) return false;
    const t = String(card.rule_text || '');
    if (zone === 'mana') return card.type === 'マリョク' || /この能力は魔力ゾーンで効果を発揮する/.test(t);
    if (zone === 'field') return card.type !== 'マリョク';
    return false;
  }

  /* card: これから召喚するイジン / mana, field: 自分の魔力ゾーン・戦場（{uid, cardId, faceUp} の配列）
     戻り値: { auto: 自動で拾えた軽減の合計, parts: [{name, n}], hints: [{name, text}], flips: [{uid, name}] } */
  function analyze(card, mana, field, byId) {
    const out = { auto: 0, parts: [], hints: [], flips: [] };
    const scan = (arr, zone) => (arr || []).forEach(inst => {
      const c = byId[inst.cardId];
      if (!c || !isActive(c, zone, inst.faceUp)) return;
      const t = String(c.rule_text || '');
      const m = t.match(RE_FLAT);
      if (m) {
        const n = Number(m[1]);
        out.auto += n;
        out.parts.push({ name: c.name, n });
      } else if (RE_RELATED.test(t)) {
        paragraphs(t).filter(p => RE_RELATED.test(p)).forEach(p => out.hints.push({ name: c.name, text: p }));
      }
      if (zone === 'mana' && RE_FLIP.test(t)) out.flips.push({ uid: inst.uid, name: c.name });
    });
    scan(mana, 'mana');
    scan(field, 'field');
    if (card && RE_SELF.test(card.rule_text || '')) {
      paragraphs(card.rule_text).filter(p => RE_SELF.test(p))
        .forEach(p => out.hints.push({ name: card.name + '（このカード）', text: p }));
    }
    return out;
  }

  const effectiveLevel = (base, reduction) => Math.max(0, (base || 0) - (reduction || 0));


  /* 配置したときにトースト表示する「能力の文章」を返す（無ければ空文字）
     zone: 'mana'（魔力ゾーンに表向きで置いた）/ 'field'（戦場に置いた）
     注釈だけの行（カッコ書き）・キーワードだけの行・「デッキに何枚でも〜」は能力として数えない */
  const KW_ONLY = /^(即応|ウォッチャー|ダブルプレッシャー|トリプルプレッシャー|クアドラプルプレッシャー|モータル|(?:パワー|アタック|ブロック)[+＋]\d+)$/;
  function abilityText(card, zone) {
    const t = String((card && card.rule_text) || '').trim();
    if (!t || t === '-' || t === '（空欄）') return '';
    if (zone === 'mana' && !(card.type === 'マリョク' || /この能力は魔力ゾーンで効果を発揮する/.test(t))) return '';
    // イジンを戦場に置いたとき：「これが戦場に置かれたとき」の能力だけを促す。
    // 常在能力（〜の間…）や、あとで誘発する能力（アタッカーになったとき・寝たとき・エンドフェイズ…）は、置いただけでは発揮しないので出さない
    if (zone === 'field' && card.type === 'イジン') {
      const SELF_PLACE = /(^|[。、]|[-‐]\s|「)(これが|墓地から)?戦場に置かれた(とき|なら)/;
      return t.split(/\n\s*\n/).map(para => para.split('\n').map(l => l.trim()).filter(l => l && !/^[（(].*[）)]$/.test(l)))
        .filter(lines => lines.length && SELF_PLACE.test(lines.join('')))
        .map(lines => lines.join('\n')).join('\n');
    }
    return t.split(/\n+/).map(l => l.trim()).filter(Boolean)
      .filter(l => !/^[（(].*[）)]$/.test(l))
      .filter(l => !/デッキに何枚でも入れてよい/.test(l))
      .filter(l => !l.split(/\s+/).every(w => KW_ONLY.test(w)))
      .join('\n');
  }

  const api = { analyze, effectiveLevel, abilityText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IjindenSummon = api;
})(typeof window !== 'undefined' ? window : globalThis);
