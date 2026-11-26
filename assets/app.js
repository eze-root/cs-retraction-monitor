/* CS 撤稿监测网站（中 / 英）：读取 data/*.json，渲染图表与表格。无构建步骤；依赖本地 vendor/echarts 与 assets/i18n.js。 */
(() => {
  'use strict';

  // ------------------------------------------------------------ 语言
  const params = new URLSearchParams(location.search);
  const pickLang = (v) => (v === 'en' || v === 'zh' ? v : null);
  const lang = pickLang(params.get('lang')) || pickLang(localStorage.getItem('rm-lang')) ||
    ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
  const DICT = window.I18N[lang], LABELS = lang === 'en' ? window.I18N_LABELS : {};
  const t = (k, vars = {}) => {
    const s = DICT[k] ?? window.I18N.zh[k] ?? k;
    return s.replace(/\{(\w+)\}/g, (_, v) => (vars[v] ?? `{${v}}`));
  };
  // 数据文件里的中文标签 → 当前语言
  const L = (s) => {
    if (lang !== 'en' || s == null) return s;
    if (LABELS[s]) return LABELS[s];
    const m = /^期刊池平均（每万篇 ([\d.]+)）$/.exec(s);
    return m ? `Pool average (${m[1]} per 10k)` : s;
  };
  const NUM_LOCALE = lang === 'en' ? 'en-US' : 'zh-CN';

  // ------------------------------------------------------------ 主题与配色
  // 类别色按固定顺序分配给实体（不按排名循环）；第 7 类以后归入“其他”。
  const PALETTE = {
    light: { cat: ['#2f6bd8', '#d9771e', '#16916d', '#b4508f', '#4ea3d9', '#b2442a', '#7a5cc4'],
             other: '#a3a9b4', ink: '#1b1f27', ink2: '#4a5160', ink3: '#7b8291', grid: '#e8ebf0', surface: '#ffffff' },
    dark:  { cat: ['#6d9bf0', '#f0a050', '#3cc395', '#dc7ab6', '#7fc2ec', '#e07055', '#a68ae6'],
             other: '#69707d', ink: '#e7eaf0', ink2: '#b2b8c4', ink3: '#848b99', grid: '#2a303c', surface: '#171b23' },
  };
  const OTHER_LABELS = new Set(['其他出版社', '其他']);
  let theme = params.get('theme') || localStorage.getItem('rm-theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const P = () => PALETTE[theme];
  // ECharts 需要具体字体名才能正确测量图例文字宽度（'inherit' 会导致重叠）。
  const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif';

  // ------------------------------------------------------------ 工具函数
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString(NUM_LOCALE));
  const pct = (x, d = 1) => (x == null ? '–' : (x * 100).toFixed(d) + '%');
  const shortPub = (s) => L(String(s).replace(' (bought by Sage November 2023)', '').replace(' - Nature Publishing Group', ' Nature'));
  const doiLink = (d) => (d ? `<a href="https://doi.org/${encodeURI(d)}" target="_blank" rel="noopener noreferrer">${esc(d)}</a>` : '<span class="muted">–</span>');

  let DATA = null;
  const charts = new Map();
  const pubColorMap = {};
  function pubColor(name) {
    if (OTHER_LABELS.has(name)) return P().other;
    const i = pubColorMap[name];
    return i == null ? P().other : P().cat[i];
  }

  function applyStaticText() {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    const lt = $('#lang-toggle');
    lt.textContent = t('lang.switch'); lt.title = t('lang.switchTitle'); lt.setAttribute('aria-label', t('lang.switchTitle'));
    $('#theme-toggle').setAttribute('aria-label', t('theme.toggle'));
  }

  // ECharts 公共样式：细线、弱网格、带悬停提示。
  function base(extra = {}) {
    const p = P();
    const axis = {
      axisLine: { lineStyle: { color: p.grid } }, axisTick: { show: false },
      axisLabel: { color: p.ink3, fontSize: 11.5 }, splitLine: { lineStyle: { color: p.grid, type: 'dashed' } },
      nameTextStyle: { color: p.ink3, fontSize: 11.5 },
    };
    return {
      backgroundColor: 'transparent', animationDuration: 400,
      textStyle: { color: p.ink2, fontFamily: FONT },
      grid: { left: 56, right: 24, top: 64, bottom: 36, containLabel: false },
      legend: { top: 0, left: 0, itemGap: 14, textStyle: { color: p.ink2, fontSize: 12, fontFamily: FONT }, itemWidth: 12, itemHeight: 8, icon: 'roundRect' },
      tooltip: { trigger: 'axis', backgroundColor: p.surface, borderColor: p.grid, textStyle: { color: p.ink, fontSize: 12.5 },
                 axisPointer: { type: 'shadow', shadowStyle: { color: theme === 'dark' ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.04)' } } },
      _axis: axis,
      ...extra,
    };
  }
  const shade = () => (theme === 'dark' ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.04)');
  const xAxisOf = (o, data, more = {}) => ({ type: 'category', data, ...o._axis, splitLine: { show: false }, ...more });
  const yAxisOf = (o, more = {}) => ({ type: 'value', ...o._axis, ...more });
  const pctAxis = (o, max = 1) => yAxisOf(o, { max, axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } });
  const barSeries = (name, data, color, more = {}) => ({
    name, type: 'bar', data, barMaxWidth: 26, itemStyle: { color, borderColor: P().surface, borderWidth: 1 }, emphasis: { focus: 'series' }, ...more,
  });
  const lineSeries = (name, data, color, more = {}) => ({
    name, type: 'line', data, symbol: 'circle', symbolSize: 7, lineStyle: { width: 2, color }, itemStyle: { color, borderColor: P().surface, borderWidth: 1.5 },
    emphasis: { focus: 'series' }, ...more,
  });
  const roundTop = (series) => { if (series.length) series[series.length - 1].itemStyle.borderRadius = [4, 4, 0, 0]; return series; };
  const single = (color, dir = 'v') => ({ itemStyle: { color, borderRadius: dir === 'v' ? [4, 4, 0, 0] : [0, 4, 4, 0] } });
  const hbarGrid = (o, left = 170) => { o.grid = { ...o.grid, left, top: 20 }; return o; };

  // ------------------------------------------------------------ 图卡片（图 / 表 切换 + 多视图）
  function chartCard(id, spec) {
    const el = document.getElementById(id);
    if (!el) return;
    const views = spec.views;
    let vi = 0, mode = 'chart';
    const viewSeg = views.length > 1
      ? `<div class="seg" data-role="views">${views.map((v, i) => `<button type="button" data-i="${i}" class="${i ? '' : 'on'}">${esc(v.label)}</button>`).join('')}</div>` : '';
    el.innerHTML = `
      <div class="card-head">
        <div><h3>${esc(spec.title)}</h3>${spec.sub ? `<p class="sub">${esc(spec.sub)}</p>` : ''}</div>
        <div style="display:flex;gap:8px">${viewSeg}
          <div class="seg" data-role="mode"><button type="button" data-m="chart" class="on">${t('common.chart')}</button><button type="button" data-m="table">${t('common.table')}</button></div>
        </div>
      </div>
      <div class="chart ${spec.tall ? 'tall' : ''}" role="img" aria-label="${esc(spec.title)}"></div>
      <div class="table-wrap" hidden><table class="data"></table></div>
      ${spec.note ? `<p class="note">${esc(spec.note)}</p>` : ''}`;
    const chartEl = $('.chart', el), tableWrap = $('.table-wrap', el);
    const render = () => {
      const v = views[vi];
      if (mode === 'chart') {
        chartEl.hidden = false; tableWrap.hidden = true;
        let inst = echarts.getInstanceByDom(chartEl);
        if (inst) inst.dispose();
        inst = echarts.init(chartEl, null, { renderer: 'svg' });
        const opt = v.option(); delete opt._axis;
        inst.setOption(opt);
        charts.get(id).inst = inst;
      } else {
        chartEl.hidden = true; tableWrap.hidden = false;
        const tb = v.table();
        $('table', el).innerHTML = renderTable(tb.cols, tb.rows);
      }
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const seg = b.parentElement;
      if (seg.dataset.role === 'views') vi = +b.dataset.i;
      else if (seg.dataset.role === 'mode') mode = b.dataset.m;
      else return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      render();
    });
    charts.set(id, { render, inst: null, el });
    render();
  }

  function renderTable(cols, rows) {
    const head = `<thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>`;
    const body = rows.map((r) => `<tr>${cols.map((c) => {
      const v = r[c.k];
      const out = c.html ? c.html(v, r) : esc(c.fmt ? c.fmt(v, r) : v);
      return `<td class="${c.num ? 'num' : ''}">${out}</td>`;
    }).join('')}</tr>`).join('');
    return head + `<tbody>${body}</tbody>`;
  }
  const tiles = (el, items) => {
    el.innerHTML = items.map(([l, v, s]) => `<div class="tile"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="hint">${esc(s)}</div></div>`).join('');
  };
  const notGenerated = (el, cmd) => { el.innerHTML = `<div class="card">${esc(t('common.notGenerated', { cmd }))}</div>`; };

  // ------------------------------------------------------------ 数据加载
  async function load() {
    const get = (f) => fetch(`data/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
    const opt = (f) => get(f).catch(() => null);
    const [meta, rq1, rates, rq2, rq3] = await Promise.all([get('meta.json'), get('rq1.json'), opt('rates.json'), opt('rq2.json'), opt('rq3.json')]);
    DATA = { meta, rq1, rates, rq2, rq3, records: null };
    rq1.top_publishers.forEach((p, i) => { if (i < 6) pubColorMap[p.publisher] = i; });
  }
  async function loadRecords() {
    if (!DATA.records) DATA.records = await fetch('data/records.json').then((r) => r.json());
    return DATA.records;
  }
  const incompleteBar = (year, v) => (year === DATA.rq1.definitions.incomplete_year ? { value: v, itemStyle: { opacity: 0.45 } } : v);
  const lagYears = (d) => (d / 365).toFixed(1);

  // ------------------------------------------------------------ 概览
  function rq3Forecast() {
    const c = DATA.rq3 && DATA.rq3.completion_forecast;
    if (!c) return null;
    const s = c.summary_2023_2024, f = s['快速时滞'], sl = s['慢速时滞'];
    return { obs: f.observed, lo: Math.min(f.pred_total, sl.pred_total), hi: Math.max(f.pred_total, sl.pred_total),
             rlo: Math.min(f.pred_remaining, sl.pred_remaining), rhi: Math.max(f.pred_remaining, sl.pred_remaining),
             plo: Math.min(f.pred_per_10k, sl.pred_per_10k), phi: Math.max(f.pred_per_10k, sl.pred_per_10k) };
  }

  function renderOverview() {
    const { rq1 } = DATA, h = rq1.headline;
    const items = [
      [t('tile.cs'), fmt(h.cs_retractions), t('tile.csHint')],
      [t('tile.journal'), fmt(h.journal_retractions), t('tile.journalHint', { n: fmt(h.journal_unique_original_doi) })],
      [t('tile.journals'), fmt(h.journals), t('tile.journalsHint', { n: fmt(h.publishers) })],
      [t('tile.peak'), String(h.peak_year), t('tile.peakHint', { n: fmt(h.peak_year_n) })],
      [t('tile.batch'), pct(rq1.batches.share_in_batches), t('tile.batchHint', { n: rq1.batches.threshold })],
      [t('tile.lag'), t('tile.lagVal', { y: lagYears(h.median_lag_days) }), t('tile.lagHint', { d: fmt(h.median_lag_days) })],
    ];
    if (DATA.rates) { const cv = DATA.rates.coverage; items.splice(3, 0, [t('tile.rate'), String(cv.window_per_10k), t('tile.rateHint', { a: cv.window[0], b: cv.window[1] })]); }
    tiles($('#kpi-tiles'), items);

    const c = rq1.concentration, by = Object.fromEntries(rq1.yearly.map((r) => [r.year, r]));
    const topReason = rq1.reasons.find((r) => !/^Investigation/.test(r.reason));
    const bj = rq1.top_batches[0];
    const f = [
      t('f.growth', { share: pct(h.share_since_2022), peak: fmt(h.peak_year_n), h: fmt(by[2023].journal_hindawi) }),
      t('f.conc', { n: fmt(c.journal.n_entities), k: c.journal.entities_for_50pct, top10: pct(c.journal.top10_share), p: c.publisher.entities_for_50pct, hhi: c.publisher.hhi }),
      t('f.batch', { share: pct(rq1.batches.share_in_batches), thr: rq1.batches.threshold, j: esc(bj.journal), date: bj.notice_date, n: fmt(bj.n) }),
      t('f.reason', { r: esc(topReason.reason), s: pct(topReason.journal_share), a: pct(h.aigc_label_share) }),
      t('f.geo', { list: rq1.countries.slice(0, 2).map((x) => `${esc(x.country)} ${pct(x.share_of_records)}`).join(lang === 'en' ? ', ' : '，') }),
      t('f.lag', { y: lagYears(h.median_lag_days), s: pct(rq1.lag.within_1y_share) }),
    ];
    if (DATA.rates) {
      const R = DATA.rates, d = R.rate_distribution, tp = R.top_by_rate[0];
      f.push(t('f.rate', { a: R.coverage.window[0], b: R.coverage.window[1], r: R.coverage.window_per_10k, min: fmt(R.coverage.min_works_for_ranking),
                           med: d.median_per_10k.toFixed(1), j: esc(tp.journal_rw), max: fmt(Math.round(tp.per_10k)) }));
    }
    if (DATA.rq2) f.push(t('f.rq2', { n: DATA.rq2.headline.explicit_llm_mentions, a: pct(DATA.rq2.headline.aigc_share_among_pre_chatgpt), b: pct(DATA.rq2.headline.aigc_share_among_post_chatgpt) }));
    const fc = rq3Forecast();
    if (DATA.rq3 && fc) f.push(t('f.rq3', { auc: DATA.rq3.content_model.auc.toFixed(2), lo: fmt(Math.round(fc.rlo / 10) * 10), hi: fmt(Math.round(fc.rhi / 10) * 10) }));
    $('#findings').innerHTML = f.map((s) => `<li>${s}</li>`).join('');

    const prog = [['ok', 'ov.done', 'ov.p1'], ['ok', 'ov.done', 'ov.p2'], ['ok', 'ov.done', 'ov.p3'], ['run', 'ov.running', 'ov.p4'], ['run', 'ov.running', 'ov.p5']];
    $('#roadmap').innerHTML = prog.map(([cls, b, k]) => `<li><span class="badge ${cls}">${t(b)}</span> ${esc(t(k))}</li>`).join('');

    const years = rq1.yearly.filter((r) => r.year >= 2014);
    chartCard('card-overview-trend', {
      title: t('ch.trend'), sub: t('ch.trendSub', { date: DATA.meta.snapshot_date.slice(0, 10) }),
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, xAxis: xAxisOf(o, years.map((r) => r.year)), yAxis: yAxisOf(o, { name: t('common.records') }),
          series: [barSeries(t('ser.journal'), years.map((r) => incompleteBar(r.year, r.journal_by_notice_year)), P().cat[0], single(P().cat[0])),
                   lineSeries(t('ser.conf'), years.map((r) => r.conference_by_notice_year), P().cat[6])] };
      }, table: () => ({ cols: [{ k: 'year', label: t('common.year') }, { k: 'journal_by_notice_year', label: t('ser.journal'), num: 1, fmt }, { k: 'conference_by_notice_year', label: t('col.conf'), num: 1, fmt }], rows: years }) }],
    });

    loadRecords().then((rec) => {
      const C = colIndex(rec);
      $('#latest-table').innerHTML = renderTable([
        { k: 'notice_date', label: t('col.date') },
        { k: 'title', label: t('col.title'), html: (v) => `<span class="title-cell">${esc(v)}</span>` },
        { k: 'journal', label: t('common.journal') },
        { k: 'reasons', label: t('col.reasons'), html: (v) => v.slice(0, 3).map((x) => `<span class="chip">${esc(x)}</span>`).join('') + (v.length > 3 ? `<span class="muted small">+${v.length - 3}</span>` : '') },
      ], rec.rows.slice(0, 15).map((r) => rowObj(rec, C, r)));
    });
  }

  // ------------------------------------------------------------ RQ1
  function renderRQ1() {
    const r = DATA.rq1, years = r.yearly.filter((x) => x.year >= 2014), X = years.map((x) => x.year);
    const yearlyTable = (keys) => () => ({ cols: [{ k: 'year', label: t('common.year') }, ...keys.map(([k, l]) => ({ k, label: l, num: 1, fmt }))], rows: years });

    chartCard('card-yearly', {
      title: t('ch.yearly'), sub: t('ch.yearlySub'), note: t('ch.yearlyNote'),
      views: [
        { label: t('v.byNotice'), option: () => {
          const o = base();
          return { ...o, xAxis: xAxisOf(o, X), yAxis: yAxisOf(o, { name: t('common.records') }),
            series: [
              ...roundTop([barSeries('Hindawi', years.map((y) => incompleteBar(y.year, y.journal_hindawi)), pubColor('Hindawi'), { stack: 's' }),
                           barSeries(t('ser.otherPub'), years.map((y) => incompleteBar(y.year, y.journal_excl_hindawi)), P().other, { stack: 's' })]),
              lineSeries(t('ser.confCtl'), years.map((y) => y.conference_by_notice_year), P().cat[6]),
            ] };
        }, table: yearlyTable([['journal_by_notice_year', t('col.total')], ['journal_hindawi', 'Hindawi'], ['journal_excl_hindawi', t('ser.otherPub')], ['journal_unique_original_doi', t('col.uniqueDoi')], ['journal_in_batch', t('col.batch')], ['conference_by_notice_year', t('col.conf')]]) },
        { label: t('v.byPub'), option: () => {
          const o = base();
          return { ...o, xAxis: xAxisOf(o, X), yAxis: yAxisOf(o, { name: t('common.records') }),
            series: [barSeries(t('ser.byPub'), years.map((y) => y.journal_by_pub_year), P().cat[0], single(P().cat[0]))] };
        }, table: yearlyTable([['journal_by_pub_year', t('ser.byPub')]]) },
        { label: t('v.batch'), option: () => {
          const o = base();
          return { ...o, xAxis: xAxisOf(o, X), yAxis: yAxisOf(o, { name: t('common.records') }),
            series: roundTop([
              barSeries(t('ser.inBatch', { n: r.batches.threshold }), years.map((y) => incompleteBar(y.year, y.journal_in_batch)), P().cat[3], { stack: 's' }),
              barSeries(t('ser.scattered'), years.map((y) => incompleteBar(y.year, y.journal_by_notice_year - y.journal_in_batch)), P().cat[4], { stack: 's' }),
            ]) };
        }, table: yearlyTable([['journal_in_batch', t('col.batch')], ['journal_by_notice_year', t('col.total')]]) },
      ],
    });

    const pby = r.publisher_by_year, prow = pby.rows.filter((x) => x.notice_year >= 2014);
    chartCard('card-publisher-year', {
      title: t('ch.pubYear'), sub: t('ch.pubYearSub'),
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, legend: { ...o.legend, type: 'scroll' }, xAxis: xAxisOf(o, prow.map((x) => x.notice_year)), yAxis: yAxisOf(o, { name: t('common.records') }),
          series: roundTop(pby.columns.map((c) => barSeries(shortPub(c), prow.map((x) => incompleteBar(x.notice_year, x[c])), pubColor(c), { stack: 's' }))) };
      }, table: () => ({ cols: [{ k: 'notice_year', label: t('common.year') }, ...pby.columns.map((c) => ({ k: c, label: shortPub(c), num: 1, fmt }))], rows: prow }) }],
    });

    const lor = r.concentration.journal_lorenz, cj = r.concentration.journal;
    chartCard('card-lorenz', {
      title: t('ch.lorenz'), sub: t('ch.lorenzSub', { n: fmt(cj.n_entities), s: cj.singletons }),
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' }, valueFormatter: (v) => pct(v) } });
        return { ...o, legend: { show: false },
          xAxis: { type: 'log', name: t('ax.rankLog'), nameLocation: 'middle', nameGap: 26, min: 1, max: lor.length, ...o._axis, splitLine: { show: false } },
          yAxis: pctAxis(o),
          series: [lineSeries(t('ser.cum'), lor.map((p) => [p.rank, p.cum_share]), P().cat[0], { symbol: 'none', areaStyle: { opacity: 0.08 },
            markLine: { symbol: 'none', label: { color: P().ink3, formatter: '{b}' }, lineStyle: { color: P().ink3, type: 'dashed', width: 1 },
              data: [{ name: t('ml.top', { k: cj.entities_for_50pct, p: '50%' }), xAxis: cj.entities_for_50pct }, { name: t('ml.top', { k: cj.entities_for_80pct, p: '80%' }), xAxis: cj.entities_for_80pct }] } })] };
      }, table: () => ({ cols: [{ k: 'rank', label: t('col.rank'), num: 1 }, { k: 'cum_share', label: t('ser.cum'), num: 1, fmt: (v) => pct(v) }], rows: lor.filter((p) => p.rank <= 20 || p.rank % 50 === 0) }) }],
    });

    const tp = r.top_publishers.slice(0, 10).reverse();
    chartCard('card-publishers', {
      title: t('ch.pubs'), sub: t('ch.pubsSub', { k: r.concentration.publisher.entities_for_80pct }),
      views: [{ label: '', option: () => {
        const o = hbarGrid(base());
        return { ...o, legend: { show: false }, xAxis: yAxisOf(o), yAxis: xAxisOf(o, tp.map((p) => shortPub(p.publisher)), { axisLabel: { ...o._axis.axisLabel, width: 150, overflow: 'truncate' } }),
          series: [barSeries(t('common.records'), tp.map((p) => ({ value: p.n, itemStyle: { color: pubColor(p.publisher), borderRadius: [0, 4, 4, 0] } })), P().cat[0])] };
      }, table: () => ({ cols: [{ k: 'publisher', label: t('common.publisher'), fmt: shortPub }, { k: 'n', label: t('common.records'), num: 1, fmt }], rows: [...tp].reverse() }) }],
    });

    const bd = r.batches.size_distribution;
    chartCard('card-batch-dist', {
      title: t('ch.batchDist'), sub: t('ch.batchDistSub'),
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, legend: { show: false }, xAxis: xAxisOf(o, bd.map((b) => b.bucket), { name: t('ax.batchSize'), nameLocation: 'middle', nameGap: 26 }), yAxis: yAxisOf(o, { name: t('common.records') }),
          series: [barSeries(t('common.records'), bd.map((b) => b.records), P().cat[3], single(P().cat[3]))] };
      }, table: () => ({ cols: [{ k: 'bucket', label: t('col.bucket') }, { k: 'events', label: t('col.events'), num: 1, fmt }, { k: 'records', label: t('common.records'), num: 1, fmt }], rows: bd }) }],
    });
    $('#batch-table').innerHTML = renderTable([
      { k: 'notice_date', label: t('col.date') }, { k: 'journal', label: t('common.journal') }, { k: 'publisher', label: t('common.publisher'), fmt: shortPub }, { k: 'n', label: t('common.n'), num: 1, fmt },
    ], r.top_batches);

    const rs = r.reasons.slice(0, 16).reverse();
    const cohorts = [['journal_share', t('ser.csj'), P().cat[0]], ['journal_excl_hindawi_share', t('ser.csjExH'), P().cat[4]], ['conference_share', t('ser.confCtl'), P().cat[6]]];
    chartCard('card-reasons', {
      title: t('ch.reasons'), sub: t('ch.reasonsSub'), tall: true,
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, valueFormatter: (v) => pct(v) } }); o.grid = { ...o.grid, left: 330, top: 40 };
        return { ...o, xAxis: pctAxis(o), yAxis: xAxisOf(o, rs.map((x) => x.reason), { axisLabel: { ...o._axis.axisLabel, width: 310, overflow: 'truncate' } }),
          series: cohorts.map(([k, n, c]) => barSeries(n, rs.map((x) => x[k]), c, { barMaxWidth: 8, itemStyle: { color: c, borderRadius: [0, 3, 3, 0] } })) };
      }, table: () => ({ cols: [{ k: 'reason', label: t('col.reason') }, { k: 'journal_n', label: t('col.journalN'), num: 1, fmt }, ...cohorts.map(([k, n]) => ({ k, label: n, num: 1, fmt: (v) => pct(v) }))], rows: [...rs].reverse() }) }],
    });

    const th = r.themes_by_year;
    chartCard('card-themes', {
      title: t('ch.themes'), sub: t('ch.themesSub'),
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' }, valueFormatter: (v) => pct(v) } }); o.grid = { ...o.grid, top: 84 };
        return { ...o, xAxis: xAxisOf(o, th.rows.map((x) => x.notice_year)), yAxis: pctAxis(o), series: th.columns.map((c, i) => lineSeries(L(c), th.rows.map((x) => x[c]), P().cat[i])) };
      }, table: () => ({ cols: [{ k: 'notice_year', label: t('common.year') }, ...th.columns.map((c) => ({ k: c, label: L(c), num: 1, fmt: (v) => pct(v) }))], rows: th.rows }) }],
    });

    const ct = r.countries.slice(0, 12).reverse();
    chartCard('card-countries', {
      title: t('ch.countries'), sub: t('ch.countriesSub'),
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, valueFormatter: (v) => pct(v) } }); o.grid = { ...o.grid, left: 110 };
        return { ...o, legend: { show: false }, xAxis: yAxisOf(o, { axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } }), yAxis: xAxisOf(o, ct.map((x) => x.country)),
          series: [barSeries(t('common.share'), ct.map((x) => x.share_of_records), P().cat[2], single(P().cat[2], 'h'))] };
      }, table: () => ({ cols: [{ k: 'country', label: t('col.country') }, { k: 'n_records', label: t('common.records'), num: 1, fmt }, { k: 'share_of_records', label: t('common.share'), num: 1, fmt: (v) => pct(v) }], rows: [...ct].reverse() }) }],
    });

    const cy = r.countries_by_year;
    chartCard('card-country-year', {
      title: t('ch.countryYear'), sub: t('ch.countryYearSub'),
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' }, valueFormatter: (v) => pct(v) } });
        return { ...o, xAxis: xAxisOf(o, cy.rows.map((x) => x.notice_year)), yAxis: pctAxis(o), series: cy.columns.map((c, i) => lineSeries(c, cy.rows.map((x) => x[c]), P().cat[i])) };
      }, table: () => ({ cols: [{ k: 'notice_year', label: t('common.year') }, ...cy.columns.map((c) => ({ k: c, label: c, num: 1, fmt: (v) => pct(v) }))], rows: cy.rows }) }],
    });

    const lg = r.lag;
    chartCard('card-lag-hist', {
      title: t('ch.lagHist'), sub: t('ch.lagHistSub', { m: fmt(lg.median_days), a: fmt(lg.p25_days), b: fmt(lg.p75_days), x: fmt(lg.n_negative_or_missing) }),
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, legend: { show: false }, xAxis: xAxisOf(o, lg.hist.map((b) => L(b.bucket))), yAxis: yAxisOf(o, { name: t('common.records') }),
          series: [barSeries(t('common.records'), lg.hist.map((b) => b.n), P().cat[5], single(P().cat[5]))] };
      }, table: () => ({ cols: [{ k: 'bucket', label: t('col.lag'), fmt: L }, { k: 'n', label: t('common.records'), num: 1, fmt }], rows: lg.hist }) }],
    });
    chartCard('card-lag-year', {
      title: t('ch.lagYear'), sub: t('ch.lagYearSub'),
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' } } }); const c = P().cat[5];
        const dash = { lineStyle: { width: 1.2, type: 'dashed', color: c }, symbol: 'none' };
        return { ...o, xAxis: xAxisOf(o, lg.by_notice_year.map((x) => x.year)), yAxis: yAxisOf(o, { name: t('common.days') }),
          series: [lineSeries('P75', lg.by_notice_year.map((x) => x.p75), c, dash), lineSeries(t('ser.median'), lg.by_notice_year.map((x) => x.median), c),
                   lineSeries('P25', lg.by_notice_year.map((x) => x.p25), c, dash)] };
      }, table: () => ({ cols: [{ k: 'year', label: t('common.year') }, { k: 'count', label: 'n', num: 1, fmt }, { k: 'p25', label: 'P25', num: 1, fmt }, { k: 'median', label: t('ser.median'), num: 1, fmt }, { k: 'p75', label: 'P75', num: 1, fmt }], rows: lg.by_notice_year }) }],
    });
    renderRates();
  }

  function renderRates() {
    const R = DATA.rates;
    if (!R) { $('#rates-lede').textContent = t('common.notGenerated', { cmd: 'make openalex site' }); return; }
    const cv = R.coverage;
    $('#rates-lede').innerHTML = t('rates.lede', { m: fmt(cv.matched_records), n: fmt(cv.journal_records), s: fmt(cv.matched_sources) });
    const py = R.pool_by_pub_year.filter((x) => x.pub_year >= 2014);
    chartCard('card-rate-year', {
      title: t('ch.rateYear'), sub: t('ch.rateYearSub'),
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' } } }); const X = py.map((x) => x.pub_year);
        return { ...o, xAxis: xAxisOf(o, X), yAxis: yAxisOf(o, { name: t('common.per10k') }),
          series: [
            lineSeries(t('ser.pool'), py.map((x) => x.per_10k), P().cat[0], { markArea: { silent: true, itemStyle: { color: shade() }, data: [[{ xAxis: '2023' }, { xAxis: String(X[X.length - 1]) }]] } }),
            lineSeries(t('ser.poolExH'), py.map((x) => x.excl_hindawi_per_10k), P().other),
            lineSeries(t('ser.poolAigc'), py.map((x) => x.aigc_per_10k), P().cat[1]),
          ] };
      }, table: () => ({ cols: [{ k: 'pub_year', label: t('col.pubYear') }, { k: 'retracted_papers', label: t('col.retracted'), num: 1, fmt }, { k: 'works', label: t('col.works'), num: 1, fmt },
        { k: 'per_10k', label: t('common.per10k'), num: 1 }, { k: 'excl_hindawi_per_10k', label: t('col.exH'), num: 1 }, { k: 'aigc_per_10k', label: t('col.aigc'), num: 1 }], rows: py }) }],
    });
    const pr = [...R.publisher_rates].sort((a, b) => a.per_10k - b.per_10k);
    chartCard('card-rate-publisher', {
      title: t('ch.ratePub'), sub: t('ch.ratePubSub', { a: cv.window[0], b: cv.window[1] }),
      views: [{ label: '', option: () => {
        const o = hbarGrid(base());
        return { ...o, legend: { show: false }, xAxis: yAxisOf(o, { name: t('common.per10k') }),
          yAxis: xAxisOf(o, pr.map((p) => shortPub(p.publisher_rw)), { axisLabel: { ...o._axis.axisLabel, width: 150, overflow: 'truncate' } }),
          series: [barSeries(t('common.per10k'), pr.map((p) => ({ value: p.per_10k, itemStyle: { color: pubColor(p.publisher_rw), borderRadius: [0, 4, 4, 0] } })), P().other)] };
      }, table: () => ({ cols: [{ k: 'publisher_rw', label: t('common.publisher'), fmt: shortPub }, { k: 'retracted', label: t('col.retracted'), num: 1, fmt }, { k: 'works', label: t('col.works'), num: 1, fmt }, { k: 'per_10k', label: t('common.per10k'), num: 1 }], rows: [...pr].reverse() }) }],
    });
    $('#rate-table-sub').textContent = t('rateTable.sub', { a: cv.window[0], b: cv.window[1], min: fmt(cv.min_works_for_ranking) });
    $('#rate-table').innerHTML = renderTable([
      { k: 'journal_rw', label: t('common.journal') }, { k: 'retracted', label: t('col.retracted'), num: 1, fmt }, { k: 'works', label: t('col.works'), num: 1, fmt },
      { k: 'per_10k', label: t('common.per10k'), num: 1, html: (v, r) => `<b>${fmt(Math.round(v))}</b> <span class="muted small">(${fmt(Math.round(r.ci_low_per_10k))}–${fmt(Math.round(r.ci_high_per_10k))})</span>` },
    ], R.top_by_rate);
  }

  // ------------------------------------------------------------ 期刊榜单（可排序）
  function renderJournals() {
    const cols = [
      { k: 'journal', label: t('common.journal') }, { k: 'publisher', label: t('common.publisher'), fmt: shortPub },
      { k: 'n', label: t('common.records'), num: 1, fmt }, { k: 'first_notice_year', label: t('j.first'), num: 1 }, { k: 'last_notice_year', label: t('j.last'), num: 1 },
      { k: 'peak_notice_year', label: t('j.peak'), num: 1 }, { k: 'batch_share', label: t('j.batchShare'), num: 1, fmt: (v) => pct(v, 0) },
      { k: 'largest_batch', label: t('j.largest'), num: 1, fmt }, { k: 'median_lag_days', label: t('j.lag'), num: 1, fmt },
      { k: 'aigc_label_share', label: t('j.aigc'), num: 1, fmt: (v) => pct(v, 0) }, { k: 'top_reason', label: t('j.topReason') },
    ];
    const byJ = DATA.rates ? DATA.rates.by_journal_rw : {};
    if (DATA.rates) cols.splice(3, 0, { k: 'per_10k', label: t('j.per10k', { w: DATA.rates.coverage.window.join('–') }), num: 1, fmt: (v) => (v == null ? '–' : fmt(Math.round(v))) });
    const rows = DATA.rq1.top_journals.map((r) => ({ ...r, per_10k: byJ[r.journal] ? byJ[r.journal].per_10k : null }));
    const tbl = $('#journal-table');
    let key = 'n', asc = false;
    const draw = () => {
      rows.sort((a, b) => { const x = a[key] ?? -Infinity, y = b[key] ?? -Infinity; return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1); });
      tbl.innerHTML = renderTable(cols, rows);
      tbl.querySelectorAll('th').forEach((th, i) => { th.dataset.k = cols[i].k; th.classList.toggle('sorted', cols[i].k === key); th.classList.toggle('asc', cols[i].k === key && asc); });
    };
    tbl.addEventListener('click', (e) => {
      const th = e.target.closest('th'); if (!th) return;
      if (th.dataset.k === key) asc = !asc; else { key = th.dataset.k; asc = false; }
      draw();
    });
    draw();
  }

  // ------------------------------------------------------------ 记录检索
  const colIndex = (rec) => Object.fromEntries(rec.columns.map((c, i) => [c, i]));
  function rowObj(rec, C, r) {
    return { id: r[C.id], title: r[C.title], journal: r[C.journal], publisher: r[C.publisher], notice_date: r[C.notice_date],
             publication_date: r[C.publication_date], original_doi: r[C.original_doi], notice_doi: r[C.notice_doi],
             reasons: r[C.reasons].map((i) => rec.reason_vocab[i]), countries: r[C.countries], batch_size: r[C.batch_size] };
  }
  async function renderRecords() {
    const rec = await loadRecords(), C = colIndex(rec);
    const all = rec.rows.map((r) => { const o = rowObj(rec, C, r); o._hay = [o.title, o.journal, o.publisher, o.original_doi, o.notice_doi, o.countries.join(' ')].join(' ').toLowerCase(); return o; });
    const opts = (sel, vals, label = (v) => v) => { sel.insertAdjacentHTML('beforeend', vals.map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('')); };
    opts($('#f-year'), [...new Set(all.map((o) => o.notice_date.slice(0, 4)))].sort().reverse());
    opts($('#f-publisher'), DATA.rq1.top_publishers.map((p) => p.publisher), shortPub);
    opts($('#f-reason'), [...rec.reason_vocab].sort());
    const PAGE = 50; let page = 0, hits = all;
    const cols = [
      { k: 'notice_date', label: t('col.date') },
      { k: 'title', label: t('col.title'), html: (v, r) => `<span class="title-cell">${esc(v)}</span><br><span class="muted small">${t('r.orig')} ${doiLink(r.original_doi)} · ${t('r.notice')} ${doiLink(r.notice_doi)}</span>` },
      { k: 'journal', label: t('col.journalPub'), html: (v, r) => `${esc(v)}<br><span class="muted small">${esc(shortPub(r.publisher))}${r.batch_size >= 10 ? ` · ${t('r.batchN', { n: r.batch_size })}` : ''}</span>` },
      { k: 'publication_date', label: t('col.pubDate') },
      { k: 'reasons', label: t('col.reasons'), html: (v) => v.map((x) => `<span class="chip">${esc(x)}</span>`).join('') },
      { k: 'countries', label: t('col.country'), fmt: (v) => v.join(', ') },
    ];
    const draw = () => {
      const n = hits.length, pages = Math.max(1, Math.ceil(n / PAGE));
      page = Math.min(page, pages - 1);
      $('#rec-table').innerHTML = renderTable(cols, hits.slice(page * PAGE, page * PAGE + PAGE));
      $('#rec-count').textContent = t('r.count', { a: fmt(n), b: fmt(all.length) });
      $('#page-info').textContent = `${page + 1} / ${pages}`;
      $('#prev').disabled = page === 0; $('#next').disabled = page >= pages - 1;
    };
    const filter = () => {
      const q = $('#q').value.trim().toLowerCase(), y = $('#f-year').value, p = $('#f-publisher').value, rs = $('#f-reason').value, b = $('#f-batch').checked;
      hits = all.filter((o) => (!q || o._hay.includes(q)) && (!y || o.notice_date.startsWith(y)) && (!p || o.publisher === p)
        && (!rs || o.reasons.includes(rs)) && (!b || o.batch_size >= 10));
      page = 0; draw();
    };
    let tm; $('#q').addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(filter, 150); });
    ['#f-year', '#f-publisher', '#f-reason', '#f-batch'].forEach((s) => $(s).addEventListener('change', filter));
    $('#prev').addEventListener('click', () => { page--; draw(); });
    $('#next').addEventListener('click', () => { page++; draw(); });
    draw();
  }

  // ------------------------------------------------------------ RQ2
  function renderRQ2() {
    const Q = DATA.rq2;
    if (!Q) return notGenerated($('#rq2-tiles'), 'make rq2 site');
    const h = Q.headline, E = Q.eras, postX = E['ChatGPT 后·排除最大期刊'], post = E['ChatGPT 后'];
    tiles($('#rq2-tiles'), [
      [t('t2.aigc'), fmt(h.aigc_label), t('t2.aigcHint', { s: pct(h.aigc_label_share) })],
      [t('t2.post'), fmt(h.aigc_post_chatgpt), t('t2.postHint', { n: fmt(h.aigc_pre_chatgpt) })],
      [t('t2.exTop'), fmt(postX.n), t('t2.exTopHint', { n: fmt(postX.journals) })],
      [t('t2.inf'), fmt(h.informative_notices), t('t2.infHint', { s: pct(h.informative_notices / h.journal_records) })],
      [t('t2.llm'), fmt(h.explicit_llm_mentions), t('t2.llmHint')],
    ]);
    const tort = Q.notice_mechanisms.find((m) => m.mechanism.startsWith('非标准'));
    $('#rq2-findings').innerHTML = [
      t('f2.1', { n: fmt(h.journal_records), i: fmt(h.informative_notices), l: h.explicit_llm_mentions }),
      t('f2.2', { a: pct(h.aigc_share_among_pre_chatgpt), b: pct(h.aigc_share_among_post_chatgpt) }),
      t('f2.3', { n: fmt(post.n), s: pct(post.top_journal_share), j: esc(post.top_journal), bs: pct(post.in_batch_share), x: fmt(postX.n) }),
      t('f2.4', { s: pct(tort.among_aigc_label) }),
    ].map((x) => `<li>${x}</li>`).join('');

    $('#tier-table').innerHTML = renderTable([
      { k: 'tier', label: t('col.tier'), fmt: L }, { k: 'n', label: t('common.records'), num: 1, fmt }, { k: 'share', label: t('common.share'), num: 1, fmt: (v) => pct(v) },
      { k: 'in_batch_share', label: t('col.batchShare'), num: 1, fmt: (v) => pct(v, 0) }, { k: 'median_lag_days', label: t('col.lagDays'), num: 1, fmt },
    ], [{ tier: t('tier.A'), n: h.explicit_llm_mentions, share: h.explicit_llm_mentions / h.journal_records, in_batch_share: null, median_lag_days: null },
        ...Q.tiers.filter((x) => !x.tier.startsWith('A'))]);

    const bp = Q.aigc_by_pub_year.filter((x) => x.pub_year >= 2016 && x.pub_year <= 2025);
    chartCard('card-aigc-pub', {
      title: t('ch.aigcPub'), sub: t('ch.aigcPubSub'),
      views: [{ label: t('v.count'), option: () => {
        const o = base();
        return { ...o, xAxis: xAxisOf(o, bp.map((x) => x.pub_year)), yAxis: yAxisOf(o, { name: t('common.records') }),
          series: roundTop([
            barSeries(t('ser.inBatch2'), bp.map((x) => x.aigc_label_batch), P().cat[3], { stack: 's', markArea: { silent: true, label: { show: true, position: 'insideTop', formatter: t('ma.postGpt'), color: P().ink3, fontSize: 11 }, itemStyle: { color: shade() }, data: [[{ xAxis: '2023' }, { xAxis: String(bp[bp.length - 1].pub_year) }]] } }),
            barSeries(t('ser.scattered2'), bp.map((x) => x.aigc_label_scattered), P().cat[4], { stack: 's' }),
          ]) };
      }, table: () => ({ cols: [{ k: 'pub_year', label: t('col.pubYear') }, { k: 'retracted', label: t('col.retTotal'), num: 1, fmt }, { k: 'aigc_label', label: t('col.labeled'), num: 1, fmt },
        { k: 'aigc_label_batch', label: t('col.batchN'), num: 1, fmt }, { k: 'aigc_label_scattered', label: t('col.scatN'), num: 1, fmt }, { k: 'aigc_share', label: t('col.labelShare'), num: 1, fmt: (v) => pct(v) }], rows: bp }) },
      ...(Q.aigc_rate_by_pub_year.length ? [{ label: t('v.per10k'), option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' } } }); const rr = Q.aigc_rate_by_pub_year.filter((x) => x.pub_year >= 2016);
        return { ...o, xAxis: xAxisOf(o, rr.map((x) => x.pub_year)), yAxis: yAxisOf(o, { name: t('common.per10k') }),
          series: [lineSeries(t('ser.labeledRate'), rr.map((x) => x.aigc_per_10k), P().cat[1]), lineSeries(t('ser.allRate'), rr.map((x) => x.per_10k), P().other)] };
      }, table: () => ({ cols: [{ k: 'pub_year', label: t('col.pubYear') }, { k: 'aigc_per_10k', label: t('ser.labeledRate'), num: 1 }, { k: 'per_10k', label: t('ser.allRate'), num: 1 }], rows: Q.aigc_rate_by_pub_year }) }] : []),
    ]});

    const bn = Q.aigc_by_notice_year_era.filter((x) => x.notice_year >= 2021);
    chartCard('card-aigc', {
      title: t('ch.aigcNotice'), sub: t('ch.aigcNoticeSub'),
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, xAxis: xAxisOf(o, bn.map((x) => x.notice_year)), yAxis: yAxisOf(o, { name: t('common.records') }),
          series: roundTop([barSeries(t('ser.preGpt'), bn.map((x) => incompleteBar(x.notice_year, x.pre_chatgpt)), P().other, { stack: 's' }),
                            barSeries(t('ser.postGpt'), bn.map((x) => incompleteBar(x.notice_year, x.post_chatgpt)), P().cat[1], { stack: 's' })]) };
      }, table: () => ({ cols: [{ k: 'notice_year', label: t('col.noticeYear') }, { k: 'pre_chatgpt', label: t('ser.preGpt'), num: 1, fmt }, { k: 'post_chatgpt', label: t('ser.postGpt'), num: 1, fmt }], rows: bn }) }],
    });

    const cov = [...Q.notice_text_coverage].reverse();
    chartCard('card-text-coverage', {
      title: t('ch.textCov'), sub: t('ch.textCovSub'),
      views: [{ label: '', option: () => {
        const o = hbarGrid(base({ tooltip: { ...base().tooltip, valueFormatter: (v) => pct(v) } }));
        return { ...o, legend: { show: false }, xAxis: pctAxis(o), yAxis: xAxisOf(o, cov.map((c) => shortPub(c.publisher)), { axisLabel: { ...o._axis.axisLabel, width: 150, overflow: 'truncate' } }),
          series: [barSeries(t('ser.informative'), cov.map((c) => ({ value: c.informative_share, itemStyle: { color: pubColor(c.publisher), borderRadius: [0, 4, 4, 0] } })), P().other)] };
      }, table: () => ({ cols: [{ k: 'publisher', label: t('common.publisher'), fmt: shortPub }, { k: 'n', label: t('common.records'), num: 1, fmt }, { k: 'openalex_text', label: t('col.hasText'), num: 1, fmt },
        { k: 'informative', label: t('ser.informative'), num: 1, fmt }, { k: 'informative_share', label: t('common.share'), num: 1, fmt: (v) => pct(v) }], rows: [...cov].reverse() }) }],
    });

    $('#mech-sub').textContent = t('mech.sub', { n: fmt(h.informative_notices) });
    $('#mech-table').innerHTML = renderTable([
      { k: 'mechanism', label: t('col.mech'), fmt: L }, { k: 'among_aigc_label', label: t('col.withLabel'), num: 1, fmt: (v) => pct(v) },
      { k: 'among_no_aigc_label', label: t('col.withoutLabel'), num: 1, fmt: (v) => pct(v) }, { k: 'informative_n', label: t('col.hits'), num: 1, fmt },
    ], Q.notice_mechanisms);
    $('#post-sub').textContent = t('post.sub', { j: post.top_journal, n: fmt(postX.n), s: pct(postX.in_batch_share) });
    $('#post-table').innerHTML = renderTable([{ k: 'journal', label: t('common.journal') }, { k: 'n', label: t('common.n'), num: 1, fmt }], postX.top_journals);
  }

  // ------------------------------------------------------------ RQ3
  function renderRQ3() {
    const Q = DATA.rq3;
    if (!Q) return notGenerated($('#rq3-tiles'), 'make rq3 site');
    const cm = Q.content_model, sr = Q.skill_rules, fair = Q.fairness.content_model, fc = rq3Forecast();
    const grp = (rows, g) => rows.find((x) => x.group === g) || {};
    const pool = Q.ppv_scenarios.find((x) => x.scenario.startsWith('期刊池') && x.fpr === 0.05);
    const vhi = Q.ppv_scenarios.find((x) => x.scenario.startsWith('极高') && x.fpr === 0.05);
    const cn = grp(fair, '中国').fpr, west = grp(fair, '欧美澳').fpr;
    const nPos = Q.data_flow.weighted_pos;
    tiles($('#rq3-tiles'), [
      [t('t3.auc'), cm.auc.toFixed(3), t('t3.aucHint', { t: Q.temporal.auc.toFixed(3) })],
      [t('t3.recall'), pct(cm.recall_at_fpr_5), t('t3.recallHint', { r: pct(cm.recall_at_fpr_1) })],
      [t('t3.ppv'), pct(pool.ppv, 2), t('t3.ppvHint')],
      [t('t3.rules'), pct(sr.recall, 2), t('t3.rulesHint', { n: sr.pos_with_tortured + sr.pos_with_llm_artifact, m: fmt(nPos) })],
      [t('t3.fair'), `${pct(cn)} / ${pct(west, 2)}`, t('t3.fairHint')],
      ...(fc ? [[t('t3.future'), `${fmt(Math.round(fc.rlo / 10) * 10)}–${fmt(Math.round(fc.rhi / 10) * 10)}`, t('t3.futureHint')]] : []),
    ]);
    $('#rq3-findings').innerHTML = [
      t('f3.1', { auc: cm.auc.toFixed(2), t: Q.temporal.auc.toFixed(2) }),
      t('f3.2', { n: sr.pos_with_tortured, m: fmt(nPos) }),
      t('f3.3', { p: pool.scenario.match(/[\d.]+/)[0], ppv: pct(pool.ppv, 2), hi: pct(vhi.ppv) }),
      t('f3.4', { cn: pct(cn), west: pct(west, 2) }),
      t('f3.5', { n: fmt(Q.prevention.flagged), d: fmt(Q.prevention.median_lag_days_flagged), py: fmt(Math.round(Q.prevention.total_paper_years_earlier)) }),
    ].map((x) => `<li>${x}</li>`).join('');

    chartCard('card-roc', {
      title: t('ch.roc'), sub: t('ch.rocSub'),
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { trigger: 'item', backgroundColor: P().surface, borderColor: P().grid, textStyle: { color: P().ink, fontSize: 12.5 },
          formatter: (p) => `${esc(p.seriesName)}<br>${t('ax.fpr')} ${pct(p.value[0])} · ${t('ax.tpr')} ${pct(p.value[1])}` } });
        o.grid = { ...o.grid, bottom: 48 };
        const ax = (name) => ({ type: 'value', min: 0, max: 1, name, nameLocation: 'middle', nameGap: 30, ...o._axis, axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } });
        return { ...o, xAxis: ax(t('ax.fpr')), yAxis: { ...ax(t('ax.tpr')), nameGap: 40 },
          series: [
            lineSeries(`${t('ser.content')} (AUC ${cm.auc.toFixed(2)})`, Q.roc.map((p) => [p.fpr, p.tpr]), P().cat[0], { symbol: 'none' }),
            { name: t('ser.rule'), type: 'scatter', data: [[sr.fpr, sr.recall]], symbolSize: 11, itemStyle: { color: P().cat[1], borderColor: P().surface, borderWidth: 2 } },
            lineSeries(t('ser.chance'), [[0, 0], [1, 1]], P().other, { symbol: 'none', lineStyle: { width: 1, type: 'dashed', color: P().other } }),
          ] };
      }, table: () => ({ cols: [{ k: 'fpr', label: t('ax.fpr'), num: 1, fmt: (v) => pct(v) }, { k: 'tpr', label: t('ax.tpr'), num: 1, fmt: (v) => pct(v) }],
                         rows: Q.roc.filter((_, i) => i % 6 === 0) }) }],
    });

    const mrow = (name, m, extra = {}) => ({ method: name, auc: m.auc, r1: m.recall_at_fpr_1, r5: m.recall_at_fpr_5, r10: m.recall_at_fpr_10, ...extra });
    $('#method-table').innerHTML = renderTable([
      { k: 'method', label: t('col.method') }, { k: 'auc', label: 'AUC', num: 1, fmt: (v) => (v == null ? '–' : v.toFixed(3)) },
      { k: 'r1', label: t('col.r1'), num: 1, fmt: (v) => pct(v) }, { k: 'r5', label: t('col.r5'), num: 1, fmt: (v) => pct(v) }, { k: 'r10', label: t('col.r10'), num: 1, fmt: (v) => pct(v) },
    ], [
      { method: t('m.rules'), auc: null, r1: null, r5: sr.recall, r10: null },
      { method: t('m.skillOnly'), auc: Q.baselines_auc.skill_counts_only },
      { method: t('m.struct'), auc: Q.baselines_auc.structural_only },
      mrow(t('m.content'), cm), mrow(t('m.temporal'), Q.temporal),
      mrow(t('m.country'), Q.content_plus_country_ablation), mrow(t('m.fair'), Q.content_model_fairness_weighted),
    ]);

    const order = ['中国', '其他地区', '未知', '印度', '欧美澳'];
    const fw = Q.fairness.fairness_weighted;
    chartCard('card-fair', {
      title: t('ch.fair'), sub: t('ch.fairSub'),
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, valueFormatter: (v) => pct(v, 2) } });
        return { ...o, xAxis: xAxisOf(o, order.map(L), { axisLabel: { ...o._axis.axisLabel, interval: 0, width: 92, overflow: 'break', lineHeight: 14 } }), yAxis: yAxisOf(o, { axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } }),
          series: [barSeries(t('ser.content'), order.map((g) => grp(fair, g).fpr), P().cat[0], single(P().cat[0])),
                   barSeries(t('ser.fairW'), order.map((g) => grp(fw, g).fpr), P().cat[2], single(P().cat[2]))] };
      }, table: () => ({ cols: [{ k: 'group', label: t('col.group'), fmt: L }, { k: 'n_neg', label: t('col.nNeg'), num: 1, fmt }, { k: 'n_pos', label: t('col.nPos'), num: 1, fmt },
        { k: 'fpr', label: t('col.fpr'), num: 1, fmt: (v) => pct(v, 2) }, { k: 'recall', label: t('col.recall'), num: 1, fmt: (v) => pct(v) }, { k: 'within_group_auc', label: t('col.withinAuc'), num: 1, fmt: (v) => (v == null ? '–' : v.toFixed(2)) }],
        rows: order.map((g) => grp(fair, g)) }) }],
    });

    $('#ppv-table').innerHTML = renderTable([
      { k: 'scenario', label: t('col.scenario'), fmt: L }, { k: 'fpr', label: t('col.threshold'), fmt: (v) => `FPR ${pct(v, 0)}` },
      { k: 'recall', label: t('col.recall'), num: 1, fmt: (v) => pct(v) }, { k: 'ppv', label: t('col.ppv'), num: 1, html: (v) => `<b>${pct(v, 2)}</b>` },
      { k: 'flags_per_1000', label: t('col.flags'), num: 1 }, { k: 'true_flags_per_1000', label: t('col.trueFlags'), num: 1 },
    ], Q.ppv_scenarios);

    const chips = (arr) => arr.slice(0, 24).map((x) => `<span class="chip">${esc(x.term)}</span>`).join('');
    $('#terms-up').innerHTML = chips(Q.top_terms.toward_retracted);
    $('#terms-down').innerHTML = chips(Q.top_terms.toward_not_retracted);

    const cf = Q.completion_forecast.scenarios, fast = cf['快速时滞'].rows, slow = cf['慢速时滞'].rows;
    const yrs = slow.map((x) => x.pub_year).filter((y) => y >= 2020);
    const at = (rows, y, k) => { const r = rows.find((x) => x.pub_year === y); return r && !r.too_early ? r[k] : null; };
    const obsAt = (y) => (slow.find((x) => x.pub_year === y) || {}).observed;
    chartCard('card-forecast', {
      title: t('ch.fc'), sub: fc ? t('fc.summary', { obs: fmt(fc.obs), lo: fmt(fc.lo), hi: fmt(fc.hi), plo: fc.plo, phi: fc.phi, rlo: fmt(fc.rlo), rhi: fmt(fc.rhi) }) : '',
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, xAxis: xAxisOf(o, yrs), yAxis: yAxisOf(o, { name: t('col.retracted') }),
          series: [barSeries(t('ser.observed'), yrs.map(obsAt), P().other, single(P().other)),
                   lineSeries(t('ser.fast'), yrs.map((y) => at(fast, y, 'pred_total')), P().cat[2]),
                   lineSeries(t('ser.slow'), yrs.map((y) => at(slow, y, 'pred_total')), P().cat[5])] };
      }, table: () => ({ cols: [{ k: 'y', label: t('col.pubYear') }, { k: 'obs', label: t('ser.observed'), num: 1, fmt }, { k: 'f', label: t('ser.fast'), num: 1, fmt }, { k: 's', label: t('ser.slow'), num: 1, fmt }],
                         rows: yrs.map((y) => ({ y, obs: obsAt(y), f: at(fast, y, 'pred_total'), s: at(slow, y, 'pred_total') })) }) }],
    });
    const bt = Q.journal_backtest_summary;
    $('#journal-note').textContent = t('rq3.journalNote', { rho: bt.spearman, p: bt.p_value, n: bt.journals });
  }

  // ------------------------------------------------------------ 方法
  function renderMethods() {
    const m = DATA.meta;
    const kv = [
      [t('kv.source'), 'Crossref / Retraction Watch (CC0)'], [t('kv.commit'), m.snapshot_commit], [t('kv.date'), m.snapshot_date],
      [t('kv.sha'), m.source_csv_sha256], [t('kv.all'), fmt(m.cohorts.all_records)], [t('kv.allRet'), fmt(m.cohorts.all_retractions)],
      [t('kv.cs'), fmt(m.cohorts.cs_retractions)], [t('kv.openalex'), t('kv.openalexVal', { d: (m.openalex_run || ['–']).join(', ') })],
      [t('kv.conf'), fmt(m.cohorts.cs_conference_retractions)], [t('kv.built'), m.site_built_at],
    ];
    $('#source-kv').innerHTML = kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('#flow-table').innerHTML = renderTable([{ k: 'step', label: t('col.step'), fmt: L }, { k: 'excluded', label: t('col.excluded'), num: 1, fmt }, { k: 'remaining', label: t('col.remaining'), num: 1, fmt }], DATA.rq1.selection_flow);
  }

  // ------------------------------------------------------------ 路由、主题、语言
  const rendered = new Set();
  const renderers = { overview: renderOverview, rq1: renderRQ1, journals: renderJournals, records: renderRecords, rq2: renderRQ2, rq3: renderRQ3, methods: renderMethods };
  function route() {
    const tab = location.hash.slice(1) || 'overview';
    const name = document.getElementById(`page-${tab}`) ? tab : 'overview';
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
    if (!rendered.has(name) && renderers[name]) { rendered.add(name); renderers[name](); }
    // 主题切换时隐藏页面上的图被标记为 dirty，可见后再重绘。
    charts.forEach((c) => { if (c.el.closest('.page.active')) { if (c.dirty) { c.dirty = false; c.render(); } else if (c.inst) c.inst.resize(); } });
  }
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('rm-theme', theme);
    charts.forEach((c) => { if (c.el.closest('.page.active')) c.render(); else c.dirty = true; });
  }
  $('#theme-toggle').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); });
  // 切换语言：保存偏好并重新加载（数据已被浏览器缓存，重绘全部文字最简单可靠）
  $('#lang-toggle').addEventListener('click', () => {
    const next = lang === 'en' ? 'zh' : 'en';
    localStorage.setItem('rm-lang', next);
    params.set('lang', next);
    location.href = `${location.pathname}?${params}${location.hash}`;
  });
  window.addEventListener('resize', () => charts.forEach((c) => c.inst && c.inst.resize()));
  window.addEventListener('hashchange', route);

  document.documentElement.dataset.theme = theme;
  applyStaticText();
  load().then(() => {
    const m = DATA.meta;
    $('#snapshot-line').textContent = t('brand.snapshot', { date: m.snapshot_date.slice(0, 10), snap: m.snapshot });
    route();
  }).catch((e) => {
    document.querySelector('main').innerHTML = `<div class="card"><h3>${t('common.loadFail')}</h3><p class="sub">${esc(e.message)}. ${t('common.loadFailHint')}</p></div>`;
  });
})();
