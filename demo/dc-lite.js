/* Small runtime that renders the mockup pages: {{holes}}, <sc-for>, <sc-if>, onClick, and a React-like class with setState. */
(function () {
  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (patch) { Object.assign(this.state, patch); schedule(); };
  DCLogic.prototype.forceUpdate = function () { schedule(); };

  var tpl, comp, root, handlers = [], queued = false;
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(function () { queued = false; render(); }); } }

  function lookup(path, scope) {
    path = path.trim();
    if (path === 'true') return true; if (path === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var parts = path.split('.'), v = scope;
    for (var i = 0; i < parts.length; i++) { if (v == null) return ''; v = v[parts[i]]; }
    return v;
  }
  var WHOLE = /^\s*\{\{([^}]+)\}\}\s*$/, ANY = /\{\{([^}]+)\}\}/g;
  function interp(s, scope) { return s.replace(ANY, function (_, p) { var v = lookup(p, scope); return v == null ? '' : String(v); }); }

  function walk(node, scope, out) {
    if (node.nodeType === 3) { out.appendChild(document.createTextNode(interp(node.nodeValue, scope))); return; }
    if (node.nodeType !== 1) return;
    var tag = node.tagName.toLowerCase();
    if (tag === 'sc-for') {
      var m = WHOLE.exec(node.getAttribute('list') || ''); var list = m ? lookup(m[1], scope) : [];
      var as = node.getAttribute('as') || 'item';
      (list || []).forEach(function (item, i) {
        var s = Object.create(scope); s[as] = item; s.$index = i;
        node.childNodes.forEach(function (c) { walk(c, s, out); });
      });
      return;
    }
    if (tag === 'sc-if') {
      var m2 = WHOLE.exec(node.getAttribute('value') || '');
      if (m2 && lookup(m2[1], scope)) node.childNodes.forEach(function (c) { walk(c, scope, out); });
      return;
    }
    var el = node.namespaceURI === 'http://www.w3.org/1999/xhtml' ? document.createElement(node.localName) : document.createElementNS(node.namespaceURI, node.localName);
    Array.prototype.forEach.call(node.attributes, function (a) {
      var name = a.name;
      if (/^hint-/.test(name)) return;
      if (/^on[a-z]+$/.test(name)) {
        var mm = WHOLE.exec(a.value); var fn = mm && lookup(mm[1], scope);
        if (typeof fn === 'function') { handlers.push(fn); el.setAttribute('data-dc-' + name.slice(2), String(handlers.length - 1)); }
        return;
      }
      el.setAttribute(name, interp(a.value, scope));
    });
    var src = node.localName === 'template' ? node.content : node;
    src.childNodes.forEach(function (c) { walk(c, scope, el); });
    out.appendChild(el);
  }

  function render() {
    handlers = [];
    var vals = comp.renderVals();
    var frag = document.createElement('div'); frag.id = 'dc-root';
    tpl.content.childNodes.forEach(function (c) { walk(c, vals, frag); });
    if (!root.firstChild) root.appendChild(frag);
    else morphdom(root.firstChild, frag);
  }

  ['click', 'input', 'change'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var el = e.target.closest && e.target.closest('[data-dc-' + type + ']');
      if (!el) return;
      var fn = handlers[Number(el.getAttribute('data-dc-' + type))];
      if (fn) fn(e);
    });
  });

  document.addEventListener('DOMContentLoaded', function () {
    var src = document.getElementById('dc-src');
    tpl = document.createElement('template'); tpl.innerHTML = src.innerHTML;
    var helmet = tpl.content.querySelector('helmet');
    if (helmet) { Array.prototype.slice.call(helmet.children).forEach(function (c) { document.head.appendChild(document.importNode(c, true)); }); helmet.remove(); }
    root = document.createElement('div'); src.replaceWith(root);
    var script = document.querySelector('script[data-dc-script]');
    var Component = new Function('DCLogic', script.textContent + '\nreturn Component;')(DCLogic);
    var props = {};
    comp = new Component(props); comp.props = props;
    render();
    if (comp.componentDidMount) comp.componentDidMount();
  });
})();
