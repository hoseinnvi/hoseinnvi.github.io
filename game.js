/* =========================================================================
   improved_game.js — Top-down adventure engine with advanced sprite handling
   -------------------------------------------------------------------------

   This version of the engine builds upon the basic example found in
   ``game.js`` and adds several features to make the most of a multi-frame
   character sprite sheet.  The improvements include:

   • Robust sprite loading: the player's sprite source is configurable and
     defaults to ``F_01.png`` (four columns by three rows).  The boot
     sequence waits for the image to load but will time out after a few
     seconds rather than hang forever if the image is missing.  If your
     sprite uses a different filename (e.g. ``F-01.png``), update
     ``PLAYER_SPRITE_SRC`` accordingly.

   • Full animation support: the player cycles through three frames (in
     each direction) when walking.  The idle frame is the middle frame
     of the vertical sequence for the current direction.  A "run" mode
     can be toggled by holding the
     ``Shift`` key; running speeds up the character and the animation.

   • Improved facing logic: diagonal movement chooses the dominant axis
     (horizontal or vertical) to determine the facing.  This ensures the
     sprite sheet is used correctly when moving in two directions.

   • Better error handling: loading maps or assets will report errors into
     the ``#loading`` element instead of silently failing.  This prevents
     the "Stuck at Loading…" problem when assets fail to load.

   • Text object rendering: like the previous version, this script draws
     Tiled text objects with respect to font, size, alignment and colour.

   To use this file, include it in your HTML page after the canvas element.
   Ensure that your ``maps`` and ``assets`` folders are accessible over
   HTTP so that ``fetch()`` can retrieve the map JSON and images.
   ========================================================================*/

// STEP 0 — Canvas and basic configuration
const canvas = document.getElementById("game");
const ctx    = canvas.getContext("2d");

// Tiled flip flags.  These are not used in this example but are defined
// here for completeness.
const FLIP_H  = 0x80000000;
const FLIP_V  = 0x40000000;
const FLIP_D  = 0x20000000;
const GID_MASK = ~(FLIP_H | FLIP_V | FLIP_D) >>> 0;

// Character sprite configuration.  Adjust ``FRAME_W`` and ``FRAME_H`` to
// match the width/height of a single cell in your sprite sheet.  The
// default of 16×16 corresponds to a 4×3 sprite sheet like F_01.png
// (four columns for four directions, three rows for animation frames).
const FRAME_W = 16;
const FRAME_H = 16;
// Number of columns (directions) and rows (frames) in the sprite sheet.
// These are initial defaults; they will be updated dynamically once the
// player's sprite image has loaded.  See ``setSpriteDimensions()``.
let SPRITE_COLUMNS = 4;
let SPRITE_ROWS    = 3;

// Scaling the player up for easier visibility.  Set to 1 for no scaling
// or 2/3 to make the character larger relative to the map.
const CHARACTER_SCALE = 3;
const PLAYER_W = FRAME_W * CHARACTER_SCALE;
const PLAYER_H = FRAME_H * CHARACTER_SCALE;

// Movement speeds (pixels per second).
const WALK_SPEED     = 100;
const RUN_MULTIPLIER = 1.7;
const WALK_ANIM_FPS  = 8;
const RUN_ANIM_FPS   = 12;

// Player state
const player = {
  x: 0, y: 0, w: PLAYER_W, h: PLAYER_H,
  vx: 0, vy: 0,
  spawnId: null,
  facing: "down", // "up", "down", "left", "right"
  sprite: new Image(),
  spriteSrc: "./assets/characters/F_01.png",
};

/*
 * Determine the number of columns and rows in the player's sprite sheet
 * based on the natural dimensions of the loaded image.
 */
function setSpriteDimensions() {
  if (player.sprite && player.sprite.naturalWidth && player.sprite.naturalHeight) {
    SPRITE_COLUMNS = Math.max(1, Math.floor(player.sprite.naturalWidth / FRAME_W));
    SPRITE_ROWS    = Math.max(1, Math.floor(player.sprite.naturalHeight / FRAME_H));
  }
}

// Current map and tileset images
let currentMap = null;
let tilesetImages = [];

// Collision rectangles, portals, and spawns
let solidRects = [];
let portals    = [];
let spawns     = Object.create(null);
// Hotspot objects for interactive elements that open the book UI.
let hotspots = [];

// --------------------------------------------------------------------
// Book UI configuration and state
// Uses a non-square, variable-width frame strip (e.g., 2048×92).
const USE_SINGLE_BOOK_IMAGE = true;
const SINGLE_BOOK_IMAGE_SRC = "./UI/book_open.png";

// Book state object
const book = {
  img: new Image(),
  // legacy fields kept for convenience; frameW will mirror current frame sw
  frameW: 0,
  frameH: 0,
  frameCount: 1,
  idleOpenFrame: 0,
  fps: 12,
  x: 0,
  y: 0,
  state: "closed",        // "closed" | "opening" | "open" | "flipping" | "closing"
  frame: 0,
  acc: 0,
  pageIndex: 0,
  lastPageIndex: 0,
  nextPageIndex: 0,
  currentKey: null,
  flipProgress: 0,
  pagesById: {
    cs:   ["Computer Vision", "Stereo and TSDF fusion", "3D surface reconstruction", "Ultrasound + vision"],
    cv:   ["Computer Vision", "Stereo and TSDF fusion", "3D surface reconstruction", "Ultrasound + vision"],
    nlp:  ["NLP & LLMs", "Retrieval Augmented Generation (RAG)", "Agents and tools", "Evaluation & safety", "Production pipelines"],
    agent:["Agentic AI", "Multi-tool flows", "MCP/Functions", "Reliability patterns"],
    rl:   ["Reinforcement Learning", "Policy/value methods", "Environment design", "Evaluation loops"],
    me:   ["About Me", "This page is intentionally left blank."],
  },
  _pagesCached: null,
  // NEW: per-frame rectangles for variable-width slicing
  frames: [] // each item: { sx, sw }
};

/* ---------------- Variable-width frame handling for book ------------------ */

/**
 * Find columns that look like separators between frames:
 *  - mostly transparent (alpha ~ 0), OR
 *  - very dark across the whole column (common in sprite gutters)
 */
function detectSeparatorColumns(imgData, W, H) {
  const data = imgData.data;
  const isSep = new Array(W).fill(false);

  const alphaThresh = 8;      // “transparent”
  const darkLumThresh = 26;   // very dark luminance threshold (0..255)
  const minTransparentRatio = 0.8; // >=80% transparent counts as a separator
  const minDarkRatio = 0.85;       // >=85% dark pixels counts as a separator

  for (let x = 0; x < W; x++) {
    let trans = 0, dark = 0;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (a < alphaThresh) trans++;
      // simple luminance
      const lum = (r * 299 + g * 587 + b * 114) / 1000;
      if (lum < darkLumThresh) dark++;
    }
    const tr = trans / H;
    const dr = dark / H;
    if (tr >= minTransparentRatio || dr >= minDarkRatio) {
      isSep[x] = true;
    }
  }
  // Always mark image edges as separators
  isSep[0] = true;
  isSep[W - 1] = true;
  return isSep;
}

/**
 * Group contiguous separator columns into boundary indices.
 * Returns a sorted array of x positions that act as “cuts” between frames.
 */
function makeBoundariesFromSeparators(isSep) {
  const W = isSep.length;
  const bounds = [];
  let inRun = false;
  let runStart = 0;

  for (let x = 0; x < W; x++) {
    if (isSep[x] && !inRun) { inRun = true; runStart = x; }
    if ((!isSep[x] || x === W - 1) && inRun) {
      const runEnd = isSep[x] ? x : x - 1;
      const mid = Math.floor((runStart + runEnd) / 2);
      bounds.push(mid);
      inRun = false;
    }
  }

  // Ensure 0 and W are present as absolute boundaries
  if (bounds[0] !== 0) bounds.unshift(0);
  if (bounds[bounds.length - 1] !== W - 1) bounds.push(W - 1);
  return bounds;
}

/**
 * Build frame rectangles using detected boundaries.
 * Falls back to equal-chunking if we detect too few frames.
 */
function buildBookFramesFromImage(countFallback = 21) {
  const img = book.img;
  if (!img || !img.naturalWidth || !img.naturalHeight) return;

  const W = img.naturalWidth;
  const H = img.naturalHeight;
  book.frameH = H;

  // Draw to an offscreen canvas and analyze pixels
  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  const octx = off.getContext("2d");
  octx.drawImage(img, 0, 0);
  const imgData = octx.getImageData(0, 0, W, H);

  const separators = detectSeparatorColumns(imgData, W, H);
  const bounds = makeBoundariesFromSeparators(separators);

  // Convert boundaries to frames (segments between consecutive cuts)
  const frames = [];
  const minFrameW = Math.max(40, Math.floor(H * 0.5)); // ignore tiny slivers
  for (let i = 0; i < bounds.length - 1; i++) {
    const left = bounds[i];
    const right = bounds[i + 1];
    // shrink by 1px to keep inside image and avoid double-counting shared cols
    const sx = left === 0 ? 0 : left + 1;
    const ex = right; // inclusive
    const sw = Math.max(0, ex - sx + 1);
    if (sw >= minFrameW) frames.push({ sx, sw });
  }

  // If detection failed (too few frames), fallback to equal-ish chunks
  if (frames.length < Math.floor(countFallback * 0.6)) {
    const base = Math.floor(W / countFallback);
    const extra = W - base * countFallback;
    const widths = Array.from({ length: countFallback }, (_, i) => base + (i < extra ? 1 : 0));
    let cursor = 0;
    for (let i = 0; i < widths.length; i++) {
      frames.push({ sx: cursor, sw: widths[i] });
      cursor += widths[i];
    }
  }

  // Commit
  book.frames = frames;
  book.frameCount = frames.length;
  book.idleOpenFrame = Math.max(0, book.frameCount - 1);

  // Center using the actual fully-open frame width
  const openW = frames[book.idleOpenFrame].sw;
  book.frameW = openW;
  if (canvas && canvas.width && canvas.height) {
    book.x = Math.round((canvas.width  - openW) / 2);
    book.y = Math.round((canvas.height - H) / 2);
  }
}

/**
 * Entry point called on image load.
 */
function adjustBookFrameSize() {
  if (!book.img || !book.img.naturalWidth) return;
  buildBookFramesFromImage(21);
}

/**
 * Convenience: current frame rect.
 */
function getCurrentBookFrame() {
  if (!book.frames.length) return { sx: 0, sw: book.frameW || 0, sh: book.frameH || 0 };
  const fi = Math.max(0, Math.min(book.frame, book.frames.length - 1));
  const fr = book.frames[fi];
  return { sx: fr.sx, sw: fr.sw, sh: book.frameH };
}

book.img.onload = adjustBookFrameSize;
book.img.src = SINGLE_BOOK_IMAGE_SRC;
if (book.img.complete) {
  adjustBookFrameSize();
}

// Keyboard state
const keys = Object.create(null);

// Timing variables for the main loop
let lastTime = 0;
let wantUse  = false;
let animTime = 0;

// Helper functions to resolve paths relative to the map JSON
function dirname(path) {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx + 1) : "";
}
function join(base, rel) {
  if (/^(https?:)?\//.test(rel)) return rel;
  if (rel.startsWith("maps/")) return rel;
  return base + rel;
}

// Keyboard listeners
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (k === "e") wantUse = true;
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = false;
});

// Additional input handlers for the book UI.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && book.state !== "closed") {
    book.state = "closing";
    book.acc = 0;
    e.preventDefault();
  }
});
canvas.addEventListener("mousedown", (e) => {
  if (book.state !== "open") return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const { sw } = getCurrentBookFrame();
  const fw = sw, fh = book.frameH;
  // Use current frame bounds
  if (mx < book.x || mx > book.x + fw || my < book.y || my > book.y + fh) return;

  const total = book._pagesCached ? book._pagesCached.length : 0;
  if (!total) return;

  let newIndex;
  if (mx < book.x + fw / 2) newIndex = (book.pageIndex - 1 + total) % total;
  else                      newIndex = (book.pageIndex + 1) % total;

  book.lastPageIndex = book.pageIndex;
  book.nextPageIndex = newIndex;
  book.flipProgress = 0;
  book.state = "flipping";
});

/* STEP 1 — Map loading */
function toPropMap(props) {
  const out = Object.create(null);
  if (!props) return out;
  for (const p of props) out[p.name] = p.value;
  return out;
}
function resizeCanvasToMap(map) {
  canvas.width  = map.width  * map.tilewidth;
  canvas.height = map.height * map.tileheight;
}

// Load a Tiled map and all of its tileset images.
async function loadMap(jsonPath) {
  let res;
  try {
    res = await fetch(jsonPath);
  } catch (err) {
    throw new Error(`Unable to fetch map: ${jsonPath} (${err.message})`);
  }
  if (!res.ok) throw new Error(`Failed to load map: ${jsonPath}`);
  const map = await res.json();

  currentMap = map;
  currentMap._jsonPath = jsonPath;
  const base = dirname(jsonPath);

  tilesetImages = [];
  solidRects    = [];
  portals       = [];
  spawns        = {};
  hotspots      = [];

  resizeCanvasToMap(map);

  // Recalculate book position if we already know sizes.
  if (book.frames.length) {
    const openW = book.frames[book.idleOpenFrame].sw;
    book.x = Math.round((canvas.width  - openW) / 2);
    book.y = Math.round((canvas.height - book.frameH) / 2);
  }

  // Load tilesets
  for (const ts of map.tilesets) {
    const img = new Image();
    img.src = join(base, ts.image);
    try {
      await img.decode();
    } catch (err) {
      console.warn(`Failed to decode tileset image ${ts.image}:`, err);
    }
    const columns = Math.floor(ts.imagewidth / map.tilewidth);
    tilesetImages.push({
      firstgid: ts.firstgid,
      columns,
      image: ts.image,
      width: ts.imagewidth,
      height: ts.imageheight,
      img,
    });
  }

  // Preload images for Image Layers
  for (const layer of map.layers) {
    if (layer.type === "imagelayer" && layer.image) {
      try {
        const img = new Image();
        img.src = join(base, layer.image);
        await img.decode();
        layer._img = img;
      } catch (e) {
        console.warn("Failed to load image layer:", layer.name, layer.image, e);
      }
    }
  }

  // Extract objects from object layers
  for (const layer of map.layers) {
    if (layer.type !== "objectgroup") continue;
    if (layer.name === "Collision") {
      for (const o of layer.objects) {
        solidRects.push({ x: o.x, y: o.y, w: o.width, h: o.height });
      }
    }
    if (layer.name === "Portals") {
      for (const o of layer.objects) {
        const P = toPropMap(o.properties);
        portals.push({
          x: o.x, y: o.y, w: o.width, h: o.height,
          auto: !!P.auto,
          prompt: P.prompt || "E: Use",
          targetMap: P.targetMap || P.map || "",
          targetSpawn: P.targetSpawn || P.spawn || "",
        });
      }
    }
    if (layer.name === "Spawns") {
      for (const o of layer.objects) {
        const P = toPropMap(o.properties);
        const spawnKey = P.id || o.name || String(o.id);
        spawns[spawnKey] = {
          x: o.x,
          y: o.y,
          facing: P.facing || "down",
        };
      }
    }
    if (layer.name === "Hotspots") {
      for (const o of layer.objects) {
        const P = toPropMap(o.properties);
        const id = (P.id || o.name || String(o.id) || "").toLowerCase();
        hotspots.push({
          id,
          x: o.x,
          y: o.y,
          r: P.radius || 12,
          title: P.title || "",
          active: P.active !== false
        });
      }
    }
  }

  // Position player at spawn
  if (player.spawnId && spawns[player.spawnId]) {
    const s = spawns[player.spawnId];
    player.x = Math.round(s.x - player.w / 2);
    player.y = Math.round(s.y - player.h);
    player.facing = s.facing || "down";
    player.spawnId = null;
  }

  // Load the player's sprite if not already
  if (!player.sprite.src) {
    player.sprite.src = player.spriteSrc;
    try {
      await player.sprite.decode?.();
      setSpriteDimensions();
    } catch (e) {
      console.warn(`Failed to decode player sprite ${player.spriteSrc}:`, e);
    }
  }
}

/* STEP 2 — Map rendering */
function drawMap() {
  for (const layer of currentMap.layers) {
    if (layer.visible === false) continue;
    if (layer.type === "imagelayer" && layer._img) {
      ctx.save();
      if (typeof layer.opacity === "number") ctx.globalAlpha = layer.opacity;
      const ox = layer.offsetx || 0;
      const oy = layer.offsety || 0;
      ctx.drawImage(layer._img, Math.round(ox), Math.round(oy));
      ctx.restore();
      continue;
    }
    if (layer.type === "tilelayer") {
      const data = layer.data;
      for (let i = 0; i < data.length; i++) {
        let gid = data[i] >>> 0;
        if (!gid) continue;
        const rawGid = gid;
        gid = (gid & GID_MASK);
        const ts = pickTilesetFor(gid);
        if (!ts) continue;
        const localId = gid - ts.firstgid;
        const sx = (localId % ts.columns) * currentMap.tilewidth;
        const sy = Math.floor(localId / ts.columns) * currentMap.tileheight;
        const dx = (i % currentMap.width) * currentMap.tilewidth;
        const dy = Math.floor(i / currentMap.width) * currentMap.tileheight;
        ctx.drawImage(
          ts.img,
          sx, sy,
          currentMap.tilewidth, currentMap.tileheight,
          dx, dy,
          currentMap.tilewidth, currentMap.tileheight
        );
      }
      continue;
    }
    if (layer.type === "objectgroup" && layer.objects?.length) {
      for (const o of layer.objects) {
        if (!o.text) continue;
        drawTiledTextObject(o, layer);
      }
      continue;
    }
  }
}

function drawTiledTextObject(o, layer) {
  const t = o.text;
  if (!t || t.text == null) return;
  ctx.save();
  if (typeof layer.opacity === "number") ctx.globalAlpha = layer.opacity;
  // Font
  const size = (t.pixelsize || 16);
  const family = t.fontfamily || "sans-serif";
  const weight = t.bold ? "bold" : "normal";
  const style  = t.italic ? "italic" : "normal";
  ctx.font = `${style} ${weight} ${size}px ${family}`;
  // Colour
  let color = t.color || "#000000";
  if (color.startsWith("#") && color.length === 9) {
    const a = parseInt(color.slice(1, 3), 16) / 255;
    const r = parseInt(color.slice(3, 5), 16);
    const g = parseInt(color.slice(5, 7), 16);
    const b = parseInt(color.slice(7, 9), 16);
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
  } else {
    ctx.fillStyle = color;
  }
  // Alignment and position
  const width  = o.width  || 0;
  const height = o.height || 0;
  const offsetX = layer.offsetx || 0;
  const offsetY = layer.offsety || 0;
  let x = o.x + offsetX;
  let y = o.y + offsetY;
  const h = (t.halign || "left").toLowerCase();
  if (h === "center") {
    ctx.textAlign = "center";
    x += width / 2;
  } else if (h === "right" || h === "justify") {
    ctx.textAlign = "right";
    x += width;
  } else {
    ctx.textAlign = "left";
  }
  const v = (t.valign || "top").toLowerCase();
  if (v === "center") {
    ctx.textBaseline = "middle";
    y += height / 2;
  } else if (v === "bottom") {
    ctx.textBaseline = "bottom";
    y += height;
  } else {
    ctx.textBaseline = "top";
  }
  const maxW = width > 0 ? width : undefined;
  if (t.stroke && t.stroke.color) {
    const sw = t.stroke.width || 1;
    ctx.lineWidth = sw;
    ctx.strokeStyle = t.stroke.color;
    drawWrappedText(t.text, x, y, maxW, size, (line, lx, ly) => {
      ctx.strokeText(line, lx, ly);
    });
  }
  drawWrappedText(t.text, x, y, maxW, size, (line, lx, ly) => {
    ctx.fillText(line, lx, ly);
  });
  ctx.restore();
}

function drawWrappedText(text, x, y, maxWidth, lineHeight, painter) {
  if (!maxWidth) {
    painter(text, x, y);
    return;
  }
  const words = String(text).split(/\s+/);
  let line = "";
  let cy = y;
  for (let n = 0; n < words.length; n++) {
    const test = line ? (line + " " + words[n]) : words[n];
    const w = ctx.measureText(test).width;
    if (w > maxWidth && line) {
      painter(line, x, cy);
      line = words[n];
      cy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) painter(line, x, cy);
}

function pickTilesetFor(gid) {
  let best = null;
  for (const ts of tilesetImages) {
    if (gid >= ts.firstgid) best = ts;
    else break;
  }
  return best;
}

/* STEP 3 — Movement & collision */
function update(dt) {
  const isRunning = !!(keys["shift"] || keys["shiftleft"] || keys["shiftright"]);
  const speed = isRunning ? WALK_SPEED * RUN_MULTIPLIER : WALK_SPEED;
  let vx = 0;
  let vy = 0;
  if (keys["arrowleft"] || keys["a"])  vx -= speed;
  if (keys["arrowright"]|| keys["d"])  vx += speed;
  if (keys["arrowup"]   || keys["w"])  vy -= speed;
  if (keys["arrowdown"] || keys["s"])  vy += speed;
  if (vx && vy) {
    const inv = 1 / Math.sqrt(2);
    vx *= inv; vy *= inv;
  }
  player.vx = vx;
  player.vy = vy;
  if (Math.abs(vx) > Math.abs(vy)) {
    if (vx < 0) player.facing = "left";
    else if (vx > 0) player.facing = "right";
  } else if (Math.abs(vy) > 0) {
    if (vy < 0) player.facing = "up";
    else if (vy > 0) player.facing = "down";
  }
  if (vx || vy) animTime += dt;
  else animTime = 0;
  player.x += player.vx * dt;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (player.vx > 0) player.x = r.x - player.w;
      else if (player.vx < 0) player.x = r.x + r.w;
    }
  }
  player.y += player.vy * dt;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (player.vy > 0) player.y = r.y - player.h;
      else if (player.vy < 0) player.y = r.y + r.h;
    }
  }
}

function overlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/* -----------------------------------------------------------------------
 * Book UI helper functions
 */
function near(a, b) {
  const dx = (a.x + a.w / 2) - b.x;
  const dy = (a.y + a.h / 2) - b.y;
  return (dx * dx + dy * dy) <= (b.r * b.r);
}

function openBookFor(idLower) {
  const key = idLower.toLowerCase();
  if (USE_SINGLE_BOOK_IMAGE) {
    if (book.img.src !== SINGLE_BOOK_IMAGE_SRC) {
      book.img.onload = adjustBookFrameSize;
      book.img.src = SINGLE_BOOK_IMAGE_SRC;
    }
  }
  const pages =
    book.pagesById[key] ||
    book.pagesById[(key === "cv" ? "cs" : "cs")] ||
    [];
  book.currentKey    = key;
  book.pageIndex     = 0;
  book.lastPageIndex = 0;
  book.nextPageIndex = 0;
  book.acc           = 0;
  book.frame         = 0;
  book.flipProgress  = 0;
  book.state         = "opening";
  book._pagesCached  = pages;

  // re-center based on known open frame width if available
  if (book.frames.length) {
    const openW = book.frames[book.idleOpenFrame].sw;
    book.x = Math.round((canvas.width  - openW) / 2);
    book.y = Math.round((canvas.height - book.frameH) / 2);
  }
}

function tryUseHotspots() {
  if (!wantUse) return;
  wantUse = false;
  if (!hotspots || !hotspots.length) return;
  const valid = new Set(["cv", "cs", "nlp", "agent", "rl", "me"]);
  for (const h of hotspots) {
    if (!h.active) continue;
    const id = (h.id || "").toLowerCase();
    if (!valid.has(id) && !(id === "cv" || id === "cs")) continue;
    if (near(player, h)) {
      openBookFor(id);
      break;
    }
  }
}

function updateBook(dt) {
  if (book.state === "closed") return;
  if (book.state === "opening") {
    book.acc += dt;
    const interval = 1 / book.fps;
    if (book.acc >= interval) {
      book.acc -= interval;
      book.frame++;
      if (book.frame >= book.idleOpenFrame) {
        book.frame = book.idleOpenFrame;
        book.state = "open";
      }
    }
    return;
  }
  if (book.state === "closing") {
    book.acc += dt;
    const interval = 1 / book.fps;
    if (book.acc >= interval) {
      book.acc -= interval;
      book.frame--;
      if (book.frame <= 0) {
        book.frame = 0;
        book.state = "closed";
      }
    }
    return;
  }
  if (book.state === "flipping") {
    const flipSpeed = 2;
    book.flipProgress += dt * flipSpeed;
    if (book.flipProgress >= 1) {
      book.flipProgress = 0;
      book.pageIndex = book.nextPageIndex;
      book.state = "open";
    }
    return;
  }
}

function drawBook(ctx) {
  if (book.state === "closed") return;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!book.frames.length) { ctx.restore(); return; }
  const fi = Math.max(0, Math.min(book.frame, book.frames.length - 1));
  const { sx, sw } = book.frames[fi];
  const sy = 0, sh = book.frameH;

  ctx.imageSmoothingEnabled = false;
  const scale = 1;
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  const dx = Math.round(book.x - (dw - sw) / 2);
  const dy = Math.round(book.y - (dh - sh) / 2);

  ctx.drawImage(book.img, sx, sy, sw, sh, dx, dy, dw, dh);
  // ... (page text + hint use dx/dy/sw/sh as you already had)
  ctx.restore();
}

/* STEP 4 — Portals & spawns */
async function tryUsePortals() {
  const base = dirname(currentMap._jsonPath || "");
  for (const p of portals) {
    if (overlap(player, p)) {
      if (p.auto || wantUse) {
        player.spawnId = p.targetSpawn;
        const nextMap = join(base, p.targetMap);
        await loadMap(nextMap);
        break;
      }
    }
  }
}

/* STEP 5 — Drawing the player sprite */
function colForFacing(facing) {
  switch (facing) {
    case "down":  return 0;
    case "right": return 1;
    case "up":    return 2;
    case "left":  return 3;
    default:       return 0;
  }
}

function currentAnimRow() {
  if (!(player.vx || player.vy)) {
    return Math.floor(SPRITE_ROWS / 2);
  }
  const isRunning = !!(keys["shift"] || keys["shiftleft"] || keys["shiftright"]);
  const fps = isRunning ? RUN_ANIM_FPS : WALK_ANIM_FPS;
  return Math.floor(animTime * fps) % SPRITE_ROWS;
}

function drawPlayer() {
  const frameRow = currentAnimRow();
  const dirCol   = colForFacing(player.facing);
  const sx = dirCol * FRAME_W;
  const sy = frameRow * FRAME_H;
  ctx.drawImage(
    player.sprite,
    sx, sy, FRAME_W, FRAME_H,
    Math.round(player.x), Math.round(player.y),
    player.w, player.h
  );
}

/* STEP 6 — UI */
const loadingEl = document.getElementById("loading");
function showLoading(text = "Loading…") {
  if (!loadingEl) return;
  loadingEl.style.display = "block";
  loadingEl.textContent = text;
}
function hideLoading() {
  if (!loadingEl) return;
  loadingEl.style.display = "none";
}

/* STEP 7 — Main loop */
function loop(t) {
  const dt = Math.min(0.05, (t - lastTime) / 1000);
  lastTime = t;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  update(dt);
  drawMap();
  drawPlayer();
  tryUsePortals().catch((err) => {
    console.error(err);
    if (loadingEl) loadingEl.textContent = "Error: " + err.message;
  });
  tryUseHotspots();
  updateBook(dt);
  drawBook(ctx);
  wantUse = false;
  requestAnimationFrame(loop);
}

/* STEP 8 — Boot sequence */
(async function boot() {
  try {
    showLoading("Loading map…");
    await new Promise((res) => {
      const timer = setTimeout(() => {
        console.warn("Sprite load timed out; continuing without waiting");
        res();
      }, 3000);
      player.sprite.addEventListener("load", () => {
        clearTimeout(timer);
        setSpriteDimensions();
        res();
      }, { once: true });
      player.sprite.src = player.spriteSrc;
    });
    player.spawnId = "toOut";
    await loadMap("maps/outdoor.json");
    hideLoading();
    requestAnimationFrame((t) => {
      lastTime = t;
      loop(t);
    });
  } catch (err) {
    console.error(err);
    if (loadingEl) loadingEl.textContent = "Error: " + err.message;
  }
})();

// Global error handlers for debugging
window.addEventListener('unhandledrejection', ev => {
  console.error('Unhandled promise rejection:', ev.reason);
  if (loadingEl) loadingEl.textContent = 'Error: ' + (ev.reason?.message || ev.reason);
});
window.addEventListener('error', ev => {
  console.error('Window error:', ev.error || ev.message);
});
