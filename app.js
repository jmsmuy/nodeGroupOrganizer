import { validate, computeGroups, buildLinkMatrix, matrixToList } from './solver.js';

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  nodes: [],
  linkMatrix: {},
  tags: [],
  minimumCombinedWeight: 0,
  maximumCombinedWeight: 100,
  allowFreeNodes: false,
  symmetricLinks: true,
  solutions: null,
  selectedSolution: null,
};

let nextNodeId = 1;
let nextTagId = 1;

const TAG_PALETTE = [
  '#4f46e5', '#059669', '#d97706', '#dc2626', '#7c3aed',
  '#0891b2', '#be185d', '#65a30d', '#ea580c', '#4338ca',
  '#0d9488', '#ca8a04', '#c026d3',
];

const GROUP_COLORS = [
  '#4f46e5', '#059669', '#d97706', '#dc2626', '#7c3aed',
  '#0891b2', '#be185d', '#65a30d', '#ea580c', '#4338ca',
];

const FREE_NODE_COLOR = '#9ca3af';
const LOCAL_STORAGE_KEY = 'nodeGroupOrganizer';
const TAG_BONUS = 2;

/** Returns a matrix of link weights from tags only (+tag.bonus per shared tag per pair). */
function getTagLinkMatrix() {
  const tagMatrix = {};
  for (const tag of state.tags) {
    const bonus = tag.bonus ?? TAG_BONUS;
    const ids = tag.nodeIds || [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const key1 = `${a}|${b}`;
        const key2 = `${b}|${a}`;
        tagMatrix[key1] = (tagMatrix[key1] || 0) + bonus;
        tagMatrix[key2] = (tagMatrix[key2] || 0) + bonus;
      }
    }
  }
  return tagMatrix;
}

/** Returns custom link weights + tag link weights (sum of both matrices). */
function getEffectiveLinkMatrix() {
  const effective = {};
  for (const [k, v] of Object.entries(state.linkMatrix)) effective[k] = v;
  const tagMatrix = getTagLinkMatrix();
  for (const [k, v] of Object.entries(tagMatrix)) {
    effective[k] = (effective[k] || 0) + v;
  }
  return effective;
}

// ── DOM refs ────────────────────────────────────────────────────────────────

const nodesList = document.getElementById('nodes-list');
const btnAddNode = document.getElementById('btn-add-node');
const nodesFieldset = document.getElementById('nodes-fieldset');
const btnToggleNodes = document.getElementById('btn-toggle-nodes');
const matrixContainer = document.getElementById('matrix-container');
const inputMin = document.getElementById('input-min');
const inputMax = document.getElementById('input-max');
const inputAllowFree = document.getElementById('input-allow-free');
const inputSymmetricLinks = document.getElementById('input-symmetric-links');
const btnRun = document.getElementById('btn-run');
const btnResetLinks = document.getElementById('btn-reset-links');
const btnClearTagLinks = document.getElementById('btn-clear-tag-links');
const btnSave = document.getElementById('btn-save');
const inputLoad = document.getElementById('input-load');
const validationErrors = document.getElementById('validation-errors');
const resultsFieldset = document.getElementById('results-fieldset');
const resultsDiv = document.getElementById('results');
const graphContainer = document.getElementById('graph-container');
const inputAnimateGraph = document.getElementById('input-animate-graph');
const solverLoading = document.getElementById('solver-loading');

// ── vis-network ─────────────────────────────────────────────────────────────

let network = null;
let visNodes = null;
let visEdges = null;

const graphPhysicsEnabled = () => inputAnimateGraph && inputAnimateGraph.checked;

function initGraph() {
  visNodes = new vis.DataSet();
  visEdges = new vis.DataSet();
  const physicsOpt = graphPhysicsEnabled() ? { stabilization: { iterations: 100 } } : false;
  network = new vis.Network(graphContainer, { nodes: visNodes, edges: visEdges }, {
    physics: physicsOpt,
    nodes: {
      shape: 'dot',
      font: { size: 14 },
      borderWidth: 2,
    },
    edges: {
      font: { size: 11, align: 'middle' },
      color: { color: '#9ca3af', highlight: '#4f46e5' },
      smooth: { type: 'continuous' },
    },
    interaction: { hover: true },
  });

  if (inputAnimateGraph) {
    inputAnimateGraph.addEventListener('change', () => {
      const enabled = inputAnimateGraph.checked;
      if (enabled) {
        syncGraph();
        network.setOptions({ physics: { stabilization: { iterations: 100 } } });
        network.stabilize();
      } else {
        network.setOptions({ physics: false });
      }
    });
  }
}

function syncGraph() {
  if (!graphPhysicsEnabled()) return;
  const nodeIds = new Set(state.nodes.map((n) => n.id));

  const existing = visNodes.getIds();
  for (const id of existing) {
    if (!nodeIds.has(id)) visNodes.remove(id);
  }

  for (const n of state.nodes) {
    const size = 10 + Math.min(n.nodeWeight, 100);
    const data = { id: n.id, label: `${n.label || n.id}\n(${n.nodeWeight})`, value: n.nodeWeight, size };
    if (visNodes.get(n.id)) {
      visNodes.update(data);
    } else {
      visNodes.add({ ...data, color: { background: '#e5e7eb', border: '#9ca3af' } });
    }
  }

  const effectiveMatrix = getEffectiveLinkMatrix();
  const wantedEdges = new Map();
  for (const [key, w] of Object.entries(effectiveMatrix)) {
    if (w !== 0) {
      const [from, to] = key.split('|');
      if (nodeIds.has(from) && nodeIds.has(to)) {
        const pairKey = from < to ? `${from}|${to}` : `${to}|${from}`;
        const other = effectiveMatrix[`${to}|${from}`] || 0;
        const pairW = state.symmetricLinks ? (w || other) : (w + other);
        if (pairW !== 0 && !wantedEdges.has(pairKey)) {
          const absW = Math.abs(pairW);
          wantedEdges.set(pairKey, {
            from,
            to,
            label: String(pairW),
            width: 1 + Math.min(absW / 10, 1),
            value: pairW,
            color: weightToEdgeColor(pairW),
          });
        }
      }
    }
  }

  const edgeIds = visEdges.getIds();
  for (const eid of edgeIds) {
    const e = visEdges.get(eid);
    const k = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    if (!wantedEdges.has(k)) visEdges.remove(eid);
  }

  const existingEdgeKeys = new Set();
  for (const eid of visEdges.getIds()) {
    const e = visEdges.get(eid);
    const k = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    existingEdgeKeys.add(k);
    const want = wantedEdges.get(k);
    if (want) visEdges.update({ id: eid, ...want, color: { color: want.color } });
  }
  for (const [key, data] of wantedEdges) {
    if (!existingEdgeKeys.has(key)) {
      visEdges.add({ id: key, ...data, color: { color: data.color } });
    }
  }
}

function weightToEdgeColor(w) {
  const gray = [0x9c, 0xa3, 0xaf];
  const green = [0x05, 0x96, 0x69];
  const red = [0xdc, 0x26, 0x26];
  if (w === 0) return '#9ca3af';
  if (w > 0) {
    const t = Math.min(1, Math.max(0, w / 10));
    const r = Math.round(gray[0] + (green[0] - gray[0]) * t);
    const g = Math.round(gray[1] + (green[1] - gray[1]) * t);
    const b = Math.round(gray[2] + (green[2] - gray[2]) * t);
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  const t = Math.min(1, Math.max(0, -w / 10));
  const r = Math.round(gray[0] + (red[0] - gray[0]) * t);
  const g = Math.round(gray[1] + (red[1] - gray[1]) * t);
  const b = Math.round(gray[2] + (red[2] - gray[2]) * t);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function colorGraphBySolution(solution) {
  if (!solution) {
    for (const n of state.nodes) {
      visNodes.update({ id: n.id, color: { background: '#e5e7eb', border: '#9ca3af' } });
    }
    for (const eid of visEdges.getIds()) {
      const e = visEdges.get(eid);
      const wantColor = e.color && e.color.color ? e.color.color : weightToEdgeColor(e.value != null ? e.value : 0);
      visEdges.update({ id: eid, hidden: false, color: { color: wantColor }, dashes: false, width: e.width != null ? e.width : 2 });
    }
    return;
  }

  const nodeGroup = {};
  solution.groups.forEach((g, gi) => {
    for (const id of g) nodeGroup[id] = gi;
  });

  const freeSet = new Set(solution.freeNodes || []);

  for (const n of state.nodes) {
    if (freeSet.has(n.id)) {
      visNodes.update({
        id: n.id,
        color: { background: '#f3f4f6', border: FREE_NODE_COLOR },
        borderWidth: 1,
        shapeProperties: { borderDashes: [4, 4] },
      });
    } else {
      const gi = nodeGroup[n.id];
      const c = gi != null ? GROUP_COLORS[gi % GROUP_COLORS.length] : '#9ca3af';
      visNodes.update({
        id: n.id,
        color: { background: c + '33', border: c },
        borderWidth: 2,
        shapeProperties: { borderDashes: false },
      });
    }
  }

  for (const eid of visEdges.getIds()) {
    const e = visEdges.get(eid);
    const gFrom = nodeGroup[e.from];
    const gTo = nodeGroup[e.to];
    const bothFree = freeSet.has(e.from) || freeSet.has(e.to);
    const intra = !bothFree && gFrom != null && gFrom === gTo;
    visEdges.update({
      id: eid,
      hidden: !intra,
      color: { color: intra ? GROUP_COLORS[gFrom % GROUP_COLORS.length] : '#d1d5db' },
      width: intra ? 3 : 2,
      dashes: false,
    });
  }
}

// ── Nodes UI ────────────────────────────────────────────────────────────────

function addNode(id, label, nodeWeight) {
  if (!id) id = `n${nextNodeId++}`;
  if (label == null) label = '';
  if (nodeWeight == null) nodeWeight = 1;

  state.nodes.push({ id, label, nodeWeight });
  renderNodeRow(state.nodes.length - 1);
  const newRow = nodesList.lastElementChild;
  if (newRow) {
    const labelInput = newRow.querySelector('input[type="text"]');
    if (labelInput) labelInput.focus();
  }
  renderMatrix();
  syncGraph();
  saveToLocalStorage();
}

function renderNodeRow(index) {
  const n = state.nodes[index];
  const row = document.createElement('div');
  row.className = 'node-row';
  row.dataset.index = index;

  const inputLabel = document.createElement('input');
  inputLabel.type = 'text';
  inputLabel.value = n.label;
  inputLabel.placeholder = 'Label';
  inputLabel.addEventListener('input', () => {
    n.label = inputLabel.value || n.id;
    renderMatrix();
    syncGraph();
    saveToLocalStorage();
  });

  const inputWeight = document.createElement('input');
  inputWeight.type = 'number';
  inputWeight.min = '0';
  inputWeight.step = '1';
  inputWeight.value = n.nodeWeight;
  inputWeight.title = 'nodeWeight';
  inputWeight.addEventListener('input', () => {
    n.nodeWeight = parseFloat(inputWeight.value) || 0;
    syncGraph();
    saveToLocalStorage();
  });

  const btnRemove = document.createElement('button');
  btnRemove.className = 'danger';
  btnRemove.textContent = 'Remove';
  btnRemove.tabIndex = -1;
  btnRemove.addEventListener('click', () => {
    removeNode(index);
  });

  row.append(inputLabel, inputWeight, btnRemove);
  nodesList.appendChild(row);
}

function removeNode(index) {
  const removed = state.nodes.splice(index, 1)[0];

  for (const key of Object.keys(state.linkMatrix)) {
    const [a, b] = key.split('|');
    if (a === removed.id || b === removed.id) {
      delete state.linkMatrix[key];
    }
  }
  state.tags.forEach((t) => {
    t.nodeIds = (t.nodeIds || []).filter((id) => id !== removed.id);
  });

  rebuildNodesUI();
  renderMatrix();
  syncGraph();
  saveToLocalStorage();
}

function rebuildNodesUI() {
  nodesList.innerHTML = '';
  state.nodes.forEach((_, i) => renderNodeRow(i));
}

// ── Link list + modal UI ─────────────────────────────────────────────────────

const linkModalOverlay = document.getElementById('link-modal-overlay');
const linkModalTitle = document.getElementById('link-modal-title');
const linkModalBody = document.getElementById('link-modal-body');
const linkModalClose = document.getElementById('link-modal-close');

function renderMatrix() {
  matrixContainer.innerHTML = '';
  if (state.nodes.length === 0) return;

  const list = document.createElement('ul');
  list.className = 'link-node-list';
  for (const node of state.nodes) {
    const li = document.createElement('li');
    li.className = 'link-node-row';
    const left = document.createElement('div');
    left.className = 'link-node-left';
    const label = document.createElement('span');
    label.className = 'link-node-label';
    label.textContent = node.label || node.id;
    const tagPills = document.createElement('span');
    tagPills.className = 'tag-pills';
    const nodeTags = state.tags.filter((t) => (t.nodeIds || []).includes(node.id));
    for (const tag of nodeTags) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.style.backgroundColor = tag.color;
      pill.style.color = '#fff';
      pill.textContent = tag.name;
      pill.title = tag.name;
      tagPills.appendChild(pill);
    }
    left.append(label, tagPills);
    const btns = document.createElement('div');
    btns.className = 'link-node-buttons';
    const btnLinks = document.createElement('button');
    btnLinks.type = 'button';
    btnLinks.textContent = 'Edit links';
    btnLinks.addEventListener('click', () => openLinkModal(node));
    const btnTags = document.createElement('button');
    btnTags.type = 'button';
    btnTags.textContent = 'Edit tags';
    btnTags.addEventListener('click', () => openTagsModal(node));
    btns.append(btnLinks, btnTags);
    li.append(left, btns);
    list.appendChild(li);
  }
  matrixContainer.appendChild(list);
}

function getLinkValue(fromId, toId) {
  const v = state.linkMatrix[`${fromId}|${toId}`];
  if (v !== undefined && v !== 0) return v;
  if (state.symmetricLinks) return state.linkMatrix[`${toId}|${fromId}`] ?? 0;
  return 0;
}

function setLinkValue(fromId, toId, val) {
  if (val !== 0) {
    state.linkMatrix[`${fromId}|${toId}`] = val;
    if (state.symmetricLinks) state.linkMatrix[`${toId}|${fromId}`] = val;
  } else {
    delete state.linkMatrix[`${fromId}|${toId}`];
    if (state.symmetricLinks) delete state.linkMatrix[`${toId}|${fromId}`];
  }
}

function openLinkModal(fromNode) {
  linkModalTitle.textContent = `Links from ${fromNode.label || fromNode.id}`;
  linkModalBody.innerHTML = '';
  const fromId = fromNode.id;
  const others = state.nodes.filter((n) => n.id !== fromId);
  if (others.length === 0) {
    linkModalBody.textContent = 'No other nodes. Add more nodes to set link weights.';
  } else {
    const table = document.createElement('table');
    table.className = 'link-modal-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>To node</th><th>Weight</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const toNode of others) {
      const tr = document.createElement('tr');
      const toId = toNode.id;
      const tdLabel = document.createElement('td');
      tdLabel.textContent = toNode.label || toNode.id;
      const tdInput = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = 'any';
      inp.placeholder = '0';
      const current = getLinkValue(fromId, toId);
      inp.value = current === 0 ? '' : current;
      inp.addEventListener('input', () => {
        const val = parseFloat(inp.value);
        const num = Number.isFinite(val) ? val : 0;
        setLinkValue(fromId, toId, num);
        syncGraph();
        saveToLocalStorage();
      });
      tdInput.appendChild(inp);
      tr.append(tdLabel, tdInput);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    linkModalBody.appendChild(table);
  }
  linkModalOverlay.hidden = false;
}

function closeLinkModal() {
  if (linkModalOverlay) linkModalOverlay.hidden = true;
}

if (linkModalClose) linkModalClose.addEventListener('click', (e) => { e.preventDefault(); closeLinkModal(); });
if (linkModalOverlay) {
  linkModalOverlay.addEventListener('click', (e) => {
    if (e.target === linkModalOverlay) closeLinkModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && linkModalOverlay && !linkModalOverlay.hidden) closeLinkModal();
});

if (linkModalOverlay) linkModalOverlay.hidden = true;

// ── Tags modal ───────────────────────────────────────────────────────────────

const tagsModalOverlay = document.getElementById('tags-modal-overlay');
const tagsModalTitle = document.getElementById('tags-modal-title');
const tagsModalBody = document.getElementById('tags-modal-body');
const tagsModalClose = document.getElementById('tags-modal-close');
const tagsNewName = document.getElementById('tags-new-name');
const tagsNewColor = document.getElementById('tags-new-color');
const tagsNewBonus = document.getElementById('tags-new-bonus');
const tagsCreateBtn = document.getElementById('tags-create-btn');

function getUnusedTagColor() {
  const used = new Set(state.tags.map((t) => t.color.toLowerCase()));
  for (const c of TAG_PALETTE) {
    if (!used.has(c.toLowerCase())) return c;
  }
  return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

function openTagsModal(node) {
  tagsModalTitle.textContent = `Tags for ${node.label || node.id}`;
  tagsModalBody.innerHTML = '';
  tagsNewColor.value = getUnusedTagColor();

  const nodeId = node.id;
  const list = document.createElement('ul');
  list.className = 'tags-modal-list';
  for (const tag of state.tags) {
    const li = document.createElement('li');
    li.className = 'tags-modal-row';
    const swatch = document.createElement('span');
    swatch.className = 'tag-swatch';
    swatch.style.backgroundColor = tag.color;
    const label = document.createElement('span');
    label.className = 'tag-name';
    label.textContent = tag.name;
    const bonusInput = document.createElement('input');
    bonusInput.type = 'number';
    bonusInput.min = 0;
    bonusInput.step = 1;
    bonusInput.className = 'tag-bonus-input';
    bonusInput.value = tag.bonus ?? 2;
    bonusInput.title = 'Points added to matrix';
    bonusInput.addEventListener('change', () => {
      tag.bonus = Math.max(0, parseInt(bonusInput.value, 10) || 0);
      bonusInput.value = tag.bonus;
    });
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (tag.nodeIds || []).includes(nodeId);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!tag.nodeIds) tag.nodeIds = [];
        if (!tag.nodeIds.includes(nodeId)) tag.nodeIds.push(nodeId);
      } else {
        tag.nodeIds = (tag.nodeIds || []).filter((id) => id !== nodeId);
      }
    });
    const btnDeleteTag = document.createElement('button');
    btnDeleteTag.type = 'button';
    btnDeleteTag.className = 'tag-delete-btn';
    btnDeleteTag.innerHTML = '&times;';
    btnDeleteTag.title = 'Delete tag';
    btnDeleteTag.setAttribute('aria-label', 'Delete tag');
    btnDeleteTag.addEventListener('click', () => {
      state.tags = state.tags.filter((t) => t.id !== tag.id);
      openTagsModal(node);
    });
    li.append(swatch, label, bonusInput, cb, btnDeleteTag);
    list.appendChild(li);
  }
  if (state.tags.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tags-empty';
    empty.textContent = 'No tags yet. Create one below.';
    tagsModalBody.appendChild(empty);
  } else {
    tagsModalBody.appendChild(list);
  }

  function createTag() {
    const name = (tagsNewName.value || '').trim();
    if (!name) return;
    const color = tagsNewColor.value;
    const bonus = Math.max(0, parseInt(tagsNewBonus?.value, 10) || 2);
    const tag = { id: `tag${nextTagId++}`, name, color, bonus, nodeIds: [nodeId] };
    state.tags.push(tag);
    tagsNewName.value = '';
    tagsNewColor.value = getUnusedTagColor();
    if (tagsNewBonus) tagsNewBonus.value = '2';
    openTagsModal(node);
  }
  tagsCreateBtn.onclick = createTag;
  tagsNewName.onkeydown = (e) => { if (e.key === 'Enter') createTag(); };

  tagsModalOverlay.hidden = false;
}

function closeTagsModal() {
  if (tagsModalOverlay) tagsModalOverlay.hidden = true;
  saveToLocalStorage();
  syncGraph();
  renderMatrix();
}

if (tagsModalClose) tagsModalClose.addEventListener('click', (e) => { e.preventDefault(); closeTagsModal(); });
if (tagsModalOverlay) {
  tagsModalOverlay.addEventListener('click', (e) => {
    if (e.target === tagsModalOverlay) closeTagsModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tagsModalOverlay && !tagsModalOverlay.hidden) closeTagsModal();
});
if (tagsModalOverlay) tagsModalOverlay.hidden = true;

// ── Bounds & options ────────────────────────────────────────────────────────

inputMin.addEventListener('input', () => {
  state.minimumCombinedWeight = parseFloat(inputMin.value) || 0;
  saveToLocalStorage();
});

inputMax.addEventListener('input', () => {
  state.maximumCombinedWeight = parseFloat(inputMax.value) || 0;
  saveToLocalStorage();
});

inputAllowFree.addEventListener('change', () => {
  state.allowFreeNodes = inputAllowFree.checked;
  saveToLocalStorage();
});

inputSymmetricLinks.addEventListener('change', () => {
  const next = inputSymmetricLinks.checked;
  if (next && !state.symmetricLinks) {
    symmetrizeMatrix();
  }
  state.symmetricLinks = next;
  renderMatrix();
  syncGraph();
  saveToLocalStorage();
});

function symmetrizeMatrix() {
  const seen = new Set();
  for (const key of Object.keys(state.linkMatrix)) {
    const [a, b] = key.split('|');
    const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const ab = state.linkMatrix[`${a}|${b}`] ?? 0;
    const ba = state.linkMatrix[`${b}|${a}`] ?? 0;
    const v = ab !== 0 ? ab : ba;
    if (v !== 0) {
      state.linkMatrix[`${a}|${b}`] = v;
      state.linkMatrix[`${b}|${a}`] = v;
    }
  }
}

// ── Reset / clear actions ────────────────────────────────────────────────────

if (btnResetLinks) {
  btnResetLinks.addEventListener('click', () => {
    state.linkMatrix = {};
    saveToLocalStorage();
    syncGraph();
    renderMatrix();
  });
}

if (btnClearTagLinks) {
  btnClearTagLinks.addEventListener('click', () => {
    state.tags.forEach((t) => { t.nodeIds = []; });
    saveToLocalStorage();
    syncGraph();
    renderMatrix();
  });
}

// ── Run solver ──────────────────────────────────────────────────────────────

btnRun.addEventListener('click', () => {
  hideErrors();
  const effectiveMatrix = getEffectiveLinkMatrix();
  const errors = validate(
    state.nodes,
    effectiveMatrix,
    state.minimumCombinedWeight,
    state.maximumCombinedWeight
  );
  if (errors.length > 0) {
    showErrors(errors);
    return;
  }

  if (solverLoading) solverLoading.hidden = false;
  setTimeout(() => {
    try {
      const result = computeGroups(
        state.nodes,
        effectiveMatrix,
        state.minimumCombinedWeight,
        state.maximumCombinedWeight,
        { allowFreeNodes: state.allowFreeNodes, symmetricLinks: state.symmetricLinks }
      );

      if (result.errors && result.errors.length > 0) {
        showErrors(result.errors);
        return;
      }

      state.solutions = result.solutions;
      state.selectedSolution = null;
      renderResults(result.solutions, result.optimal);
    } finally {
      if (solverLoading) solverLoading.hidden = true;
    }
  }, 0);
});

// ── Results UI ──────────────────────────────────────────────────────────────

function renderResults(solutions, optimal) {
  resultsFieldset.hidden = false;
  resultsDiv.innerHTML = '';

  if (solutions.length === 0) {
    resultsDiv.innerHTML = '<p style="color:var(--text-muted);padding:8px;">No feasible solution found. Try relaxing the group bounds or adjusting node weights.</p>';
    colorGraphBySolution(null);
    return;
  }

  solutions.forEach((sol, idx) => {
    const card = document.createElement('div');
    card.className = 'solution-card';

    const header = document.createElement('div');
    header.className = 'solution-header';

    const freeCount = (sol.freeNodes && sol.freeNodes.length) || 0;
    const freeLabel = freeCount > 0 ? ` | ${freeCount} free` : '';

    header.innerHTML = `
      <span><span class="rank">#${idx + 1}</span>${idx === 0 && optimal ? '<span class="optimal-badge">Optimal</span>' : ''}</span>
      <span class="total-weight">totalWeight: ${sol.totalWeight}${freeLabel}</span>
    `;

    const body = document.createElement('div');
    body.className = 'solution-body';

    const idToLabel = (id) => state.nodes.find((n) => n.id === id)?.label || id;
    let tableHTML = '<table><thead><tr><th>Group</th><th>Nodes</th><th>Node Weight Sum</th><th>Combined Weight</th></tr></thead><tbody>';
    sol.groupDetails.forEach((gd, gi) => {
      const color = GROUP_COLORS[gi % GROUP_COLORS.length];
      const labels = gd.nodeIds.map(idToLabel).join(', ');
      tableHTML += `<tr>
        <td><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle;"></span>${gi + 1}</td>
        <td>${labels}</td>
        <td>${gd.nodeWeightSum}</td>
        <td>${gd.combinedWeight}</td>
      </tr>`;
    });
    tableHTML += '</tbody></table>';

    if (freeCount > 0) {
      const freeLabels = sol.freeNodes.map(idToLabel).join(', ');
      tableHTML += `<div class="free-nodes-banner"><strong>Free Nodes:</strong> ${freeLabels}</div>`;
    }

    body.innerHTML = tableHTML;

    header.addEventListener('click', () => {
      const wasOpen = body.classList.contains('open');

      for (const b of resultsDiv.querySelectorAll('.solution-body')) b.classList.remove('open');
      for (const h of resultsDiv.querySelectorAll('.solution-header')) h.classList.remove('selected');

      if (!wasOpen) {
        body.classList.add('open');
        header.classList.add('selected');
        state.selectedSolution = idx;
        colorGraphBySolution(sol);
      } else {
        state.selectedSolution = null;
        colorGraphBySolution(null);
      }
    });

    card.append(header, body);
    resultsDiv.appendChild(card);
  });

  const firstHeader = resultsDiv.querySelector('.solution-header');
  if (firstHeader) firstHeader.click();
}

// ── Validation errors ───────────────────────────────────────────────────────

function showErrors(errors) {
  validationErrors.hidden = false;
  validationErrors.innerHTML = '<ul>' + errors.map((e) => `<li>${e}</li>`).join('') + '</ul>';
}

function hideErrors() {
  validationErrors.hidden = true;
  validationErrors.innerHTML = '';
}

// ── Local storage (persist across reloads) ───────────────────────────────────

function getSerializableState() {
  return {
    nodes: state.nodes.map((n) => ({ id: n.id, label: n.label, nodeWeight: n.nodeWeight })),
    linkWeights: matrixToList(state.linkMatrix),
    minimumCombinedWeight: state.minimumCombinedWeight,
    maximumCombinedWeight: state.maximumCombinedWeight,
    allowFreeNodes: state.allowFreeNodes,
    symmetricLinks: state.symmetricLinks,
    tags: state.tags.map((t) => ({ id: t.id, name: t.name, color: t.color, bonus: t.bonus ?? 2, nodeIds: (t.nodeIds || []).slice() })),
  };
}

function saveToLocalStorage() {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(getSerializableState()));
  } catch (e) {
    // Ignore quota or privacy errors
  }
}

function restoreFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.nodes)) return false;
    loadData(data);
    return true;
  } catch (e) {
    return false;
  }
}

// ── Save / Load ─────────────────────────────────────────────────────────────

btnSave.addEventListener('click', () => {
  const data = getSerializableState();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'node-group-data.json';
  a.click();
  URL.revokeObjectURL(url);
});

inputLoad.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      loadData(data);
    } catch (err) {
      showErrors([`Failed to parse JSON: ${err.message}`]);
    }
  };
  reader.readAsText(file);
  inputLoad.value = '';
});

function loadData(data) {
  hideErrors();

  if (!data.nodes || !Array.isArray(data.nodes)) {
    showErrors(['Invalid file: missing "nodes" array.']);
    return;
  }

  state.nodes = data.nodes.map((n) => ({
    id: n.id,
    label: n.label || n.id,
    nodeWeight: n.nodeWeight || 0,
  }));

  state.linkMatrix = buildLinkMatrix(data.linkWeights || []);
  state.minimumCombinedWeight = data.minimumCombinedWeight || 0;
  state.maximumCombinedWeight = data.maximumCombinedWeight || 100;
  state.allowFreeNodes = !!data.allowFreeNodes;
  state.symmetricLinks = data.symmetricLinks !== false;

  const nodeIdSet = new Set(state.nodes.map((n) => n.id));
  state.tags = (data.tags || []).map((t) => ({
    id: t.id,
    name: t.name || 'Tag',
    color: t.color || TAG_PALETTE[0],
    bonus: t.bonus ?? 2,
    nodeIds: (t.nodeIds || []).filter((id) => nodeIdSet.has(id)),
  }));
  const tagNumericIds = state.tags
    .map((t) => parseInt(String(t.id).replace(/\D/g, ''), 10))
    .filter((v) => !isNaN(v));
  nextTagId = tagNumericIds.length > 0 ? Math.max(...tagNumericIds) + 1 : 1;

  const numericIds = state.nodes
    .map((n) => parseInt(n.id.replace(/\D/g, ''), 10))
    .filter((v) => !isNaN(v));
  nextNodeId = numericIds.length > 0 ? Math.max(...numericIds) + 1 : 1;

  inputMin.value = state.minimumCombinedWeight;
  inputMax.value = state.maximumCombinedWeight;
  inputAllowFree.checked = state.allowFreeNodes;
  inputSymmetricLinks.checked = state.symmetricLinks;
  rebuildNodesUI();
  renderMatrix();
  syncGraph();

  const errors = validate(
    state.nodes,
    state.linkMatrix,
    state.minimumCombinedWeight,
    state.maximumCombinedWeight
  );
  if (errors.length > 0) showErrors(errors);

  resultsFieldset.hidden = true;
  resultsDiv.innerHTML = '';
  state.solutions = null;
  state.selectedSolution = null;

  saveToLocalStorage();
}

// ── Init ────────────────────────────────────────────────────────────────────

if (btnToggleNodes && nodesFieldset) {
  btnToggleNodes.addEventListener('click', () => {
    const collapsed = nodesFieldset.classList.toggle('collapsed');
    btnToggleNodes.textContent = collapsed ? '▶' : '▼';
    btnToggleNodes.setAttribute('aria-label', collapsed ? 'Expand list' : 'Collapse list');
    btnToggleNodes.title = collapsed ? 'Expand list' : 'Collapse list';
  });
}

btnAddNode.addEventListener('click', () => addNode());

initGraph();

// Restore last session from localStorage (survives reload)
restoreFromLocalStorage();
