/* CS 撤稿监测网站：读取 data/*.json，渲染图表与表格。无构建步骤、无第三方依赖（除本地 vendor/echarts）。 */
(() => {
  'use strict';

  // ------------------------------------------------------------ 主题与配色
  // 类别色按固定顺序分配给实体（不按排名循环）；第 7 类以后归入“其他”。
  const PALETTE = {
    light: { cat: ['#2f6bd8', '#d9771e', '#16916d', '#b4508f', '#4ea3d9', '#b2442a', '#7a5cc4'],
             other: '#a3a9b4', ink: '#1b1f27', ink2: '#4a5160', ink3: '#7b8291', grid: '#e8ebf0', surface: '#ffffff' },
    dark:  { cat: ['#6d9bf0', '#f0a050', '#3cc395', '#dc7ab6', '#7fc2ec', '#e07055', '#a68ae6'],
             other: '#69707d', ink: '#e7eaf0', ink2: '#b2b8c4', ink3: '#848b99', grid: '#2a303c', surface: '#171b23' },
  };
  const OTHER_LABELS = new Set(['其他出版社', '其他']);
  let theme = new URLSearchParams(location.search).get('theme') || localStorage.getItem('rm-theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const P = () => PALETTE[theme];
  // ECharts 需要具体字体名才能正确测量图例文字宽度（'inherit' 会导致重叠）。
  const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif';

  // ------------------------------------------------------------ 工具函数
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString('zh-CN'));
  const pct = (x, d = 1) => (x == null ? '–' : (x * 100).toFixed(d) + '%');
  const shortPub = (s) => String(s).replace(' (bought by Sage November 2023)', '').replace(' - Nature Publishing Group', ' Nature');
  const doiLink = (d) => (d ? `<a href="https://doi.org/${encodeURI(d)}" target="_blank" rel="noopener noreferrer">${esc(d)}</a>` : '<span class="muted">–</span>');

  let DATA = null;
  const charts = new Map();   // id -> {render, inst}
  let pubColorMap = {};

  function pubColor(name) {
    if (OTHER_LABELS.has(name)) return P().other;
    const i = pubColorMap[name];
    return i == null ? P().other : P().cat[i];
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
  const xAxisOf = (o, data, more = {}) => ({ type: 'category', data, ...o._axis, splitLine: { show: false }, ...more });
  const yAxisOf = (o, more = {}) => ({ type: 'value', ...o._axis, ...more });
  const barSeries = (name, data, color, more = {}) => ({
    name, type: 'bar', data, barMaxWidth: 26, itemStyle: { color, borderColor: P().surface, borderWidth: 1 }, emphasis: { focus: 'series' }, ...more,
  });
  const lineSeries = (name, data, color, more = {}) => ({
    name, type: 'line', data, symbol: 'circle', symbolSize: 7, lineStyle: { width: 2, color }, itemStyle: { color, borderColor: P().surface, borderWidth: 1.5 },
    emphasis: { focus: 'series' }, ...more,
  });
  // 堆叠柱只给最顶层圆角。
  const roundTop = (series) => { if (series.length) series[series.length - 1].itemStyle.borderRadius = [4, 4, 0, 0]; return series; };

  // ------------------------------------------------------------ 图卡片（图 / 表 切换 + 多视图）
  // spec: {title, sub, note, tall, views: [{label, option: () => echartsOption, table: () => ({cols, rows})}]}
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
          <div class="seg" data-role="mode"><button type="button" data-m="chart" class="on">图</button><button type="button" data-m="table">表</button></div>
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
        const t = v.table();
        $('table', el).innerHTML = renderTable(t.cols, t.rows);
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

  // ------------------------------------------------------------ 数据加载
  async function load() {
    const get = (f) => fetch(`data/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
    const opt = (f) => get(f).catch(() => null);   // 可选模块：缺失时页面显示“尚未生成”
    const [meta, rq1, rates, rq2] = await Promise.all([get('meta.json'), get('rq1.json'), opt('rates.json'), opt('rq2.json')]);
    DATA = { meta, rq1, rates, rq2, records: null };
    rq1.top_publishers.forEach((p, i) => { if (i < 6) pubColorMap[p.publisher] = i; });
  }
  async function loadRecords() {
    if (!DATA.records) DATA.records = await fetch('data/records.json').then((r) => r.json());
    return DATA.records;
  }

  // ------------------------------------------------------------ 概览
  function renderOverview() {
    const { rq1 } = DATA, h = rq1.headline;
    const tiles = [
      ['CS 撤稿记录', fmt(h.cs_retractions), '含会议与跨学科'],
      ['CS 期刊撤稿', fmt(h.journal_retractions), `唯一原论文 DOI ${fmt(h.journal_unique_original_doi)}`],
      ['涉及期刊', fmt(h.journals), `${fmt(h.publishers)} 家出版社`],
      ['峰值年份', String(h.peak_year), `${fmt(h.peak_year_n)} 条`],
      ['批量撤稿占比', pct(rq1.batches.share_in_batches), `同日同刊 ≥${rq1.batches.threshold} 条`],
      ['发表→撤稿中位时滞', `${(h.median_lag_days / 365).toFixed(1)} 年`, `${fmt(h.median_lag_days)} 天`],
    ];
    if (DATA.rates) { const cv = DATA.rates.coverage; tiles.splice(3, 0, ['撤稿率（每万篇）', String(cv.window_per_10k), `${cv.window[0]}–${cv.window[1]} 年发表，撤稿期刊池`]); }
    $('#kpi-tiles').innerHTML = tiles.map(([l, v, s]) =>
      `<div class="tile"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="hint">${esc(s)}</div></div>`).join('');

    const c = rq1.concentration, yr = rq1.yearly, by = Object.fromEntries(yr.map((r) => [r.year, r]));
    const top3c = rq1.countries.slice(0, 2);
    const topTheme = rq1.reasons.find((r) => !/^Investigation/.test(r.reason));
    const bj = rq1.top_batches[0];
    $('#findings').innerHTML = [
      `<b>增长集中在 2022 年以后：</b>${pct(h.share_since_2022)} 的期刊撤稿记录发生在 2022 年及以后；2023 年达到峰值 ${fmt(h.peak_year_n)} 条（Hindawi ${fmt(by[2023].journal_hindawi)} 条）。`,
      `<b>来源高度集中：</b>${fmt(c.journal.n_entities)} 种期刊中，前 ${c.journal.entities_for_50pct} 种贡献一半记录，前 10 种占 ${pct(c.journal.top10_share)}；出版社层面前 ${c.publisher.entities_for_50pct} 家即过半（HHI = ${c.publisher.hhi}）。`,
      `<b>批量撤稿主导：</b>${pct(rq1.batches.share_in_batches)} 的记录属于同日同刊 ≥${rq1.batches.threshold} 条的批次；最大一批为 ${esc(bj.journal)} 在 ${bj.notice_date} 的 ${fmt(bj.n)} 条。`,
      `<b>原因以“不可靠结果 + 评审/引用操纵”为主：</b>最常见的非调查类标签是“${esc(topTheme.reason)}”（${pct(topTheme.journal_share)}）；“计算机生成内容”标签占 ${pct(h.aigc_label_share)}。`,
      `<b>地域集中：</b>${top3c.map((x) => `${esc(x.country)} ${pct(x.share_of_records)}`).join('，')} 的记录含该国作者（多国可重复计）。`,
      `<b>撤稿滞后：</b>发表到撤稿的中位时间约 ${(h.median_lag_days / 365).toFixed(1)} 年，一年内撤稿只占 ${pct(rq1.lag.within_1y_share)}。`,
      ...(DATA.rates ? [(() => { const R = DATA.rates, d = R.rate_distribution, t = R.top_by_rate[0];
        return `<b>撤稿率差异极大：</b>${R.coverage.window[0]}–${R.coverage.window[1]} 年发表的论文整体为每万篇 ${R.coverage.window_per_10k} 篇；发文 ≥${fmt(R.coverage.min_works_for_ranking)} 篇的期刊中位数仅 ${d.median_per_10k.toFixed(1)}，最高的 ${esc(t.journal_rw)} 达 ${fmt(Math.round(t.per_10k))}。`; })()] : []),
      ...(DATA.rq2 ? [`<b>RQ2：</b>开放声明文本中明确提到 LLM 的为 ${DATA.rq2.headline.explicit_llm_mentions} 条；“生成内容”标签在 ChatGPT 前后发表的论文中占比相近（${pct(DATA.rq2.headline.aigc_share_among_pre_chatgpt)} / ${pct(DATA.rq2.headline.aigc_share_among_post_chatgpt)}）。`] : []),
    ].map((s) => `<li>${s}</li>`).join('');

    const years = yr.filter((r) => r.year >= 2014);
    chartCard('card-overview-trend', {
      title: 'CS 期刊与会议撤稿记录数（按撤稿声明年份）',
      sub: `2026 年截至 ${DATA.meta.snapshot_date.slice(0, 10)}`,
      views: [{
        label: '', option: () => {
          const o = base();
          return { ...o, xAxis: xAxisOf(o, years.map((r) => r.year)), yAxis: yAxisOf(o, { name: '记录数' }),
            series: [barSeries('期刊', years.map((r) => incompleteBar(r.year, r.journal_by_notice_year)), P().cat[0], { itemStyle: { color: P().cat[0], borderRadius: [4, 4, 0, 0] } }),
                     lineSeries('会议（对照）', years.map((r) => r.conference_by_notice_year), P().cat[6])] };
        },
        table: () => ({ cols: [{ k: 'year', label: '年份' }, { k: 'journal_by_notice_year', label: '期刊', num: 1, fmt }, { k: 'conference_by_notice_year', label: '会议', num: 1, fmt }], rows: years }),
      }],
    });

    loadRecords().then((rec) => {
      const C = colIndex(rec);
      $('#latest-table').innerHTML = renderTable([
        { k: 'notice_date', label: '撤稿日期' },
        { k: 'title', label: '标题', html: (v) => `<span class="title-cell">${esc(v)}</span>` },
        { k: 'journal', label: '期刊' },
        { k: 'reasons', label: '来源原因', html: (v) => v.slice(0, 3).map((x) => `<span class="chip">${esc(x)}</span>`).join('') + (v.length > 3 ? `<span class="muted small">+${v.length - 3}</span>` : '') },
      ], rec.rows.slice(0, 15).map((r) => rowObj(rec, C, r)));
    });
  }
  // 不完整年份（快照当年）用浅色柱。
  function incompleteBar(year, v) {
    return year === DATA.rq1.definitions.incomplete_year ? { value: v, itemStyle: { opacity: 0.45 } } : v;
  }

  // ------------------------------------------------------------ RQ1
  function renderRQ1() {
    const r = DATA.rq1, years = r.yearly.filter((x) => x.year >= 2014), X = years.map((x) => x.year);
    const yearlyTable = (keys) => () => ({ cols: [{ k: 'year', label: '年份' }, ...keys.map(([k, l]) => ({ k, label: l, num: 1, fmt }))], rows: years });

    chartCard('card-yearly', {
      title: 'CS 期刊撤稿记录数的年度变化',
      sub: '堆叠：Hindawi 与其他出版社；折线：CS 会议撤稿作对照',
      note: '按发表年份看时，近年数值受右删失影响（论文发表后尚未有足够时间被撤稿）。',
      views: [
        { label: '按撤稿年', option: () => {
          const o = base();
          return { ...o, xAxis: xAxisOf(o, X), yAxis: yAxisOf(o, { name: '记录数' }),
            series: [
              ...roundTop([barSeries('Hindawi', years.map((y) => incompleteBar(y.year, y.journal_hindawi)), pubColor('Hindawi'), { stack: 's' }),
                           barSeries('其他出版社', years.map((y) => incompleteBar(y.year, y.journal_excl_hindawi)), P().other, { stack: 's' })]),
              lineSeries('CS 会议（对照）', years.map((y) => y.conference_by_notice_year), P().cat[6]),
            ] };
        }, table: yearlyTable([['journal_by_notice_year', '期刊合计'], ['journal_hindawi', 'Hindawi'], ['journal_excl_hindawi', '其他出版社'], ['journal_unique_original_doi', '唯一原论文 DOI'], ['journal_in_batch', '批量撤稿'], ['conference_by_notice_year', '会议']]) },
        { label: '按发表年', option: () => {
          const o = base();
          return { ...o, xAxis: xAxisOf(o, X), yAxis: yAxisOf(o, { name: '记录数' }),
            series: [barSeries('期刊撤稿（按原论文发表年）', years.map((y) => y.journal_by_pub_year), P().cat[0], { itemStyle: { color: P().cat[0], borderRadius: [4, 4, 0, 0] } })] };
        }, table: yearlyTable([['journal_by_pub_year', '期刊撤稿（按发表年）']]) },
        { label: '批量 vs 零散', option: () => {
          const o = base();
          return { ...o, xAxis: xAxisOf(o, X), yAxis: yAxisOf(o, { name: '记录数' }),
            series: roundTop([
              barSeries(`批量（同日同刊 ≥${r.batches.threshold}）`, years.map((y) => incompleteBar(y.year, y.journal_in_batch)), P().cat[3], { stack: 's' }),
              barSeries('零散', years.map((y) => incompleteBar(y.year, y.journal_by_notice_year - y.journal_in_batch)), P().cat[4], { stack: 's' }),
            ]) };
        }, table: yearlyTable([['journal_in_batch', '批量'], ['journal_by_notice_year', '合计']]) },
      ],
    });

    const pby = r.publisher_by_year, prow = pby.rows.filter((x) => x.notice_year >= 2014);
    chartCard('card-publisher-year', {
      title: '出版社构成的年度变化', sub: '前 6 家出版社，其余合并为“其他出版社”',
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, legend: { ...o.legend, type: 'scroll' }, xAxis: xAxisOf(o, prow.map((x) => x.notice_year)), yAxis: yAxisOf(o, { name: '记录数' }),
          series: roundTop(pby.columns.map((c) => barSeries(shortPub(c), prow.map((x) => incompleteBar(x.notice_year, x[c])), pubColor(c), { stack: 's' }))) };
      }, table: () => ({ cols: [{ k: 'notice_year', label: '年份' }, ...pby.columns.map((c) => ({ k: c, label: shortPub(c), num: 1, fmt }))], rows: prow }) }],
    });

    const lor = r.concentration.journal_lorenz, cj = r.concentration.journal;
    chartCard('card-lorenz', {
      title: '期刊集中度：累计记录占比', sub: `按撤稿记录数排序的 ${fmt(cj.n_entities)} 种期刊；${cj.singletons} 种只有 1 条`,
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, trigger: 'axis', axisPointer: { type: 'line' }, valueFormatter: (v) => pct(v) } });
        return { ...o, legend: { show: false },
          xAxis: { type: 'log', name: '期刊排名（对数）', nameLocation: 'middle', nameGap: 26, min: 1, max: lor.length, ...o._axis, splitLine: { show: false } },
          yAxis: yAxisOf(o, { max: 1, axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } }),
          series: [lineSeries('累计占比', lor.map((p) => [p.rank, p.cum_share]), P().cat[0], { symbol: 'none', areaStyle: { opacity: 0.08 },
            markLine: { symbol: 'none', label: { color: P().ink3, formatter: '{b}' }, lineStyle: { color: P().ink3, type: 'dashed', width: 1 },
              data: [{ name: `前 ${cj.entities_for_50pct} 种 = 50%`, xAxis: cj.entities_for_50pct }, { name: `前 ${cj.entities_for_80pct} 种 = 80%`, xAxis: cj.entities_for_80pct }] } })] };
      }, table: () => ({ cols: [{ k: 'rank', label: '排名', num: 1 }, { k: 'cum_share', label: '累计占比', num: 1, fmt: (v) => pct(v) }], rows: lor.filter((p) => p.rank <= 20 || p.rank % 50 === 0) }) }],
    });

    const tp = r.top_publishers.slice(0, 10).reverse();
    chartCard('card-publishers', {
      title: '出版社撤稿记录数（前 10）', sub: `前 ${r.concentration.publisher.entities_for_80pct} 家出版社占 80% 记录`,
      views: [{ label: '', option: () => {
        const o = base(); o.grid = { ...o.grid, left: 170 };
        return { ...o, legend: { show: false }, xAxis: yAxisOf(o), yAxis: xAxisOf(o, tp.map((p) => shortPub(p.publisher)), { axisLabel: { ...o._axis.axisLabel, width: 150, overflow: 'truncate' } }),
          series: [barSeries('记录数', tp.map((p) => ({ value: p.n, itemStyle: { color: pubColor(p.publisher), borderRadius: [0, 4, 4, 0] } })), P().cat[0])] };
      }, table: () => ({ cols: [{ k: 'publisher', label: '出版社' }, { k: 'n', label: '记录数', num: 1, fmt }], rows: [...tp].reverse() }) }],
    });

    const bd = r.batches.size_distribution;
    chartCard('card-batch-dist', {
      title: '按批次规模划分的记录数', sub: '同一期刊同一撤稿日期视为一个批次',
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, legend: { show: false }, xAxis: xAxisOf(o, bd.map((b) => b.bucket), { name: '批次规模（条/批）', nameLocation: 'middle', nameGap: 26 }), yAxis: yAxisOf(o, { name: '记录数' }),
          series: [barSeries('记录数', bd.map((b) => b.records), P().cat[3], { itemStyle: { color: P().cat[3], borderRadius: [4, 4, 0, 0] } })] };
      }, table: () => ({ cols: [{ k: 'bucket', label: '批次规模' }, { k: 'events', label: '批次数', num: 1, fmt }, { k: 'records', label: '记录数', num: 1, fmt }], rows: bd }) }],
    });
    $('#batch-table').innerHTML = renderTable([
      { k: 'notice_date', label: '撤稿日期' }, { k: 'journal', label: '期刊' }, { k: 'publisher', label: '出版社', fmt: shortPub }, { k: 'n', label: '条数', num: 1, fmt },
    ], r.top_batches);

    const rs = r.reasons.slice(0, 16).reverse();
    const cohorts = [['journal_share', 'CS 期刊', P().cat[0]], ['journal_excl_hindawi_share', 'CS 期刊（排除 Hindawi）', P().cat[4]], ['conference_share', 'CS 会议（对照）', P().cat[6]]];
    chartCard('card-reasons', {
      title: '最常见的撤稿原因标签（多标签，占比不可相加）', sub: 'Retraction Watch 原始原因标签；含该标签的记录占队列比例', tall: true,
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, valueFormatter: (v) => pct(v) } }); o.grid = { ...o.grid, left: 330, top: 40 };
        return { ...o, xAxis: yAxisOf(o, { max: 1, axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } }),
          yAxis: xAxisOf(o, rs.map((x) => x.reason), { axisLabel: { ...o._axis.axisLabel, width: 310, overflow: 'truncate' } }),
          series: cohorts.map(([k, n, c]) => barSeries(n, rs.map((x) => x[k]), c, { barMaxWidth: 8, itemStyle: { color: c, borderRadius: [0, 3, 3, 0] } })) };
      }, table: () => ({ cols: [{ k: 'reason', label: '原因' }, { k: 'journal_n', label: '期刊记录数', num: 1, fmt }, ...cohorts.map(([k, n]) => ({ k, label: n, num: 1, fmt: (v) => pct(v) }))], rows: [...rs].reverse() }) }],
    });

    const th = r.themes_by_year;
    chartCard('card-themes', {
      title: '原因主题的年度变化（T1–T7 探索性归并）', sub: '每年含该主题的记录占比；一条记录可命中多个主题',
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' }, valueFormatter: (v) => pct(v) } });
        o.grid = { ...o.grid, top: 84 };
        return { ...o, xAxis: xAxisOf(o, th.rows.map((x) => x.notice_year)), yAxis: yAxisOf(o, { max: 1, axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } }),
          series: th.columns.map((c, i) => lineSeries(c, th.rows.map((x) => x[c]), P().cat[i])) };
      }, table: () => ({ cols: [{ k: 'notice_year', label: '年份' }, ...th.columns.map((c) => ({ k: c, label: c, num: 1, fmt: (v) => pct(v) }))], rows: th.rows }) }],
    });

    const ct = r.countries.slice(0, 12).reverse();
    chartCard('card-countries', {
      title: '作者国家（前 12）', sub: '含该国作者的记录占比；多国合作重复计',
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, valueFormatter: (v) => pct(v) } }); o.grid = { ...o.grid, left: 110 };
        return { ...o, legend: { show: false }, xAxis: yAxisOf(o, { axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } }), yAxis: xAxisOf(o, ct.map((x) => x.country)),
          series: [barSeries('占比', ct.map((x) => x.share_of_records), P().cat[2], { itemStyle: { color: P().cat[2], borderRadius: [0, 4, 4, 0] } })] };
      }, table: () => ({ cols: [{ k: 'country', label: '国家' }, { k: 'n_records', label: '记录数', num: 1, fmt }, { k: 'share_of_records', label: '占比', num: 1, fmt: (v) => pct(v) }], rows: [...ct].reverse() }) }],
    });

    const cy = r.countries_by_year;
    chartCard('card-country-year', {
      title: '主要国家占比的年度变化', sub: '前 6 个国家',
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' }, valueFormatter: (v) => pct(v) } });
        return { ...o, xAxis: xAxisOf(o, cy.rows.map((x) => x.notice_year)), yAxis: yAxisOf(o, { max: 1, axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } }),
          series: cy.columns.map((c, i) => lineSeries(c, cy.rows.map((x) => x[c]), P().cat[i])) };
      }, table: () => ({ cols: [{ k: 'notice_year', label: '年份' }, ...cy.columns.map((c) => ({ k: c, label: c, num: 1, fmt: (v) => pct(v) }))], rows: cy.rows }) }],
    });

    const lg = r.lag;
    chartCard('card-lag-hist', {
      title: '发表到撤稿的时间分布', sub: `中位数 ${fmt(lg.median_days)} 天；四分位 ${fmt(lg.p25_days)}–${fmt(lg.p75_days)} 天；${fmt(lg.n_negative_or_missing)} 条日期异常已排除`,
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, legend: { show: false }, xAxis: xAxisOf(o, lg.hist.map((b) => b.bucket)), yAxis: yAxisOf(o, { name: '记录数' }),
          series: [barSeries('记录数', lg.hist.map((b) => b.n), P().cat[5], { itemStyle: { color: P().cat[5], borderRadius: [4, 4, 0, 0] } })] };
      }, table: () => ({ cols: [{ k: 'bucket', label: '时滞' }, { k: 'n', label: '记录数', num: 1, fmt }], rows: lg.hist }) }],
    });
    chartCard('card-lag-year', {
      title: '撤稿时滞的年度变化', sub: '按撤稿年份；实线为中位数，虚线为四分位数（天）',
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' } } }); const c = P().cat[5];
        return { ...o, xAxis: xAxisOf(o, lg.by_notice_year.map((x) => x.year)), yAxis: yAxisOf(o, { name: '天' }),
          series: [lineSeries('P75', lg.by_notice_year.map((x) => x.p75), c, { lineStyle: { width: 1.2, type: 'dashed', color: c }, symbol: 'none' }),
                   lineSeries('中位数', lg.by_notice_year.map((x) => x.median), c),
                   lineSeries('P25', lg.by_notice_year.map((x) => x.p25), c, { lineStyle: { width: 1.2, type: 'dashed', color: c }, symbol: 'none' })] };
      }, table: () => ({ cols: [{ k: 'year', label: '年份' }, { k: 'count', label: 'n', num: 1, fmt }, { k: 'p25', label: 'P25', num: 1, fmt }, { k: 'median', label: '中位数', num: 1, fmt }, { k: 'p75', label: 'P75', num: 1, fmt }], rows: lg.by_notice_year }) }],
    });
  }

  function renderRates() {
    const R = DATA.rates;
    if (!R) { $('#rates-lede').textContent = '尚未生成：运行 make openalex && make site。'; return; }
    const cv = R.coverage;
    $('#rates-lede').innerHTML = `分子：按<b>原论文发表年</b>计的唯一撤稿论文；分母：该期刊该年的 OpenAlex 发文量。匹配 ${fmt(cv.matched_records)} / ${fmt(cv.journal_records)} 条、${fmt(cv.matched_sources)} 种期刊。
      期刊池只含有过 CS 撤稿的期刊，是<b>条件比率</b>。2023 年后发表的论文观察期短，比率偏低（右删失）。`;
    const py = R.pool_by_pub_year.filter((x) => x.pub_year >= 2014);
    chartCard('card-rate-year', {
      title: '每万篇撤稿数（按原论文发表年）', sub: '灰色区域：右删失，数值会继续上升',
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' } } });
        const X = py.map((x) => x.pub_year);
        return { ...o, xAxis: xAxisOf(o, X), yAxis: yAxisOf(o, { name: '每万篇' }),
          series: [
            lineSeries('撤稿期刊池', py.map((x) => x.per_10k), P().cat[0], { markArea: { silent: true, itemStyle: { color: theme === 'dark' ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.04)' }, data: [[{ xAxis: 2023 }, { xAxis: X[X.length - 1] }]] } }),
            lineSeries('排除 Hindawi 期刊', py.map((x) => x.excl_hindawi_per_10k), P().other),
            lineSeries('其中带“生成内容”标签', py.map((x) => x.aigc_per_10k), P().cat[1]),
          ] };
      }, table: () => ({ cols: [{ k: 'pub_year', label: '发表年' }, { k: 'retracted_papers', label: '撤稿', num: 1, fmt }, { k: 'works', label: '发文量', num: 1, fmt },
        { k: 'per_10k', label: '每万篇', num: 1 }, { k: 'excl_hindawi_per_10k', label: '排除 Hindawi', num: 1 }, { k: 'aigc_per_10k', label: '生成内容标签', num: 1 }], rows: py }) }],
    });
    const pr = [...R.publisher_rates].sort((a, b) => a.per_10k - b.per_10k);
    chartCard('card-rate-publisher', {
      title: '出版社撤稿率', sub: `${cv.window[0]}–${cv.window[1]} 年发表；撤稿记录最多的 12 家出版社`,
      views: [{ label: '', option: () => {
        const o = base(); o.grid = { ...o.grid, left: 170, top: 20 };
        return { ...o, legend: { show: false }, xAxis: yAxisOf(o, { name: '每万篇' }),
          yAxis: xAxisOf(o, pr.map((p) => shortPub(p.publisher_rw)), { axisLabel: { ...o._axis.axisLabel, width: 150, overflow: 'truncate' } }),
          series: [barSeries('每万篇', pr.map((p) => ({ value: p.per_10k, itemStyle: { color: pubColor(p.publisher_rw), borderRadius: [0, 4, 4, 0] } })), P().other)] };
      }, table: () => ({ cols: [{ k: 'publisher_rw', label: '出版社', fmt: shortPub }, { k: 'retracted', label: '撤稿', num: 1, fmt }, { k: 'works', label: '发文量', num: 1, fmt }, { k: 'per_10k', label: '每万篇', num: 1 }], rows: [...pr].reverse() }) }],
    });
    $('#rate-table-sub').textContent = `${cv.window[0]}–${cv.window[1]} 年发文 ≥${fmt(cv.min_works_for_ranking)} 篇的期刊；括号内为 Wilson 95% 区间`;
    $('#rate-table').innerHTML = renderTable([
      { k: 'journal_rw', label: '期刊' }, { k: 'retracted', label: '撤稿', num: 1, fmt }, { k: 'works', label: '发文量', num: 1, fmt },
      { k: 'per_10k', label: '每万篇', num: 1, html: (v, r) => `<b>${fmt(Math.round(v))}</b> <span class="muted small">(${fmt(Math.round(r.ci_low_per_10k))}–${fmt(Math.round(r.ci_high_per_10k))})</span>` },
    ], R.top_by_rate);
  }

  // ------------------------------------------------------------ 期刊榜单（可排序）
  function renderJournals() {
    const cols = [
      { k: 'journal', label: '期刊' }, { k: 'publisher', label: '出版社', fmt: shortPub },
      { k: 'n', label: '记录数', num: 1, fmt }, { k: 'first_notice_year', label: '首次', num: 1 }, { k: 'last_notice_year', label: '最近', num: 1 },
      { k: 'peak_notice_year', label: '峰值年', num: 1 }, { k: 'batch_share', label: '批量占比', num: 1, fmt: (v) => pct(v, 0) },
      { k: 'largest_batch', label: '最大批次', num: 1, fmt }, { k: 'median_lag_days', label: '中位时滞(天)', num: 1, fmt },
      { k: 'aigc_label_share', label: '生成内容标签', num: 1, fmt: (v) => pct(v, 0) }, { k: 'top_reason', label: '最常见原因' },
    ];
    const byJ = DATA.rates ? DATA.rates.by_journal_rw : {};
    if (DATA.rates) cols.splice(3, 0, { k: 'per_10k', label: `每万篇(${DATA.rates.coverage.window.join('–')})`, num: 1, fmt: (v) => (v == null ? '–' : fmt(Math.round(v))) });
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
    const opts = (sel, vals) => { sel.insertAdjacentHTML('beforeend', vals.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')); };
    opts($('#f-year'), [...new Set(all.map((o) => o.notice_date.slice(0, 4)))].sort().reverse());
    opts($('#f-publisher'), DATA.rq1.top_publishers.map((p) => p.publisher));
    opts($('#f-reason'), [...rec.reason_vocab].sort());
    const PAGE = 50; let page = 0, hits = all;
    const cols = [
      { k: 'notice_date', label: '撤稿日期' },
      { k: 'title', label: '标题', html: (v, r) => `<span class="title-cell">${esc(v)}</span><br><span class="muted small">原文 ${doiLink(r.original_doi)} · 声明 ${doiLink(r.notice_doi)}</span>` },
      { k: 'journal', label: '期刊 / 出版社', html: (v, r) => `${esc(v)}<br><span class="muted small">${esc(shortPub(r.publisher))}${r.batch_size >= 10 ? ` · 批次 ${r.batch_size} 条` : ''}</span>` },
      { k: 'publication_date', label: '发表日期' },
      { k: 'reasons', label: '来源原因', html: (v) => v.map((x) => `<span class="chip">${esc(x)}</span>`).join('') },
      { k: 'countries', label: '国家', fmt: (v) => v.join(', ') },
    ];
    const draw = () => {
      const n = hits.length, pages = Math.max(1, Math.ceil(n / PAGE));
      page = Math.min(page, pages - 1);
      $('#rec-table').innerHTML = renderTable(cols, hits.slice(page * PAGE, page * PAGE + PAGE));
      $('#rec-count').textContent = `${fmt(n)} / ${fmt(all.length)} 条`;
      $('#page-info').textContent = `${page + 1} / ${pages}`;
      $('#prev').disabled = page === 0; $('#next').disabled = page >= pages - 1;
    };
    const filter = () => {
      const q = $('#q').value.trim().toLowerCase(), y = $('#f-year').value, p = $('#f-publisher').value, rs = $('#f-reason').value, b = $('#f-batch').checked;
      hits = all.filter((o) => (!q || o._hay.includes(q)) && (!y || o.notice_date.startsWith(y)) && (!p || o.publisher === p)
        && (!rs || o.reasons.includes(rs)) && (!b || o.batch_size >= 10));
      page = 0; draw();
    };
    let t; $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(filter, 150); });
    ['#f-year', '#f-publisher', '#f-reason', '#f-batch'].forEach((s) => $(s).addEventListener('change', filter));
    $('#prev').addEventListener('click', () => { page--; draw(); });
    $('#next').addEventListener('click', () => { page++; draw(); });
    draw();
  }

  // ------------------------------------------------------------ RQ2 预览 & 方法
  function renderRQ2() {
    const Q = DATA.rq2;
    if (!Q) { $('#rq2-tiles').innerHTML = '<div class="card">尚未生成：运行 make rq2 && make site。</div>'; return; }
    const h = Q.headline, E = Q.eras, postX = E['ChatGPT 后·排除最大期刊'];
    $('#rq2-tiles').innerHTML = [
      ['带“生成内容”标签', fmt(h.aigc_label), `占期刊撤稿 ${pct(h.aigc_label_share)}`],
      ['ChatGPT 后发表·带标签', fmt(h.aigc_post_chatgpt), `ChatGPT 前 ${fmt(h.aigc_pre_chatgpt)}`],
      ['排除最大期刊后', fmt(postX.n), `${fmt(postX.journals)} 种期刊`],
      ['有实质文本的声明', fmt(h.informative_notices), `占 ${pct(h.informative_notices / h.journal_records)}`],
      ['声明明确提到 LLM', fmt(h.explicit_llm_mentions), '规则初筛'],
    ].map(([l, v, s2]) => `<div class="tile"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="hint">${esc(s2)}</div></div>`).join('');

    const post = E['ChatGPT 后'];
    $('#rq2-findings').innerHTML = [
      `<b>公开元数据无法确认 LLM 导致的撤稿：</b>${fmt(h.journal_records)} 条中只有 ${fmt(h.informative_notices)} 条声明有实质文本，其中明确提到 ChatGPT / LLM 的为 ${h.explicit_llm_mentions} 条。`,
      `<b>标签没有在 ChatGPT 后变多：</b>“生成内容”标签在 ChatGPT 前、后发表的撤稿论文中分别占 ${pct(h.aigc_share_among_pre_chatgpt)} 和 ${pct(h.aigc_share_among_post_chatgpt)}。`,
      `<b>LLM 时代候选高度集中：</b>ChatGPT 后发表且带标签的 ${fmt(post.n)} 条中，${pct(post.top_journal_share)} 来自 ${esc(post.top_journal)}，${pct(post.in_batch_share)} 为批量撤稿；排除后只剩 ${fmt(postX.n)} 条。`,
      `<b>有文本的声明指向“非标准用语”：</b>带标签的声明中 ${pct(Q.notice_mechanisms.find((m) => m.mechanism.startsWith('非标准')).among_aigc_label)} 提到 non-standard vocabulary（tortured phrases），LLM 为 0。`,
    ].map((x) => `<li>${x}</li>`).join('');

    $('#tier-table').innerHTML = renderTable([
      { k: 'tier', label: '分层' }, { k: 'n', label: '记录数', num: 1, fmt }, { k: 'share', label: '占比', num: 1, fmt: (v) => pct(v) },
      { k: 'in_batch_share', label: '批量占比', num: 1, fmt: (v) => pct(v, 0) }, { k: 'median_lag_days', label: '中位时滞(天)', num: 1, fmt },
    ], [{ tier: 'A 声明明确提及 LLM', n: h.explicit_llm_mentions, share: h.explicit_llm_mentions / h.journal_records, in_batch_share: null, median_lag_days: null },
        ...Q.tiers.filter((t) => !t.tier.startsWith('A'))]);

    const bp = Q.aigc_by_pub_year.filter((x) => x.pub_year >= 2016 && x.pub_year <= 2025);
    chartCard('card-aigc-pub', {
      title: '带“生成内容”标签的撤稿，按原论文发表年', sub: '灰色区域：ChatGPT 公开发布（2022-11-30）后发表；近年论文观察期短（右删失）',
      views: [{ label: '记录数', option: () => {
        const o = base();
        return { ...o, xAxis: xAxisOf(o, bp.map((x) => x.pub_year)), yAxis: yAxisOf(o, { name: '记录数' }),
          series: roundTop([
            barSeries('批量撤稿中', bp.map((x) => x.aigc_label_batch), P().cat[3], { stack: 's', markArea: { silent: true, label: { show: true, position: 'insideTop', formatter: 'ChatGPT 后发表', color: P().ink3, fontSize: 11 }, itemStyle: { color: theme === 'dark' ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.04)' }, data: [[{ xAxis: '2023' }, { xAxis: String(bp[bp.length - 1].pub_year) }]] } }),
            barSeries('零散撤稿中', bp.map((x) => x.aigc_label_scattered), P().cat[4], { stack: 's' }),
          ]) };
      }, table: () => ({ cols: [{ k: 'pub_year', label: '发表年' }, { k: 'retracted', label: '撤稿合计', num: 1, fmt }, { k: 'aigc_label', label: '带标签', num: 1, fmt },
        { k: 'aigc_label_batch', label: '批量', num: 1, fmt }, { k: 'aigc_label_scattered', label: '零散', num: 1, fmt }, { k: 'aigc_share', label: '标签占比', num: 1, fmt: (v) => pct(v) }], rows: bp }) },
      ...(Q.aigc_rate_by_pub_year.length ? [{ label: '每万篇', option: () => {
        const o = base({ tooltip: { ...base().tooltip, axisPointer: { type: 'line' } } }); const r = Q.aigc_rate_by_pub_year.filter((x) => x.pub_year >= 2016);
        return { ...o, xAxis: xAxisOf(o, r.map((x) => x.pub_year)), yAxis: yAxisOf(o, { name: '每万篇' }),
          series: [lineSeries('带标签撤稿 / 万篇', r.map((x) => x.aigc_per_10k), P().cat[1]), lineSeries('全部撤稿 / 万篇', r.map((x) => x.per_10k), P().other)] };
      }, table: () => ({ cols: [{ k: 'pub_year', label: '发表年' }, { k: 'aigc_per_10k', label: '带标签/万篇', num: 1 }, { k: 'per_10k', label: '全部/万篇', num: 1 }], rows: Q.aigc_rate_by_pub_year }) }] : []),
    ]});

    const bn = Q.aigc_by_notice_year_era.filter((x) => x.notice_year >= 2021);
    chartCard('card-aigc', {
      title: '带标签的撤稿，按撤稿年份', sub: '按原论文发表于 ChatGPT 之前 / 之后拆分',
      views: [{ label: '', option: () => {
        const o = base();
        return { ...o, xAxis: xAxisOf(o, bn.map((x) => x.notice_year)), yAxis: yAxisOf(o, { name: '记录数' }),
          series: roundTop([barSeries('ChatGPT 前发表', bn.map((x) => incompleteBar(x.notice_year, x.pre_chatgpt)), P().other, { stack: 's' }),
                            barSeries('ChatGPT 后发表', bn.map((x) => incompleteBar(x.notice_year, x.post_chatgpt)), P().cat[1], { stack: 's' })]) };
      }, table: () => ({ cols: [{ k: 'notice_year', label: '撤稿年' }, { k: 'pre_chatgpt', label: 'ChatGPT 前发表', num: 1, fmt }, { k: 'post_chatgpt', label: 'ChatGPT 后发表', num: 1, fmt }], rows: bn }) }],
    });

    const cov = [...Q.notice_text_coverage].reverse();
    chartCard('card-text-coverage', {
      title: '撤稿声明文本的可用性', sub: '有实质内容（去掉模板句与标题后 ≥80 字符）的比例，前 10 家出版社',
      views: [{ label: '', option: () => {
        const o = base({ tooltip: { ...base().tooltip, valueFormatter: (v) => pct(v) } }); o.grid = { ...o.grid, left: 170, top: 20 };
        return { ...o, legend: { show: false }, xAxis: yAxisOf(o, { max: 1, axisLabel: { ...o._axis.axisLabel, formatter: (v) => pct(v, 0) } }),
          yAxis: xAxisOf(o, cov.map((c) => shortPub(c.publisher)), { axisLabel: { ...o._axis.axisLabel, width: 150, overflow: 'truncate' } }),
          series: [barSeries('有实质文本', cov.map((c) => ({ value: c.informative_share, itemStyle: { color: pubColor(c.publisher), borderRadius: [0, 4, 4, 0] } })), P().other)] };
      }, table: () => ({ cols: [{ k: 'publisher', label: '出版社', fmt: shortPub }, { k: 'n', label: '记录', num: 1, fmt }, { k: 'openalex_text', label: '有文本', num: 1, fmt },
        { k: 'informative', label: '有实质文本', num: 1, fmt }, { k: 'informative_share', label: '比例', num: 1, fmt: (v) => pct(v) }], rows: [...cov].reverse() }) }],
    });

    $('#mech-sub').textContent = `${fmt(h.informative_notices)} 条有实质文本的声明，规则初筛（多标签），按是否带“生成内容”标签比较`;
    $('#mech-table').innerHTML = renderTable([
      { k: 'mechanism', label: '机制线索' }, { k: 'among_aigc_label', label: '带标签', num: 1, fmt: (v) => pct(v) },
      { k: 'among_no_aigc_label', label: '不带标签', num: 1, fmt: (v) => pct(v) }, { k: 'informative_n', label: '命中数', num: 1, fmt },
    ], Q.notice_mechanisms);
    $('#post-sub').textContent = `ChatGPT 后发表且带标签，排除 ${post.top_journal} 后的 ${fmt(postX.n)} 条（批量占比 ${pct(postX.in_batch_share)}）；第二阶段人工核查的起点`;
    $('#post-table').innerHTML = renderTable([{ k: 'journal', label: '期刊' }, { k: 'n', label: '条数', num: 1, fmt }], postX.top_journals);
  }
  function renderMethods() {
    const m = DATA.meta;
    const kv = [
      ['数据源', 'Crossref / Retraction Watch（CC0）'], ['快照提交', m.snapshot_commit], ['快照日期', m.snapshot_date],
      ['CSV SHA-256', m.source_csv_sha256], ['全部通知记录', fmt(m.cohorts.all_records)], ['全学科撤稿', fmt(m.cohorts.all_retractions)],
      ['CS 撤稿', fmt(m.cohorts.cs_retractions)], ['OpenAlex 获取', (m.openalex_run || ['–'])[0] + '（发文量、撤稿声明文本，CC0）'], ['CS 会议撤稿', fmt(m.cohorts.cs_conference_retractions)], ['网站构建时间', m.site_built_at],
    ];
    $('#source-kv').innerHTML = kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('#flow-table').innerHTML = renderTable([{ k: 'step', label: '步骤' }, { k: 'excluded', label: '排除', num: 1, fmt }, { k: 'remaining', label: '剩余', num: 1, fmt }], DATA.rq1.selection_flow);
  }

  // ------------------------------------------------------------ 路由与主题
  const rendered = new Set();
  const renderers = { overview: renderOverview, rq1: () => { renderRQ1(); renderRates(); }, journals: renderJournals, records: renderRecords, rq2: renderRQ2, methods: renderMethods };
  function route() {
    const tab = (location.hash.slice(1) || 'overview');
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
  window.addEventListener('resize', () => charts.forEach((c) => c.inst && c.inst.resize()));
  window.addEventListener('hashchange', route);

  document.documentElement.dataset.theme = theme;
  load().then(() => { const m = DATA.meta; $('#snapshot-line').textContent = `Retraction Watch 快照 ${m.snapshot_date.slice(0, 10)} · ${m.snapshot}`; route(); })
    .catch((e) => { document.querySelector('main').innerHTML = `<div class="card"><h3>数据加载失败</h3><p class="sub">${esc(e.message)}。请先运行 <code>make site</code>，并通过 HTTP 服务访问（<code>make serve</code>），不要直接双击打开 HTML。</p></div>`; });
})();
