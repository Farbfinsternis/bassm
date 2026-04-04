// ── Pin type constants & colours ──────────────────────────────────────────────

const PIN_COLORS = {
    exec:    '#ffffff',
    integer: '#5b9bd5',
    string:  '#6abf6a',
    bool:    '#d4c74a',
    asset:   '#888888',
};

// ── Noodle helpers ───────────────────────────────────────────────────────────

function createNoodlePath(x1, y1, x2, y2, color = '#666') {
    const dx = Math.abs(x2 - x1) * 0.5;
    const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    return path;
}

function updateNoodlePath(path, x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1) * 0.5;
    path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
}

// ── Node DOM builder ─────────────────────────────────────────────────────────

function createNodeElement(nodeDef, x, y) {
    const el = document.createElement('div');
    el.className = 'bnc-node';
    if (nodeDef.isPlay || nodeDef.isLoop) el.classList.add('bnc-node-play');
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    el.dataset.nodeId = nodeDef.id;

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'bnc-node-header';
    if (nodeDef.category) header.classList.add('bnc-cat-' + nodeDef.category);

    const titleSpan = document.createElement('span');
    titleSpan.className = 'bnc-node-title';
    titleSpan.textContent = nodeDef.title;
    header.appendChild(titleSpan);

    const headerRight = document.createElement('div');
    headerRight.className = 'bnc-node-header-right';

    if (nodeDef.zone && nodeDef.zone !== 'any') {
        const badge = document.createElement('span');
        badge.className = 'bnc-node-zone-badge';
        const iconCls = nodeDef.zone === 'setup' ? 'codicon-settings-gear' : 'codicon-sync';
        badge.innerHTML = `<i class=\"codicon ${iconCls}\"></i>`;
        badge.title = nodeDef.zone === 'setup' ? 'Setup Zone' : 'Frame Zone';
        headerRight.appendChild(badge);
    }

    if (!nodeDef.isPlay && !nodeDef.isLoop) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'bnc-node-close';
        closeBtn.innerHTML = '&#x2715;'; // X character
        closeBtn.title = 'Delete node';
        headerRight.appendChild(closeBtn);
    }

    header.appendChild(headerRight);
    el.appendChild(header);

    // ── Body ──
    const body = document.createElement('div');
    body.className = 'bnc-node-body';

    // Exec input pin (left, top)
    if (nodeDef.execIn) {
        const row = _createPinRow('exec', nodeDef.execIn, 'input');
        body.appendChild(row);
    }

    // Exec output pin (right, top)
    if (nodeDef.execOut) {
        const row = _createPinRow('exec', nodeDef.execOut, 'output');
        body.appendChild(row);
    }

    // Data input pins
    if (nodeDef.inputs) {
        for (const pin of nodeDef.inputs) {
            body.appendChild(_createPinRow(pin.type, pin.name, 'input'));
        }
    }

    // Data output pins
    if (nodeDef.outputs) {
        for (const pin of nodeDef.outputs) {
            body.appendChild(_createPinRow(pin.type, pin.name, 'output'));
        }
    }

    el.appendChild(body);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'bnc-node-resize-handle';
    el.appendChild(resizeHandle);

    return el;
}

function _createPinRow(type, label, direction) {
    const row = document.createElement('div');
    row.className = `bnc-pin-row bnc-pin-${direction}`;

    const dot = document.createElement('span');
    dot.className = 'bnc-pin-dot';
    dot.style.backgroundColor = PIN_COLORS[type] || PIN_COLORS.integer;
    dot.dataset.pinType = type;
    dot.dataset.pinDir  = direction;
    dot.dataset.pinName = label;

    // Exec pins use a triangle/diamond shape
    if (type === 'exec') dot.classList.add('bnc-pin-exec');

    const name = document.createElement('span');
    name.className = 'bnc-pin-label';
    name.textContent = label;

    if (direction === 'input') {
        row.appendChild(dot);
        row.appendChild(name);
        // Add inline input for data pins (not exec)
        if (type !== 'exec') {
            const input = document.createElement('input');
            input.className = 'bnc-pin-value';
            input.type = type === 'bool' ? 'checkbox' : 'text';
            input.dataset.pinName = label;
            input.placeholder = type === 'integer' ? '0' : type === 'string' ? '""' : '';
            // Prevent canvas interactions while typing
            input.addEventListener('pointerdown', e => e.stopPropagation());
            input.addEventListener('keydown', e => e.stopPropagation());
            row.appendChild(input);
        }
    } else {
        row.appendChild(name);
        row.appendChild(dot);
    }
    return row;
}

// ── PLAY node definition ─────────────────────────────────────────────────────

function makePlayNode() {
    return {
        id:       'play-entry',
        title:    '▶  PLAY',
        isPlay:   true,
        category: 'event',
        zone:     'setup',
        execIn:   null,
        execOut:  'Setup',
        inputs:   null,
        outputs:  null,
    };
}

function makeLoopNode() {
    return {
        id:       'loop-entry',
        title:    '↻  LOOP',
        isLoop:   true,
        category: 'event',
        zone:     'frame',
        execIn:   'Exec',
        execOut:  'Frame',
        inputs:   null,
        outputs:  null,
    };
}

// ── Main Editor class ────────────────────────────────────────────────────────

export class BASSMNodeEditor {
    constructor() {
        this.container  = document.getElementById('bnc-world-container');
        this.world      = document.getElementById('bnc-world');
        this.nodesLayer = document.getElementById('bnc-nodes');
        this.noodleSvg  = document.getElementById('bnc-noodles');
        this.uiLayer    = document.getElementById('bnc-ui');

        // Position camera so the PLAY/LOOP nodes appear top-left with padding
        this.camX = 60;
        this.camY = 60;
        this.zoom = 1.0;

        this.isDragging = false;

        /** @type {Map<string, {def: object, el: HTMLElement, x: number, y: number}>} */
        this.nodes = new Map();

        /** @type {Array<{from: string, fromPin: string, to: string, toPin: string, el: SVGPathElement}>} */
        this.edges = [];

        /** @type {Set<string>} */
        this.selectedNodes = new Set();

        // Wiring state (Phase 3)
        this._wiring = null;       // { nodeId, pinName, pinDir, pinType, previewPath }
        this._selBox = null;       // { startX, startY, el }

        // Node Picker (Phase 4)
        this._pickerEl = null;
        this._commands = [];       // loaded from commands-map.json

        this._nextNodeId = 1;

        this._initEvents();
        this._updateTransform();

        // Spawn only the PLAY node at start
        this._addNode(makePlayNode(), 0, 0);

        // Load command definitions
        this._loadCommands();
    }

    async _loadCommands() {
        try {
            const resp = await fetch('./src/commands-map.json');
            this._commands = await resp.json();
        } catch (e) {
            console.warn('Failed to load commands-map.json', e);
        }
    }

    // ── Camera & global events (Phase 1 + 3) ─────────────────────────────────

    _initEvents() {
        this.container.addEventListener('contextmenu', e => e.preventDefault());
        this.container.addEventListener('pointerdown', e => this._onPointerDown(e));
        document.addEventListener('pointermove', e => this._onPointerMove(e));
        document.addEventListener('pointerup',   e => this._onPointerUp(e));
        this.container.addEventListener('wheel', e => this._onWheel(e), { passive: false });

        // Double-click on grid → open Node Picker
        this.container.addEventListener('dblclick', e => this._onDblClick(e));

        // Drag & Drop from Project Tree into the Grid
        // Drag & Drop from Project Tree into the Grid
        this.container.addEventListener('dragenter', e => e.preventDefault());
        this.container.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move'; // Match Tree effectAllowed='move'
        });
        this.container.addEventListener('drop', e => this._onGridDrop(e));

        this.uiLayer.addEventListener('wheel', e => e.stopPropagation(), { passive: false });
        this.uiLayer.addEventListener('pointerdown', e => e.stopPropagation());

        // Keyboard: Delete selected nodes
        document.addEventListener('keydown', e => this._onKeyDown(e));
    }

    _onPointerDown(e) {
        // ── Pan with middle/right click ──
        if (e.button === 1 || e.button === 2) {
            e.preventDefault();
            this._closePicker();
            this.isDragging = true;
            this.container.style.cursor = 'grabbing';
            return;
        }

        // ── Left click on empty grid: start selection box or deselect ──
        if (e.button === 0) {
            const target = e.target;

            // Close picker when clicking outside it
            if (this._pickerEl && !target.closest('.bnc-picker')) {
                this._closePicker();
            }

            // Clicked on a node body (not header, not pin) → select it
            const nodeEl = target.closest('.bnc-node');
            if (nodeEl && !target.classList.contains('bnc-pin-dot')) {
                const nodeId = nodeEl.dataset.nodeId;
                if (!e.shiftKey) {
                    // Without shift: exclusive select
                    this._clearSelection();
                }
                this._selectNode(nodeId);
                return;
            }

            // Clicked on a pin dot → start wiring
            if (target.classList.contains('bnc-pin-dot')) {
                e.stopPropagation();
                this._startWiring(target, e);
                return;
            }

            // Clicked on empty space → deselect all & start selection box
            if (!e.shiftKey) this._clearSelection();
            this._startSelectionBox(e);
        }
    }

    _onPointerMove(e) {
        // Camera panning
        if (this.isDragging) {
            this.camX += e.movementX;
            this.camY += e.movementY;
            this._updateTransform();
            return;
        }

        // Wiring preview noodle
        if (this._wiring) {
            this._updateWiringPreview(e);
            return;
        }

        // Selection box
        if (this._selBox) {
            this._updateSelectionBox(e);
        }
    }

    _onPointerUp(e) {
        // Camera pan end
        if (this.isDragging) {
            this.isDragging = false;
            this.container.style.cursor = 'grab';
            return;
        }

        // Wiring end
        if (this._wiring) {
            this._endWiring(e);
            return;
        }

        // Selection box end
        if (this._selBox) {
            this._endSelectionBox();
        }
    }

    _onKeyDown(e) {
        // Ignore key events when node editor isn't active
        if (!document.body.classList.contains('state-node-editor')) return;

        if (e.key === 'Delete' || e.key === 'Backspace') {
            this._deleteSelectedNodes();
        }
    }

    _onWheel(e) {
        e.preventDefault();
        const rect = this.container.getBoundingClientRect();
        const pointerX = e.clientX - rect.left;
        const pointerY = e.clientY - rect.top;

        const worldX = (pointerX - this.camX) / this.zoom;
        const worldY = (pointerY - this.camY) / this.zoom;

        const zoomDelta = -e.deltaY * 0.001;
        this.zoom = Math.max(0.1, Math.min(this.zoom * Math.exp(zoomDelta), 3.0));

        this.camX = pointerX - (worldX * this.zoom);
        this.camY = pointerY - (worldY * this.zoom);

        this._updateTransform();
    }

    _updateTransform() {
        this.world.style.transform = `translate(${this.camX}px, ${this.camY}px) scale(${this.zoom})`;
    }

    /** Convert a screen-space (clientX/Y) coordinate to world-space */
    _screenToWorld(clientX, clientY) {
        const rect = this.container.getBoundingClientRect();
        return {
            x: (clientX - rect.left - this.camX) / this.zoom,
            y: (clientY - rect.top  - this.camY) / this.zoom,
        };
    }

    // ── Node management (Phase 2) ────────────────────────────────────────────

    _addNode(def, x, y) {
        if (!def.id) def.id = 'node-' + (this._nextNodeId++);
        const el = createNodeElement(def, x, y);

        if (def.width)  el.style.width  = def.width + 'px';
        if (def.height) el.style.height = def.height + 'px';

        this.nodesLayer.appendChild(el);
        this.nodes.set(def.id, { def, el, x, y });

        // Drag handling on header
        const header = el.querySelector('.bnc-node-header');
        this._makeNodeDraggable(def.id, header, el);

        // Close button handling
        const closeBtn = el.querySelector('.bnc-node-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // prevent drag or select
                this._deleteNode(def.id);
            });
            // Also prevent drag when down on button
            closeBtn.addEventListener('pointerdown', e => e.stopPropagation());
        }

        // Drag & Drop onto exactly this node (to auto-fill inputs)
        el.addEventListener('dragenter', e => e.preventDefault());
        el.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move'; // Match Tree effectAllowed='move'
            el.classList.add('bnc-node-dragover');
        });
        el.addEventListener('dragleave', () => el.classList.remove('bnc-node-dragover'));
        el.addEventListener('drop', e => {
            el.classList.remove('bnc-node-dragover');
            const data = e.dataTransfer.getData('text/plain');
            if (!data) return;

            e.preventDefault();
            e.stopPropagation(); // Prevent grid drop handler from triggering

            const ext = data.split('.').pop().toLowerCase();
            const valid = ['raw', 'iraw', 'bmap', 'fnt', 'font', 'mask'];
            if (!valid.includes(ext)) {
                if (typeof window.logLine === 'function') {
                    window.logLine(`Abgewiesen: BASSM Node benötigt .raw oder .iraw. Bitte .${ext} nicht verwenden!`, 'error');
                }
                return;
            }

            let targetInput = el.querySelector('.bnc-pin-value[data-pin-name="file"]')
                           || el.querySelector('.bnc-pin-value[data-pin-name="image"]')
                           || el.querySelector('.bnc-pin-value[type="text"]');

            if (targetInput) {
                let val = data;
                if (!val.startsWith('"')) val = '"' + val + '"';
                targetInput.value = val;

                // Visual flash
                const oldBg = targetInput.style.backgroundColor;
                targetInput.style.backgroundColor = '#2a4a6a';
                setTimeout(() => targetInput.style.backgroundColor = oldBg, 300);
            }
        });

        // Resize handling
        const resizeBtn = el.querySelector('.bnc-node-resize-handle');
        if (resizeBtn) {
            resizeBtn.addEventListener('pointerdown', e => {
                e.stopPropagation();
                
                const startX = e.clientX;
                const startY = e.clientY;
                const startW = el.offsetWidth;
                const startH = el.offsetHeight;
                
                // Measure the minimal content height
                const prevH = el.style.height;
                el.style.height = 'auto';
                const minH = el.offsetHeight;
                el.style.height = prevH || startH + 'px';

                const onMove = ev => {
                    const dx = (ev.clientX - startX) / this.zoom;
                    const dy = (ev.clientY - startY) / this.zoom;

                    let newW = startW + dx;
                    let newH = startH + dy;

                    const snap = 20; // Minor grid
                    let w = Math.round(newW / snap) * snap;
                    let h = Math.round(newH / snap) * snap;

                    if (w < 160) w = Math.max(160, Math.ceil(160 / snap) * snap);
                    if (h < minH) h = Math.ceil(minH / snap) * snap;

                    el.style.width  = w + 'px';
                    el.style.height = h + 'px';
                    
                    def.width = w;
                    def.height = h;

                    this._updateEdges();
                };

                const onUp = () => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                };

                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }
        
        return def.id;
    }

    _makeNodeDraggable(nodeId, handle, nodeEl) {
        let dragging = false;
        let startMouseX, startMouseY, startNodeX, startNodeY;

        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.stopPropagation();
            dragging = true;
            const entry = this.nodes.get(nodeId);
            startMouseX = e.clientX;
            startMouseY = e.clientY;
            startNodeX  = entry.x;
            startNodeY  = entry.y;
            handle.setPointerCapture(e.pointerId);
            nodeEl.classList.add('bnc-node-dragging');
        });

        handle.addEventListener('pointermove', e => {
            if (!dragging) return;
            const dx = (e.clientX - startMouseX) / this.zoom;
            const dy = (e.clientY - startMouseY) / this.zoom;
            const entry = this.nodes.get(nodeId);
            const snap = 20;
            const nx = startNodeX + dx;
            const ny = startNodeY + dy;
            entry.x = Math.round(nx / snap) * snap;
            entry.y = Math.round(ny / snap) * snap;
            nodeEl.style.left = entry.x + 'px';
            nodeEl.style.top  = entry.y + 'px';
            this._redrawEdgesForNode(nodeId);
        });

        handle.addEventListener('pointerup', e => {
            if (!dragging) return;
            dragging = false;
            handle.releasePointerCapture(e.pointerId);
            nodeEl.classList.remove('bnc-node-dragging');
        });
    }

    // ── Selection (Phase 3) ──────────────────────────────────────────────────

    _selectNode(nodeId) {
        this.selectedNodes.add(nodeId);
        const entry = this.nodes.get(nodeId);
        if (entry) entry.el.classList.add('bnc-node-selected');
    }

    _deselectNode(nodeId) {
        this.selectedNodes.delete(nodeId);
        const entry = this.nodes.get(nodeId);
        if (entry) entry.el.classList.remove('bnc-node-selected');
    }

    _clearSelection() {
        for (const id of this.selectedNodes) {
            const entry = this.nodes.get(id);
            if (entry) entry.el.classList.remove('bnc-node-selected');
        }
        this.selectedNodes.clear();
    }

    _startSelectionBox(e) {
        const world = this._screenToWorld(e.clientX, e.clientY);
        const el = document.createElement('div');
        el.className = 'bnc-selection-box';
        el.style.left   = world.x + 'px';
        el.style.top    = world.y + 'px';
        el.style.width  = '0px';
        el.style.height = '0px';
        this.nodesLayer.appendChild(el);
        this._selBox = { startX: world.x, startY: world.y, el };
    }

    _updateSelectionBox(e) {
        if (!this._selBox) return;
        const world = this._screenToWorld(e.clientX, e.clientY);
        const x = Math.min(this._selBox.startX, world.x);
        const y = Math.min(this._selBox.startY, world.y);
        const w = Math.abs(world.x - this._selBox.startX);
        const h = Math.abs(world.y - this._selBox.startY);
        this._selBox.el.style.left   = x + 'px';
        this._selBox.el.style.top    = y + 'px';
        this._selBox.el.style.width  = w + 'px';
        this._selBox.el.style.height = h + 'px';
    }

    _endSelectionBox() {
        if (!this._selBox) return;
        const boxRect = this._selBox.el.getBoundingClientRect();
        this._selBox.el.remove();

        // Find all nodes whose DOM element overlaps the selection box
        for (const [id, entry] of this.nodes) {
            const nodeRect = entry.el.getBoundingClientRect();
            if (
                nodeRect.left < boxRect.right  && nodeRect.right  > boxRect.left &&
                nodeRect.top  < boxRect.bottom && nodeRect.bottom > boxRect.top
            ) {
                this._selectNode(id);
            }
        }
        this._selBox = null;
    }

    // ── Deletion (Phase 3) ───────────────────────────────────────────────────

    _deleteSelectedNodes() {
        for (const nodeId of [...this.selectedNodes]) {
            this._deleteNode(nodeId);
        }
    }

    _deleteNode(nodeId) {
        const entry = this.nodes.get(nodeId);
        if (!entry) return;

        // PLAY and LOOP nodes cannot be deleted
        if (entry.def.isPlay || entry.def.isLoop) return;

        // Auto-heal logic for standard Exec flow:
        // Find ALL incoming 'exec' edges and ALL outgoing 'exec' edges connecting to this node.
        const execIns  = this.edges.filter(e => e.to === nodeId   && e.type === 'exec');
        const execOuts = this.edges.filter(e => e.from === nodeId && e.type === 'exec');

        // If there is 1 or more incoming Execs, but STRICTLY 1 outgoing Exec,
        // we can safely bridge the gap left by this deleted node.
        let healEdges = [];
        if (execIns.length > 0 && execOuts.length === 1) {
            const outTarget = execOuts[0];
            healEdges = execIns.map(eIn => ({
                from: eIn.from, fromPin: eIn.fromPin, 
                to: outTarget.to, toPin: outTarget.toPin
            }));
        }

        // Remove all edges connected to this node
        this.edges = this.edges.filter(edge => {
            if (edge.from === nodeId || edge.to === nodeId) {
                edge.el.remove();
                // Restore inline input on the OTHER node's pin
                if (edge.to !== nodeId) this._showPinInput(edge.to, edge.toPin);
                return false;
            }
            return true;
        });

        // Apply healed edges to bypass the deleted node
        for (const heal of healEdges) {
            const color = PIN_COLORS['exec'] || '#ffffff';
            this.addEdge(heal.from, heal.fromPin, heal.to, heal.toPin, color, 'exec');
            this._hidePinInput(heal.to, heal.toPin); 
        }

        // Remove DOM element
        entry.el.remove();
        this.nodes.delete(nodeId);
        this.selectedNodes.delete(nodeId);
    }

    // ── Pin input visibility helpers ────────────────────────────────────────────

    _hidePinInput(nodeId, pinName) {
        const entry = this.nodes.get(nodeId);
        if (!entry) return;
        const input = entry.el.querySelector(`.bnc-pin-value[data-pin-name="${pinName}"]`);
        if (input) input.style.display = 'none';
    }

    _showPinInput(nodeId, pinName) {
        const entry = this.nodes.get(nodeId);
        if (!entry) return;
        const input = entry.el.querySelector(`.bnc-pin-value[data-pin-name="${pinName}"]`);
        if (input) input.style.display = '';
    }

    // ── Wiring / Noodle connection (Phase 3) ─────────────────────────────────

    _startWiring(pinDot, e) {
        e.stopPropagation();
        const nodeEl = pinDot.closest('.bnc-node');
        const nodeId = nodeEl.dataset.nodeId;
        const pinName = pinDot.dataset.pinName;
        const pinDir  = pinDot.dataset.pinDir;
        const pinType = pinDot.dataset.pinType;

        // Get source pin position in world space
        const pos = this._getPinWorldPos(nodeId, pinName, pinDir);
        const color = PIN_COLORS[pinType] || '#666';

        // Create a preview noodle
        const previewPath = createNoodlePath(pos.x, pos.y, pos.x, pos.y, color);
        previewPath.setAttribute('stroke-dasharray', '6 4');
        previewPath.setAttribute('opacity', '0.6');
        this.noodleSvg.appendChild(previewPath);

        this._wiring = { nodeId, pinName, pinDir, pinType, previewPath, startPos: pos };
    }

    _updateWiringPreview(e) {
        if (!this._wiring) return;
        const world = this._screenToWorld(e.clientX, e.clientY);
        const { startPos, pinDir } = this._wiring;

        if (pinDir === 'output') {
            updateNoodlePath(this._wiring.previewPath, startPos.x, startPos.y, world.x, world.y);
        } else {
            updateNoodlePath(this._wiring.previewPath, world.x, world.y, startPos.x, startPos.y);
        }
    }

    _endWiring(e) {
        if (!this._wiring) return;
        const wiring = this._wiring;
        this._wiring = null;

        // Remove the dashed preview path
        wiring.previewPath.remove();

        // Find the nearest compatible pin within a generous radius
        const hit = this._findNearestPin(e.clientX, e.clientY, 30);
        if (!hit) {
            // Drop in empty space -> Open Context Picker
            const worldPos = this._screenToWorld(e.clientX, e.clientY);
            this._openPicker(e.clientX, e.clientY, worldPos, wiring);
            return;
        }

        const { nodeId: targetNodeId, pinName: targetPinName, pinDir: targetPinDir, pinType: targetPinType } = hit;

        // Validate connection
        if (!this._isValidConnection(wiring, targetNodeId, targetPinName, targetPinDir, targetPinType)) return;

        // Determine from/to
        let fromId, fromPin, toId, toPin;
        if (wiring.pinDir === 'output') {
            fromId = wiring.nodeId; fromPin = wiring.pinName;
            toId   = targetNodeId;  toPin   = targetPinName;
        } else {
            fromId = targetNodeId;  fromPin = targetPinName;
            toId   = wiring.nodeId; toPin   = wiring.pinName;
        }

        // Create the real edge (cleanup of illegal overlapping happens in addEdge)
        const color = PIN_COLORS[wiring.pinType] || '#666';
        this.addEdge(fromId, fromPin, toId, toPin, color, wiring.pinType);

        // Hide the inline input on the connected pin
        this._hidePinInput(toId, toPin);
    }

    _isValidConnection(wiring, targetNodeId, targetPinName, targetPinDir, targetPinType) {
        // Can't connect to self
        if (wiring.nodeId === targetNodeId) return false;

        // Must be opposite directions (output → input)
        if (wiring.pinDir === targetPinDir) return false;

        // Types must match
        if (wiring.pinType !== targetPinType) return false;

        // Check for duplicate edge
        const fromId  = wiring.pinDir === 'output' ? wiring.nodeId : targetNodeId;
        const toId    = wiring.pinDir === 'output' ? targetNodeId  : wiring.nodeId;
        const fromPin = wiring.pinDir === 'output' ? wiring.pinName : targetPinName;
        const toPin   = wiring.pinDir === 'output' ? targetPinName  : wiring.pinName;

        for (const edge of this.edges) {
            if (edge.from === fromId && edge.to === toId &&
                edge.fromPin === fromPin && edge.toPin === toPin) {
                return false;
            }
        }

        // Zone validation (only applicable to Exec pins conceptually, but we can do it globally)
        const sourceEntry = this.nodes.get(fromId);
        const targetEntry = this.nodes.get(toId);
        if (sourceEntry && targetEntry) {
            const sz = sourceEntry.def.zone || 'any';
            const tz = targetEntry.def.zone || 'any';
            
            // Loop node is the bridge: Setup -> Loop is allowed
            // Other than that, cross-zone wiring is blocked
            if (sz === 'setup' && tz === 'frame' && !targetEntry.def.isLoop) return false;
            if (sz === 'frame' && tz === 'setup') return false;
        }

        return true;
    }

    /** Find the nearest pin dot within `radius` screen pixels of (clientX, clientY) */
    _findNearestPin(clientX, clientY, radius) {
        let best = null;
        let bestDist = radius * radius; // compare squared distances

        for (const [nodeId, entry] of this.nodes) {
            const dots = entry.el.querySelectorAll('.bnc-pin-dot');
            for (const dot of dots) {
                const r = dot.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top  + r.height / 2;
                const dx = clientX - cx;
                const dy = clientY - cy;
                const distSq = dx * dx + dy * dy;
                if (distSq < bestDist) {
                    bestDist = distSq;
                    best = {
                        nodeId,
                        pinName: dot.dataset.pinName,
                        pinDir:  dot.dataset.pinDir,
                        pinType: dot.dataset.pinType,
                    };
                }
            }
        }
        return best;
    }

    // ── Edge / Noodle drawing (Phase 2) ──────────────────────────────────────

    _getPinWorldPos(nodeId, pinName, pinDir) {
        const entry = this.nodes.get(nodeId);
        if (!entry) return { x: 0, y: 0 };
        const dot = entry.el.querySelector(
            `.bnc-pin-dot[data-pin-name="${pinName}"][data-pin-dir="${pinDir}"]`
        );
        if (!dot) return { x: entry.x, y: entry.y };
        const nodeRect = entry.el.getBoundingClientRect();
        const dotRect  = dot.getBoundingClientRect();
        return {
            x: entry.x + (dotRect.left + dotRect.width / 2 - nodeRect.left) / this.zoom,
            y: entry.y + (dotRect.top  + dotRect.height / 2 - nodeRect.top)  / this.zoom,
        };
    }

    _redrawEdgesForNode(nodeId) {
        for (const edge of this.edges) {
            if (edge.from === nodeId || edge.to === nodeId) {
                const p1 = this._getPinWorldPos(edge.from, edge.fromPin, 'output');
                const p2 = this._getPinWorldPos(edge.to,   edge.toPin,   'input');
                updateNoodlePath(edge.el, p1.x, p1.y, p2.x, p2.y);
            }
        }
    }

    addEdge(fromId, fromPin, toId, toPin, color, pinType = null) {
        if (!pinType) {
            // Safe fallback if called programmatically without pinType
            const toEntry = this.nodes.get(toId);
            if (toEntry) {
                if (toEntry.def.execIn === toPin) pinType = 'exec';
                else {
                    const inp = (toEntry.def.inputs || []).find(i => i.name === toPin);
                    if (inp) pinType = inp.type;
                }
            }
        }

        // Cleanup illegal connections
        this.edges = this.edges.filter(edge => {
            // Rule 1: Data inputs (not exec) can only receive ONE incoming connection.
            if (pinType !== 'exec' && edge.to === toId && edge.toPin === toPin) {
                edge.el.remove();
                this._showPinInput(edge.to, edge.toPin);
                return false;
            }
            // Rule 2: Exec outputs can only have ONE outgoing connection.
            if (pinType === 'exec' && edge.from === fromId && edge.fromPin === fromPin) {
                edge.el.remove();
                return false;
            }
            return true;
        });

        const p1 = this._getPinWorldPos(fromId, fromPin, 'output');
        const p2 = this._getPinWorldPos(toId,   toPin,   'input');
        const path = createNoodlePath(p1.x, p1.y, p2.x, p2.y, color);
        this.noodleSvg.appendChild(path);
        this.edges.push({ from: fromId, fromPin, to: toId, toPin, type: pinType, el: path });
    }

    // ── Public: spawn a command node (used by Phase 4 picker) ────────────────

    spawnCommandNode(cmdDef, worldX, worldY) {
        const def = {
            id:       null, // auto-assigned
            title:    cmdDef.name,
            category: this._categorize(cmdDef),
            zone:     cmdDef.zone || 'any',
            execIn:   'Exec',
            execOut:  'Exec',
            inputs:   (cmdDef.args || []).map(a => ({ name: a.name, type: a.type })),
            outputs:  cmdDef.outputs ? cmdDef.outputs : (cmdDef.return !== 'void' ? [{ name: 'Result', type: cmdDef.return }] : null),
        };
        return this._addNode(def, worldX, worldY);
    }

    _categorize(cmd) {
        const n = cmd.name.toLowerCase();
        if (['graphics','cls','clscolor','color','palettecolor','plot','line','rect','box',
             'text','screenflip','coppercolor','drawimage','drawbob','setbackground',
             'loadmask','loadimage','loadanimimage','loadtileset','loadtilemap',
             'drawtilemap','setviewport','viewport','setcamera','settilemap',
             'loadfont','usefont'].includes(n)) return 'graphics';
        if (['loadsample','playsample','playsampleonce','stopsample'].includes(n)) return 'audio';
        if (['waitkey'].includes(n)) return 'input';
        if (['delay','waitvbl','end'].includes(n)) return 'flow';
        return 'math';
    }

    // ── Drag & Drop (Phase 4.1) ─────────────────────────────────────────────

    _onGridDrop(e) {
        let filePath = e.dataTransfer.getData('text/plain');
        if (!filePath) return;
        
        // Ensure path ends up relative (tree gives relative paths, so this is fine)
        const ext = filePath.split('.').pop().toLowerCase();
        
        e.preventDefault();

        const spawnNodeWithFile = (nameToSpawn) => {
            const cmdDef = this._commands.find(c => c.name === nameToSpawn);
            if (!cmdDef) return;
            const worldPos = this._screenToWorld(e.clientX, e.clientY);
            const nodeId = this.spawnCommandNode(cmdDef, worldPos.x, worldPos.y);

            const entry = this.nodes.get(nodeId);
            if (entry) {
                let targetInput = entry.el.querySelector('.bnc-pin-value[data-pin-name="file"]')
                               || entry.el.querySelector('.bnc-pin-value[type="text"]');
                if (targetInput) {
                    let val = filePath;
                    if (!val.startsWith('"')) val = '"' + val + '"';
                    targetInput.value = val;
                }
            }
        };

        if (ext === 'iraw') {
            spawnNodeWithFile('LoadImage'); 
        } else if (ext === 'bmap') {
            spawnNodeWithFile('LoadTilemap');
        } else if (['fnt', 'font'].includes(ext)) {
            spawnNodeWithFile('LoadFont');
        } else if (ext === 'mask') {
            spawnNodeWithFile('LoadMask');
        } else if (ext === 'raw') {
            // .raw is ambiguous on Amiga (Audio or Image)
            if (typeof window.showContextMenu === 'function') {
                window.showContextMenu(e.clientX, e.clientY, [
                    { label: 'Import als Bitmap (.raw)...', action: () => spawnNodeWithFile('LoadImage') },
                    { label: 'Import als Sound (.raw)...',  action: () => spawnNodeWithFile('LoadSample') }
                ]);
            } else {
                // Fallback
                const isSnd = confirm('Als Sound laden? (Abbrechen für Bild)');
                spawnNodeWithFile(isSnd ? 'LoadSample' : 'LoadImage');
            }
        } else {
            if (typeof window.logLine === 'function') {
                window.logLine(`Abgewiesen: BASSM benötigt Amiga-konforme .raw / .iraw Dateien. Bitte konvertiere .${ext} erst!`, 'error');
            }
        }
    }

    // ── Node Picker (Phase 4) ────────────────────────────────────────────────

    _onDblClick(e) {
        // Don't open if clicking on a node
        if (e.target.closest('.bnc-node')) return;
        this._closePicker();

        const worldPos = this._screenToWorld(e.clientX, e.clientY);
        this._openPicker(e.clientX, e.clientY, worldPos, null);
    }

    _openPicker(screenX, screenY, worldPos, contextWiring) {
        const picker = document.createElement('div');
        picker.className = 'bnc-picker bnc-ui-element';

        // Position in screen space via the UI layer
        const rect = this.container.getBoundingClientRect();
        picker.style.left = (screenX - rect.left) + 'px';
        picker.style.top  = (screenY - rect.top) + 'px';

        // Header row with search + close button
        const headerRow = document.createElement('div');
        headerRow.className = 'bnc-picker-header';

        const search = document.createElement('input');
        search.className = 'bnc-picker-search';
        search.type = 'text';
        search.placeholder = 'Search node\u2026';
        headerRow.appendChild(search);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'bnc-picker-close';
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', () => this._closePicker());
        headerRow.appendChild(closeBtn);

        picker.appendChild(headerRow);

        // Scrollable list
        const list = document.createElement('div');
        list.className = 'bnc-picker-list';
        picker.appendChild(list);

        // Build categorized entries
        const categories = this._buildCategories(contextWiring, null);
        this._renderPickerList(list, categories, worldPos, contextWiring);

        // Search filtering
        search.addEventListener('input', () => {
            const q = search.value.toLowerCase().trim();
            const filtered = this._buildCategories(contextWiring, q);
            this._renderPickerList(list, filtered, worldPos, contextWiring);
        });

        // Close on Escape
        search.addEventListener('keydown', e => {
            if (e.key === 'Escape') this._closePicker();
        });

        // Stop events from reaching the canvas
        picker.addEventListener('pointerdown', e => e.stopPropagation());
        picker.addEventListener('wheel', e => e.stopPropagation(), { passive: false });

        this.uiLayer.appendChild(picker);
        this._pickerEl = picker;

        // Focus search after a tick (so dblclick doesn't steal it)
        requestAnimationFrame(() => search.focus());
    }

    _closePicker() {
        if (this._pickerEl) {
            this._pickerEl.remove();
            this._pickerEl = null;
        }
    }

    _buildCategories(contextWiring, query) {
        const cats = new Map();

        // Add LOOP node if none exists yet (singleton)
        const loopExists = this.nodes.has('loop-entry');
        if (!loopExists) {
            const loopMatch = !query || '\u21bb loop'.includes(query);
            if (loopMatch) {
                let allowLoop = true;
                if (contextWiring) {
                    if (contextWiring.pinType !== 'exec') allowLoop = false;
                    else if (contextWiring.pinDir === 'input') allowLoop = false;
                }
                
                if (allowLoop) {
                    if (!cats.has('Event')) cats.set('Event', []);
                    cats.get('Event').push({ name: '\u21bb  LOOP', _isLoopPicker: true, description: 'Main game loop (While 1 \u2026 ScreenFlip \u2026 Wend). Only one allowed.', zone: 'frame' });
                }
            }
        }

        for (const cmd of this._commands) {
            // Filter by search query
            if (query && !cmd.name.toLowerCase().includes(query)) continue;

            // Filter context
            if (contextWiring) {
                let hasMatch = false;
                if (contextWiring.pinType === 'exec') {
                    if (contextWiring.pinDir === 'output') {
                        hasMatch = true;
                        const sourceZone = this.nodes.get(contextWiring.nodeId).def.zone || 'any';
                        const targetZone = cmd.zone || 'any';
                        if (sourceZone === 'frame' && targetZone === 'setup') hasMatch = false;
                        if (sourceZone === 'setup' && targetZone === 'frame') hasMatch = false;
                    } else {
                        hasMatch = true;
                        const targetZone = this.nodes.get(contextWiring.nodeId).def.zone || 'any';
                        const sourceZone = cmd.zone || 'any';
                        if (sourceZone === 'setup' && targetZone === 'frame') hasMatch = false;
                        if (sourceZone === 'frame' && targetZone === 'setup') hasMatch = false;
                    }
                } else {
                    const pType = contextWiring.pinType;
                    if (contextWiring.pinDir === 'output') {
                        if (cmd.args && cmd.args.some(arg => arg.type === pType)) hasMatch = true;
                    } else {
                        if (cmd.return === pType) hasMatch = true;
                    }
                }

                if (!hasMatch) continue;
            }

            const cat = this._categorize(cmd);
            const catName = cat.charAt(0).toUpperCase() + cat.slice(1);
            if (!cats.has(catName)) cats.set(catName, []);
            cats.get(catName).push(cmd);
        }
        return cats;
    }

    _renderPickerList(listEl, categories, worldPos, contextWiring) {
        listEl.innerHTML = '';
        if (categories.size === 0) {
            const empty = document.createElement('div');
            empty.className = 'bnc-picker-empty';
            empty.textContent = 'No nodes found.';
            listEl.appendChild(empty);
            return;
        }

        for (const [catName, cmds] of categories) {
            const catHeader = document.createElement('div');
            catHeader.className = 'bnc-picker-cat';
            catHeader.textContent = catName;

            const catBody = document.createElement('div');
            catBody.className = 'bnc-picker-cat-body';

            // Toggle collapse
            catHeader.addEventListener('click', () => {
                const collapsed = catBody.style.display === 'none';
                catBody.style.display = collapsed ? '' : 'none';
                catHeader.classList.toggle('collapsed', !collapsed);
            });

            for (const cmd of cmds) {
                const item = document.createElement('div');
                item.className = 'bnc-picker-item';
                
                const itemName = document.createElement('span');
                itemName.textContent = cmd.name;
                item.appendChild(itemName);
                
                if (cmd.zone && cmd.zone !== 'any') {
                    const badge = document.createElement('span');
                    badge.className = 'bnc-picker-item-badge';
                    const iconCls = cmd.zone === 'setup' ? 'codicon-settings-gear' : 'codicon-sync';
                    badge.innerHTML = `<i class=\"codicon ${iconCls}\"></i>`;
                    badge.title = cmd.zone === 'setup' ? 'Setup Zone Only' : 'Frame Zone Only';
                    item.appendChild(badge);
                }

                item.title = cmd.description || '';
                item.addEventListener('click', () => {
                    let newNodeId = null;
                    if (cmd._isLoopPicker) {
                        newNodeId = this._addNode(makeLoopNode(), worldPos.x, worldPos.y);
                    } else {
                        newNodeId = this.spawnCommandNode(cmd, worldPos.x, worldPos.y);
                    }
                    this._closePicker();

                    if (contextWiring && newNodeId) {
                        this._autoWire(contextWiring, newNodeId);
                    }
                });
                catBody.appendChild(item);
            }

            listEl.appendChild(catHeader);
            listEl.appendChild(catBody);
        }
    }

    _autoWire(contextWiring, newNodeId) {
        const newEntry = this.nodes.get(newNodeId);
        if (!newEntry) return;

        let targetPinName = null;
        let targetPinDir = contextWiring.pinDir === 'output' ? 'input' : 'output';

        if (contextWiring.pinType === 'exec') {
            if (targetPinDir === 'input' && newEntry.def.execIn) targetPinName = newEntry.def.execIn;
            else if (targetPinDir === 'output' && newEntry.def.execOut) targetPinName = newEntry.def.execOut;
        } else {
            if (targetPinDir === 'input' && newEntry.def.inputs) {
                const match = newEntry.def.inputs.find(i => i.type === contextWiring.pinType);
                if (match) targetPinName = match.name;
            } else if (targetPinDir === 'output' && newEntry.def.outputs) {
                const match = newEntry.def.outputs.find(o => o.type === contextWiring.pinType);
                if (match) targetPinName = match.name;
            }
        }

        if (targetPinName) {
            // Verify and connect
            if (this._isValidConnection(contextWiring, newNodeId, targetPinName, targetPinDir, contextWiring.pinType)) {
                let fromId, fromPin, toId, toPin;
                if (contextWiring.pinDir === 'output') {
                    fromId = contextWiring.nodeId; fromPin = contextWiring.pinName;
                    toId   = newNodeId;            toPin   = targetPinName;
                } else {
                    fromId = newNodeId;            fromPin = targetPinName;
                    toId   = contextWiring.nodeId; toPin   = contextWiring.pinName;
                }
                const color = PIN_COLORS[contextWiring.pinType] || '#666';
                this.addEdge(fromId, fromPin, toId, toPin, color, contextWiring.pinType);
                this._hidePinInput(toId, toPin);
            }
        }
    }
}
