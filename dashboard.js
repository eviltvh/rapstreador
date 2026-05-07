/* ═══════════════════════════════════════════════════════════
   POLPO :: NETWORK ANALYZER  ·  dashboard.js
   Toda la lógica de visualización (D3 + grafo + interacción).
   No conoce Supabase: solo recibe rows transformados desde app.js
   y dibuja. Entry point: buildDashboard(rows).
   -bynd
   ═══════════════════════════════════════════════════════════ */

"use strict";

// ─── DEAD BRANCH CONFIG ──────────────────────────────────
// status que cuentan como "muertos" base. luego se propaga hacia arriba:
// si un nodo no-mutual tiene TODOS sus out-edges apuntando a muertos,
// también se considera muerto -> rama muerta entera en morado.
const DEAD_STATUSES = new Set(['inactive', 'request_canceled']);
const DEAD_COLOR = '#B14DFF';

// ─── STATE ───────────────────────────────────────────────
const state = {
  nodes: [],
  links: [],
  nodeMap: new Map(),
  adj: new Map(),
  outAdj: new Map(),
  inAdj: new Map(),
  deadSet: new Set(),
  filter: 'all',
  selectedId: null,
  pathIds: new Set(),
  pathOrdered: [],
  showLabels: true,
  frozen: false,
};

// ─── BUILD GRAPH FROM ROWS ───────────────────────────────
function buildGraph(rows) {
  const nodeMap = new Map();

  const ensureNode = (id, isGhost = false) => {
    if (!id) return null;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        id,
        username: id,
        ghost: isGhost,
        status: isGhost ? 'origin' : 'unknown',
        mutual: false,
        origen: '',
        followed_at: '',
        mutual_checked_at: '',
        unfollowed_at: '',
        last_updated: '',
        profile_followers: '',
        profile_following: '',
        profile_ratio: '',
        stand_type: '',
      });
    } else if (!isGhost) {
      nodeMap.get(id).ghost = false;
    }
    return nodeMap.get(id);
  };

  const links = [];
  rows.forEach(row => {
    const u = (row.username || '').trim();
    if (!u) return;
    const node = ensureNode(u, false);
    Object.assign(node, {
      followed_at: row.followed_at || '',
      status: (row.status || 'unknown').toLowerCase(),
      mutual: row.mutual === true || String(row.mutual || '').toLowerCase() === 'true',
      mutual_checked_at: row.mutual_checked_at || '',
      unfollowed_at: row.unfollowed_at || '',
      last_updated: row.last_updated || '',
      origen: (row.origen || '').trim(),
      profile_followers: row.profile_followers ?? '',
      profile_following: row.profile_following ?? '',
      profile_ratio: row.profile_ratio ?? '',
      stand_type: row.stand_type || '',
    });

    const o = node.origen;
    if (o && o.toLowerCase() !== 'unknown' && o !== u) {
      ensureNode(o, true);
      links.push({ source: o, target: u });
    }
  });

  const seen = new Set();
  const dedup = [];
  links.forEach(l => {
    const k = `${l.source}|${l.target}`;
    if (!seen.has(k)) { seen.add(k); dedup.push(l); }
  });

  return { nodes: Array.from(nodeMap.values()), links: dedup };
}

// ─── ADJACENCY + STATS ───────────────────────────────────
function indexGraph(nodes, links) {
  const adj = new Map();
  const outAdj = new Map();
  const inAdj = new Map();
  const nodeMap = new Map();
  nodes.forEach(n => {
    adj.set(n.id, new Set());
    outAdj.set(n.id, new Set());
    inAdj.set(n.id, new Set());
    nodeMap.set(n.id, n);
  });
  links.forEach(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    adj.get(s)?.add(t);
    adj.get(t)?.add(s);
    outAdj.get(s)?.add(t);
    inAdj.get(t)?.add(s);
  });
  return { adj, outAdj, inAdj, nodeMap };
}

// ─── DEAD SET COMPUTATION ────────────────────────────────
// 1) marca como muertos los que tienen status ∈ DEAD_STATUSES
// 2) propaga: cualquier nodo no-mutual cuyos out-edges TODOS son muertos,
//    también es muerto. itera hasta estabilizar (fixed-point).
// los mutuals nunca se marcan muertos -> el origen amarillo se respeta.
// los ghosts (origenes puros) sí pueden marcarse si toda su descendencia es muerta.
function computeDeadSet() {
  const dead = new Set();

  // base
  state.nodes.forEach(n => {
    if (!n.mutual && DEAD_STATUSES.has((n.status || '').toLowerCase())) {
      dead.add(n.id);
    }
  });

  // propagation
  let changed = true;
  while (changed) {
    changed = false;
    state.nodes.forEach(n => {
      if (dead.has(n.id) || n.mutual) return;
      const outs = state.outAdj.get(n.id);
      if (!outs || outs.size === 0) return; // hojas no propagan
      let allDead = true;
      outs.forEach(c => { if (!dead.has(c)) allDead = false; });
      if (allDead) { dead.add(n.id); changed = true; }
    });
  }

  return dead;
}

function connectedComponents(nodes, adj) {
  const seen = new Set();
  let count = 0;
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    count++;
    const stack = [n.id];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      adj.get(x)?.forEach(y => { if (!seen.has(y)) stack.push(y); });
    }
  }
  return count;
}

// ─── BFS SHORTEST PATH ───────────────────────────────────
function shortestPath(adj, fromId, toId) {
  if (!adj.has(fromId) || !adj.has(toId)) return null;
  if (fromId === toId) return [fromId];
  const prev = new Map();
  const queue = [fromId];
  prev.set(fromId, null);
  while (queue.length) {
    const cur = queue.shift();
    if (cur === toId) {
      const path = [];
      let x = cur;
      while (x !== null) { path.unshift(x); x = prev.get(x); }
      return path;
    }
    adj.get(cur)?.forEach(nb => {
      if (!prev.has(nb)) {
        prev.set(nb, cur);
        queue.push(nb);
      }
    });
  }
  return null;
}

// ─── D3 RENDERING ────────────────────────────────────────
let svg, gZoom, gLinks, gNodes, simulation, zoomBehavior;

function initSvg() {
  svg = d3.select('#graph');
  svg.selectAll('*').remove();

  const defs = svg.append('defs');
  const mk = (id, color) => defs.append('marker')
    .attr('id', id)
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 14).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', color);
  mk('arrow', '#444');
  mk('arrow-hl', '#E8FF00');
  mk('arrow-path', '#FF00B3');
  mk('arrow-dead', DEAD_COLOR);

  gZoom = svg.append('g').attr('class', 'zoom-layer');
  gLinks = gZoom.append('g').attr('class', 'links');
  gNodes = gZoom.append('g').attr('class', 'nodes');

  zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 8])
    .on('zoom', (e) => gZoom.attr('transform', e.transform));
  svg.call(zoomBehavior);
}

function destroySimulation() {
  if (simulation) { simulation.stop(); simulation = null; }
  if (svg) svg.selectAll('*').remove();
}

function nodeColor(d) {
  // dead tiene prioridad sobre todo excepto mutual (el deadSet ya excluye mutuals)
  if (state.deadSet.has(d.id)) {
    return d.ghost ? 'transparent' : DEAD_COLOR;
  }
  if (d.ghost) return 'transparent';
  if (d.mutual) return '#E8FF00';
  if (d.status === 'unfollowed') return '#444';
  if (d.status === 'origin') return 'transparent';
  return '#f5f5f5';
}
function nodeStroke(d) {
  if (state.deadSet.has(d.id)) return DEAD_COLOR;
  if (d.ghost) return '#666';
  if (d.mutual) return '#E8FF00';
  if (d.status === 'unfollowed') return '#444';
  return '#f5f5f5';
}
function nodeRadius(d) {
  const deg = state.adj.get(d.id)?.size || 1;
  return Math.min(12, 4 + Math.sqrt(deg) * 1.5);
}

// helper: el link entra a una rama muerta si su target está en deadSet
function linkIsDead(d) {
  const t = d.target.id || d.target;
  return state.deadSet.has(t);
}

function render() {
  const { width, height } = svg.node().getBoundingClientRect();

  const linkSel = gLinks.selectAll('line.link')
    .data(state.links, d => `${(d.source.id||d.source)}|${(d.target.id||d.target)}`);
  linkSel.exit().remove();
  const linkEnter = linkSel.enter().append('line')
    .attr('class', 'link');
  const allLinks = linkEnter.merge(linkSel);

  // pinta links muertos en morado tenue
  allLinks
    .style('stroke', d => linkIsDead(d) ? DEAD_COLOR : null)
    .style('stroke-opacity', d => linkIsDead(d) ? 0.5 : null);

  const nodeSel = gNodes.selectAll('g.node').data(state.nodes, d => d.id);
  nodeSel.exit().remove();
  const nodeEnter = nodeSel.enter().append('g').attr('class', 'node');
  nodeEnter.append('circle');
  nodeEnter.append('text').attr('dy', 18);
  const allNodes = nodeEnter.merge(nodeSel);

  allNodes.select('circle')
    .attr('r', nodeRadius)
    .attr('fill', nodeColor)
    .attr('stroke', nodeStroke)
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', d => d.ghost ? '2,2' : null);
  allNodes.select('text')
    .text(d => d.id)
    .style('display', state.showLabels ? null : 'none');

  allNodes
    .on('click', (e, d) => { e.stopPropagation(); selectNode(d.id); })
    .on('mouseenter', (e, d) => showTooltip(e, d))
    .on('mousemove', moveTooltip)
    .on('mouseleave', hideTooltip)
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); if (!state.frozen) { d.fx = null; d.fy = null; } }));

  if (simulation) simulation.stop();
  simulation = d3.forceSimulation(state.nodes)
    .force('link', d3.forceLink(state.links).id(d => d.id).distance(60).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-180))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius(d => nodeRadius(d) + 6))
    .alpha(1)
    .alphaDecay(0.025);

  simulation.on('tick', () => {
    allLinks
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    allNodes.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  svg.on('click', () => selectNode(null));
}

function applyHighlights() {
  const sel = state.selectedId;
  const path = state.pathIds;
  const filter = state.filter;
  const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();

  gNodes.selectAll('g.node').each(function(d) {
    const el = d3.select(this);
    let dim = false;
    let highlight = false;

    if (filter !== 'all') {
      if (filter === 'mutual' && !d.mutual) dim = true;
      else if (filter === 'active' && d.status !== 'active') dim = true;
      else if (filter === 'unfollowed' && d.status !== 'unfollowed') dim = true;
      else if (filter === 'origin' && !d.ghost && state.outAdj.get(d.id)?.size === 0) dim = true;
      else if (filter === 'dead' && !state.deadSet.has(d.id)) dim = true;
    }
    if (search && !d.id.toLowerCase().includes(search)) dim = true;

    if (sel) {
      const neighbors = state.adj.get(sel) || new Set();
      if (d.id === sel || neighbors.has(d.id)) { dim = false; highlight = (d.id !== sel); }
      else dim = true;
    }
    const inPath = path.has(d.id);
    if (inPath) dim = false;

    el.classed('dim', dim);
    el.classed('highlight', highlight && !inPath);
    el.classed('selected', d.id === sel && !inPath);
    el.classed('path', inPath);
  });

  gLinks.selectAll('line.link').each(function(d) {
    const el = d3.select(this);
    const sId = d.source.id || d.source;
    const tId = d.target.id || d.target;
    let dim = false;
    let highlight = false;
    let inPath = false;

    if (path.size > 1) {
      const ordered = state.pathOrdered || [];
      for (let i = 0; i < ordered.length - 1; i++) {
        const a = ordered[i], b = ordered[i+1];
        if ((sId === a && tId === b) || (sId === b && tId === a)) { inPath = true; break; }
      }
    }

    if (sel) {
      if (sId === sel || tId === sel) highlight = true;
      else dim = true;
    }
    if (filter !== 'all' || search) {
      const sDim = d3.select(gNodes.selectAll('g.node').filter(n => n.id === sId).node()).classed('dim');
      const tDim = d3.select(gNodes.selectAll('g.node').filter(n => n.id === tId).node()).classed('dim');
      if (sDim || tDim) dim = true;
    }
    if (inPath) { dim = false; highlight = false; }

    el.classed('dim', dim);
    el.classed('highlight', highlight && !inPath);
    el.classed('path', inPath);

    // marker priority: path > highlight > dead > default
    const isDead = state.deadSet.has(tId);
    let marker = 'url(#arrow)';
    if (inPath) marker = 'url(#arrow-path)';
    else if (highlight) marker = 'url(#arrow-hl)';
    else if (isDead) marker = 'url(#arrow-dead)';
    el.attr('marker-end', marker);
  });
}

// ─── TOOLTIP ─────────────────────────────────────────────
const tooltipEl = document.getElementById('tooltip');
function showTooltip(e, d) {
  const inDeg = state.inAdj.get(d.id)?.size || 0;
  const outDeg = state.outAdj.get(d.id)?.size || 0;
  const deadTag = state.deadSet.has(d.id) ? ' · dead' : '';
  tooltipEl.innerHTML = `
    <div class="tooltip-name">@${d.id}</div>
    <div>${d.ghost ? '[ origin only ]' : (d.status || '—')}${d.mutual ? ' · mutual' : ''}${deadTag}</div>
    <div style="color:var(--muted);margin-top:2px;">in ${inDeg} · out ${outDeg}</div>
  `;
  tooltipEl.classList.add('show');
  moveTooltip(e);
}
function moveTooltip(e) {
  tooltipEl.style.left = (e.pageX + 14) + 'px';
  tooltipEl.style.top = (e.pageY + 14) + 'px';
}
function hideTooltip() { tooltipEl.classList.remove('show'); }

// ─── SELECT NODE ─────────────────────────────────────────
function selectNode(id) {
  state.selectedId = id;
  renderNodeInfo();
  applyHighlights();
}

function renderNodeInfo() {
  const box = document.getElementById('nodeInfo');
  if (!state.selectedId) {
    box.innerHTML = '<div class="node-info-empty">click any node in the graph</div>';
    return;
  }
  const d = state.nodeMap.get(state.selectedId);
  if (!d) { box.innerHTML = '<div class="node-info-empty">node not found</div>'; return; }

  const ins = Array.from(state.inAdj.get(d.id) || []);
  const outs = Array.from(state.outAdj.get(d.id) || []);
  const isDead = state.deadSet.has(d.id);

  let html = `<div class="node-info-name">${d.id}</div>`;
  html += '<dl>';
  if (isDead) {
    html += `<dt>branch</dt><dd style="color:${DEAD_COLOR};">dead</dd>`;
  }
  if (d.ghost) {
    html += `<dt>type</dt><dd class="accent">origin only</dd>`;
    html += `<dt>incoming</dt><dd>${ins.length}</dd>`;
    html += `<dt>spawned</dt><dd class="accent">${outs.length}</dd>`;
  } else {
    html += `<dt>status</dt><dd class="${d.status==='active'?'accent':''}">${d.status||'—'}</dd>`;
    html += `<dt>mutual</dt><dd class="${d.mutual?'accent':''}">${d.mutual?'yes':'no'}</dd>`;
    html += `<dt>origen</dt><dd class="pink">${d.origen||'—'}</dd>`;
    if (d.followed_at) html += `<dt>followed</dt><dd>${(d.followed_at||'').slice(0,10)}</dd>`;
    if (d.unfollowed_at) html += `<dt>unfollowed</dt><dd class="pink">${(d.unfollowed_at||'').slice(0,10)}</dd>`;
    if (d.last_updated) html += `<dt>updated</dt><dd>${(d.last_updated||'').slice(0,10)}</dd>`;
    if (d.profile_followers) html += `<dt>followers</dt><dd>${d.profile_followers}</dd>`;
    if (d.profile_following) html += `<dt>following</dt><dd>${d.profile_following}</dd>`;
    if (d.profile_ratio) html += `<dt>ratio</dt><dd>${d.profile_ratio}</dd>`;
    if (d.stand_type) html += `<dt>type</dt><dd>${d.stand_type}</dd>`;
    html += `<dt>incoming</dt><dd>${ins.length}</dd>`;
    html += `<dt>outgoing</dt><dd class="accent">${outs.length}</dd>`;
  }
  html += '</dl>';

  if (ins.length || outs.length) {
    html += '<div class="neighbors">';
    if (ins.length) {
      html += '<div class="neighbors-title">← incoming (origenes)</div>';
      ins.slice(0, 30).forEach(n => html += `<span class="neighbor-chip in" data-jump="${n}">@${n}</span>`);
      if (ins.length > 30) html += `<span class="neighbor-chip">+${ins.length-30}</span>`;
    }
    if (outs.length) {
      html += '<div class="neighbors-title" style="margin-top:8px;">→ outgoing (spawned)</div>';
      outs.slice(0, 30).forEach(n => html += `<span class="neighbor-chip out" data-jump="${n}">@${n}</span>`);
      if (outs.length > 30) html += `<span class="neighbor-chip">+${outs.length-30}</span>`;
    }
    html += '</div>';
  }

  box.innerHTML = html;
  box.querySelectorAll('[data-jump]').forEach(el => {
    el.addEventListener('click', () => selectNode(el.getAttribute('data-jump')));
  });
}

// ─── SEARCH ──────────────────────────────────────────────
function runSearch() {
  const q = document.getElementById('searchInput').value.toLowerCase().trim();
  const box = document.getElementById('searchResults');
  if (!q) { box.innerHTML = ''; applyHighlights(); return; }

  const filter = state.filter;
  const matches = state.nodes.filter(n => {
    if (!n.id.toLowerCase().includes(q)) return false;
    if (filter === 'mutual') return n.mutual;
    if (filter === 'active') return n.status === 'active';
    if (filter === 'unfollowed') return n.status === 'unfollowed';
    if (filter === 'origin') return n.ghost || (state.outAdj.get(n.id)?.size > 0);
    if (filter === 'dead') return state.deadSet.has(n.id);
    return true;
  }).slice(0, 50);

  box.innerHTML = matches.map(n => {
    const tag = state.deadSet.has(n.id) ? 'dead'
      : n.ghost ? 'origin'
      : (n.mutual ? 'mutual' : (n.status||'—'));
    return `<div class="search-result" data-id="${n.id}">
      <span>@${n.id}</span><span class="badge">${tag}</span>
    </div>`;
  }).join('');
  box.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-id');
      selectNode(id);
      focusNode(id);
    });
  });
  applyHighlights();
}

function focusNode(id) {
  const n = state.nodeMap.get(id);
  if (!n || n.x == null) return;
  const { width, height } = svg.node().getBoundingClientRect();
  const k = 1.6;
  const t = d3.zoomIdentity.translate(width/2 - n.x*k, height/2 - n.y*k).scale(k);
  svg.transition().duration(500).call(zoomBehavior.transform, t);
}

// ─── PATH FINDING ────────────────────────────────────────
function tracePath() {
  const fromId = document.getElementById('pathFrom').value.trim();
  const toId   = document.getElementById('pathTo').value.trim();
  const out = document.getElementById('pathResult');

  if (!fromId || !toId) {
    out.innerHTML = '<div class="path-empty">enter two usernames to find connection</div>';
    return;
  }
  if (!state.nodeMap.has(fromId)) { out.innerHTML = `<div class="path-fail">@${fromId} not in graph</div>`; return; }
  if (!state.nodeMap.has(toId))   { out.innerHTML = `<div class="path-fail">@${toId} not in graph</div>`; return; }

  const path = shortestPath(state.adj, fromId, toId);
  if (!path) {
    out.innerHTML = `<div class="path-fail">no path · disconnected</div>`;
    state.pathIds = new Set();
    state.pathOrdered = [];
    applyHighlights();
    return;
  }

  state.pathIds = new Set(path);
  state.pathOrdered = path;

  const hops = path.length - 1;
  let html = `<div class="path-success">${hops} hop${hops!==1?'s':''} · ${path.length} nodes</div>`;
  path.forEach((id, i) => {
    html += `<div class="path-step" data-id="${id}">
      <span class="num">${String(i+1).padStart(2,'0')}</span><span>@${id}</span>
    </div>`;
    if (i < path.length - 1) {
      const a = path[i], b = path[i+1];
      const forward = state.outAdj.get(a)?.has(b);
      html += `<div class="path-arrow">${forward ? '↓ spawned' : '↑ origen of'}</div>`;
    }
  });
  out.innerHTML = html;
  out.querySelectorAll('.path-step').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-id');
      selectNode(id);
      focusNode(id);
    });
  });
  applyHighlights();
}

function clearPath() {
  document.getElementById('pathFrom').value = '';
  document.getElementById('pathTo').value = '';
  state.pathIds = new Set();
  state.pathOrdered = [];
  document.getElementById('pathResult').innerHTML = '<div class="path-empty">enter two usernames to find connection</div>';
  applyHighlights();
}

// ─── STATS RENDERING ─────────────────────────────────────
function renderStats() {
  document.getElementById('statNodes').textContent = state.nodes.length;
  document.getElementById('statEdges').textContent = state.links.length;
  const mutuals = state.nodes.filter(n => n.mutual).length;
  document.getElementById('statMutuals').textContent = mutuals;
  let originCount = 0;
  state.outAdj.forEach((s) => { if (s.size > 0) originCount++; });
  document.getElementById('statOrigins').textContent = originCount;
  document.getElementById('statComponents').textContent = connectedComponents(state.nodes, state.adj);
  const avgDeg = state.nodes.length ? (2 * state.links.length / state.nodes.length).toFixed(2) : 0;
  document.getElementById('statDegree').textContent = avgDeg;

  // Dead stat (opcional, solo si existe el elemento en el HTML)
  const statDead = document.getElementById('statDead');
  if (statDead) statDead.textContent = state.deadSet.size;
}

// ─── DASHBOARD UI WIRING (toolbar + filters + search) ────
function wireDashboardUI() {
  // search
  const searchInput = document.getElementById('searchInput');
  searchInput.removeEventListener?.('input', runSearch);
  searchInput.addEventListener('input', runSearch);

  // filter chips
  document.querySelectorAll('.chip').forEach(c => {
    // clone to clear listeners on reload
    const clone = c.cloneNode(true);
    c.replaceWith(clone);
  });
  document.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      state.filter = c.getAttribute('data-filter');
      runSearch();
      applyHighlights();
    });
  });

  // path
  const pathBtn = document.getElementById('pathBtn');
  const pathClear = document.getElementById('pathClearBtn');
  const pathFrom = document.getElementById('pathFrom');
  const pathTo = document.getElementById('pathTo');
  pathBtn.onclick = tracePath;
  pathClear.onclick = clearPath;
  pathFrom.onkeydown = (e) => { if (e.key === 'Enter') tracePath(); };
  pathTo.onkeydown   = (e) => { if (e.key === 'Enter') tracePath(); };

  // toolbar
  document.getElementById('resetBtn').onclick = () => {
    svg.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity);
    if (simulation) simulation.alpha(0.6).restart();
  };
  document.getElementById('freezeBtn').onclick = (e) => {
    state.frozen = !state.frozen;
    e.target.classList.toggle('active', state.frozen);
    if (state.frozen) {
      state.nodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
      simulation?.stop();
    } else {
      state.nodes.forEach(n => { n.fx = null; n.fy = null; });
      simulation?.alpha(0.3).restart();
    }
  };
  document.getElementById('labelsBtn').onclick = (e) => {
    state.showLabels = !state.showLabels;
    e.target.classList.toggle('active', state.showLabels);
    gNodes.selectAll('g.node text').style('display', state.showLabels ? null : 'none');
  };

  // resize
  window.onresize = () => {
    if (!simulation) return;
    const { width, height } = svg.node().getBoundingClientRect();
    simulation.force('center', d3.forceCenter(width/2, height/2));
    simulation.alpha(0.3).restart();
  };
}

// ─── ENTRY POINT ─────────────────────────────────────────
// app.js llama esto pasándole los rows transformados de la DB
function buildDashboard(rows) {
  const { nodes, links } = buildGraph(rows);
  if (!nodes.length) {
    showToast('no nodes in result');
    return;
  }

  state.nodes = nodes;
  state.links = links;
  const idx = indexGraph(nodes, links);
  state.adj = idx.adj;
  state.outAdj = idx.outAdj;
  state.inAdj = idx.inAdj;
  state.nodeMap = idx.nodeMap;
  state.deadSet = computeDeadSet();
  state.selectedId = null;
  state.pathIds = new Set();
  state.pathOrdered = [];
  state.filter = 'all';

  initSvg();
  render();
  renderStats();
  renderNodeInfo();
  wireDashboardUI();
  runSearch();
  setTimeout(applyHighlights, 100);
}

// limpieza para reload (equivalente a destroyAllCharts del playbook)
function destroyDashboard() {
  destroySimulation();
  state.nodes = [];
  state.links = [];
  state.adj = new Map();
  state.outAdj = new Map();
  state.inAdj = new Map();
  state.nodeMap = new Map();
  state.deadSet = new Set();
  state.selectedId = null;
  state.pathIds = new Set();
  state.pathOrdered = [];
}

// ─── TOAST helper ────────────────────────────────────────
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3500);
}

// expose para app.js
window.POLPO_DASHBOARD = { buildDashboard, destroyDashboard, showToast };
