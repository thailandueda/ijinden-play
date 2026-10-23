/* アプリのバージョン（更新したら番号を上げる。ヘッダのバッジに表示し、更新履歴へリンク） */
(function () {
  'use strict';
  const APP_VERSION = '1.9.6';
  const APP_UPDATED = '2026-10-23';
  window.APP_VERSION = APP_VERSION;
  function put() {
    const h1 = document.querySelector('.brand-text h1');
    if (!h1 || h1.querySelector('.ver-badge')) return;
    const a = document.createElement('a');
    a.className = 'ver-badge';
    a.href = 'https://github.com/thailandueda/ijinden-play#更新履歴';
    a.target = '_blank'; a.rel = 'noopener';
    a.textContent = 'v' + APP_VERSION;
    a.title = `バージョン ${APP_VERSION}（${APP_UPDATED} 更新）：更新履歴を開く`;
    h1.appendChild(a);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put); else put();
})();
