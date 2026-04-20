/**
 * Injects the OSP-72 design-mode guest bootstrap into proxied HTML.
 * Communicates with the parent BrowserTab via postMessage only.
 */

const DESIGN_SCRIPT_MARKER = 'data-opencursor-design-guest="1"';

/** Max outerHTML / snippet length sent to parent */
const SNIPPET_MAX = 8000;

function escapeScriptClose(s: string): string {
  return s.replace(/<\/script/gi, "<\\/script");
}

export function appendDesignModeGuestScript(html: string): string {
  const scriptBody = buildGuestScriptSource();
  const tag = `<script ${DESIGN_SCRIPT_MARKER} type="application/javascript">${escapeScriptClose(
    scriptBody
  )}</script>`;

  const lower = html.toLowerCase();
  const bodyClose = lower.lastIndexOf("</body>");
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + tag + html.slice(bodyClose);
  }
  const htmlClose = lower.lastIndexOf("</html>");
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + tag + html.slice(htmlClose);
  }
  return html + tag;
}

/**
 * Guest script design notes
 * -------------------------
 * 1. Hover highlight: rather than toggling a CSS class on the target element
 *    (which causes the outline to jump discontinuously as the hover moves), we
 *    render a single absolute-positioned overlay div and animate its transform
 *    + width + height. The element never gets mutated, and the box slides
 *    smoothly from one target rect to the next.
 * 2. Element screenshot: the previous implementation cloned the target node and
 *    drew it into an SVG `<foreignObject>` without any style context, so the
 *    resulting image was visually blank for almost every real site. We now
 *    inline the computed styles from the live DOM onto the clone (and every
 *    descendant) before serialization, which makes fonts, colors, layout,
 *    borders, and backgrounds render correctly.
 */
function buildGuestScriptSource(): string {
  return `(function(){
  if (window.__opencursorDesignGuestInstalled) return;
  window.__opencursorDesignGuestInstalled = true;

  var OPENCURSOR_DESIGN = 'opencursor-design';
  var OPENCURSOR_SOURCE = 'opencursor-design-guest';
  var enabled = false;
  var hoverTarget = null;
  var highlightBox = null;
  var dragThreshold = 8;
  var pointerDown = false;
  var startX = 0, startY = 0;
  var strokePoints = [];
  var strokeCanvas = null;
  var strokeCtx = null;
  var overlayBlocker = null;
  var suppressNextClick = false;

  function makeCaptureId() {
    return 'cap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function postToParent(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(Object.assign({ source: OPENCURSOR_SOURCE }, payload), '*');
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Animated hover highlight
  // ---------------------------------------------------------------------------

  function ensureHighlightBox() {
    if (highlightBox) return;
    highlightBox = document.createElement('div');
    highlightBox.setAttribute('data-opencursor-design-overlay', '1');
    highlightBox.setAttribute('aria-hidden', 'true');
    highlightBox.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;' +
      'pointer-events:none;z-index:2147483646;' +
      'border:2px solid rgba(59,130,246,0.95);border-radius:6px;' +
      'background:rgba(59,130,246,0.10);' +
      'box-shadow:0 0 0 1px rgba(255,255,255,0.45),0 12px 32px -10px rgba(59,130,246,0.45);' +
      'transition:transform 140ms cubic-bezier(0.22,1,0.36,1),' +
                 'width 140ms cubic-bezier(0.22,1,0.36,1),' +
                 'height 140ms cubic-bezier(0.22,1,0.36,1),' +
                 'opacity 90ms ease;' +
      'transform:translate3d(-10000px,-10000px,0);opacity:0;' +
      'will-change:transform,width,height,opacity;';
    document.documentElement.appendChild(highlightBox);
  }

  function updateHighlight(el) {
    if (!el) { hideHighlight(); return; }
    ensureHighlightBox();
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { hideHighlight(); return; }
    hoverTarget = el;
    highlightBox.style.transform = 'translate3d(' + r.left + 'px,' + r.top + 'px,0)';
    highlightBox.style.width = r.width + 'px';
    highlightBox.style.height = r.height + 'px';
    highlightBox.style.opacity = '1';
  }

  function hideHighlight() {
    hoverTarget = null;
    if (!highlightBox) return;
    highlightBox.style.opacity = '0';
  }

  function removeHighlightBox() {
    hoverTarget = null;
    if (highlightBox && highlightBox.parentNode) {
      highlightBox.parentNode.removeChild(highlightBox);
    }
    highlightBox = null;
  }

  function reflowHighlight() {
    // Called on scroll/resize — reposition without animating so the box tracks
    // the user's scroll instead of lagging behind.
    if (!hoverTarget || !highlightBox) return;
    var prev = highlightBox.style.transition;
    highlightBox.style.transition = 'none';
    updateHighlight(hoverTarget);
    // Force layout so the transition re-enables on the next frame cleanly.
    void highlightBox.offsetWidth;
    highlightBox.style.transition = prev;
  }

  // ---------------------------------------------------------------------------
  // Hit-testing / label
  // ---------------------------------------------------------------------------

  function pickTargetEl(x, y) {
    var list = [];
    try { list = document.elementsFromPoint(x, y) || []; } catch (e) {}
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el || el.nodeType !== 1) continue;
      if (el === strokeCanvas || el === overlayBlocker || el === highlightBox) continue;
      if (el.hasAttribute && el.hasAttribute('data-opencursor-design-overlay')) continue;
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      if (tag === 'HTML' || tag === 'BODY') continue;
      return el;
    }
    return document.body;
  }

  function classNameString(el) {
    if (!el) return '';
    var cn = el.className;
    if (typeof cn === 'string') return cn;
    if (cn && typeof cn.baseVal === 'string') return cn.baseVal;
    return '';
  }

  function compactLabel(el) {
    if (!el || !el.tagName) return 'element';
    var tag = el.tagName.toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = '';
    var cn = classNameString(el);
    if (cn) {
      var parts = cn.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      if (parts.length) cls = '.' + parts.join('.');
    }
    return tag + id + cls;
  }

  function truncate(s, n) {
    if (!s) return '';
    if (s.length <= n) return s;
    return s.slice(0, n) + '\\n…';
  }

  function buildSnippet(el) {
    var html = '';
    try { html = el.outerHTML || ''; } catch (e) { html = ''; }
    return truncate(html, ${SNIPPET_MAX});
  }

  function elementPathIndices(el) {
    var path = [];
    var cur = el;
    while (cur && cur !== document.documentElement) {
      var parent = cur.parentElement;
      if (!parent) break;
      var idx = -1;
      try { idx = Array.prototype.indexOf.call(parent.children, cur); } catch (e) { idx = -1; }
      if (idx < 0) break;
      path.unshift(idx);
      cur = parent;
    }
    return path;
  }

  function elementRectPayload(el) {
    try {
      var r = el.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height
      };
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Proxy URL <-> upstream URL helpers + live page-state sync
  // ---------------------------------------------------------------------------

  function decodeProxyTargetHref(rawHref) {
    try {
      var u = new URL(rawHref, location.href);
      var m = u.pathname.match(/^\\/browser\\/(https?)\\/([^\\/]+)(\\/.*)?$/i);
      if (!m) return rawHref;
      var scheme = m[1].toLowerCase();
      var host = decodeURIComponent(m[2]);
      var path = m[3] || '/';
      // Strip the IDE iframe-auth token so it never bleeds into the user-visible
      // URL bar or into server-rewritten Location / HTML href attributes. The
      // proxy itself reads it off the outer request before forwarding.
      var cleaned = new URLSearchParams(u.search || '');
      cleaned.delete('__ocs_access');
      var qs = cleaned.toString();
      var search = qs ? '?' + qs : '';
      return scheme + '://' + host + path + search + u.hash;
    } catch (e) {
      return rawHref;
    }
  }

  function encodeProxyHref(targetHref) {
    var target = new URL(targetHref, decodeProxyTargetHref(location.href));
    // If the URL is already a proxy URL on our own origin, return it as-is
    // instead of recursively wrapping it (which produced garbage paths like
    // \`/browser/http/localhost%3A9100/browser/https/...\` whenever a page
    // pushed location.href or origin-relative URLs back through pushState).
    if (target.origin === location.origin &&
        /^\\/browser\\/(https?)\\//i.test(target.pathname)) {
      var cleaned = new URLSearchParams(target.search || '');
      cleaned.delete('__ocs_access');
      var qs = cleaned.toString();
      var q = qs ? '?' + qs : '';
      return target.origin + target.pathname + q + target.hash;
    }
    var scheme = target.protocol.replace(':', '');
    var host = encodeURIComponent(target.host);
    var path = target.pathname === '' ? '/' : target.pathname;
    // Drop the iframe-auth query param — it rides on the proxy URL, not the
    // upstream one; we don't want it encoded into the /browser/... path.
    var tp = new URLSearchParams(target.search || '');
    tp.delete('__ocs_access');
    var tpQs = tp.toString();
    var targetSearch = tpQs ? '?' + tpQs : '';
    var tail =
      path === '/' && !targetSearch && !target.hash
        ? ''
        : path + targetSearch + target.hash;
    return location.origin + '/browser/' + scheme + '/' + host + (tail === '/' ? '' : tail);
  }

  function shouldProxyRewriteUrl(raw) {
    if (raw == null || raw === '') return false;
    if (typeof raw !== 'string') raw = String(raw);
    // Ignore javascript:, mailto:, tel:, hash-only, data:, blob: etc.
    if (/^(javascript:|mailto:|tel:|data:|blob:)/i.test(raw)) return false;
    if (raw.charAt(0) === '#') return false;
    return true;
  }

  var navSyncTimer = 0;
  function postNavState() {
    try {
      var msg = {
        kind: 'nav',
        href: decodeProxyTargetHref(location.href)
      };
      var t = (document.title || '').trim();
      // Only attach a title when it's non-empty. SPA frameworks (YouTube,
      // Twitter, etc.) briefly blank document.title during client-side
      // navigation; omitting the field here lets the parent preserve the
      // last good tab label instead of flashing back to the hostname.
      if (t) msg.title = t;
      postToParent(msg);
    } catch (e) {}
  }

  function queueNavState() {
    if (navSyncTimer) {
      clearTimeout(navSyncTimer);
    }
    navSyncTimer = setTimeout(function() {
      navSyncTimer = 0;
      postNavState();
    }, 0);
  }

  function patchHistoryApi() {
    try {
      var origPush = history.pushState.bind(history);
      var origReplace = history.replaceState.bind(history);
      history.pushState = function(state, title, url) {
        if (shouldProxyRewriteUrl(url)) {
          try { url = encodeProxyHref(String(url)); } catch (e) {}
        }
        var ret = origPush(state, title, url);
        queueNavState();
        return ret;
      };
      history.replaceState = function(state, title, url) {
        if (shouldProxyRewriteUrl(url)) {
          try { url = encodeProxyHref(String(url)); } catch (e) {}
        }
        var ret = origReplace(state, title, url);
        queueNavState();
        return ret;
      };
    } catch (e) {}
  }

  function patchDynamicFormSubmissions() {
    // Server-side HTML rewrite already fixes static form[action] attributes in
    // the initial document. This catches dynamic apps that mutate the action
    // later or submit via JS with a plain same-origin relative URL.
    document.addEventListener('submit', function(ev) {
      if (enabled) return;
      var form = ev.target;
      if (!form || !form.getAttribute) return;
      var raw = form.getAttribute('action');
      if (!shouldProxyRewriteUrl(raw)) return;
      try {
        form.setAttribute('action', encodeProxyHref(String(raw)));
      } catch (e) {}
    }, true);
  }

  var lastTitle = '';
  function observeTitleAndUrl() {
    window.addEventListener('popstate', queueNavState);
    window.addEventListener('hashchange', queueNavState);
    // Poll document.title once per second in addition to the MutationObserver.
    // Many SPA frameworks (YouTube, Twitter, etc.) replace the entire <title>
    // element rather than mutating its text, so a subtree observer on the
    // original element goes deaf. Polling document.title catches both cases
    // without any per-framework special-casing.
    try { lastTitle = document.title || ''; } catch (e) {}
    try {
      if (typeof MutationObserver !== 'undefined' && document.head) {
        // Watch the entire <head> so newly-added <title> elements also fire.
        var headObserver = new MutationObserver(function() { queueNavState(); });
        headObserver.observe(document.head, {
          childList: true,
          characterData: true,
          subtree: true
        });
      }
    } catch (e) {}
    setInterval(function() {
      try {
        var cur = (document.title || '').trim();
        // Only push on non-empty transitions. An empty title is almost
        // always a transient SPA state, not a user-meaningful value, and
        // postNavState() drops the field anyway — but we avoid even queuing
        // a redundant send.
        if (cur && cur !== lastTitle) {
          lastTitle = cur;
          queueNavState();
        }
      } catch (e) {}
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Element screenshot (SVG <foreignObject> with inlined computed styles)
  // ---------------------------------------------------------------------------

  var VOID_TAGS = ['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'];

  function htmlToXhtml(s) {
    // SVG foreignObject parses its content as XHTML — void tags MUST be
    // self-closed or the SVG parser bails and the <img onload> never fires.
    for (var i = 0; i < VOID_TAGS.length; i++) {
      var t = VOID_TAGS[i];
      var re = new RegExp('<' + t + '(\\\\s[^>]*)?>(?!<\\\\/' + t + '>)', 'gi');
      s = s.replace(re, function(_m, attrs) {
        var a = attrs || '';
        return '<' + t + a + '/>';
      });
    }
    return s;
  }

  function inlineComputedStyles(src, dst) {
    if (!src || !dst || src.nodeType !== 1 || dst.nodeType !== 1) return;
    var cs;
    try { cs = getComputedStyle(src); } catch (e) { return; }
    var cssText = '';
    // Walk the CSSStyleDeclaration and re-emit every property so the clone has
    // the *resolved* values (color: rgb(...), font-family: ..., etc.) instead
    // of depending on external stylesheets we can't reach from inside the SVG.
    for (var i = 0; i < cs.length; i++) {
      var p = cs[i];
      var v = cs.getPropertyValue(p);
      if (v == null || v === '') continue;
      // Skip noise that bloats the serialized output without affecting visuals.
      if (p === 'cursor' || p === 'pointer-events' || p === 'user-select') continue;
      cssText += p + ':' + v + ';';
    }
    dst.setAttribute('style', cssText);

    var srcChildren = src.children;
    var dstChildren = dst.children;
    var len = Math.min(srcChildren.length, dstChildren.length);
    for (var j = 0; j < len; j++) {
      inlineComputedStyles(srcChildren[j], dstChildren[j]);
    }
  }

  function stripUnserializable(root) {
    try {
      var scripts = root.querySelectorAll('script,link[rel="stylesheet"],noscript');
      for (var i = scripts.length - 1; i >= 0; i--) {
        var n = scripts[i];
        if (n.parentNode) n.parentNode.removeChild(n);
      }
    } catch (e) {}
  }

  function toAbsoluteUrl(raw) {
    if (!raw) return raw;
    try { return new URL(raw, document.baseURI).href; }
    catch (e) { return raw; }
  }

  /**
   * Fetch url and resolve to a data: URL. Used to inline every
   * sub-resource (images, fonts, videos, etc.) into the serialized SVG so the
   * foreignObject render is fully self-contained — no blob: base-URL
   * resolution pitfalls, no CORS tainting, no relative-path 404s.
   */
  function fetchAsDataUrl(url) {
    return fetch(url, { credentials: 'include', mode: 'cors' })
      .catch(function() { return fetch(url, { credentials: 'include' }); })
      .then(function(res) {
        if (!res || !res.ok) throw new Error('fetch failed');
        return res.blob();
      })
      .then(function(blob) {
        return new Promise(function(resolve, reject) {
          var reader = new FileReader();
          reader.onload = function() { resolve(String(reader.result || '')); };
          reader.onerror = function() { reject(reader.error); };
          reader.readAsDataURL(blob);
        });
      });
  }

  /** Same-origin cache: one request per unique URL per capture cycle. */
  var resourceCache = {};
  function cachedFetchAsDataUrl(url) {
    if (!url) return Promise.resolve(null);
    if (resourceCache[url]) return resourceCache[url];
    var p = fetchAsDataUrl(url).catch(function() { return null; });
    resourceCache[url] = p;
    return p;
  }

  /**
   * Replace src, srcset, href, poster, etc. on the cloned element tree
   * with data: URLs. Any fetch failure leaves the original URL in place so
   * the browser can still try to load it at render time (strictly additive).
   */
  function inlineResourceAttributes(root) {
    var tasks = [];
    var urlAttrs = [
      ['img', 'src'],
      ['image', 'href'],
      ['source', 'src'],
      ['audio', 'src'],
      ['video', 'src'],
      ['video', 'poster']
    ];
    function schedule(el, attr) {
      var raw = el.getAttribute(attr);
      if (!raw || raw.indexOf('data:') === 0) return;
      var abs = toAbsoluteUrl(raw);
      tasks.push(
        cachedFetchAsDataUrl(abs).then(function(dataUrl) {
          if (dataUrl) el.setAttribute(attr, dataUrl);
          else el.setAttribute(attr, abs);
        })
      );
    }
    for (var i = 0; i < urlAttrs.length; i++) {
      var tag = urlAttrs[i][0];
      var attr = urlAttrs[i][1];
      var nodes;
      try { nodes = root.querySelectorAll(tag + '[' + attr + ']'); }
      catch (e) { nodes = []; }
      for (var j = 0; j < nodes.length; j++) {
        schedule(nodes[j], attr);
      }
    }
    // Root-level <img>/<source>/<video> fixup — querySelectorAll skips the root itself.
    if (root.tagName === 'IMG' && root.hasAttribute('src')) schedule(root, 'src');
    if (root.tagName === 'SOURCE' && root.hasAttribute('src')) schedule(root, 'src');
    if (root.tagName === 'VIDEO' && root.hasAttribute('poster')) schedule(root, 'poster');
    if (root.tagName === 'VIDEO' && root.hasAttribute('src')) schedule(root, 'src');

    // srcset everywhere — each URL in the comma-list gets inlined.
    var srcsetNodes;
    try { srcsetNodes = root.querySelectorAll('[srcset]'); } catch (e) { srcsetNodes = []; }
    var all = Array.prototype.slice.call(srcsetNodes);
    if (root.hasAttribute && root.hasAttribute('srcset')) all.push(root);
    for (var k = 0; k < all.length; k++) {
      (function(el) {
        var srcset = el.getAttribute('srcset');
        if (!srcset) return;
        var segments = srcset.split(',').map(function(s) { return s.trim(); });
        var perUrl = segments.map(function(seg) {
          var sp = seg.indexOf(' ');
          var urlPart = sp > 0 ? seg.slice(0, sp) : seg;
          var rest = sp > 0 ? seg.slice(sp) : '';
          if (!urlPart || urlPart.indexOf('data:') === 0) {
            return Promise.resolve(urlPart + rest);
          }
          var abs = toAbsoluteUrl(urlPart);
          return cachedFetchAsDataUrl(abs).then(function(du) {
            return (du || abs) + rest;
          });
        });
        tasks.push(Promise.all(perUrl).then(function(parts) {
          el.setAttribute('srcset', parts.join(', '));
        }));
      })(all[k]);
    }

    // xlink:href on <use>, <image> (SVG). getAttribute with namespace prefix.
    var useNodes;
    try { useNodes = root.querySelectorAll('use, image'); } catch (e) { useNodes = []; }
    for (var u = 0; u < useNodes.length; u++) {
      var un = useNodes[u];
      var hrefAttr = un.getAttribute('href') || un.getAttributeNS && un.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (hrefAttr && hrefAttr.indexOf('data:') !== 0 && hrefAttr.charAt(0) !== '#') {
        (function(node, raw) {
          var abs = toAbsoluteUrl(raw);
          tasks.push(cachedFetchAsDataUrl(abs).then(function(du) {
            var val = du || abs;
            if (node.hasAttribute('href')) node.setAttribute('href', val);
            if (node.hasAttributeNS && node.hasAttributeNS('http://www.w3.org/1999/xlink', 'href')) {
              node.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', val);
            }
          }));
        })(un, hrefAttr);
      }
    }

    return Promise.all(tasks);
  }

  /**
   * Rewrite any url("http://…") references inside a clones computed inline
   * styles to url("data:…"). Catches backgrounds, list-style-images, masks,
   * borders, etc. — anything a stylesheet would normally pull over the network.
   */
  function inlineInlineStyleUrls(root) {
    var tasks = [];
    var nodes = [root];
    try {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) nodes.push(all[i]);
    } catch (e) {}

    var urlRe = /url\\((['"]?)([^'")]+)\\1\\)/g;

    for (var n = 0; n < nodes.length; n++) {
      (function(el) {
        var style = el.getAttribute && el.getAttribute('style');
        if (!style || style.indexOf('url(') === -1) return;
        // Collect unique URLs first so we only fetch each one once.
        var seen = {};
        var urls = [];
        var m;
        urlRe.lastIndex = 0;
        while ((m = urlRe.exec(style))) {
          var raw = m[2];
          if (!raw || raw.indexOf('data:') === 0 || raw.charAt(0) === '#') continue;
          if (seen[raw]) continue;
          seen[raw] = true;
          urls.push(raw);
        }
        if (urls.length === 0) return;
        var subs = urls.map(function(raw) {
          var abs = toAbsoluteUrl(raw);
          return cachedFetchAsDataUrl(abs).then(function(du) { return { raw: raw, next: du || abs }; });
        });
        tasks.push(Promise.all(subs).then(function(results) {
          var map = {};
          for (var r = 0; r < results.length; r++) map[results[r].raw] = results[r].next;
          var updated = style.replace(new RegExp(urlRe.source, 'g'), function(full, q, raw) {
            var next = map[raw];
            if (!next) return full;
            return 'url("' + next + '")';
          });
          el.setAttribute('style', updated);
        }));
      })(nodes[n]);
    }

    return Promise.all(tasks);
  }

  function snapshotElement(el, cb) {
    resourceCache = {};
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { cb(null); return; }
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.ceil(r.width);
      var h = Math.ceil(r.height);
      var maxDim = 2048;
      var scale = Math.min(1, maxDim / Math.max(w * dpr, h * dpr));

      var clone = el.cloneNode(true);
      inlineComputedStyles(el, clone);
      stripUnserializable(clone);

      // Reset margins/positioning so the clone anchors at (0,0) inside the SVG
      // wrapper rather than wherever it sat in the original layout flow.
      clone.style.margin = '0';
      clone.style.position = 'static';
      clone.style.transform = 'none';
      clone.style.left = '0';
      clone.style.top = '0';
      clone.style.right = 'auto';
      clone.style.bottom = 'auto';

      // Inline ALL sub-resources as data: URLs so the SVG is fully
      // self-contained. Without this, an <img src="/logos/doodle.gif"> resolves
      // against the blob URL context (not the page) and fails to load, which
      // is why the previous SVG path painted blank.
      var finalize = function() {
        try {
          var ser = new XMLSerializer();
          var inner;
          try { inner = ser.serializeToString(clone); }
          catch (se) { cb(null); return; }
          inner = htmlToXhtml(inner);

          var svgStr =
            '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
              '<foreignObject width="100%" height="100%">' +
                '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + w + 'px;height:' + h + 'px;overflow:hidden;box-sizing:border-box;background:#ffffff;">' +
                  inner +
                '</div>' +
              '</foreignObject>' +
            '</svg>';

          var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
          var url = URL.createObjectURL(blob);
          var svgImg = new Image();
          var svgDone = false;
          var svgTimer = setTimeout(function() {
            if (svgDone) return;
            svgDone = true;
            URL.revokeObjectURL(url);
            cb(null);
          }, 10000);
          svgImg.onload = function() {
            if (svgDone) return;
            svgDone = true;
            clearTimeout(svgTimer);
            try {
              var c = document.createElement('canvas');
              c.width = Math.max(1, Math.floor(w * dpr * scale));
              c.height = Math.max(1, Math.floor(h * dpr * scale));
              var ctx = c.getContext('2d');
              if (!ctx) { URL.revokeObjectURL(url); cb(null); return; }
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, c.width, c.height);
              ctx.drawImage(svgImg, 0, 0, c.width, c.height);
              URL.revokeObjectURL(url);
              try { cb(c.toDataURL('image/png')); }
              catch (e2) { cb(null); }
            } catch (e3) {
              URL.revokeObjectURL(url);
              cb(null);
            }
          };
          svgImg.onerror = function() {
            if (svgDone) return;
            svgDone = true;
            clearTimeout(svgTimer);
            URL.revokeObjectURL(url);
            cb(null);
          };
          svgImg.src = url;
        } catch (e) {
          cb(null);
        }
      };

      // Fire the two inlining passes in parallel — they touch disjoint
      // attribute sets so they can't step on each other.
      Promise.all([
        inlineResourceAttributes(clone),
        inlineInlineStyleUrls(clone)
      ]).then(finalize, finalize);
    } catch (e) {
      cb(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Stroke (drag-to-annotate)
  // ---------------------------------------------------------------------------

  function ensureStrokeCanvas() {
    if (strokeCanvas) return;
    strokeCanvas = document.createElement('canvas');
    strokeCanvas.setAttribute('data-opencursor-design-overlay', '1');
    strokeCanvas.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;';
    strokeCtx = strokeCanvas.getContext('2d');
    document.documentElement.appendChild(strokeCanvas);
    resizeStroke();
  }

  function resizeStroke() {
    if (!strokeCanvas) return;
    strokeCanvas.width = window.innerWidth;
    strokeCanvas.height = window.innerHeight;
  }

  function ensureOverlayBlocker() {
    if (overlayBlocker) return;
    overlayBlocker = document.createElement('div');
    overlayBlocker.setAttribute('data-opencursor-design-overlay', '1');
    overlayBlocker.style.cssText =
      'position:fixed;inset:0;z-index:2147483645;cursor:crosshair;background:transparent;';
    // Pointer events drive stroke detection (down/move/up). The click event
    // is the canonical select-capture trigger — pointerdown/up can be skipped
    // by synthetic event generators (test harnesses, some automation APIs)
    // but click is always delivered, so we key the capture off it.
    overlayBlocker.addEventListener('pointermove', onPointerMove, true);
    overlayBlocker.addEventListener('pointerdown', onPointerDown, true);
    overlayBlocker.addEventListener('pointerup', onPointerUp, true);
    overlayBlocker.addEventListener('click', onClickCapture, true);
    overlayBlocker.addEventListener('contextmenu', blockEvent, true);
    document.documentElement.appendChild(overlayBlocker);
  }

  function removeOverlayBlocker() {
    if (overlayBlocker && overlayBlocker.parentNode) {
      overlayBlocker.parentNode.removeChild(overlayBlocker);
    }
    overlayBlocker = null;
  }

  function blockEvent(ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }

  function drawStrokeSegment(from, to) {
    if (!strokeCtx) return;
    strokeCtx.strokeStyle = 'rgba(59,130,246,0.95)';
    strokeCtx.lineWidth = 3;
    strokeCtx.lineCap = 'round';
    strokeCtx.lineJoin = 'round';
    strokeCtx.beginPath();
    strokeCtx.moveTo(from.x, from.y);
    strokeCtx.lineTo(to.x, to.y);
    strokeCtx.stroke();
  }

  function strokeBounds(points) {
    if (!points || points.length === 0) return null;
    var minX = points[0].x;
    var minY = points[0].y;
    var maxX = points[0].x;
    var maxY = points[0].y;
    for (var i = 1; i < points.length; i++) {
      var p = points[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    // Padding makes the screenshot include the circled contents, not just the
    // stroke itself hugging the edges.
    var pad = 24;
    var left = Math.max(0, Math.floor(minX - pad));
    var top = Math.max(0, Math.floor(minY - pad));
    var right = Math.min(window.innerWidth, Math.ceil(maxX + pad));
    var bottom = Math.min(window.innerHeight, Math.ceil(maxY + pad));
    var width = Math.max(1, right - left);
    var height = Math.max(1, bottom - top);
    return { left: left, top: top, width: width, height: height };
  }

  function cropStrokeOverlay(rect) {
    if (!strokeCanvas || !rect) return null;
    try {
      var c = document.createElement('canvas');
      c.width = rect.width;
      c.height = rect.height;
      var ctx = c.getContext('2d');
      if (!ctx) return null;
      // Transparent background — parent composites this over the rendered
      // screenshot of the same rect.
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.drawImage(
        strokeCanvas,
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        0,
        0,
        rect.width,
        rect.height
      );
      return c.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  }

  function finalizeStroke() {
    if (!strokeCanvas || strokePoints.length < 2) {
      if (strokeCanvas) { strokeCanvas.remove(); strokeCanvas = null; strokeCtx = null; }
      strokePoints = [];
      return;
    }
    try {
      var rect = strokeBounds(strokePoints);
      var overlayUrl = cropStrokeOverlay(rect);
      postToParent({
        kind: 'stroke',
        captureId: makeCaptureId(),
        // Annotation-only overlay; BrowserTab composites this on top of the
        // rendered screenshot for the same rect.
        imageDataUrl: overlayUrl || undefined,
        caption: 'Annotated region',
        pageUrl: location.href,
        rect: rect,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        scroll: {
          x: window.scrollX || window.pageXOffset || 0,
          y: window.scrollY || window.pageYOffset || 0
        }
      });
    } catch (e) {}
    strokeCanvas.remove();
    strokeCanvas = null;
    strokeCtx = null;
    strokePoints = [];
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function onPointerMove(ev) {
    if (!enabled) return;
    if (pointerDown) {
      strokePoints.push({ x: ev.clientX, y: ev.clientY });
      if (strokePoints.length >= 2) {
        ensureStrokeCanvas();
        var a = strokePoints[strokePoints.length - 2];
        var b = strokePoints[strokePoints.length - 1];
        drawStrokeSegment(a, b);
      }
      return;
    }
    var el = pickTargetEl(ev.clientX, ev.clientY);
    if (el && el !== document.documentElement) {
      updateHighlight(el);
    } else {
      hideHighlight();
    }
  }

  function onPointerDown(ev) {
    if (!enabled) return;
    pointerDown = true;
    startX = ev.clientX;
    startY = ev.clientY;
    strokePoints = [{ x: startX, y: startY }];
    if (strokeCanvas) { strokeCanvas.remove(); strokeCanvas = null; strokeCtx = null; }
  }

  function onPointerUp(ev) {
    if (!enabled) return;
    var wasDown = pointerDown;
    pointerDown = false;
    if (!wasDown) return;
    var dx = ev.clientX - startX;
    var dy = ev.clientY - startY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= dragThreshold) {
      // User drew a stroke — finalize it. Suppress the subsequent click so it
      // doesn't also trigger a select capture on top of the stroke capture.
      suppressNextClick = true;
      finalizeStroke();
      hideHighlight();
      return;
    }
    // Short tap — the click listener will handle the select.
    strokePoints = [];
    if (strokeCanvas) { strokeCanvas.remove(); strokeCanvas = null; strokeCtx = null; }
  }

  function onClickCapture(ev) {
    if (!enabled) return;
    // Always block the click from reaching the underlying page (no accidental
    // link navigation, form submission, etc.).
    ev.preventDefault();
    ev.stopPropagation();
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    var el = pickTargetEl(ev.clientX, ev.clientY);
    if (!el) {
      try { console.warn('[opencursor-design] no target element for click at', ev.clientX, ev.clientY); } catch (e) {}
      return;
    }
    var label = compactLabel(el);
    var snippet = buildSnippet(el);
    var captureId = makeCaptureId();
    var pathIndices = elementPathIndices(el);
    var rect = elementRectPayload(el);
    try { console.log('[opencursor-design] capture start', { captureId: captureId, label: label, tag: el.tagName, x: ev.clientX, y: ev.clientY }); } catch (e) {}
    snapshotElement(el, function(img) {
      try {
        console.log('[opencursor-design] capture done', {
          captureId: captureId,
          hasImage: !!img,
          imageBytes: img ? img.length : 0
        });
      } catch (e) {}
      postToParent({
        kind: 'select',
        captureId: captureId,
        label: label,
        snippet: snippet,
        imageDataUrl: img || undefined,
        pageUrl: location.href,
        pathIndices: pathIndices,
        rect: rect,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        scroll: {
          x: window.scrollX || window.pageXOffset || 0,
          y: window.scrollY || window.pageYOffset || 0
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Enable/disable + host messages
  // ---------------------------------------------------------------------------

  function setEnabled(on) {
    enabled = on;
    pointerDown = false;
    strokePoints = [];
    if (strokeCanvas) { strokeCanvas.remove(); strokeCanvas = null; strokeCtx = null; }
    if (enabled) {
      ensureOverlayBlocker();
      ensureHighlightBox();
    } else {
      removeOverlayBlocker();
      removeHighlightBox();
    }
    postToParent({ kind: 'state', enabled: enabled });
  }

  function onMessage(ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.type !== OPENCURSOR_DESIGN) return;
    if (d.op === 'enable') setEnabled(true);
    else if (d.op === 'disable') setEnabled(false);
    else if (d.op === 'ping') {
      postToParent({ kind: 'ready', enabled: enabled });
      postNavState();
    }
  }

  patchHistoryApi();
  patchDynamicFormSubmissions();
  observeTitleAndUrl();
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', function() { resizeStroke(); reflowHighlight(); });
  window.addEventListener('scroll', reflowHighlight, true);

  postToParent({ kind: 'ready', enabled: false });
  postNavState();
})();`;
}
