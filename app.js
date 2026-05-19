(function emotionMapClassroom() {
  "use strict";

  const SUPABASE_URL = "https://irryksaoygdklwtsjsru.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_9zF3s9-hDyRRVi5OqAFP-w_z9Mrx9bt";
  const SUPABASE_ENABLED = true;
  const SB_REST = `${SUPABASE_URL}/rest/v1/emotion_map_responses`;
  const SB_HEADERS = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
  };

  const CANVAS_WIDTH = 360;
  const CANVAS_HEIGHT = 620;
  const STORE_WIDTH = 120;
  const STORE_HEIGHT = 207;
  const MAX_HISTORY = 20;
  const BODY_MASK_VERSION = "paper_ref_v1";
  const MIN_PAINTED_PIXELS = 1;
  const APP_VERSION = "20260519-0125";

  const EMOTIONS = [
    { id: "enojo", label: "Enojo" },
    { id: "tristeza", label: "Tristeza" }
  ];
  const MAP_TYPE_ORDER = ["activation", "deactivation"];

  const MAP_TYPES = {
    activation: {
      label: "Activación",
      paintColor: "rgba(239, 68, 68, 0.92)",
      instruction: "Pintá las zonas de tu cuerpo que sentís más activas, intensas o encendidas cuando aparece esta emoción."
    },
    deactivation: {
      label: "Debilitamiento",
      paintColor: "rgba(96, 165, 250, 0.9)",
      instruction: "Ahora pintá las zonas de tu cuerpo que sentís más débiles, apagadas o lentas cuando aparece esta emoción."
    }
  };

  const state = {
    classId: "default",
    participantId: "",
    participantIdHash: "",
    sessionId: "",
    tasks: [],
    taskIndex: 0,
    tool: "paint",
    brushSize: 24,
    isDrawing: false,
    activeMapType: "activation",
    lastPoint: null,
    undoStack: [],
    responses: [],
    saved: false,
    saveInFlight: false,
    debugEnabled: false
  };

  const ui = {};
  const paintSurfaces = {};
  let maskCanvas;
  let maskCtx;
  let storeMaskCanvas;
  let bodyTemplateImage;
  let bodyMaskImage;
  let bodyOutlineImage;
  let lastPointerId = null;
  let lastPointerCanvas = null;

  // Cache for decoded bit arrays — avoids re-decoding identical masks on each heatmap render.
  const bitsCache = new Map();

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    setupStateFromUrl();
    setupCanvas();
    bindEvents();
    setStartEnabled(false);

    try {
      await loadBodyAssets();
      buildMasks();
      drawAllBaseBodies();
      setStartEnabled(true);
    } catch (error) {
      showTaskError("No se pudo cargar la silueta corporal. Revisá la carpeta assets.");
      console.error(error);
    }
  }

  function cacheDom() {
    ui.screenStart = document.getElementById("screen-start");
    ui.screenTask = document.getElementById("screen-task");
    ui.screenResults = document.getElementById("screen-results");
    ui.screenLearning = document.getElementById("screen-learning");

    ui.participantInput = document.getElementById("participant-id");
    ui.startButton = document.getElementById("start-button");
    ui.restartButton = document.getElementById("restart-button");

    ui.taskCounter = document.getElementById("task-counter");
    ui.taskPhaseChip = document.getElementById("task-phase-chip");
    ui.progressFill = document.getElementById("progress-fill");
    ui.taskTitle = document.getElementById("task-title");
    ui.taskInstruction = document.getElementById("task-instruction");
    ui.taskError = document.getElementById("task-error");
    ui.bodyMaps = Array.from(document.querySelectorAll(".body-map"));
    ui.mobileMapTabs = Array.from(document.querySelectorAll(".mobile-map-tab"));

    ui.baseCanvases = {};
    ui.paintCanvases = {};
    MAP_TYPE_ORDER.forEach((mapType) => {
      ui.baseCanvases[mapType] = document.getElementById(`${mapType}-base-canvas`);
      ui.paintCanvases[mapType] = document.getElementById(`${mapType}-paint-canvas`);
    });
    ui.toolPaint = document.getElementById("tool-paint");
    ui.toolErase = document.getElementById("tool-erase");
    ui.brushSize = document.getElementById("brush-size");
    ui.brushSizeValue = document.getElementById("brush-size-value");
    ui.undoButton = document.getElementById("undo-button");
    ui.clearButton = document.getElementById("clear-button");
    ui.nextButton = document.getElementById("next-button");
    ui.paintStatus = document.getElementById("paint-status");

    ui.saveStatus = document.getElementById("save-status");
    ui.participantCount = document.getElementById("participant-count");
    ui.heatmapGrid = document.getElementById("heatmap-grid");
    ui.learnButton = document.getElementById("learn-button");
    ui.backResultsButton = document.getElementById("back-results-button");
    ui.reloadHeatmapsButton = document.getElementById("reload-heatmaps-button");
    ui.retrySaveButton = document.getElementById("retry-save-button");
  }

  function setupStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const classParam = (params.get("class") || params.get("class_id") || "").trim();
    state.classId = classParam || "default";
    state.debugEnabled = params.get("debug") === "1";
    setDefaultBrushSize();
    if (state.debugEnabled) {
      window.emotionMapDebug = {
        version: APP_VERSION,
        state,
        getStats: () => Object.fromEntries(
          MAP_TYPE_ORDER.map((mapType) => [mapType, computePaintStats(mapType)])
        ),
        getButton: () => ({
          disabled: ui.nextButton ? ui.nextButton.disabled : null,
          text: ui.nextButton ? ui.nextButton.textContent : null,
          status: ui.paintStatus ? ui.paintStatus.textContent : null
        })
      };
    }
  }

  function setupCanvas() {
    MAP_TYPE_ORDER.forEach((mapType) => {
      const baseCanvas = ui.baseCanvases[mapType];
      const paintCanvas = ui.paintCanvases[mapType];
      paintSurfaces[mapType] = {
        baseCanvas,
        paintCanvas,
        baseCtx: baseCanvas.getContext("2d"),
        paintCtx: paintCanvas.getContext("2d", { willReadFrequently: true })
      };
    });

    maskCanvas = document.createElement("canvas");
    maskCanvas.width = CANVAS_WIDTH;
    maskCanvas.height = CANVAS_HEIGHT;
    maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });

    storeMaskCanvas = document.createElement("canvas");
    storeMaskCanvas.width = STORE_WIDTH;
    storeMaskCanvas.height = STORE_HEIGHT;
  }

  function setDefaultBrushSize() {
    const isTouchSized = window.matchMedia("(pointer: coarse), (max-width: 760px)").matches;
    state.brushSize = isTouchSized ? 34 : 24;
    if (ui.brushSize) {
      ui.brushSize.value = String(state.brushSize);
    }
    if (ui.brushSizeValue) {
      ui.brushSizeValue.textContent = String(state.brushSize);
    }
  }

  function bindEvents() {
    ui.startButton.addEventListener("click", startExperiment);
    ui.restartButton.addEventListener("click", resetToStart);

    ui.toolPaint.addEventListener("click", () => setTool("paint"));
    ui.toolErase.addEventListener("click", () => setTool("erase"));
    ui.mobileMapTabs.forEach((button) => {
      button.addEventListener("click", () => setActiveMapType(button.dataset.mapType || "activation"));
    });
    ui.brushSize.addEventListener("input", () => {
      state.brushSize = Number(ui.brushSize.value);
      ui.brushSizeValue.textContent = String(state.brushSize);
    });

    if (ui.undoButton) {
      ui.undoButton.addEventListener("click", undoPaint);
    }
    if (ui.clearButton) {
      ui.clearButton.addEventListener("click", () => clearPaint(true));
    }
    ui.nextButton.addEventListener("click", saveCurrentTask);
    if (ui.learnButton) {
      ui.learnButton.addEventListener("click", () => showScreen("learning"));
    }
    if (ui.backResultsButton) {
      ui.backResultsButton.addEventListener("click", () => showScreen("results"));
    }
    if (ui.reloadHeatmapsButton) {
      ui.reloadHeatmapsButton.addEventListener("click", loadAndRenderHeatmaps);
    }
    if (ui.retrySaveButton) {
      ui.retrySaveButton.addEventListener("click", saveResponsesAndRender);
    }

    // Pointer Events only — covers mouse, touch, and stylus uniformly.
    // setPointerCapture (called in onPointerDown) keeps drawing stable.
    MAP_TYPE_ORDER.forEach((mapType) => {
      const canvas = paintSurfaces[mapType].paintCanvas;
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointerleave", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
    });
    window.addEventListener("resize", updateMobileBodyMode);
  }

  function setStartEnabled(enabled) {
    ui.startButton.disabled = !enabled;
    ui.startButton.textContent = enabled ? "Comenzar" : "Cargando silueta...";
  }

  function loadBodyAssets() {
    // Version-stamp the asset URLs so browsers re-fetch after deployments.
    const v = APP_VERSION;
    return Promise.all([
      loadImage(`./assets/body-template.png?v=${v}`),
      loadImage(`./assets/body-mask.png?v=${v}`),
      loadImage(`./assets/body-outline.png?v=${v}`)
    ]).then(([template, mask, outline]) => {
      bodyTemplateImage = template;
      bodyMaskImage = mask;
      bodyOutlineImage = outline;
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function buildMasks() {
    maskCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    maskCtx.drawImage(bodyMaskImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const storeCtx = storeMaskCanvas.getContext("2d", { willReadFrequently: true });
    storeCtx.clearRect(0, 0, STORE_WIDTH, STORE_HEIGHT);
    storeCtx.drawImage(bodyMaskImage, 0, 0, STORE_WIDTH, STORE_HEIGHT);
  }

  async function startExperiment() {
    ui.startButton.disabled = true;
    const name = ui.participantInput.value.trim() || "Anónimo";
    state.participantId = name;
    // Hash the name so it's never stored in plain text in Supabase.
    state.participantIdHash = await hashParticipantId(name, state.classId);
    state.sessionId = createSessionId();
    state.tasks = buildTaskList();
    state.taskIndex = 0;
    state.responses = [];
    state.saved = false;
    state.saveInFlight = false;
    hideRetryButton();
    showScreen("task");
    renderTask();
  }

  // Returns a 12-hex-char opaque identifier derived from name + class.
  // Deterministic within a class so admin can still track the same student across
  // sessions, but opaque to anyone without the name list.
  async function hashParticipantId(name, classId) {
    const input = `${name}|${classId}`;
    if (window.crypto && window.crypto.subtle) {
      try {
        const buffer = await window.crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(input)
        );
        const bytes = new Uint8Array(buffer);
        return "p_" + Array.from(bytes.slice(0, 6))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      } catch (_) {
        // fall through to sync fallback
      }
    }
    let h = 5381;
    for (let i = 0; i < input.length; i += 1) {
      h = ((h << 5) + h) ^ input.charCodeAt(i);
    }
    return "p_" + (h >>> 0).toString(16).padStart(8, "0");
  }

  function buildTaskList() {
    return shuffle(EMOTIONS.slice()).map((emotion) => ({
      emotion: emotion.id,
      emotionLabel: emotion.label
    }));
  }

  function renderTask() {
    const task = getCurrentTask();
    if (!task) {
      finishExperiment();
      return;
    }

    ui.taskCounter.textContent = `${state.taskIndex + 1} / ${state.tasks.length}`;
    ui.progressFill.style.width = `${(state.taskIndex / state.tasks.length) * 100}%`;
    ui.taskTitle.textContent = task.emotionLabel;
    ui.taskPhaseChip.textContent = "Dos siluetas";
    ui.taskPhaseChip.classList.remove("deactivation");
    ui.taskInstruction.textContent = `Usá las figuras de abajo para indicar las sensaciones corporales que experimentás cuando sentís ${task.emotionLabel.toLowerCase()}.`;
    hideTaskError();
    setTool("paint");
    clearPaint(false);
    state.activeMapType = "activation";
    state.undoStack = [];
    updateMobileBodyMode();
    refreshPaintStatus();
  }

  function getCurrentTask() {
    return state.tasks[state.taskIndex] || null;
  }

  function setTool(tool) {
    state.tool = tool;
    ui.toolPaint.classList.toggle("active", tool === "paint");
    ui.toolErase.classList.toggle("active", tool === "erase");
  }

  function setActiveMapType(mapType) {
    if (!MAP_TYPES[mapType]) {
      return;
    }
    state.activeMapType = mapType;
    updateMobileBodyMode();
    refreshPaintStatus();
  }

  function isSingleBodyMobile() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  function updateMobileBodyMode() {
    const singleBody = isSingleBodyMobile();
    ui.bodyMaps.forEach((map) => {
      const isActive = map.dataset.mapType === state.activeMapType;
      map.classList.toggle("mobile-active", isActive);
    });
    ui.mobileMapTabs.forEach((button) => {
      const isActive = button.dataset.mapType === state.activeMapType;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
    if (ui.taskPhaseChip) {
      ui.taskPhaseChip.textContent = singleBody
        ? (state.activeMapType === "activation" ? "Silueta 1 / 2" : "Silueta 2 / 2")
        : "Dos siluetas";
    }
  }

  function onPointerDown(event) {
    if (!getCurrentTask() || state.isDrawing) {
      return;
    }
    event.preventDefault();
    const mapType = event.currentTarget.dataset.mapType || "activation";
    state.activeMapType = mapType;
    lastPointerId = event.pointerId;
    lastPointerCanvas = event.currentTarget;
    if (typeof lastPointerCanvas.setPointerCapture === "function") {
      try {
        lastPointerCanvas.setPointerCapture(lastPointerId);
      } catch (_) {
        lastPointerId = null;
      }
    }
    startStroke(mapType, getCanvasPoint(event, mapType));
  }

  function onPointerMove(event) {
    if (!state.isDrawing) {
      return;
    }
    event.preventDefault();
    continueStroke(getCanvasPoint(event, state.activeMapType));
  }

  function onPointerUp() {
    if (!state.isDrawing) {
      return;
    }
    if (
      lastPointerId !== null &&
      lastPointerCanvas &&
      typeof lastPointerCanvas.hasPointerCapture === "function" &&
      lastPointerCanvas.hasPointerCapture(lastPointerId)
    ) {
      try {
        lastPointerCanvas.releasePointerCapture(lastPointerId);
      } catch (_) {
        // Nothing to release.
      }
    }
    endStroke();
  }

  function startStroke(mapType, point) {
    state.isDrawing = true;
    state.activeMapType = mapType;
    state.lastPoint = point;
    pushUndoSnapshot(mapType);
    drawStrokeSegment(point, point);
  }

  function continueStroke(point) {
    drawStrokeSegment(state.lastPoint, point);
    state.lastPoint = point;
  }

  function endStroke() {
    state.isDrawing = false;
    state.lastPoint = null;
    lastPointerId = null;
    lastPointerCanvas = null;
  }

  function drawStrokeSegment(from, to) {
    const surface = getSurface(state.activeMapType);
    if (!surface) {
      return;
    }
    const ctx = surface.paintCtx;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = state.brushSize;
    if (state.tool === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0, 0, 0, 1)";
      ctx.fillStyle = "rgba(0, 0, 0, 1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = MAP_TYPES[state.activeMapType].paintColor;
      ctx.fillStyle = MAP_TYPES[state.activeMapType].paintColor;
    }

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.hypot(dx, dy) < 0.5) {
      ctx.beginPath();
      ctx.arc(to.x, to.y, state.brushSize / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    ctx.restore();

    applyBodyMask(state.activeMapType);
    hideTaskError();
    refreshPaintStatus();
  }

  function applyBodyMask(mapType) {
    const surface = getSurface(mapType);
    if (!surface) {
      return;
    }
    surface.paintCtx.save();
    surface.paintCtx.globalCompositeOperation = "destination-in";
    surface.paintCtx.drawImage(maskCanvas, 0, 0);
    surface.paintCtx.restore();
  }

  // Stores the 120×207 bitset (~3 KB) instead of a full 360×620 RGBA ImageData (~900 KB),
  // keeping the undo stack lean on mobile.
  function pushUndoSnapshot(mapType = state.activeMapType) {
    state.undoStack.push({
      bits: encodePaintBitsRaw(mapType),
      mapType
    });
    if (state.undoStack.length > MAX_HISTORY) {
      state.undoStack.shift();
    }
  }

  function pushClearSnapshot() {
    state.undoStack.push({
      kind: "all",
      snapshots: MAP_TYPE_ORDER.map((mapType) => ({
        bits: encodePaintBitsRaw(mapType),
        mapType
      }))
    });
    if (state.undoStack.length > MAX_HISTORY) {
      state.undoStack.shift();
    }
  }

  function undoPaint() {
    if (!state.undoStack.length) {
      return;
    }
    const entry = state.undoStack.pop();
    if (entry.kind === "all") {
      entry.snapshots.forEach((snapshot) => restoreFromBits(snapshot.bits, snapshot.mapType));
    } else {
      restoreFromBits(entry.bits, entry.mapType);
      state.activeMapType = entry.mapType;
    }
    updateMobileBodyMode();
    refreshPaintStatus();
  }

  // Re-renders the canvas from a stored 120×207 bitset.
  function restoreFromBits(bits, mapType) {
    const surface = getSurface(mapType);
    if (!surface) {
      return;
    }
    const ctx = surface.paintCtx;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const cellW = CANVAS_WIDTH / STORE_WIDTH;
    const cellH = CANVAS_HEIGHT / STORE_HEIGHT;
    ctx.fillStyle = MAP_TYPES[mapType].paintColor;
    for (let i = 0; i < STORE_WIDTH * STORE_HEIGHT; i += 1) {
      if (getBit(bits, i)) {
        const sx = i % STORE_WIDTH;
        const sy = Math.floor(i / STORE_WIDTH);
        ctx.fillRect(
          Math.floor(sx * cellW),
          Math.floor(sy * cellH),
          Math.ceil(cellW + 0.5),
          Math.ceil(cellH + 0.5)
        );
      }
    }
    applyBodyMask(mapType);
  }

  function clearPaint(withHistory) {
    if (withHistory) {
      pushClearSnapshot();
    }
    MAP_TYPE_ORDER.forEach((mapType) => {
      const surface = getSurface(mapType);
      if (surface) {
        surface.paintCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    });
    refreshPaintStatus();
  }

  function saveCurrentTask() {
    const task = getCurrentTask();
    if (!task) {
      return;
    }

    if (isSingleBodyMobile() && state.activeMapType === "activation") {
      setActiveMapType("deactivation");
      return;
    }

    hideTaskError();
    const statsByType = Object.fromEntries(
      MAP_TYPE_ORDER.map((mapType) => [mapType, computePaintStats(mapType)])
    );
    const totalPainted = MAP_TYPE_ORDER.reduce(
      (total, mapType) => total + statsByType[mapType].paintedPixels,
      0
    );
    if (totalPainted < MIN_PAINTED_PIXELS) {
      showTaskError("Todavía no hay ninguna marca dentro de las siluetas. Pintá una zona del cuerpo para poder guardar.");
      refreshPaintStatus();
      return;
    }

    const responses = MAP_TYPE_ORDER.map((mapType) => {
      const paintedPixels = statsByType[mapType].paintedPixels;
      const noChange = paintedPixels < MIN_PAINTED_PIXELS;
      return {
        emotion: task.emotion,
        emotionLabel: task.emotionLabel,
        mapType,
        noChange,
        paintedPixels,
        maskBitsB64: noChange ? emptyBitsBase64() : encodePaintBits(mapType)
      };
    });

    state.responses.push(...responses);
    state.taskIndex += 1;
    ui.progressFill.style.width = `${(state.taskIndex / state.tasks.length) * 100}%`;

    if (state.taskIndex >= state.tasks.length) {
      finishExperiment();
    } else {
      renderTask();
    }
  }

  function finishExperiment() {
    showScreen("results");
    saveResponsesAndRender();
  }

  async function saveResponsesAndRender() {
    hideRetryButton();
    if (!SUPABASE_ENABLED) {
      setSaveStatus("Supabase no está configurado. Mostrando solo los mapas locales.", "err");
      renderHeatmaps(state.responses.map(localResponseToRow));
      return;
    }

    if (!state.saved) {
      if (ui.retrySaveButton) {
        ui.retrySaveButton.disabled = true;
      }
      try {
        state.saveInFlight = true;
        setSaveStatus("", "");
        await saveRows(buildSupabaseRows());
        state.saved = true;
        setSaveStatus("", "");
      } catch (error) {
        state.saveInFlight = false;
        console.warn("Supabase insert error:", error);
        setSaveStatus("No se pudo guardar en Supabase. Revisá la conexión y reintentá.", "err");
        if (ui.retrySaveButton) {
          ui.retrySaveButton.disabled = false;
        }
        showRetryButton();
        renderHeatmaps(state.responses.map(localResponseToRow));
        return;
      }
      state.saveInFlight = false;
      if (ui.retrySaveButton) {
        ui.retrySaveButton.disabled = false;
      }
    }

    await loadAndRenderHeatmaps();
  }

  async function saveRows(rows) {
    const res = await fetch(SB_REST, {
      method: "POST",
      headers: { ...SB_HEADERS, "Prefer": "return=minimal" },
      body: JSON.stringify(rows)
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
  }

  function buildSupabaseRows() {
    return state.responses.map((response) => ({
      participant_id: state.participantIdHash,
      session_id: state.sessionId,
      class_id: state.classId,
      emotion: response.emotion,
      map_type: response.mapType,
      mask_bits_b64: response.maskBitsB64,
      store_width: STORE_WIDTH,
      store_height: STORE_HEIGHT,
      painted_pixels: response.paintedPixels,
      no_change: response.noChange,
      body_mask_version: BODY_MASK_VERSION
    }));
  }

  function localResponseToRow(response) {
    return {
      participant_id: state.participantIdHash,
      session_id: state.sessionId,
      class_id: state.classId,
      emotion: response.emotion,
      map_type: response.mapType,
      mask_bits_b64: response.maskBitsB64,
      store_width: STORE_WIDTH,
      store_height: STORE_HEIGHT,
      painted_pixels: response.paintedPixels,
      no_change: response.noChange,
      body_mask_version: BODY_MASK_VERSION
    };
  }

  async function loadAndRenderHeatmaps() {
    if (state.saveInFlight) {
      return;
    }
    if (!SUPABASE_ENABLED) {
      renderHeatmaps(state.responses.map(localResponseToRow));
      return;
    }

    try {
      setSaveStatus("", "");
      const rows = await loadRows();
      setSaveStatus("", "");
      renderHeatmaps(rows);
    } catch (error) {
      console.warn("Supabase select error:", error);
      setSaveStatus("No se pudieron cargar los mapas colectivos. Mostrando solo esta sesión.", "err");
      renderHeatmaps(state.responses.map(localResponseToRow));
    }
  }

  async function loadRows() {
    const params = [
      "select=session_id,emotion,map_type,mask_bits_b64,store_width,store_height,no_change,body_mask_version",
      `class_id=eq.${encodeURIComponent(state.classId)}`,
      `body_mask_version=eq.${encodeURIComponent(BODY_MASK_VERSION)}`,
      "limit=500"
    ].join("&");
    const res = await fetch(`${SB_REST}?${params}`, { headers: SB_HEADERS });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  function renderHeatmaps(rows) {
    ui.heatmapGrid.innerHTML = "";
    updateParticipantCount(rows);
    EMOTIONS.forEach((emotion) => {
      const filtered = rows.filter((row) =>
        row.emotion === emotion.id &&
        row.store_width === STORE_WIDTH &&
        row.store_height === STORE_HEIGHT
      );
      const card = document.createElement("div");
      card.className = "heatmap-card";
      card.innerHTML = `
        <div class="heatmap-title">${escapeHtml(emotion.label)}</div>
        <canvas width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" aria-label="Mapa colectivo de ${escapeHtml(emotion.label)}"></canvas>
      `;
      ui.heatmapGrid.appendChild(card);
      drawCollectiveHeatmap(card.querySelector("canvas"), filtered);
    });
  }

  function updateParticipantCount(rows) {
    if (!ui.participantCount) {
      return;
    }
    ui.participantCount.textContent = String(countParticipants(rows));
  }

  function countParticipants(rows) {
    const sessionIds = new Set(
      rows.map((row) => row.session_id || "").filter(Boolean)
    );
    return sessionIds.size || (rows.length ? 1 : 0);
  }

  function drawCollectiveHeatmap(canvas, rows) {
    const ctx = canvas.getContext("2d");
    drawBaseBody(ctx);
    if (!rows.length) {
      return;
    }

    const activation = new Uint16Array(STORE_WIDTH * STORE_HEIGHT);
    const deactivation = new Uint16Array(STORE_WIDTH * STORE_HEIGHT);
    rows.forEach((row) => {
      if (row.map_type !== "activation" && row.map_type !== "deactivation") {
        return;
      }
      const target = row.map_type === "activation" ? activation : deactivation;
      const bits = decodeBits(row.mask_bits_b64);
      for (let i = 0; i < target.length; i += 1) {
        if (getBit(bits, i)) {
          target[i] += 1;
        }
      }
    });

    const participantCount = Math.max(1, countParticipants(rows));
    const heatCanvas = document.createElement("canvas");
    heatCanvas.width = CANVAS_WIDTH;
    heatCanvas.height = CANVAS_HEIGHT;
    const heatCtx = heatCanvas.getContext("2d");
    const cellW = CANVAS_WIDTH / STORE_WIDTH;
    const cellH = CANVAS_HEIGHT / STORE_HEIGHT;

    for (let y = 0; y < STORE_HEIGHT; y += 1) {
      for (let x = 0; x < STORE_WIDTH; x += 1) {
        const index = y * STORE_WIDTH + x;
        const value = (activation[index] - deactivation[index]) / participantCount;
        if (value === 0) {
          continue;
        }
        heatCtx.fillStyle = heatColor(value);
        heatCtx.fillRect(x * cellW, y * cellH, Math.ceil(cellW) + 0.4, Math.ceil(cellH) + 0.4);
      }
    }

    heatCtx.save();
    heatCtx.globalCompositeOperation = "destination-in";
    heatCtx.drawImage(maskCanvas, 0, 0);
    heatCtx.restore();

    ctx.drawImage(heatCanvas, 0, 0);
    ctx.drawImage(bodyOutlineImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  function heatColor(value) {
    const t = Math.max(0, Math.min(1, Math.abs(value)));
    const alpha = 0.18 + t * 0.78;
    const color = value >= 0
      ? interpolateColor({ r: 255, g: 229, b: 120 }, { r: 185, g: 28, b: 28 }, t)
      : interpolateColor({ r: 191, g: 219, b: 254 }, { r: 37, g: 99, b: 235 }, t);
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(3)})`;
  }

  function interpolateColor(from, to, amount) {
    return {
      r: Math.round(from.r + (to.r - from.r) * amount),
      g: Math.round(from.g + (to.g - from.g) * amount),
      b: Math.round(from.b + (to.b - from.b) * amount)
    };
  }

  function drawBaseBody(ctx) {
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
    gradient.addColorStop(0, "#fbfaf3");
    gradient.addColorStop(1, "#ecece4");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.drawImage(bodyTemplateImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  function drawAllBaseBodies() {
    MAP_TYPE_ORDER.forEach((mapType) => {
      const surface = getSurface(mapType);
      if (surface) {
        drawBaseBody(surface.baseCtx);
      }
    });
  }

  function getSurface(mapType) {
    return paintSurfaces[mapType] || null;
  }

  function computePaintStats(mapType) {
    const surface = getSurface(mapType);
    if (!surface) {
      return { paintedPixels: 0 };
    }
    const data = surface.paintCtx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
    let paintedPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) {
        paintedPixels += 1;
      }
    }
    return { paintedPixels };
  }

  function refreshPaintStatus() {
    if (!ui.nextButton || !ui.paintStatus) {
      return;
    }
    const totalPainted = MAP_TYPE_ORDER.reduce(
      (total, mapType) => total + computePaintStats(mapType).paintedPixels,
      0
    );
    if (isSingleBodyMobile() && state.activeMapType === "activation") {
      const activePixels = computePaintStats("activation").paintedPixels;
      ui.nextButton.disabled = false;
      ui.nextButton.textContent = "Seguir con más débil";
      ui.paintStatus.textContent = activePixels >= MIN_PAINTED_PIXELS
        ? `Marca detectada (${activePixels} píxeles).`
        : "Pintá este cuerpo o continuá con la segunda silueta.";
      ui.paintStatus.classList.toggle("ready", activePixels >= MIN_PAINTED_PIXELS);
      return;
    }
    const hasPaint = totalPainted >= MIN_PAINTED_PIXELS;
    ui.nextButton.disabled = !hasPaint;
    ui.nextButton.textContent = hasPaint ? "Guardar y continuar" : "Pintá al menos una zona";
    ui.paintStatus.textContent = hasPaint
      ? `Marca detectada (${totalPainted} píxeles).`
      : "Pintá al menos una zona en alguna de las dos siluetas.";
    ui.paintStatus.classList.toggle("ready", hasPaint);
  }

  // Returns the 120×207 bitset as a Uint8Array (used internally for undo stack).
  function encodePaintBitsRaw(mapType = state.activeMapType) {
    const surface = getSurface(mapType);
    if (!surface) {
      return new Uint8Array(Math.ceil((STORE_WIDTH * STORE_HEIGHT) / 8));
    }
    const source = surface.paintCtx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
    const bytes = new Uint8Array(Math.ceil((STORE_WIDTH * STORE_HEIGHT) / 8));
    for (let sy = 0; sy < STORE_HEIGHT; sy += 1) {
      const y0 = Math.floor((sy * CANVAS_HEIGHT) / STORE_HEIGHT);
      const y1 = Math.max(y0 + 1, Math.floor(((sy + 1) * CANVAS_HEIGHT) / STORE_HEIGHT));
      for (let sx = 0; sx < STORE_WIDTH; sx += 1) {
        const x0 = Math.floor((sx * CANVAS_WIDTH) / STORE_WIDTH);
        const x1 = Math.max(x0 + 1, Math.floor(((sx + 1) * CANVAS_WIDTH) / STORE_WIDTH));
        let painted = false;
        for (let y = y0; y < y1 && !painted; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const idx = (y * CANVAS_WIDTH + x) * 4 + 3;
            if (source[idx] > 0) {
              painted = true;
              break;
            }
          }
        }
        if (painted) {
          setBit(bytes, sy * STORE_WIDTH + sx);
        }
      }
    }
    return bytes;
  }

  function encodePaintBits(mapType = state.activeMapType) {
    return bytesToBase64(encodePaintBitsRaw(mapType));
  }

  function emptyBitsBase64() {
    return bytesToBase64(new Uint8Array(Math.ceil((STORE_WIDTH * STORE_HEIGHT) / 8)));
  }

  function setBit(bytes, index) {
    bytes[index >> 3] |= 1 << (index & 7);
  }

  function getBit(bytes, index) {
    return (bytes[index >> 3] & (1 << (index & 7))) !== 0;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  function decodeBits(base64) {
    if (bitsCache.has(base64)) {
      return bitsCache.get(base64);
    }
    const binary = atob(base64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    bitsCache.set(base64, bytes);
    return bytes;
  }

  function getCanvasPoint(event, mapType) {
    return getCanvasPointFromClient(event.clientX, event.clientY, mapType);
  }

  function getCanvasPointFromClient(clientX, clientY, mapType) {
    const surface = getSurface(mapType);
    const rect = surface.paintCanvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) * CANVAS_WIDTH) / rect.width,
      y: ((clientY - rect.top) * CANVAS_HEIGHT) / rect.height
    };
  }

  function setSaveStatus(message, type) {
    if (!ui.saveStatus) {
      return;
    }
    ui.saveStatus.textContent = message;
    ui.saveStatus.className = `save-status${type ? ` ${type}` : ""}${message ? "" : " hidden"}`;
  }

  function showRetryButton() {
    if (ui.retrySaveButton) {
      ui.retrySaveButton.classList.remove("hidden");
    }
  }

  function hideRetryButton() {
    if (ui.retrySaveButton) {
      ui.retrySaveButton.classList.add("hidden");
    }
  }

  function showTaskError(message) {
    ui.taskError.textContent = message;
    ui.taskError.classList.remove("hidden");
  }

  function hideTaskError() {
    ui.taskError.classList.add("hidden");
  }

  function showScreen(name) {
    ui.screenStart.classList.toggle("active", name === "start");
    ui.screenTask.classList.toggle("active", name === "task");
    ui.screenResults.classList.toggle("active", name === "results");
    ui.screenLearning.classList.toggle("active", name === "learning");
    window.scrollTo(0, 0);
  }

  function resetToStart() {
    state.tasks = [];
    state.taskIndex = 0;
    state.responses = [];
    state.saved = false;
    state.saveInFlight = false;
    clearPaint(false);
    hideTaskError();
    hideRetryButton();
    showScreen("start");
  }

  function createSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function shuffle(items) {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[char]));
  }
})();
