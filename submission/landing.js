/* =============================================================================
 * 参赛提交页 · 脚本
 * =============================================================================
 * 这一页的全部内容都在 HTML 里，**没有一行字是 JS 生成的**。
 * 所以这个文件只做两件锦上添花的事，脚本不跑也只是少两个功能，页面不会缺块：
 *
 *   1. 语言切换（默认中文，切过一次就记住）
 *   2. 复制按钮（把 demo 链接 / 命令行粘走）
 *
 * 刻意不做的事：视频播放器接管、滚动动画、任何懒加载框架。
 * 评委的时间很短，这一页必须在 3 秒内把三件东西指出来。
 * ============================================================================= */
(function () {
  'use strict';

  var LANG_KEY = 'gift188.submission.lang';

  /** localStorage 在 file:// 与隐私模式下都可能抛，所以每处都包起来。 */
  function readLang() {
    try {
      return window.localStorage.getItem(LANG_KEY);
    } catch (e) {
      return null;
    }
  }

  function writeLang(lang) {
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch (e) {
      /* 无痕模式之类：这次不记住，下次再说 */
    }
  }

  function applyLang(lang) {
    document.documentElement.setAttribute('data-lang', lang);
    // 让读屏与复制粘贴拿到正确语言的文本
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-Hans' : 'en');
  }

  // ---- 语言 -----------------------------------------------------------------

  // 默认**中文**，而且不猜浏览器语言。
  // 这不是省事：HTML 里的 `data-lang="zh"`、`<html lang="zh-Hans">`、正文全是中文，
  // 脚本再按 navigator 改一次，就等于「同一份页面对不同人长得不一样」——
  // 提交页要的是所有人看到同一张脸。想看英文点右上角那一个按钮，记住选择。
  applyLang(readLang() === 'en' ? 'en' : 'zh');

  var toggle = document.querySelector('[data-lang-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-lang') === 'zh' ? 'en' : 'zh';
      applyLang(next);
      writeLang(next);
    });
  }

  // ---- 复制 -----------------------------------------------------------------

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // 回退：http 页面里 clipboard API 不可用时的老办法（file:// 下尤其需要）
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    var sel = btn.getAttribute('data-copy');
    var src = document.querySelector(sel);
    if (!src) return;
    // 地址还是待填的时候没有可复制的东西，按钮自己藏掉。
    // CSS 也能做，但那时按钮会先闪一下再消失。
    if (src.hasAttribute('data-todo')) {
      btn.hidden = true;
      return;
    }
    var label = btn.textContent;

    btn.addEventListener('click', function () {
      copyText(src.textContent.trim())
        .then(function () {
          btn.setAttribute('data-done', '1');
          // 按当前语言给个反馈；两套都在 DOM 里，按 data-lang 取对应那半句
          var msg = document.documentElement.getAttribute('data-lang') === 'zh' ? '已复制' : 'Copied';
          btn.textContent = msg;
          window.setTimeout(function () {
            btn.removeAttribute('data-done');
            btn.textContent = label;
          }, 1600);
        })
        .catch(function () {
          // 复制不了就把内容选上，让人自己 Ctrl+C
          var range = document.createRange();
          range.selectNodeContents(src);
          var sel2 = window.getSelection();
          sel2.removeAllRanges();
          sel2.addRange(range);
        });
    });
  });
})();