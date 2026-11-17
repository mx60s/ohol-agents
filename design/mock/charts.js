// Tiny SVG helpers for the mockups. Not production code.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  function mark(shape, x, y, r, fill, stroke, opts = {}) {
    const sw = opts.sw ?? 1.5;
    const f = opts.hollow ? 'var(--parchment-hi)' : fill;
    const st = opts.hollow ? fill : (stroke || 'var(--ink)');
    const ring = `stroke-linejoin="round"`;
    let el;
    if (shape === 'circle') el = `<circle cx="${x}" cy="${y}" r="${r}" fill="${f}" stroke="${st}" stroke-width="${sw}"/>`;
    else if (shape === 'square') el = `<rect x="${x - r * .88}" y="${y - r * .88}" width="${r * 1.76}" height="${r * 1.76}" rx="1.5" fill="${f}" stroke="${st}" stroke-width="${sw}"/>`;
    else if (shape === 'triangle') el = `<path d="M${x} ${y - r * 1.1} L${x + r * 1.05} ${y + r * .8} L${x - r * 1.05} ${y + r * .8}Z" fill="${f}" stroke="${st}" stroke-width="${sw}" ${ring}/>`;
    else el = `<path d="M${x} ${y - r * 1.2} L${x + r * 1.1} ${y} L${x} ${y + r * 1.2} L${x - r * 1.1} ${y}Z" fill="${f}" stroke="${st}" stroke-width="${sw}" ${ring}/>`;
    return el;
  }
  // linear scale
  const lin = (d0, d1, r0, r1) => (v) => r0 + (v - d0) / (d1 - d0) * (r1 - r0);
  function axes({ W, H, m, x, y, xt, yt, xlab, ylab, xfmt = (v) => v, yfmt = (v) => v, grid = true }) {
    let s = '';
    yt.forEach((v) => {
      const yy = y(v);
      if (grid) s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
      s += `<text x="${m.l - 6}" y="${yy + 4}" text-anchor="end">${yfmt(v)}</text>`;
    });
    xt.forEach((v) => {
      const xx = x(v);
      s += `<text x="${xx}" y="${H - m.b + 16}" text-anchor="middle">${xfmt(v)}</text>`;
    });
    s += `<g class="axis"><line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/><line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}"/></g>`;
    if (xlab) s += `<text class="axis-title" x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle">${xlab}</text>`;
    if (ylab) s += `<text class="axis-title" transform="translate(13 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle">${ylab}</text>`;
    return s;
  }
  function svg(el, W, H, inner) {
    el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img">${inner}</svg>`;
  }
  window.CH = { mark, lin, axes, svg, NS };
})();
