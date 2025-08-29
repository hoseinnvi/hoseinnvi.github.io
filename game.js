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
// ``SPRITE_COLUMNS`` is the number of columns in the sprite sheet (one per
// direction); ``SPRITE_ROWS`` is the number of rows (the number of frames
// in each direction).  For F_01.png there are 4 columns (down, right,
// up, left) and 3 rows (animation frames).
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

// Movement speeds (pixels per second).  ``WALK_SPEED`` applies when
// walking; ``RUN_SPEED`` multiplies ``WALK_SPEED`` when the Shift key
// is held down.  ``WALK_ANIM_FPS`` and ``RUN_ANIM_FPS`` control how
// quickly the sprite animation cycles while walking or running.
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
  // Change this to match your actual filename if necessary.  The default
  // assumes ``F_01.png`` (underscore).  If your file uses a hyphen
  // (``F-01.png``), update this string accordingly.
  spriteSrc: "./assets/characters/F_01.png",
};

/*
 * Determine the number of columns and rows in the player's sprite sheet
 * based on the natural dimensions of the loaded image.  This function
 * should be called after the sprite has been decoded or loaded.  It
 * updates the global ``SPRITE_COLUMNS`` and ``SPRITE_ROWS`` variables.
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

// Hotspots for interactive book UI
let hotspots = [];

// Book UI configuration and state
const book = {
  img: new Image(),
  // Path to the exported sprite sheet for the book (horizontal strip)
  src: "./UI/book_open.png",
  // Dimensions of one frame of the book sprite sheet
  frameW: 256,
  frameH: 256,
  // Total number of frames in the strip (opening/closing animation length)
  frameCount: 12,
  // Frames per second for the opening/closing animation
  fps: 12,
  // Position on screen; will be centered when the map is loaded
  x: 0,
  y: 0,
  // Current animation state: "closed", "opening", "open", "closing"
  state: "closed",
  // Current frame index within the sprite sheet
  frame: 0,
  // Accumulator for animation timing
  acc: 0,
  // Current page index when the book is open
  pageIndex: 0,
  // Which hotspot triggered the book (used to look up pages)
  currentKey: null,
  // Map of pages for each hotspot identifier
  pagesById: {
    cs:   ["Computer Vision", "Stereo, TSDF fusion", "3D surface rec.", "Ultrasound + vision"],
    cv:   ["Computer Vision", "Stereo, TSDF fusion", "3D surface rec.", "Ultrasound + vision"],
    nlp:  ["NLP & LLMs", "RAG, agents", "Eval & safety", "Prod pipelines"],
    agent:["Agentic AI", "Multi-tool flows", "MCP/Functions", "Reliability patterns"],
    rl:   ["Reinforcement Learning", "Policy/value", "Env design", "Eval loops"]
  },
  // Cached copy of the current pages; filled when opening the book
  _pagesCached: null
};
// Assign the image source; this will start loading the sprite sheet
book.img.src = book.src;

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

// Listen for Escape to close the book.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" || e.key === "Esc") {
    if (book.state !== "closed") {
      book.state = "closing";
      book.acc = 0;
      // Prevent default behaviour such as exiting full-screen.
      e.preventDefault();
    }
  }
});

// Listen for mouse clicks to flip pages when the book is open.
canvas.addEventListener("mousedown", (e) => {
  if (book.state !== "open") return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  // Ignore clicks outside the book.
  if (
    mx < book.x ||
    mx > book.x + book.frameW ||
    my < book.y ||
    my > book.y + book.frameH
  ) {
    return;
  }
  const leftSide = mx < book.x + book.frameW / 2;
  const pages = book._pagesCached || [];
  if (!pages.length) return;
  if (leftSide) {
    book.pageIndex = (book.pageIndex - 1 + pages.length) % pages.length;
  } else {
    book.pageIndex = (book.pageIndex + 1) % pages.length;
  }
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

// Load a Tiled map and all of its tileset images.  Errors are caught and
// reported into the loading overlay instead of leaving the game stuck.
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

  resizeCanvasToMap(map);

  // Position the book in the center of the canvas when loading a new map.
  book.x = Math.round((canvas.width  - book.frameW) / 2);
  book.y = Math.round((canvas.height - book.frameH) / 2);

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

    // Hotspots define areas where the player can open the book.
    // Each hotspot should have a unique id (e.g. "cv", "nlp", "agent", "rl").
    if (layer.name === "Hotspots") {
      hotspots = [];
      for (const o of layer.objects) {
        const P = toPropMap(o.properties);
        hotspots.push({
          id: (P.id || o.name || String(o.id)).toLowerCase(),
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
      // After decoding, update sprite sheet dimensions
      setSpriteDimensions();
    } catch (e) {
      // If decode fails, log a warning but continue.  The sprite may still
      // load asynchronously via the 'load' event (below).  We attempt to
      // determine the sheet dimensions once it does load.
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
  // Apply any layer offsets to the object position
  const offsetX = layer.offsetx || 0;
  const offsetY = layer.offsety || 0;
  let x = o.x + offsetX;
  let y = o.y + offsetY;
  // Horizontal alignment: adjust x based on the object's width and alignment
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
  // Vertical alignment: adjust y based on the object's height and alignment
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
  // Wrap width: only set a maximum width when width > 0.  Otherwise undefined
  const maxW = width > 0 ? width : undefined;
  // Draw stroke if defined
  if (t.stroke && t.stroke.color) {
    const sw = t.stroke.width || 1;
    ctx.lineWidth = sw;
    ctx.strokeStyle = t.stroke.color;
    drawWrappedText(t.text, x, y, maxW, size, (line, lx, ly) => {
      ctx.strokeText(line, lx, ly);
    });
  }
  // Draw fill text
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
  // Determine if run key is held (Shift)
  const isRunning = !!(keys["shift"] || keys["shiftleft"] || keys["shiftright"]);
  const speed = isRunning ? WALK_SPEED * RUN_MULTIPLIER : WALK_SPEED;
  let vx = 0;
  let vy = 0;
  if (keys["arrowleft"] || keys["a"])  vx -= speed;
  if (keys["arrowright"]|| keys["d"])  vx += speed;
  if (keys["arrowup"]   || keys["w"])  vy -= speed;
  if (keys["arrowdown"] || keys["s"])  vy += speed;
  // Normalise diagonal
  if (vx && vy) {
    const inv = 1 / Math.sqrt(2);
    vx *= inv; vy *= inv;
  }
  player.vx = vx;
  player.vy = vy;
  // Update facing.  When moving diagonally, choose the dominant axis.
  if (Math.abs(vx) > Math.abs(vy)) {
    if (vx < 0) player.facing = "left";
    else if (vx > 0) player.facing = "right";
  } else if (Math.abs(vy) > 0) {
    if (vy < 0) player.facing = "up";
    else if (vy > 0) player.facing = "down";
  }
  // Advance animation time only when moving
  if (vx || vy) animTime += dt;
  else animTime = 0;
  // Move X
  player.x += player.vx * dt;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (player.vx > 0) player.x = r.x - player.w;
      else if (player.vx < 0) player.x = r.x + r.w;
    }
  }
  // Move Y
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

/* STEP 4.5 — Hotspots & interactive book */
// Check if the player is within range of a hotspot and pressing the use key.
function near(a, b, r) {
  const dx = (a.x + a.w / 2) - b.x;
  const dy = (a.y + a.h / 2) - b.y;
  return (dx * dx + dy * dy) <= (r * r);
}

function openBookFor(idLower) {
  // Normalise key and look up pages.
  const key = idLower.toLowerCase();
  const pages =
    book.pagesById[key] || book.pagesById[(key === "cv" ? "cs" : "cs")];
  book.currentKey = key;
  book.pageIndex = 0;
  book.state = "opening";
  book.frame = 0;
  book.acc = 0;
  book._pagesCached = pages;
}

function tryUseHotspots() {
  // Only trigger when the 'use' key has been pressed.
  if (!wantUse) return;
  wantUse = false;
  // List of recognised hotspot identifiers.
  const valid = new Set(["cv", "cs", "nlp", "agent", "rl"]);
  for (const h of hotspots) {
    if (!h.active) continue;
    if (!valid.has(h.id)) continue;
    if (near(player, h, h.r || 12)) {
      openBookFor(h.id);
      break;
    }
  }
}

function updateBook(dt) {
  if (book.state === "opening") {
    book.acc += dt;
    if (book.acc >= 1 / book.fps) {
      book.acc = 0;
      book.frame++;
      if (book.frame >= book.frameCount - 1) {
        book.frame = book.frameCount - 1;
        book.state = "open";
      }
    }
  } else if (book.state === "closing") {
    book.acc += dt;
    if (book.acc >= 1 / book.fps) {
      book.acc = 0;
      book.frame--;
      if (book.frame <= 0) {
        book.frame = 0;
        book.state = "closed";
      }
    }
  }
}

function drawBook() {
  if (book.state === "closed") return;
  // Darken the screen behind the book.
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  // Draw the current frame of the book.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    book.img,
    book.frame * book.frameW,
    0,
    book.frameW,
    book.frameH,
    book.x,
    book.y,
    book.frameW,
    book.frameH
  );
  // If the book is open, draw the page text.
  if (book.state === "open" && book._pagesCached) {
    const pages = book._pagesCached;
    const text = pages[book.pageIndex] || "";
    // Position the text inside the page.  Adjust these values to align with your artwork.
    const box = {
      x: book.x + 70,
      y: book.y + 60,
      w: book.frameW - 140,
      line: 18,
      max: 10,
    };
    ctx.fillStyle = "#2b261a";
    ctx.font = "16px monospace";
    ctx.textBaseline = "top";
    let y = box.y;
    // Simple word wrap
    const words = String(text).split(/\s+/);
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > box.w && line) {
        ctx.fillText(line, box.x, y);
        line = word;
        y += box.line;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, box.x, y);
    // Draw hint for page navigation and closing.
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "14px monospace";
    ctx.fillText(
      "← click left • click right →    (Esc closes)",
      box.x,
      book.y + book.frameH - 24
    );
  }
}

/* STEP 5 — Drawing the player sprite */
// Column index for each facing direction.  Columns correspond to the
// directions in the order: down (0), right (1), up (2), left (3).
function colForFacing(facing) {
  switch (facing) {
    case "down":  return 0;
    case "right": return 1;
    case "up":    return 2;
    case "left":  return 3;
    default:       return 0;
  }
}

// Compute the current animation row (frame) index.  If the player is
// idle, return the middle frame (row 1) for a neutral pose.  When
// moving, cycle through the number of available rows (``SPRITE_ROWS``)
// according to the configured FPS.
function currentAnimRow() {
  if (!(player.vx || player.vy)) {
    // Use the middle frame as idle pose (row index 1 for 3 rows)
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
  // Process automatic or interactive portals
  tryUsePortals().catch((err) => {
    console.error(err);
    if (loadingEl) loadingEl.textContent = "Error: " + err.message;
  });
  // Allow the player to interact with hotspots to open the book.
  tryUseHotspots();
  // Advance book animation state.
  updateBook(dt);
  // Draw the book UI overlay on top of everything else.
  drawBook();
  wantUse = false;
  requestAnimationFrame(loop);
}

/* STEP 8 — Boot sequence */
(async function boot() {
  try {
    showLoading("Loading map…");
    // Attempt to load the player's sprite.  Use a timeout to avoid hanging
    // forever if the image is missing.
    await new Promise((res) => {
      const timer = setTimeout(() => {
        console.warn("Sprite load timed out; continuing without waiting");
        res();
      }, 3000);
      player.sprite.addEventListener("load", () => {
        clearTimeout(timer);
        // Once loaded, update the sprite sheet dimensions
        setSpriteDimensions();
        res();
      }, { once: true });
      player.sprite.src = player.spriteSrc;
    });
    // Choose an initial map and spawn point here.  Modify as needed.
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