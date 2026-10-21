'use strict';

// Visits panel: page views per hour (24 h, 7 days) or per day (30 days) as
// a column chart, for all sites or one. Used on the account page and in the
// admin panel; `endpoint` is /me/stats or /admin/stats.

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_ICONS = {
  chart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 20V11M12 20V5M19 20v-6"/></svg>',
  table: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M3.5 15h17M10 10v9.5"/></svg>',
};

function statsPanel(root, { endpoint, siteNames = [] }) {
  const state = { site: '', range: '24h', data: null };
  root.classList.add('stats');
  root.innerHTML = `
    <div class="stats-filters">
      <select class="stats-site" aria-label=""></select>
      <div class="segmented stats-ranges" role="group"></div>
      <div class="segmented view-switch" role="group">
        <button type="button" data-view="chart" aria-pressed="true">${VIEW_ICONS.chart}</button>
        <button type="button" data-view="table" aria-pressed="false">${VIEW_ICONS.table}</button>
      </div>
    </div>
    <div class="stats-tiles">
      <div class="stat-tile"><span class="stat-label"></span><b class="stat-value" data-stat="total">–</b></div>
      <div class="stat-tile"><span class="stat-label"></span><b class="stat-value" data-stat="peak">–</b></div>
    </div>
    <div class="chart" role="img"><svg></svg><div class="chart-tip" hidden><b></b><span></span></div><p class="chart-empty" hidden></p></div>
    <ul class="stats-sites"></ul>
    <div class="stats-table table-wrap" hidden><table><thead><tr><th></th><th class="num"></th></tr></thead><tbody></tbody></table></div>`;

  const select = $('.stats-site', root);
  select.setAttribute('aria-label', t('stats.site'));
  select.append(new Option(t('stats.allSites'), ''));
  for (const name of siteNames) select.append(new Option(name, name));
  select.hidden = siteNames.length < 2;
  select.addEventListener('change', () => {
    state.site = select.value;
    load();
  });

  const segmented = $('.stats-ranges', root);
  segmented.setAttribute('aria-label', t('stats.range'));
  for (const range of ['24h', '7d', '30d']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.range = range;
    button.textContent = t(`stats.range${range}`);
    button.setAttribute('aria-pressed', String(range === state.range));
    button.addEventListener('click', () => {
      state.range = range;
      for (const b of segmented.children) b.setAttribute('aria-pressed', String(b === button));
      load();
    });
    segmented.append(button);
  }
  $$('.stat-label', root)[0].textContent = t('stats.total');
  // Chart or table: the same numbers, two ways to read them.
  const views = $('.view-switch', root);
  views.setAttribute('aria-label', t('stats.view'));
  for (const b of views.children) {
    const label = t(b.dataset.view === 'chart' ? 'stats.viewChart' : 'stats.viewTable');
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', () => {
      for (const other of views.children) other.setAttribute('aria-pressed', String(other === b));
      const table = b.dataset.view === 'table';
      $('.chart', root).hidden = table;
      $('.stats-table', root).hidden = !table;
    });
  }
  $$('th', root)[0].textContent = t('stats.when');
  $$('th', root)[1].textContent = t('stats.views');

  async function load() {
    root.classList.add('loading'); // the previous chart stays while the new data loads
    const query = new URLSearchParams({ range: state.range });
    if (state.site) query.set('site', state.site);
    try {
      state.data = await api(`${endpoint}?${query}`);
      render();
    } finally {
      root.classList.remove('loading');
    }
  }

  function render() {
    const { buckets, unit, total, sites } = state.data;
    const peak = buckets.reduce((best, b) => (b.views > (best?.views ?? 0) ? b : best), null);
    $('[data-stat=total]', root).textContent = total.toLocaleString(LANG);
    $$('.stat-label', root)[1].textContent = t(unit === 'day' ? 'stats.peakDay' : 'stats.peakHour');
    $('[data-stat=peak]', root).textContent = peak ? bucketLabel(peak.t, unit) : '–';
    drawChart($('.chart', root), buckets, unit);

    // Views per site, when all sites are shown.
    const list = $('.stats-sites', root);
    list.hidden = Boolean(state.site) || sites.length < 2;
    list.replaceChildren(
      ...sites.slice(0, 8).map((s) => {
        const li = document.createElement('li');
        li.innerHTML = '<span></span><b></b>';
        li.firstChild.textContent = s.name;
        li.lastChild.textContent = s.views.toLocaleString(LANG);
        return li;
      }),
    );

    $('tbody', root).replaceChildren(
      ...buckets
        .slice()
        .reverse()
        .map((b) => {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td></td><td class="num"></td>';
          tr.children[0].textContent = bucketLabel(b.t, unit);
          tr.children[1].textContent = b.views.toLocaleString(LANG);
          return tr;
        }),
    );
  }

  new ResizeObserver(() => state.data && drawChart($('.chart', root), state.data.buckets, state.data.unit)).observe($('.chart', root));
  load();
  return { reload: load };
}


// Buckets are UTC hours ("2026-10-21T14") or days ("2026-10-21T00"); labels are local.
const bucketDate = (t) => new Date(`${t}:00:00Z`);
function bucketLabel(t, unit) {
  const d = bucketDate(t);
  if (unit === 'day') return d.toLocaleDateString(LANG, { weekday: 'short', day: 'numeric', month: 'numeric' });
  return d.toLocaleString(LANG, { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// A clean axis: a step of 1, 2 or 5 × 10ⁿ and at most 5 ticks above zero.
function niceAxis(value) {
  if (value <= 4) return { max: 4, step: 1 };
  const power = 10 ** Math.floor(Math.log10(value / 5));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => value / s <= 5);
  return { max: Math.ceil(value / step) * step, step };
}

function drawChart(chart, buckets, unit) {
  const svg = $('svg', chart);
  const tip = $('.chart-tip', chart);
  const width = chart.clientWidth;
  const height = 220;
  const pad = { top: 12, right: 4, bottom: 26, left: 40 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const { max, step } = niceAxis(Math.max(...buckets.map((b) => b.views), 0));
  const band = innerW / buckets.length;
  const barW = Math.max(1, Math.min(24, band - 2)); // capped width, 2px surface gap
  const y = (v) => pad.top + innerH - (v / max) * innerH;

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.replaceChildren();
  const el = (name, attrs, parent = svg) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.append(node);
    return node;
  };

  // Recessive grid and y ticks.
  for (let value = 0; value <= max; value += step) {
    const i = value;
    const gy = y(value);
    el('line', { x1: pad.left, x2: width - pad.right, y1: gy, y2: gy, class: i ? 'grid' : 'baseline' });
    el('text', { x: pad.left - 8, y: gy + 4, class: 'tick', 'text-anchor': 'end' }).textContent = compact(value);
  }

  // X labels: a few, at whole hours/days.
  const every = unit === 'day' ? 5 : buckets.length > 48 ? 24 : 6;
  buckets.forEach((b, i) => {
    const d = bucketDate(b.t);
    const local = unit === 'day' ? d.getDate() : d.getHours();
    const show = unit === 'day' ? i % every === 0 : buckets.length > 48 ? local === 0 : local % every === 0;
    if (!show) return;
    const label = unit === 'day' || buckets.length > 48
      ? d.toLocaleDateString(LANG, { day: 'numeric', month: 'numeric' })
      : `${String(local).padStart(2, '0')}:00`;
    el('text', { x: pad.left + band * i + band / 2, y: height - 6, class: 'tick', 'text-anchor': 'middle' }).textContent = label;
  });

  // Columns: rounded data end, square at the baseline.
  const bars = el('g', { class: 'bars' });
  buckets.forEach((b, i) => {
    if (!b.views) return;
    const x = pad.left + band * i + (band - barW) / 2;
    const top = y(b.views);
    const h = pad.top + innerH - top;
    const r = Math.min(4, barW / 2, h);
    el('path', {
      d: `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`,
      'data-i': i,
    }, bars);
  });

  // Hover: the whole column slot is the hit target.
  const hits = el('g', { class: 'hits' });
  buckets.forEach((b, i) => el('rect', { x: pad.left + band * i, y: pad.top, width: band, height: innerH, 'data-i': i }, hits));
  hits.onpointermove = (e) => {
    const i = Number(e.target.dataset.i);
    if (Number.isNaN(i)) return;
    const b = buckets[i];
    $('b', tip).textContent = t('stats.viewsCount', { n: b.views.toLocaleString(LANG) });
    $('span', tip).textContent = bucketLabel(b.t, unit);
    tip.hidden = false;
    // Beside the column, inside the plot, flipping to the left near the right edge.
    const right = pad.left + band * (i + 1) + 6;
    const flip = right + tip.offsetWidth > width;
    tip.style.setProperty('--x', `${flip ? pad.left + band * i - 6 - tip.offsetWidth : right}px`);
    tip.style.setProperty('--y', `${pad.top}px`);
    for (const p of bars.children) p.classList.toggle('hover', p.dataset.i === String(i));
  };
  hits.onpointerleave = () => {
    tip.hidden = true;
    for (const p of bars.children) p.classList.remove('hover');
  };

  const total = buckets.reduce((sum, b) => sum + b.views, 0);
  $('.chart-empty', chart).hidden = total > 0;
  $('.chart-empty', chart).textContent = t('stats.none');
  chart.setAttribute('aria-label', t('stats.aria', { n: total.toLocaleString(LANG) }));
}

function compact(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
