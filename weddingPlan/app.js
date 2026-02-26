import { validate, computeGroups, buildLinkMatrix, matrixToList } from '../solver.js';

// Wedding skin: nodes = guests (person or group), nodeWeight = number of people,
// groups = tables, combinedWeight = likeness between people, totalWeight = optimization level.
// allowFreeNodes always false; symmetricLinks always true.

const state = {
  nodes: [],
  linkMatrix: {},
  tags: [],
  minimumCombinedWeight: 7,
  maximumCombinedWeight: 10,
  allowFreeNodes: false,
  symmetricLinks: true,
  solutions: null,
  selectedSolution: null,
  splittingPremiumPoints: 5,
  fixedGroups: [],
};

let nextNodeId = 1;
let nextTagId = 1;

const TAG_PALETTE = [
  '#b76e79', '#c9a66b', '#7d9d7c', '#c17f7f', '#8b7355',
  '#a67c52', '#9f7d9f', '#6b8e9e', '#c9a66b', '#8fbc8f',
  '#d4a5a5', '#b8860b', '#cd5c5c',
];

const GROUP_COLORS = [
  '#b76e79', '#c9a66b', '#7d9d7c', '#c17f7f', '#8b7355',
  '#a67c52', '#9f7d9f', '#6b8e9e',
];

const FREE_NODE_COLOR = '#9ca3af';
const LOCAL_STORAGE_KEY = 'weddingPlanSeating';
const TAG_BONUS = 2;

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
const inputSplittingPremium = document.getElementById('input-splitting-premium');
const btnRun = document.getElementById('btn-run');
const btnResetLinks = document.getElementById('btn-reset-links');
const btnClearTagLinks = document.getElementById('btn-clear-tag-links');
const btnShowFixedTables = document.getElementById('btn-show-fixed-tables');
const btnSave = document.getElementById('btn-save');
const fixedTablesModalOverlay = document.getElementById('fixed-tables-modal-overlay');
const fixedTablesModalBody = document.getElementById('fixed-tables-modal-body');
const fixedTablesModalClose = document.getElementById('fixed-tables-modal-close');
const generateTableModalOverlay = document.getElementById('generate-table-modal-overlay');
const generateTableModalBody = document.getElementById('generate-table-modal-body');
const generateTableModalClose = document.getElementById('generate-table-modal-close');
const generateTableSaveBtn = document.getElementById('generate-table-save-btn');
const btnGenerateTable = document.getElementById('btn-generate-table');
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
      color: { color: '#a67c52', highlight: '#b76e79' },
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
      visNodes.add({ ...data, color: { background: '#fdf6f0', border: '#c9a66b' } });
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
  const gray = [0xa6, 0x7c, 0x52];
  const green = [0x7d, 0x9d, 0x7c];
  const red = [0xc1, 0x7f, 0x7f];
  if (w === 0) return '#a67c52';
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
      visNodes.update({ id: n.id, color: { background: '#fdf6f0', border: '#c9a66b' } });
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
        color: { background: '#fdf6f0', border: FREE_NODE_COLOR },
        borderWidth: 1,
        shapeProperties: { borderDashes: [4, 4] },
      });
    } else {
      const gi = nodeGroup[n.id];
      const c = gi != null ? GROUP_COLORS[gi % GROUP_COLORS.length] : '#c9a66b';
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
      color: { color: intra ? GROUP_COLORS[gFrom % GROUP_COLORS.length] : '#d4b896' },
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
  inputLabel.placeholder = 'Person or group';
  inputLabel.addEventListener('input', () => {
    n.label = inputLabel.value || n.id;
    renderMatrix();
    syncGraph();
    saveToLocalStorage();
  });

  const inputWeight = document.createElement('input');
  inputWeight.type = 'number';
  inputWeight.min = '1';
  inputWeight.step = '1';
  inputWeight.value = n.nodeWeight;
  inputWeight.title = 'Guests (1 = single person)';
  inputWeight.addEventListener('input', () => {
    n.nodeWeight = Math.max(1, parseFloat(inputWeight.value) || 1);
    inputWeight.value = n.nodeWeight;
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
  linkModalTitle.textContent = `Likeness from ${fromNode.label || fromNode.id}`;
  linkModalBody.innerHTML = '';
  const fromId = fromNode.id;
  const others = state.nodes.filter((n) => n.id !== fromId);
  if (others.length === 0) {
    linkModalBody.textContent = 'No other guests. Add more to set likeness.';
  } else {
    const table = document.createElement('table');
    table.className = 'link-modal-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Person</th><th>Likeness (0-10)</th></tr>';
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
      inp.min = 0;
      inp.max = 10;
      inp.step = 1;
      inp.placeholder = '0';
      const current = getLinkValue(fromId, toId);
      inp.value = current === 0 ? '' : current;
      inp.addEventListener('input', () => {
        let val = parseFloat(inp.value);
        if (!Number.isFinite(val)) val = 0;
        val = Math.min(10, Math.max(0, val));
        setLinkValue(fromId, toId, val);
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

// ── Bounds ───────────────────────────────────────────────────────────────────

inputMin.addEventListener('input', () => {
  state.minimumCombinedWeight = parseFloat(inputMin.value) || 0;
  saveToLocalStorage();
});

inputMax.addEventListener('input', () => {
  state.maximumCombinedWeight = parseFloat(inputMax.value) || 0;
  saveToLocalStorage();
});

if (inputSplittingPremium) {
  inputSplittingPremium.addEventListener('input', () => {
    state.splittingPremiumPoints = Math.max(0, parseInt(inputSplittingPremium.value, 10) || 0);
    inputSplittingPremium.value = state.splittingPremiumPoints;
    saveToLocalStorage();
  });
}

// Wedding: allowFreeNodes always false, symmetricLinks always true (no UI for them)

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

function openFixedTablesModal() {
  fixedTablesModalBody.innerHTML = '';
  const idToLabel = (id) => state.nodes.find((n) => n.id === id)?.label || id;
  if (state.fixedGroups.length === 0) {
    fixedTablesModalBody.textContent = 'No fixed tables. Use "Fix Table" on a solution row to fix a table.';
  } else {
    const list = document.createElement('ul');
    list.className = 'fixed-tables-list';
    state.fixedGroups.forEach((groupIds, idx) => {
      const li = document.createElement('li');
      li.className = 'fixed-tables-row';
      const labels = groupIds.map(idToLabel).join(', ');
      const span = document.createElement('span');
      span.className = 'fixed-tables-labels';
      span.textContent = labels;
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'tag-delete-btn';
      btnDel.innerHTML = '&times;';
      btnDel.title = 'Remove fixed table';
      btnDel.addEventListener('click', () => {
        state.fixedGroups.splice(idx, 1);
        saveToLocalStorage();
        openFixedTablesModal();
      });
      li.append(span, btnDel);
      list.appendChild(li);
    });
    fixedTablesModalBody.appendChild(list);
  }
  fixedTablesModalOverlay.hidden = false;
}

function closeFixedTablesModal() {
  if (fixedTablesModalOverlay) fixedTablesModalOverlay.hidden = true;
}

if (btnShowFixedTables) btnShowFixedTables.addEventListener('click', openFixedTablesModal);
if (fixedTablesModalClose) fixedTablesModalClose.addEventListener('click', (e) => { e.preventDefault(); closeFixedTablesModal(); });
if (fixedTablesModalOverlay) {
  fixedTablesModalOverlay.addEventListener('click', (e) => {
    if (e.target === fixedTablesModalOverlay) closeFixedTablesModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fixedTablesModalOverlay && !fixedTablesModalOverlay.hidden) closeFixedTablesModal();
});
if (fixedTablesModalOverlay) fixedTablesModalOverlay.hidden = true;

let generateTableCurrentIds = [];

function openGenerateTableModal() {
  generateTableCurrentIds = [];
  function renderBody() {
    generateTableModalBody.innerHTML = '';
    const idToLabel = (id) => state.nodes.find((n) => n.id === id)?.label || id;
    const maxW = state.maximumCombinedWeight;
    const currentSum = generateTableCurrentIds.reduce((s, id) => s + (state.nodes.find((n) => n.id === id)?.nodeWeight ?? 0), 0);

    const capLine = document.createElement('p');
    capLine.className = 'generate-table-cap';
    capLine.textContent = `Current table: ${currentSum} / ${maxW} people`;
    generateTableModalBody.appendChild(capLine);

    if (generateTableCurrentIds.length > 0) {
      const list = document.createElement('ul');
      list.className = 'fixed-tables-list generate-table-current-list';
      generateTableCurrentIds.forEach((nodeId, idx) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        const w = node?.nodeWeight ?? 0;
        const li = document.createElement('li');
        li.className = 'fixed-tables-row';
        const span = document.createElement('span');
        span.className = 'fixed-tables-labels';
        span.textContent = `${idToLabel(nodeId)} (${w})`;
        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'tag-delete-btn';
        btnDel.innerHTML = '&times;';
        btnDel.title = 'Remove from table';
        btnDel.addEventListener('click', () => {
          generateTableCurrentIds.splice(idx, 1);
          renderBody();
        });
        li.append(span, btnDel);
        list.appendChild(li);
      });
      generateTableModalBody.appendChild(list);
    }

    const addHeading = document.createElement('p');
    addHeading.className = 'generate-table-add-heading';
    addHeading.textContent = 'Add guest:';
    generateTableModalBody.appendChild(addHeading);

    const inFixedTable = new Set(state.fixedGroups.flat());
    const available = state.nodes.filter((n) => !generateTableCurrentIds.includes(n.id) && !inFixedTable.has(n.id) && currentSum + (n.nodeWeight ?? 0) <= maxW);
    if (available.length === 0) {
      const msg = document.createElement('p');
      msg.className = 'tags-empty';
      msg.textContent = generateTableCurrentIds.length === 0 ? 'Add guests below or no guests fit the table capacity.' : 'No more guests fit (table at or over capacity).';
      generateTableModalBody.appendChild(msg);
    } else {
      const addWrap = document.createElement('div');
      addWrap.className = 'generate-table-add-buttons';
      available.forEach((node) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-small';
        btn.textContent = `${idToLabel(node.id)} (${node.nodeWeight ?? 0})`;
        btn.addEventListener('click', () => {
          generateTableCurrentIds.push(node.id);
          renderBody();
        });
        addWrap.appendChild(btn);
      });
      generateTableModalBody.appendChild(addWrap);
    }

    generateTableSaveBtn.disabled = generateTableCurrentIds.length === 0;
  }

  renderBody();
  generateTableSaveBtn.onclick = () => {
    if (generateTableCurrentIds.length === 0) return;
    state.fixedGroups.push(generateTableCurrentIds.slice());
    saveToLocalStorage();
    closeGenerateTableModal();
  };
  generateTableModalOverlay.hidden = false;
}

function closeGenerateTableModal() {
  if (generateTableModalOverlay) generateTableModalOverlay.hidden = true;
}

if (btnGenerateTable) btnGenerateTable.addEventListener('click', openGenerateTableModal);
if (generateTableModalClose) generateTableModalClose.addEventListener('click', (e) => { e.preventDefault(); closeGenerateTableModal(); });
if (generateTableModalOverlay) {
  generateTableModalOverlay.addEventListener('click', (e) => {
    if (e.target === generateTableModalOverlay) closeGenerateTableModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && generateTableModalOverlay && !generateTableModalOverlay.hidden) closeGenerateTableModal();
});
if (generateTableModalOverlay) generateTableModalOverlay.hidden = true;

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
        { allowFreeNodes: false, symmetricLinks: true, balanceGroupWeightsFactor: 1, bonusPerGroup: state.splittingPremiumPoints, fixedGroups: state.fixedGroups }
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
    resultsDiv.innerHTML = '<p style="color:var(--text-muted);padding:8px;">No feasible table combination found. Try relaxing table size or adjusting guest counts.</p>';
    colorGraphBySolution(null);
    return;
  }

  solutions.forEach((sol, idx) => {
    const card = document.createElement('div');
    card.className = 'solution-card';

    const header = document.createElement('div');
    header.className = 'solution-header';

    const freeCount = (sol.freeNodes && sol.freeNodes.length) || 0;
    const freeLabel = freeCount > 0 ? ` | ${freeCount} unseated` : '';

    header.innerHTML = `
      <span><span class="rank">#${idx + 1}</span>${idx === 0 && optimal ? '<span class="optimal-badge">Best</span>' : ''}</span>
      <span class="total-weight">Optimization Level: ${sol.totalWeight}${freeLabel}</span>
    `;

    const body = document.createElement('div');
    body.className = 'solution-body';

    const idToLabel = (id) => state.nodes.find((n) => n.id === id)?.label || id;
    const groupKey = (ids) => [...ids].sort().join(',');
    const nodeIdToFixedColor = {};
    state.fixedGroups.forEach((groupIds, fi) => {
      const c = GROUP_COLORS[fi % GROUP_COLORS.length];
      groupIds.forEach((id) => { nodeIdToFixedColor[id] = c; });
    });

    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Table</th><th>People</th><th>Amount people at the table</th><th>Likeness between people</th><th></th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    sol.groupDetails.forEach((gd, gi) => {
      const color = GROUP_COLORS[gi % GROUP_COLORS.length];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle;"></span>${gi + 1}</td>
        <td></td>
        <td>${gd.nodeWeightSum}</td>
        <td>${gd.combinedWeight}</td>
        <td></td>`;
      const rowKey = groupKey(gd.nodeIds);
      const fixedIdx = state.fixedGroups.findIndex((fg) => groupKey(fg) === rowKey);
      if (fixedIdx >= 0) {
        const fixedColor = GROUP_COLORS[fixedIdx % GROUP_COLORS.length];
        tr.style.backgroundColor = fixedColor + '22';
        tr.classList.add('fixed-table-row');
      }
      const tdPeople = tr.cells[1];
      gd.nodeIds.forEach((id, i) => {
        if (i > 0) tdPeople.appendChild(document.createTextNode(', '));
        const span = document.createElement('span');
        span.textContent = idToLabel(id);
        const fixedColor = nodeIdToFixedColor[id];
        if (fixedColor) {
          span.className = 'fixed-guest-name';
          span.style.color = fixedColor;
        }
        tdPeople.appendChild(span);
      });
      const fixBtn = document.createElement('button');
      fixBtn.type = 'button';
      fixBtn.className = 'btn-small fix-table-btn';
      fixBtn.textContent = 'Fix Table';
      fixBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeIds = gd.nodeIds.slice();
        const nodeIdSet = new Set(nodeIds);
        state.fixedGroups = state.fixedGroups.filter((fg) => !fg.some((id) => nodeIdSet.has(id)));
        state.fixedGroups.push(nodeIds);
        saveToLocalStorage();
        const newFixedColor = GROUP_COLORS[(state.fixedGroups.length - 1) % GROUP_COLORS.length];
        tr.style.backgroundColor = newFixedColor + '22';
        tr.classList.add('fixed-table-row');
      });
      tr.querySelector('td:last-child').appendChild(fixBtn);
      tbody.appendChild(tr);
    });
    body.appendChild(table);

    if (freeCount > 0) {
      const freeBanner = document.createElement('div');
      freeBanner.className = 'free-nodes-banner';
      const freeLabels = sol.freeNodes.map(idToLabel).join(', ');
      freeBanner.innerHTML = `<strong>Unseated:</strong> ${freeLabels}`;
      body.appendChild(freeBanner);
    }

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

// ── Local storage ───────────────────────────────────────────────────────────

function getSerializableState() {
  return {
    nodes: state.nodes.map((n) => ({ id: n.id, label: n.label, nodeWeight: n.nodeWeight })),
    linkWeights: matrixToList(state.linkMatrix),
    minimumCombinedWeight: state.minimumCombinedWeight,
    maximumCombinedWeight: state.maximumCombinedWeight,
    allowFreeNodes: false,
    symmetricLinks: true,
    tags: state.tags.map((t) => ({ id: t.id, name: t.name, color: t.color, bonus: t.bonus ?? 2, nodeIds: (t.nodeIds || []).slice() })),
    splittingPremiumPoints: state.splittingPremiumPoints,
    fixedGroups: state.fixedGroups.map((g) => g.slice()),
  };
}

function saveToLocalStorage() {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(getSerializableState()));
  } catch (e) {}
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

// ── Save / Load ──────────────────────────────────────────────────────────────

btnSave.addEventListener('click', () => {
  const data = getSerializableState();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'wedding-seating.json';
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
    nodeWeight: n.nodeWeight != null && n.nodeWeight >= 1 ? n.nodeWeight : 1,
  }));

  state.linkMatrix = buildLinkMatrix(data.linkWeights || []);
  state.minimumCombinedWeight = data.minimumCombinedWeight ?? 7;
  state.maximumCombinedWeight = data.maximumCombinedWeight ?? 10;
  state.splittingPremiumPoints = data.splittingPremiumPoints ?? 5;
  state.allowFreeNodes = false;
  state.symmetricLinks = true;

  const nodeIdSet = new Set(state.nodes.map((n) => n.id));
  state.fixedGroups = Array.isArray(data.fixedGroups) ? data.fixedGroups.map((g) => g.filter((id) => nodeIdSet.has(id))).filter((g) => g.length > 0) : [];
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
  if (inputSplittingPremium) inputSplittingPremium.value = state.splittingPremiumPoints;
  rebuildNodesUI();
  renderMatrix();
  syncGraph();

  const effectiveMatrix = getEffectiveLinkMatrix();
  const errors = validate(
    state.nodes,
    effectiveMatrix,
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

restoreFromLocalStorage();
