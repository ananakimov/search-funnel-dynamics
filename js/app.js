/* Интерфейс. Без фреймворка: строки HTML + делегирование событий. */
(function () {
  'use strict';
  const C = window.Core, V = window.Vault;
  const $app = document.getElementById('app');

  const state = {
    key: null, saltId: null, vaultDates: new Set(), localDates: new Set(),
    snaps: [], scope: loadScope(), cmp: null,
    sort: { key: 'activity', dir: -1 }, pq: '',
    of: { q: '', who: '', kinds: new Set(['arrived', 'advance', 'back', 'exit']) },
    drawer: null, pending: null, pop: null, onlyMoved: false, skippedLocal: 0, idbOff: false,
  };

  /* ---------- утилиты ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const fd = (iso) => (iso ? +iso.slice(8, 10) + ' ' + MON[+iso.slice(5, 7) - 1] : '—');
  const fdy = (iso) => (iso ? fd(iso) + ' ' + iso.slice(0, 4) : '—');
  const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return f[a > 10 && a < 20 ? 2 : b > 1 && b < 5 ? 1 : b === 1 ? 0 : 2]; };
  const short = (a) => String(a || '').replace(/^Россия,\s*/, '');
  const scopeStages = () => C.STAGES.filter((s) => state.scope.stages.includes(s));
  const stIdx = (s) => (C.STAGE_RANK[s] === undefined ? 0 : C.STAGE_RANK[s]);
  const sorted = () => state.snaps.slice().sort((a, b) => (a.date < b.date ? -1 : 1));

  function loadScope() {
    try { const s = JSON.parse(localStorage.getItem('ft.scope')); if (s && s.regions && s.brands && s.tt && s.stages) return s; } catch (e) { /* нет доступа к localStorage */ }
    return JSON.parse(JSON.stringify(C.DEFAULT_SCOPE));
  }
  function saveScope() { try { localStorage.setItem('ft.scope', JSON.stringify(state.scope)); } catch (e) { /* ignore */ } }

  function delta(d, good) { // good: 'up' | 'down' | null
    if (d === 0) return '<span class="zero">0</span>';
    const cls = good === null ? 'zero' : (d > 0) === (good === 'up') ? 'pos' : 'neg';
    return `<span class="${cls}">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>`;
  }
  const stageChip = (s) => (s ? `<span class="stage"><i class="dot s${stIdx(s)}"></i>${esc(s)}</span>` : '<span class="stage muted">—</span>');
  const trans = (f, t) => `${f ? stageChip(f) : '<span class="muted">новая</span>'}<span class="arrow">→</span>${t ? stageChip(t) : '<span class="muted">нет в выгрузке</span>'}`;

  function kindChip(ev) {
    const m = { new: 'Новая задача', enter: 'Пришла в этап', advance: 'Продвинулась', back: 'Откат назад', same: 'Без движения' };
    const ex = { gone: 'Пропала из выгрузки', beyond: 'Ушла дальше по воронке', behind: 'Ушла на ранний этап', filter: 'Вышла из фильтра' };
    return `<span class="chip ${ev.kind}">${ev.kind === 'exit' ? ex[ev.sub] : m[ev.kind]}</span>`;
  }

  function seg(byStage, total, max) {
    const stages = scopeStages();
    const w = max ? (total / max) * 100 : 100;
    return `<div class="seg" style="width:${w}%">${stages.map((s) => `<i class="s${stIdx(s)}" style="width:${total ? ((byStage[s] || 0) / total) * 100 : 0}%" title="${esc(s)}: ${byStage[s] || 0}"></i>`).join('')}</div>`;
  }
  function legend() { return `<div class="legend">${scopeStages().map((s) => `<span><i class="dot s${stIdx(s)}"></i>${esc(s)}</span>`).join('')}</div>`; }

  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
  }

  /* ---------- сравнение ---------- */
  let cmpCache = null;
  function getCmp() {
    const s = sorted();
    if (s.length < 2) return null;
    if (!state.cmp || !s.find((x) => x.date === state.cmp.a) || !s.find((x) => x.date === state.cmp.b) || state.cmp.a >= state.cmp.b) {
      state.cmp = { a: s[s.length - 2].date, b: s[s.length - 1].date };
    }
    const key = state.cmp.a + '|' + state.cmp.b + '|' + JSON.stringify(state.scope) + '|' + s.map((x) => x.date + x.rows.length).join(',');
    if (!cmpCache || cmpCache.key !== key) {
      const A = s.find((x) => x.date === state.cmp.a), B = s.find((x) => x.date === state.cmp.b);
      cmpCache = { key, res: C.compare(A, B, state.scope) };
    }
    return cmpCache.res;
  }
  const latest = () => sorted()[sorted().length - 1];

  /* ---------- вход ---------- */
  async function boot() {
    let vault = null, vaultErr = null;
    try {
      const r = await fetch('vault.json', { cache: 'no-store' });
      if (r.ok) vault = await r.json(); else vaultErr = 'vault.json не найден (' + r.status + ')';
    } catch (e) { vaultErr = 'Не удалось загрузить vault.json'; }
    renderGate(vault, vaultErr);
  }

  function renderGate(vault, err) {
    $app.innerHTML = `
      <div class="gate"><div class="card">
        <div class="logo">${logoSvg()}</div>
        <h1>Воронка поиска</h1>
        <p class="muted" style="margin:6px 0 0">Динамика объектов и работа поисковиков по выгрузкам первой формы. Введите пароль.</p>
        <form id="gateForm">
          <input type="password" id="pw" placeholder="Пароль" autocomplete="current-password" autofocus ${vault ? '' : 'disabled'}>
          <div class="err" id="gateErr">${esc(err || '')}</div>
          <button class="btn btn-primary" type="submit" ${vault ? '' : 'disabled'} style="justify-content:center">Открыть</button>
        </form>
      </div></div>`;
    document.getElementById('gateForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button'), er = document.getElementById('gateErr');
      btn.disabled = true; btn.textContent = 'Проверяю…'; er.textContent = '';
      try {
        const o = await V.openVault(vault, document.getElementById('pw').value);
        await afterUnlock(o);
      } catch (ex) {
        er.textContent = 'Неверный пароль';
        btn.disabled = false; btn.textContent = 'Открыть';
      }
    });
  }

  async function afterUnlock(o) {
    state.key = o.key; state.saltId = o.saltId;
    const map = new Map();
    o.snapshots.forEach((s) => { map.set(s.date, s); state.vaultDates.add(s.date); });
    const loc = await V.localLoad(o.key, o.saltId);
    state.skippedLocal = loc.skipped; state.idbOff = !!loc.unavailable;
    loc.snapshots.forEach((s) => { map.set(s.date, s); state.localDates.add(s.date); });
    state.snaps = [...map.values()];
    if (!location.hash) location.hash = '#/overview';
    renderShell();
  }

  /* ---------- оболочка ---------- */
  function ico(n) {
    const p = { filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>', history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>', upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>' }[n];
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  }
  function logoSvg() { return '<svg width="18" height="18" viewBox="0 0 32 32"><path d="M5 7h22l-8.5 10v7l-5 2.5V17z" fill="#fff"/></svg>'; }

  function route() { const h = (location.hash || '#/overview').replace(/^#\//, '').split('/'); return { page: h[0] || 'overview', arg: decodeURIComponent(h.slice(1).join('/')) }; }

  function renderShell() {
    const s = sorted();
    const cmpSel = s.length >= 2 ? (() => {
      getCmp();
      const opt = (sel) => s.map((x) => `<option value="${x.date}" ${x.date === sel ? 'selected' : ''}>${fdy(x.date)}</option>`).join('');
      return `<div class="cmp">Сравнить <select data-act="cmpA">${opt(state.cmp.a)}</select> → <select data-act="cmpB">${opt(state.cmp.b)}</select></div>`;
    })() : '';
    $app.innerHTML = `
      <header class="top"><div class="top-in">
        <a class="brand" href="#/overview"><span class="logo">${logoSvg()}</span><b>Воронка поиска</b></a>
        <nav class="nav" id="nav"></nav>
        <div class="top-r">${cmpSel}
          <button class="btn" data-pop="scope" title="Какие объекты считаем">${ico('filter')}Фильтры</button>
          <button class="btn icon" data-pop="hist" title="История выгрузок" aria-label="История выгрузок">${ico('history')}</button>
          <label class="btn btn-primary" for="fileIn">${ico('upload')}Загрузить выгрузку</label>
          <input type="file" id="fileIn" accept=".xlsx,.xls" class="hide">
        </div>
      </div></header>
      <main id="view"></main><div id="drawerHost"></div><div id="popHost"></div><div id="modalHost"></div>`;
    renderView(); renderPop(); renderModal();
  }

  function renderView() {
    const r = route();
    const nav = [['overview', 'Обзор'], ['people', 'Сотрудники'], ['objects', 'Объекты']];
    const active = r.page === 'person' ? 'people' : r.page;
    document.getElementById('nav').innerHTML = nav.map(([k, l]) => `<a href="#/${k}" class="${k === active ? 'on' : ''}">${l}</a>`).join('');
    const v = document.getElementById('view');
    if (!state.snaps.length) { v.innerHTML = emptyState(); renderDrawer(); return; }
    const fn = { overview: pgOverview, people: pgPeople, person: pgPerson, objects: pgObjects }[r.page] || pgOverview;
    v.innerHTML = fn(r.arg);
    if (r.page === 'people') renderPeopleBody();
    if (r.page === 'objects') renderObjList();
    renderDrawer();
    window.scrollTo(0, 0);
  }

  function emptyState() {
    return `<div class="card"><div class="empty"><h2>Пока нет ни одной выгрузки</h2><p>Нажмите «Загрузить выгрузку» и выберите файл xlsx из первой формы.</p></div></div>`;
  }

  /* ---------- общие блоки ---------- */
  function scopeLine() {
    const s = state.scope;
    return `${s.regions.join(', ')} · ${s.brands.join(', ')} · ${s.tt.join(', ')} · ${scopeStages().join(' / ')}`;
  }

  function kpi(l, v, s, cls) { return `<div class="card kpi ${cls || ''}"><div class="l">${l}</div><div class="v num">${v}</div><div class="s">${s || '&nbsp;'}</div></div>`; }

  function stageFlows(res) {
    const inn = {}, out = {};
    for (const e of res.events) {
      if (['new', 'enter', 'advance', 'back'].includes(e.kind) && e.fromStage !== e.toStage) inn[e.toStage] = (inn[e.toStage] || 0) + 1;
      if (['exit', 'advance', 'back'].includes(e.kind) && e.fromStage !== e.toStage) out[e.fromStage] = (out[e.fromStage] || 0) + 1;
    }
    return { inn, out };
  }

  function matrixHtml(res) {
    const sp = res.specials;
    const rowsOrder = [sp.NEW, ...C.STAGES, sp.OTHER], colsOrder = [...C.STAGES, sp.GONE, sp.OTHER];
    const get = (f, t) => (res.matrix.find((m) => m.from === f && m.to === t) || { n: 0 }).n;
    const rows = rowsOrder.filter((f) => res.matrix.some((m) => m.from === f));
    const cols = colsOrder.filter((t) => res.matrix.some((m) => m.to === t));
    const tracked = new Set(state.scope.stages);
    const cell = (f, t) => {
      const n = get(f, t);
      if (!n) return '<td class="zero">·</td>';
      let cls = 'cell';
      if (f === t) cls = 'diag';
      else if (!tracked.has(f) && tracked.has(t)) cls = 'cell inn';
      else if (tracked.has(f) && !tracked.has(t)) cls = 'cell out';
      else if (C.STAGE_RANK[t] > C.STAGE_RANK[f]) cls = 'cell fwd';
      else cls = 'cell bwd';
      return `<td class="${cls}">${n}</td>`;
    };
    return `<div class="tw"><table class="mx"><thead><tr><th class="rh">Было (A) ↓ · Стало (B) →</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((f) => `<tr><td class="rh">${esc(f)}</td>${cols.map((t) => cell(f, t)).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="legend" style="margin-top:10px"><span><i class="dot" style="background:var(--primary-soft);border:1px solid hsl(145 50% 70%)"></i>пришли в отслеживаемые этапы</span><span><i class="dot" style="background:var(--blue-soft);border:1px solid var(--st2)"></i>продвинулись</span><span><i class="dot" style="background:var(--orange-soft);border:1px solid var(--orange)"></i>откат назад</span><span><i class="dot" style="background:hsl(0 0% 94%);border:1px solid var(--st1)"></i>выбыли из отслеживаемых</span></div>`;
  }

  function trendHtml(list) {
    const max = Math.max(1, ...list.map((t) => t.total));
    return `<div class="trend">${list.map((t) => `<div class="tcol"><div class="tv num">${t.total}</div>
      <div class="tbar" style="height:${(t.total / max) * 78}%">${scopeStages().map((s) => `<i class="s${stIdx(s)}" style="height:${t.total ? ((t.byStage[s] || 0) / t.total) * 100 : 0}%" title="${esc(s)}: ${t.byStage[s] || 0}"></i>`).join('')}</div>
      <div class="td">${fd(t.date)}</div></div>`).join('')}</div>`;
  }

  function evRow(ev, opts) {
    opts = opts || {};
    const r = ev.row;
    return `<tr class="click" data-obj="${ev.id}">
      <td class="addr"><span class="addr-t">${esc(short(r.address))}</span><span class="sub num">№ ${ev.id} · ${esc(r.brand || '')}${ev.reassignedFrom ? ' · от ' + esc(ev.reassignedFrom) : ''}</span></td>
      ${opts.who ? `<td>${esc(ev.who)}</td>` : ''}
      <td>${trans(ev.fromStage, ev.toStage)}</td>
      <td>${kindChip(ev)}</td>
      <td class="num">${dueCell(ev)}</td></tr>`;
  }
  function dueCell(ev) {
    const r = ev.b || ev.a;
    let s = r && r.due ? fd(r.due) : '<span class="muted">нет срока</span>';
    if (ev.b && ev.overdueB) s += ' <span class="chip od">просрочен</span>';
    if (ev.dueChange && ev.dueChange.days) s += ` <span class="sub">(${ev.dueChange.days > 0 ? '+' : '−'}${Math.abs(ev.dueChange.days)} дн.)</span>`;
    return s;
  }

  /* ---------- Обзор ---------- */
  function pgOverview() {
    const res = getCmp();
    if (!res) return pgSingle();
    const { inn, out } = stageFlows(res);
    const arrived = res.n.new + res.n.enter;
    const od = res.after.overdue - res.before.overdue;
    const people = res.people.slice().sort((a, b) => act(b) - act(a)).slice(0, 8);
    const newOnes = res.events.filter((e) => e.kind === 'new' || e.kind === 'enter');
    return `
      <div class="page-h"><h1>Обзор</h1>
        <button class="btn" data-act="report">Скачать отчёт .xlsx</button></div>
      <div class="grid g5">
        ${kpi('В отслеживаемых этапах', res.after.total, `было ${res.before.total} · ${delta(res.after.total - res.before.total, null)}`)}
        ${kpi('Пришли в этапы', arrived, `${res.n.enter} из ранних этапов · ${res.n.new} новых задач`, 'hl')}
        ${kpi('Продвинулись дальше', res.n.advance, backCount(res) ? `и ${backCount(res)} вернулись на ранний этап` : 'возвратов нет')}
        ${kpi('Выбыли из этапов', res.n.exit, exitBreak(res))}
        ${kpi('Просрочено по сроку', res.after.overdue, `было ${res.before.overdue} · ${delta(od, 'down')}`)}
      </div>
      <h2 class="mt" style="margin-bottom:10px">По этапам</h2>
      <div class="grid g3 stages">${scopeStages().map((s) => {
        const b = res.before.byStage[s] || 0, a = res.after.byStage[s] || 0;
        return `<div class="card stage-card"><i class="bar s${stIdx(s)}"></i><div class="nm">${esc(s)}</div>
          <div class="big num">${a}<span class="dlt">${delta(a - b, 'up')}</span></div>
          <div class="flows muted"><span>+${inn[s] || 0} пришло</span><span>−${out[s] || 0} ушло</span></div></div>`;
      }).join('')}</div>
      <div class="card mt"><div class="card-h"><h2>Куда перешли задачи</h2></div><div class="card-b">${matrixHtml(res)}
        ${res.outsideNew ? `<p class="sub" style="margin:10px 0 0">Ещё ${res.outsideNew} новых задач появилось вне отслеживаемых этапов (например, «В работе») — они не в счёте.</p>` : ''}</div></div>
      <div class="grid g2 mt" style="align-items:start">
        <div class="card"><div class="card-h"><h2>Сотрудники с движением</h2><a class="btn btn-sm" href="#/people">Все сотрудники</a></div>
          <div class="tw"><table><thead><tr><th>Сотрудник</th><th class="r">Было → стало</th><th class="r">Пришли</th><th class="r">Продвинули</th><th class="r">Выбыли</th></tr></thead><tbody>
          ${people.map((p) => `<tr class="click" data-person="${esc(p.name)}"><td>${esc(p.name)}</td><td class="r num">${p.before.total} → ${p.after.total}</td><td class="r num">${p.n.new + p.n.enter || '·'}</td><td class="r num">${p.n.advance || '·'}</td><td class="r num">${p.n.exit || '·'}</td></tr>`).join('')}
          </tbody></table></div></div>
        <div class="card"><div class="card-h"><h2>Пришли в этапы (${newOnes.length})</h2><a class="btn btn-sm" href="#/objects" data-kinds="arrived">Все</a></div>
          ${newOnes.length ? `<div class="tw"><table><thead><tr><th>Объект</th><th>Поисковик</th><th>Этап</th></tr></thead><tbody>
          ${newOnes.slice(0, 10).map((e) => `<tr class="click" data-obj="${e.id}"><td class="addr"><span class="addr-t">${esc(short(e.row.address))}</span><span class="sub num">№ ${e.id}</span></td><td>${esc(e.who)}</td><td>${trans(e.fromStage, e.toStage)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">Никто не пришёл в этапы</div>'}</div>
      </div>`;
  }

  // «возврат» = откат внутри отслеживаемых этапов + уход на более ранний этап за их пределами
  const backCount = (res) => res.events.filter((e) => e.kind === 'back' || (e.kind === 'exit' && e.sub === 'behind')).length;
  const act = (p) => p.n.new + p.n.enter + p.n.advance + p.n.back + p.n.exit;
  function exitBreak(res) {
    const c = { gone: 0, beyond: 0, behind: 0, filter: 0 };
    res.events.forEach((e) => { if (e.kind === 'exit') c[e.sub]++; });
    const parts = [];
    if (c.gone) parts.push(`${c.gone} пропали из выгрузки`);
    if (c.beyond) parts.push(`${c.beyond} дальше по воронке`);
    if (c.behind) parts.push(`${c.behind} на ранний этап`);
    if (c.filter) parts.push(`${c.filter} сменили фильтр`);
    return parts.join(' · ') || 'нет';
  }

  // одна выгрузка — состояние без динамики
  function pgSingle() {
    const s = latest(), S = C.mkSets(state.scope);
    const cnt = C.stageCounts(s.rows, S, s.date);
    const by = new Map();
    s.rows.forEach((r) => { if (C.inScope(r, S)) { const n = C.person(r); if (!by.has(n)) by.set(n, { name: n, total: 0, byStage: {}, od: 0 }); const p = by.get(n); p.total++; p.byStage[r.stage] = (p.byStage[r.stage] || 0) + 1; if (C.isOverdue(r, s.date)) p.od++; } });
    const list = [...by.values()].sort((a, b) => b.total - a.total);
    return `
      <div class="page-h"><div><h1>Воронка на ${fdy(s.date)}</h1><p>${esc(scopeLine())}</p></div></div>
      <div class="note" style="margin-bottom:14px">Загружена одна выгрузка, поэтому динамики пока нет. Загрузите следующую — и здесь появится, кто что сделал за период.</div>
      <div class="grid g3 stages">${scopeStages().map((st) => `<div class="card stage-card"><i class="bar s${stIdx(st)}"></i><div class="nm">${esc(st)}</div><div class="big num">${cnt.byStage[st] || 0}</div></div>`).join('')}</div>
      <div class="card mt"><div class="card-h"><h2>Сотрудники (${list.length})</h2>${legend()}</div><div class="tw"><table><thead><tr><th>Сотрудник</th><th class="r">Объектов</th><th>Этапы</th><th class="r">Просрочено</th></tr></thead><tbody>
      ${list.map((p) => `<tr class="click" data-person="${esc(p.name)}"><td>${esc(p.name)}</td><td class="r num">${p.total}</td><td style="width:34%">${seg(p.byStage, p.total, list[0].total)}</td><td class="r num">${p.od || '·'}</td></tr>`).join('')}</tbody></table></div></div>`;
  }

  /* ---------- Сотрудники ---------- */
  function pgPeople() {
    const res = getCmp();
    return `<div class="page-h"><div><h1>Сотрудники</h1><p>${res ? `Изменения за ${fd(res.A.date)} → ${fd(res.B.date)}. Нажмите на фамилию, чтобы открыть карточку.` : 'Нажмите на фамилию, чтобы открыть карточку.'}</p></div></div>
      <div class="bar-f"><input type="search" id="pq" placeholder="Найти сотрудника" value="${esc(state.pq)}" data-act="pq">
        ${res ? `<label class="checks"><label><input type="checkbox" data-act="onlyMoved" ${state.onlyMoved ? 'checked' : ''}>Отобразить только с движением</label></label>` : ''}</div>
      <div class="card" id="peopleBody"></div>`;
  }

  function peopleRows() {
    const res = getCmp();
    if (res) return res.people.map((p) => ({ ...p, act: act(p), dTotal: p.after.total - p.before.total, od: p.after.overdue, dOd: p.after.overdue - p.before.overdue, arrived: p.n.new + p.n.enter }));
    const s = latest(), S = C.mkSets(state.scope), by = new Map();
    s.rows.forEach((r) => { if (C.inScope(r, S)) { const n = C.person(r); if (!by.has(n)) by.set(n, { name: n, n: { new: 0, enter: 0, advance: 0, back: 0, exit: 0, same: 0 }, events: [], before: { total: 0, byStage: {}, overdue: 0 }, after: { total: 0, byStage: {}, overdue: 0 } }); const p = by.get(n); p.after.total++; p.after.byStage[r.stage] = (p.after.byStage[r.stage] || 0) + 1; if (C.isOverdue(r, s.date)) p.after.overdue++; } });
    return [...by.values()].map((p) => ({ ...p, act: 0, dTotal: 0, od: p.after.overdue, dOd: 0, arrived: 0 }));
  }

  function renderPeopleBody() {
    const host = document.getElementById('peopleBody'); if (!host) return;
    const res = getCmp();
    let rows = peopleRows();
    const q = state.pq.trim().toLowerCase();
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));
    if (res && state.onlyMoved) rows = rows.filter((p) => act(p) > 0); // движение = пришёл / продвинулся / откат / выбыл
    const k = state.sort.key, d = state.sort.dir;
    const val = { name: (p) => p.name, before: (p) => p.before.total, after: (p) => p.after.total, delta: (p) => p.dTotal, arrived: (p) => p.arrived, advance: (p) => p.n.advance, back: (p) => p.n.back, exit: (p) => p.n.exit, same: (p) => p.n.same, od: (p) => p.od, activity: (p) => p.act * 1000 + p.after.total }[k] || ((p) => p.act);
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * d || a.name.localeCompare(b.name, 'ru'); });
    const max = Math.max(1, ...rows.map((p) => p.after.total));
    const th = (key, label, cls) => `<th class="sort ${cls || ''} ${k === key ? 'on' + (d > 0 ? ' asc' : '') : ''}" data-sort="${key}">${label}</th>`;
    host.innerHTML = rows.length ? `<div class="tw"><table><thead><tr>
      ${th('name', 'Сотрудник')}${res ? th('before', 'Было', 'r') : ''}${th('after', res ? 'Стало' : 'Объектов', 'r')}${res ? th('delta', 'Δ', 'r') + th('arrived', 'Пришли', 'r') + th('advance', 'Продвинули', 'r') + th('back', 'Откат', 'r') + th('exit', 'Выбыли', 'r') + th('same', 'Без движения', 'r') : ''}
      <th>Этапы сейчас</th>${th('od', 'Просрочено', 'r')}</tr></thead><tbody>
      ${rows.map((p) => `<tr class="click" data-person="${esc(p.name)}"><td>${esc(p.name)}</td>
        ${res ? `<td class="r num">${p.before.total}</td>` : ''}<td class="r num"><b>${p.after.total}</b></td>
        ${res ? `<td class="r num">${delta(p.dTotal, null)}</td><td class="r num">${p.arrived || '<span class="zero">·</span>'}</td><td class="r num">${p.n.advance || '<span class="zero">·</span>'}</td><td class="r num">${p.n.back || '<span class="zero">·</span>'}</td><td class="r num">${p.n.exit || '<span class="zero">·</span>'}</td><td class="r num">${p.n.same || '<span class="zero">·</span>'}</td>` : ''}
        <td style="width:18%">${seg(p.after.byStage, p.after.total, max)}</td>
        <td class="r num">${p.od ? p.od : '<span class="zero">·</span>'}${res && p.dOd ? ' <span class="sub">(' + (p.dOd > 0 ? '+' : '−') + Math.abs(p.dOd) + ')</span>' : ''}</td></tr>`).join('')}
      </tbody></table></div><div class="card-b">${legend()}</div>` : '<div class="empty">Никого не нашлось</div>';
  }

  /* ---------- Карточка сотрудника ---------- */
  function pgPerson(name) {
    const res = getCmp();
    const snaps = sorted();
    const tr = C.personTrend(snaps, state.scope, name);
    let p = res ? res.people.find((x) => x.name === name) : null;
    if (!res) {
      const s = latest(), S = C.mkSets(state.scope), rows = s.rows.filter((r) => C.person(r) === name && C.inScope(r, S));
      const c = C.stageCounts(rows, S, s.date);
      p = { name, n: { new: 0, enter: 0, advance: 0, back: 0, exit: 0, same: 0 }, events: rows.map((r) => ({ id: r.id, kind: 'same', sub: null, who: name, a: null, b: r, fromStage: r.stage, toStage: r.stage, row: r, overdueA: false, overdueB: C.isOverdue(r, s.date), reassignedFrom: null, dueChange: null })), before: c, after: c };
    }
    if (!p) return `<a class="back" href="#/people">← Все сотрудники</a><div class="card"><div class="empty">У сотрудника «${esc(name)}» нет объектов в выбранных этапах в этих выгрузках.</div></div>`;
    const arrived = p.n.new + p.n.enter;
    const group = (title, kinds, hint) => {
      const list = p.events.filter((e) => kinds.includes(e.kind)).sort((a, b) => (a.row.address || '').localeCompare(b.row.address || '', 'ru'));
      if (!list.length) return '';
      return `<div class="card mt" style="overflow:hidden"><div class="ev-h">${title}<span class="cnt">${list.length}</span>${hint ? `<span class="sub" style="font-weight:400">${hint}</span>` : ''}</div><div class="tw"><table><thead><tr><th>Объект</th><th>Этап</th><th>Что произошло</th><th>Срок</th></tr></thead><tbody>${list.map((e) => evRow(e)).join('')}</tbody></table></div></div>`;
    };
    const before = res ? p.before : null;
    return `
      <a class="back" href="#/people">← Все сотрудники</a>
      <div class="page-h"><div><h1>${esc(name)}</h1><p>${res ? `Изменения за ${fd(res.A.date)} → ${fd(res.B.date)} (${res.days} ${plural(res.days, ['день', 'дня', 'дней'])})` : 'Состояние на ' + fdy(latest().date)}</p></div></div>
      <div class="grid g5">
        ${kpi('Сейчас в этапах', p.after.total, before ? `было ${before.total} · ${delta(p.after.total - before.total, null)}` : '')}
        ${kpi('Пришли в этапы', res ? arrived : '—', res ? `${p.n.enter} из ранних · ${p.n.new} новых` : 'нужна вторая выгрузка', res && arrived ? 'hl' : '')}
        ${kpi('Продвинулись', res ? p.n.advance : '—', res && p.n.back ? `${p.n.back} откатились` : '')}
        ${kpi('Выбыли', res ? p.n.exit : '—', res && p.n.same ? `${p.n.same} без движения` : '')}
        ${kpi('Просрочено', p.after.overdue, before ? `было ${before.overdue} · ${delta(p.after.overdue - before.overdue, 'down')}` : '')}
      </div>
      <div class="grid g2 mt" style="align-items:start">
        <div class="card"><div class="card-h"><h2>По этапам</h2></div><div class="card-b"><table><thead><tr><th>Этап</th>${res ? '<th class="r">Было</th>' : ''}<th class="r">Сейчас</th>${res ? '<th class="r">Δ</th>' : ''}</tr></thead><tbody>
          ${scopeStages().map((s) => `<tr><td>${stageChip(s)}</td>${res ? `<td class="r num">${before.byStage[s] || 0}</td>` : ''}<td class="r num"><b>${p.after.byStage[s] || 0}</b></td>${res ? `<td class="r num">${delta((p.after.byStage[s] || 0) - (before.byStage[s] || 0), null)}</td>` : ''}</tr>`).join('')}
        </tbody></table></div></div>
        <div class="card"><div class="card-h"><h2>Динамика по выгрузкам</h2>${legend()}</div><div class="card-b">${trendHtml(tr)}</div></div>
      </div>
      ${res ? group('Пришли в этапы', ['new', 'enter']) + group('Продвинулись', ['advance']) + group('Откатились назад', ['back']) + group('Выбыли из этапов', ['exit'], 'ушли дальше, на ранний этап, в другой фильтр или пропали из выгрузки') + group('Без движения', ['same'], 'тот же этап, что и в прошлой выгрузке') : group('Объекты', ['same'])}`;
  }

  /* ---------- Объекты ---------- */
  // кнопки-фильтры; «Новые» — часть «Пришли в этапы», поэтому кнопки могут перекрываться
  const MATCH = { arrived: (e) => e.kind === 'new' || e.kind === 'enter', new: (e) => e.kind === 'new', advance: (e) => e.kind === 'advance', back: (e) => e.kind === 'back', exit: (e) => e.kind === 'exit', same: (e) => e.kind === 'same' };
  function pgObjects() {
    const res = getCmp();
    // «Пришли в этапы» = новые задачи + пришедшие из ранних этапов — как на карточке в Обзоре
    const kinds = [['arrived', 'Пришли в этапы'], ['new', 'Новые'], ['advance', 'Продвинулись'], ['back', 'Откат'], ['exit', 'Выбыли'], ['same', 'Без движения']];
    const who = [...new Set((res ? res.events.map((e) => e.who) : latest().rows.map((r) => C.person(r))))].sort((a, b) => a.localeCompare(b, 'ru'));
    return `<div class="page-h"><div><h1>Объекты</h1><p>${res ? `Что произошло с каждым объектом за ${fd(res.A.date)} → ${fd(res.B.date)}. Нажмите на строку — откроется история статусов.` : 'Объекты в отслеживаемых этапах.'}</p></div></div>
      <div class="bar-f"><input type="search" id="oq" placeholder="Адрес или номер задачи" value="${esc(state.of.q)}" data-act="oq">
        <select data-act="owho"><option value="">Все сотрудники</option>${who.map((w) => `<option ${state.of.who === w ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select>
        ${res ? kinds.map(([k, l]) => `<button class="tog ${state.of.kinds.has(k) ? 'on' : ''}" data-kind="${k}">${l}</button>`).join('') : ''}</div>
      <div class="card" id="objList"></div>`;
  }

  function renderObjList() {
    const host = document.getElementById('objList'); if (!host) return;
    const res = getCmp();
    let list;
    if (res) list = res.events.filter((e) => [...state.of.kinds].some((k) => MATCH[k](e)));
    else { const s = latest(), S = C.mkSets(state.scope); list = s.rows.filter((r) => C.inScope(r, S)).map((r) => ({ id: r.id, kind: 'same', sub: null, who: C.person(r), a: null, b: r, fromStage: r.stage, toStage: r.stage, row: r, overdueA: false, overdueB: C.isOverdue(r, s.date), reassignedFrom: null, dueChange: null })); }
    if (state.of.who) list = list.filter((e) => e.who === state.of.who);
    const q = state.of.q.trim().toLowerCase();
    if (q) list = list.filter((e) => String(e.id).includes(q) || (e.row.address || '').toLowerCase().includes(q));
    const order = { new: 0, enter: 1, advance: 2, back: 3, exit: 4, same: 5 };
    list.sort((a, b) => order[a.kind] - order[b.kind] || (a.who || '').localeCompare(b.who || '', 'ru'));
    host.innerHTML = list.length ? `<div class="tw"><table><thead><tr><th>Объект</th><th>Поисковик</th><th>Этап</th><th>Что произошло</th><th>Срок</th></tr></thead><tbody>${list.slice(0, 400).map((e) => evRow(e, { who: true })).join('')}</tbody></table></div>${list.length > 400 ? `<div class="card-b sub">Показано 400 из ${list.length}. Уточните поиск.</div>` : `<div class="card-b sub">${list.length} ${plural(list.length, ['объект', 'объекта', 'объектов'])}</div>`}` : '<div class="empty">Ничего не найдено</div>';
  }

  /* ---------- Карточка объекта ---------- */
  function renderDrawer() {
    const host = document.getElementById('drawerHost'); if (!host) return;
    if (!state.drawer) { host.innerHTML = ''; return; }
    const id = state.drawer, snaps = sorted();
    const hist = C.taskHistory(snaps, id);
    const last = [...hist].reverse().find((h) => h.row);
    if (!last) { host.innerHTML = ''; return; }
    const r = last.row, since = C.stageSince(hist);
    const age = r.created ? C.daysBetween(r.created, last.date) : null;
    let prev = null;
    const items = hist.map((h) => {
      let cls = '', body;
      if (!h.row) { body = '<span class="muted">нет в выгрузке</span>'; cls = 'gone'; }
      else {
        const notes = [];
        if (prev && prev.stage !== h.row.stage) cls = 'chg';
        if (!prev && hist.indexOf(h) > 0) cls = 'chg';
        if (prev && (prev.searcher || '') !== (h.row.searcher || '')) notes.push('сотрудник: ' + esc(prev.searcher || '—') + ' → ' + esc(h.row.searcher || '—'));
        if (prev && prev.due !== h.row.due) notes.push('срок: ' + fd(prev.due) + ' → ' + fd(h.row.due));
        if (C.isOverdue(h.row, h.date)) notes.push('<span class="neg">просрочен</span>');
        body = stageChip(h.row.stage) + (notes.length ? `<div class="sub">${notes.join(' · ')}</div>` : '');
        prev = h.row;
      }
      return `<li class="${cls}"><div class="d">${fdy(h.date)}</div>${body}</li>`;
    }).reverse();
    const kv = [
      ['Статус сейчас', stageChip(r.stage) + (since && since.snapshots > 1 ? ` <span class="sub">· без смены уже ${since.snapshots} выгр., с ${fd(since.since)} или раньше</span>` : '')],
      ['Поисковик', esc(r.searcher || '—')], ['Менеджер по развитию', esc(r.devManager || '—')], ['Бренд · тип ТТ', esc((r.brand || '—') + ' · ' + (r.tt || '—'))],
      ['Регион', esc(r.region || '—')], ['Создана', fd(r.created) + (age != null ? ` <span class="sub">· ${age} дн. назад</span>` : '')],
      ['Срок', r.due ? fd(r.due) + (C.isOverdue(r, last.date) ? ' <span class="chip od">просрочен на ' + C.daysBetween(r.due, last.date) + ' дн.</span>' : '') : '—'],
      ['Территория', esc(r.territory || '—')], ['Проектный менеджер', esc(r.pm || '—')], ['Юрисконсульт', esc(r.lawyer || '—')], ['Рук. строительного отдела', esc(r.builder || '—')],
      ['Номер ТТ', r.shop || '—'], ['Фактическое открытие', r.openedAt ? fdy(r.openedAt) : '—'],
    ];
    host.innerHTML = `<div class="veil" data-act="closeDrawer"></div><aside class="drawer" role="dialog" aria-label="Карточка объекта">
      <div class="drawer-h"><div><div class="sub num">Задача № ${id}</div><h2 style="margin-top:2px">${esc(short(r.address))}</h2></div><button class="x" data-act="closeDrawer" aria-label="Закрыть">×</button></div>
      <div class="drawer-b"><h3 style="margin-bottom:10px">История статусов</h3><ul class="tl">${items.join('')}</ul>
      <h3 style="margin:24px 0 10px">Данные из выгрузки ${fd(last.date)}</h3><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div></aside>`;
  }

  /* ---------- Фильтры, история, окно загрузки ---------- */
  function allValues(key) {
    const set = new Set();
    state.snaps.forEach((s) => s.rows.forEach((r) => { const v = key === 'region' ? C.normRegion(r.region) : r[key]; if (v) set.add(v); }));
    return [...set].sort((a, b) => String(a).localeCompare(String(b), 'ru'));
  }

  function popScope() {
    const checks = (key, vals, cur) => `<div class="checks">${vals.map((v) => `<label><input type="checkbox" data-scope="${key}" value="${esc(v)}" ${cur.includes(v) ? 'checked' : ''}>${esc(v)}</label>`).join('')}</div>`;
    const stageVals = C.STAGES.concat(allValues('stage').filter((x) => !C.STAGES.includes(x)));
    const regions = ['Москва', 'МО', 'СПб', 'ЛО', ...allValues('region').filter((x) => !['Москва', 'МО', 'СПб', 'ЛО'].includes(x))];
    return `<div class="pop-h"><h3>Какие объекты считаем</h3><button class="x" data-act="closePop" aria-label="Закрыть">×</button></div>
      <div class="pop-b grid" style="gap:14px">
        <div class="fld"><b>Регионы</b>${checks('regions', regions, state.scope.regions)}</div>
        <div class="fld"><b>Бренды</b>${checks('brands', allValues('brand'), state.scope.brands)}</div>
        <div class="fld"><b>Статус ТТ</b>${checks('tt', allValues('tt'), state.scope.tt)}</div>
        <div class="fld"><b>Этапы</b>${checks('stages', stageVals, state.scope.stages)}</div>
      </div>`;
  }

  function popHist() {
    const S = C.mkSets(state.scope);
    const rows = sorted().slice().reverse().map((x) => {
      const c = C.stageCounts(x.rows, S, x.date);
      const loc = state.localDates.has(x.date), vlt = state.vaultDates.has(x.date);
      const where = loc ? (vlt ? 'заменена в этом браузере' : 'только в этом браузере') : 'у всех';
      return `<tr><td><b>${fdy(x.date)}</b><div class="sub">${where}</div></td><td class="r num">${x.rows.length}</td><td class="r num">${c.total}</td><td class="r">${loc ? `<button class="btn btn-sm btn-danger" data-delsnap="${x.date}" title="Удалить из этого браузера">×</button>` : ''}</td></tr>`;
    }).join('');
    return `<div class="pop-h"><h3>История выгрузок</h3><button class="x" data-act="closePop" aria-label="Закрыть">×</button></div>
      <div class="pop-b">
        <table><thead><tr><th>Дата</th><th class="r">Задач</th><th class="r">В этапах</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Пока пусто</td></tr>'}</tbody></table>
        ${state.skippedLocal ? `<div class="note warn" style="margin-top:10px">${state.skippedLocal} локальных записей зашифрованы прежним паролем и не открылись.</div>` : ''}
        ${state.idbOff ? '<div class="note warn" style="margin-top:10px">Браузер не сохраняет данные (приватный режим?). Загруженное пропадёт после закрытия вкладки.</div>' : ''}
      </div>`;
  }

  function renderPop() {
    const host = document.getElementById('popHost'); if (!host) return;
    document.querySelectorAll('[data-pop]').forEach((b) => b.classList.toggle('on', b.dataset.pop === state.pop));
    if (!state.pop) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="pop" role="dialog">${state.pop === 'scope' ? popScope() : popHist()}</div>`;
  }

  function modalBody() {
    const p = state.pending;
    if (p.loading) return '<p class="muted">Читаю файл…</p>';
    if (p.error) return `<div class="note bad">${esc(p.error)}</div><div class="row" style="margin-top:14px"><button class="btn" data-act="cancelSnap">Закрыть</button></div>`;
    const S = C.mkSets(state.scope), cnt = C.stageCounts(p.rows, S, p.date || '9999-12-31');
    const warns = [];
    const prevSnap = sorted().filter((x) => x.date < (p.date || '9999')).pop();
    if (prevSnap && p.date) {
      const ids = new Set(p.rows.map((r) => r.id));
      const miss = prevSnap.rows.filter((r) => !ids.has(r.id)).length;
      if (miss / prevSnap.rows.length > 0.25) warns.push(`Из прошлой выгрузки (${fd(prevSnap.date)}) в этом файле не нашлось ${miss} из ${prevSnap.rows.length} задач. Похоже, применён другой фильтр — тогда они будут показаны как «пропали из выгрузки».`);
    }
    const unk = [...new Set(p.rows.map((r) => r.stage).filter((x) => x && !C.STAGES.includes(x)))];
    if (unk.length) warns.push('Неизвестные этапы: ' + unk.join(', ') + '. Они посчитаются как «дальше по воронке» — сообщите, чтобы добавить их в порядок этапов.');
    if (!cnt.total) warns.push('В отслеживаемые этапы не попало ни одного объекта. Проверьте фильтры наверху.');
    if (p.absent.length) warns.push('В файле нет необязательных колонок: ' + p.absent.join(', ') + '.');
    const exists = p.date && state.snaps.some((x) => x.date === p.date);
    return `<div class="grid" style="gap:12px">
      <div><b>${esc(p.fileName)}</b><div class="muted">${p.rows.length} задач · в отслеживаемых этапах ${cnt.total} (${scopeStages().map((s) => s + ' ' + (cnt.byStage[s] || 0)).join(' · ')})</div></div>
      <div class="fld"><b>Дата, на которую сделана выгрузка</b><input type="date" id="snapDate" value="${p.date || ''}" data-act="snapDate" style="width:180px"></div>
      ${exists ? `<div class="note warn">Выгрузка за ${fdy(p.date)} уже есть — при сохранении она будет заменена.</div>` : ''}
      ${warns.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}
      <div class="row"><button class="btn btn-primary" data-act="saveSnap" ${p.date ? '' : 'disabled'}>Сохранить выгрузку</button><button class="btn" data-act="cancelSnap">Отмена</button></div></div>`;
  }

  function renderModal() {
    const host = document.getElementById('modalHost'); if (!host) return;
    if (!state.pending) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="veil" data-act="cancelSnap"></div><div class="modal" role="dialog" aria-label="Загрузка выгрузки"><div class="pop-h"><h3>Загрузка выгрузки</h3><button class="x" data-act="cancelSnap" aria-label="Закрыть">×</button></div><div class="pop-b">${modalBody()}</div></div>`;
  }

  /* ---------- загрузка файла ---------- */
  async function handleFile(file) {
    if (!file) return;
    state.pop = null; renderPop();
    state.pending = { loading: true }; renderModal();
    try {
      if (!window.XLSX) throw new Error('Не загрузилась библиотека чтения xlsx (нужен интернет при первом открытии).');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      let parsed = null, lastErr = null;
      const names = wb.SheetNames.slice().sort((a) => (a === 'Открытия' ? -1 : 1));
      for (const n of names) {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
        const r = C.parseAoa(aoa);
        if (r.error) lastErr = r.error; else { parsed = r; break; }
      }
      if (!parsed) throw new Error(lastErr || 'Не удалось разобрать файл');
      if (!parsed.rows.length) throw new Error('В файле нет ни одной задачи.');
      const maxCreated = parsed.rows.reduce((m, r) => (r.created && r.created > m ? r.created : m), '');
      const guess = C.guessDateFromName(file.name, maxCreated ? maxCreated.slice(0, 4) : null)
        || (maxCreated ? maxCreated : null)
        || new Date(file.lastModified).toISOString().slice(0, 10);
      state.pending = { rows: parsed.rows, fileName: file.name, date: guess, skipped: parsed.skippedGroupRows, absent: parsed.absentOptional };
    } catch (e) {
      state.pending = { error: e.message || String(e) };
    }
    renderModal();
  }

  async function saveSnap() {
    const p = state.pending; if (!p || !p.date) return;
    const snap = { date: p.date, fileName: p.fileName, uploadedAt: new Date().toISOString(), rows: p.rows };
    try { await V.localSave(state.key, state.saltId, snap); } catch (e) { state.idbOff = true; }
    state.snaps = state.snaps.filter((x) => x.date !== snap.date).concat(snap);
    state.localDates.add(snap.date);
    state.pending = null; state.cmp = null; cmpCache = null;
    toast('Выгрузка за ' + fdy(snap.date) + ' сохранена');
    location.hash = '#/overview';
    renderShell();
  }

  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function report() {
    const res = getCmp(); if (!res || !window.XLSX) return;
    const wb = XLSX.utils.book_new();
    const st = scopeStages();
    const people = res.people.slice().sort((a, b) => act(b) - act(a)).map((p) => ({
      'Сотрудник': p.name, 'Было': p.before.total, 'Стало': p.after.total, 'Δ': p.after.total - p.before.total,
      'Пришли (новые + из ранних этапов)': p.n.new + p.n.enter, 'Продвинулись': p.n.advance, 'Откатились': p.n.back, 'Выбыли': p.n.exit, 'Без движения': p.n.same,
      'Просрочено было': p.before.overdue, 'Просрочено стало': p.after.overdue,
      ...Object.fromEntries(st.map((s) => [s + ' (стало)', p.after.byStage[s] || 0])),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(people), 'Сотрудники');
    const kindName = (e) => ({ new: 'Новая задача', enter: 'Пришла в этап', advance: 'Продвинулась', back: 'Откат назад', same: 'Без движения', exit: { gone: 'Пропала из выгрузки', beyond: 'Ушла дальше по воронке', behind: 'Ушла на ранний этап', filter: 'Вышла из фильтра' }[e.sub] }[e.kind]);
    const evs = res.events.filter((e) => e.kind !== 'same').map((e) => ({
      'Номер задачи': e.id, 'Адрес': short(e.row.address), 'Сотрудник': e.who, 'Бренд': e.row.brand, 'Что произошло': kindName(e),
      ['Этап ' + fd(res.A.date)]: e.fromStage || 'нет', ['Этап ' + fd(res.B.date)]: e.toStage || 'нет в выгрузке', 'Срок': e.row.due || '', 'Просрочен': e.overdueB ? 'да' : '',
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(evs), 'События');
    download(new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], { type: 'application/octet-stream' }), `Динамика воронки ${res.A.date} — ${res.B.date}.xlsx`);
  }

  /* ---------- события ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target;
    let el;
    if ((el = t.closest('[data-pop]'))) { state.pop = state.pop === el.dataset.pop ? null : el.dataset.pop; renderPop(); return; }
    if (state.pop && !t.closest('.pop')) { state.pop = null; renderPop(); }
    if ((el = t.closest('[data-obj]'))) { state.drawer = +el.dataset.obj; renderDrawer(); return; }
    if ((el = t.closest('[data-person]'))) { location.hash = '#/person/' + encodeURIComponent(el.dataset.person); return; }
    if ((el = t.closest('[data-sort]'))) { const k = el.dataset.sort; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'name' ? 1 : -1) }; renderPeopleBody(); return; }
    if ((el = t.closest('[data-kind]'))) { const k = el.dataset.kind; state.of.kinds.has(k) ? state.of.kinds.delete(k) : state.of.kinds.add(k); el.classList.toggle('on'); renderObjList(); return; }
    if ((el = t.closest('[data-kinds]'))) { state.of.kinds = new Set(el.dataset.kinds.split(',')); return; } // ссылка «Все» ведёт на #/objects
    if ((el = t.closest('[data-delsnap]'))) { const d = el.dataset.delsnap; if (confirm('Удалить выгрузку за ' + fdy(d) + ' из этого браузера?')) { V.localDelete(d).then(() => { state.localDates.delete(d); if (state.vaultDates.has(d)) { /* вернётся версия из vault.json после перезагрузки */ toast('Локальная версия удалена. Опубликованная вернётся после обновления страницы.'); } state.snaps = state.snaps.filter((x) => x.date !== d); cmpCache = null; state.cmp = null; renderShell(); }); } return; }
    if ((el = t.closest('[data-act]'))) {
      const a = el.dataset.act;
      if (a === 'closeDrawer') { state.drawer = null; renderDrawer(); }
      else if (a === 'saveSnap') saveSnap();
      else if (a === 'cancelSnap') { state.pending = null; renderModal(); }
      else if (a === 'closePop') { state.pop = null; renderPop(); }
      else if (a === 'report') report();
      return;
    }
    if (t.closest('#drop')) document.getElementById('fileIn').click();
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'fileIn') { handleFile(t.files[0]); t.value = ''; return; }
    if (t.dataset.act === 'cmpA' || t.dataset.act === 'cmpB') {
      const n = Object.assign({}, state.cmp); if (t.dataset.act === 'cmpA') n.a = t.value; else n.b = t.value;
      if (n.a >= n.b) { toast('Левая дата должна быть раньше правой'); renderShell(); return; }
      state.cmp = n; renderShell(); return;
    }
    if (t.dataset.act === 'onlyMoved') { state.onlyMoved = t.checked; renderPeopleBody(); return; }
    if (t.dataset.act === 'owho') { state.of.who = t.value; renderObjList(); return; }
    if (t.dataset.act === 'snapDate') { if (state.pending) { state.pending.date = t.value; renderModal(); } return; }
    if (t.dataset.scope) {
      const k = t.dataset.scope, set = new Set(state.scope[k]);
      t.checked ? set.add(t.value) : set.delete(t.value);
      state.scope[k] = [...set]; saveScope(); cmpCache = null;
      const y = window.scrollY, pp = document.querySelector('.pop'), py = pp ? pp.scrollTop : 0;
      renderView(); renderPop(); window.scrollTo(0, y);
      const np = document.querySelector('.pop'); if (np) np.scrollTop = py;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.act === 'pq') { state.pq = t.value; renderPeopleBody(); }
    if (t.dataset.act === 'oq') { state.of.q = t.value; renderObjList(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.pending) { state.pending = null; renderModal(); }
    else if (state.pop) { state.pop = null; renderPop(); }
    else if (state.drawer) { state.drawer = null; renderDrawer(); }
  });

  document.addEventListener('dragover', (e) => { const d = e.target.closest && e.target.closest('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
  document.addEventListener('dragleave', (e) => { const d = e.target.closest && e.target.closest('#drop'); if (d) d.classList.remove('over'); });
  document.addEventListener('drop', (e) => { const d = e.target.closest && e.target.closest('#drop'); if (d) { e.preventDefault(); d.classList.remove('over'); handleFile(e.dataTransfer.files[0]); } });

  window.addEventListener('hashchange', () => { if (state.key) { state.drawer = null; renderView(); } });

  window.__ft = { state, getCmp }; // для отладки и tests.html
  boot();
})();
