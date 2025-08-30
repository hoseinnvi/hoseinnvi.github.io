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
// Hotspot objects for interactive elements that open the book UI.
let hotspots = [];

// --------------------------------------------------------------------
// Book UI configuration and state
// The game supports a pop-up "book" overlay that animates open and closed,
// displays topic-specific text, and allows the player to flip between pages.
// By default, a single sprite sheet is used for all topics.  Each frame in
// the sheet is square (height equals width) and the frames are laid out
// horizontally.  The final frame shows the fully open book.
const USE_SINGLE_BOOK_IMAGE = true;
// Path to the shared book sprite sheet.  You can replace this with your
// own artwork; the sheet should contain a sequence of frames from closed
// to fully open.  Each frame must be square and arranged in a single row.
const SINGLE_BOOK_IMAGE_SRC = "./UI/book_open.png";

// Book state object.  When the player interacts with certain hotspots,
// the book animates open and displays text relevant to that hotspot.
const book = {
  img: new Image(),
  frameW: 0,
  frameH: 0,
  frameCount: 1,
  idleOpenFrame: 0,
  fps: 12,                // Animation speed for open/close (frames per second)
  x: 0,                   // Screen position (set after image loads)
  y: 0,
  state: "closed",        // "closed" | "opening" | "open" | "flipping" | "closing"
  frame: 0,               // Current frame index in the sprite sheet
  acc: 0,                 // Accumulated time for frame timing
  pageIndex: 0,           // Current page index within the selected topic
  lastPageIndex: 0,       // Previous page index (for flip animation)
  nextPageIndex: 0,       // Destination page index during flip animation
  currentKey: null,       // ID of the hotspot that opened the book
  flipProgress: 0,        // 0..1 progress during page-flip animation
  // Text content per topic.  Modify these arrays to customise what each
  // hotspot displays when the book is open.  Each array entry represents
  // a single page.
  pagesById: {
    cs:   ["Computer Vision", "Stereo and TSDF fusion", "3D surface reconstruction", "Ultrasound + vision"],
    cv:   ["Computer Vision", "Stereo and TSDF fusion", "3D surface reconstruction", "Ultrasound + vision"],
    nlp:  ["NLP & LLMs", "Retrieval Augmented Generation (RAG)", "Agents and tools", "Evaluation & safety", "Production pipelines"],
    agent:["Agentic AI", "Multi‑tool flows", "MCP/Functions", "Reliability patterns"],
    rl:   ["Reinforcement Learning", "Policy/value methods", "Environment design", "Evaluation loops"],
    me:   ["About Me", "This page is intentionally left blank."],
  },
  _pagesCached: null      // Internal cache of the selected topic's pages
};


/**
 * Compute the frame dimensions and count for the book sprite sheet.  The
 * frames are assumed to be square and arranged horizontally.  The last
 * frame (index ``idleOpenFrame``) represents the fully open book.
 */
function adjustBookFrameSize() {
  const img = book.img;
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  // Each frame is a square: height and width are equal to the image height.
  book.frameH = img.naturalHeight;
  book.frameW = book.frameH * 1.5; // FIX: Use a 3:2 aspect ratio for the book
  book.frameCount = Math.max(1, Math.floor(img.naturalWidth / book.frameW));
  // The last frame depicts the fully open book.
  book.idleOpenFrame = Math.max(0, book.frameCount - 1);
  // Centre the book on the canvas if the canvas dimensions are known.
  if (canvas && canvas.width && canvas.height) {
    book.x = Math.round((canvas.width  - book.frameW) / 2);
    book.y = Math.round((canvas.height - book.frameH) / 2);
  }
}

// Load the shared book image and calculate frame metrics.  The image
// decoding happens asynchronously, and ``adjustBookFrameSize`` will run
// when the image has loaded.  If the image is already cached, the
// dimensions are computed immediately.
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

// Additional input handlers for the book UI.  Pressing the Escape key will
// close the book (if open), and clicking on the left or right half of
// the book while it is open flips to the previous or next page.
window.addEventListener("keydown", (e) => {
  // Only handle Escape if the book UI is active; let other keys through.
  if (e.key === "Escape" && book.state !== "closed") {
    // Start closing the book regardless of whether it is fully open.
    book.state = "closing";
    book.acc = 0;
    e.preventDefault();
  }
});
canvas.addEventListener("mousedown", (e) => {
  // Ignore clicks when the book is not fully open.
  if (book.state !== "open") return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  // Check if the click falls within the book's bounding box.
  if (mx < book.x || mx > book.x + book.frameW ||
      my < book.y || my > book.y + book.frameH) return;
  // Flip pages based on whether the click was on the left or right side.
  const total = book._pagesCached ? book._pagesCached.length : 0;
  if (!total) return;
  // Determine page change direction
  let newIndex;
  if (mx < book.x + book.frameW / 2) {
    // Left side: previous page (wrap around)
    newIndex = (book.pageIndex - 1 + total) % total;
  } else {
    // Right side: next page
    newIndex = (book.pageIndex + 1) % total;
  }
  // Setup flip animation
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
  // Reset hotspots when loading a new map.  The Hotspots layer may be
  // defined per map and contains interactive trigger zones.
  hotspots      = [];

  resizeCanvasToMap(map);

  // Recalculate book position when the canvas size changes.  The book
  // sprite sheet may not have loaded yet, so ``frameW`` and ``frameH``
  // might still be zero.  This will be updated again once the image
  // finishes loading.
  if (book.frameW && book.frameH) {
    book.x = Math.round((canvas.width  - book.frameW) / 2);
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
    // Parse interactive hotspots from the "Hotspots" object layer.  Each
    // object defines an area (by x/y) where the player can press E to
    // open the book.  A ``radius`` property can override the default
    // trigger radius (12 pixels).  The ``id`` property determines which
    // content is shown.
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

/* -----------------------------------------------------------------------
 * Book UI helper functions
 *
 * The following functions implement the behaviour of the interactive book
 * overlay.  The book can be opened by pressing E near a hotspot (see
 * ``tryUseHotspots``).  When open, the book animates via frames in the
 * sprite sheet.  The player can flip pages by clicking on the left or
 * right side of the book, and press Escape to close it.
 */

/**
 * Return true if the player's centre is within a circular hotspot.
 * @param {object} a - Player object with x, y, w, h fields.
 * @param {object} b - Hotspot with x, y (centre) and r (radius).
 */
function near(a, b) {
  const dx = (a.x + a.w / 2) - b.x;
  const dy = (a.y + a.h / 2) - b.y;
  return (dx * dx + dy * dy) <= (b.r * b.r);
}

/**
 * Start opening the book for the given hotspot ID.  This sets up the
 * animation state and loads the appropriate pages for the topic.  If
 * ``USE_SINGLE_BOOK_IMAGE`` is true, the same sprite sheet is reused
 * regardless of topic.
 * @param {string} idLower - Lowercase ID of the hotspot (e.g. "cv", "nlp").
 */
function openBookFor(idLower) {
  const key = idLower.toLowerCase();
  // If using a single image, ensure the sprite is loaded and sized.
  if (USE_SINGLE_BOOK_IMAGE) {
    if (book.img.src !== SINGLE_BOOK_IMAGE_SRC) {
      book.img.onload = adjustBookFrameSize;
      book.img.src = SINGLE_BOOK_IMAGE_SRC;
    }
  }
  // Pull pages for this topic; fall back to cs if cv alias is used.
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
  // Ensure the book is centred on screen (in case window size changed).
  if (book.frameW && book.frameH) {
    book.x = Math.round((canvas.width  - book.frameW) / 2);
    book.y = Math.round((canvas.height - book.frameH) / 2);
  }
}

/**
 * Check if the player is near any active hotspot and open the book if
 * the E key was pressed.  After handling, the ``wantUse`` flag is reset.
 */
function tryUseHotspots() {
  if (!wantUse) return;
  wantUse = false;
  if (!hotspots || !hotspots.length) return;
  // Define which IDs are valid triggers; others are ignored.
  const valid = new Set(["cv", "cs", "nlp", "agent", "rl", "me"]);
  for (const h of hotspots) {
    if (!h.active) continue;
    const id = (h.id || "").toLowerCase();
    // Accept alias "cv" as "cs" (computer vision).
    if (!valid.has(id) && !(id === "cv" || id === "cs")) continue;
    if (near(player, h)) {
      openBookFor(id);
      break;
    }
  }
}

/**
 * Animate the book's open/close and page-flip states.  Should be called
 * once per frame with the frame's delta time.  When the book is fully
 * open, it remains in an idle state until closed or pages are flipped.
 * @param {number} dt - Time elapsed since the last frame, in seconds.
 */
function updateBook(dt) {
  if (book.state === "closed") return;
  // Opening animation: step through frames until the idle open frame.
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
  // Closing animation: reverse through frames until fully closed.
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
  // Flipping animation: cross-fade between pages.
  if (book.state === "flipping") {
    // Flip speed: adjust this to make page turns faster or slower.
    const flipSpeed = 2; // units per second (completes in 0.5s)
    book.flipProgress += dt * flipSpeed;
    if (book.flipProgress >= 1) {
      book.flipProgress = 0;
      book.pageIndex = book.nextPageIndex;
      book.state = "open";
    }
    return;
  }
  // Idle open state: nothing to update.
}

/**
 * Draw the book overlay and its contents.  If the book is not open or
 * animating, this function does nothing.  The underlying map and player
 * should already have been drawn before calling this function.
 * @param {CanvasRenderingContext2D} ctx - The drawing context.
 */
function drawBook(ctx) {
  if (book.state === "closed") return;
  ctx.save();
  // Dim the world behind the book.
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Draw the current frame of the book sprite.
  ctx.imageSmoothingEnabled = false;
  const sx = book.frame * book.frameW;
  ctx.drawImage(
    book.img,
    sx, 0, book.frameW, book.frameH,
    book.x, book.y,
    book.frameW, book.frameH
  );
  // Draw page text only when the book is open or flipping.
  if (book.state === "open" || book.state === "flipping") {
    const pages = book._pagesCached || [];
    // Determine old and new page indices for cross-fading.
    const oldIndex = book.pageIndex;
    const newIndex = (book.state === "flipping") ? book.nextPageIndex : book.pageIndex;
    // Function to draw a page's text into the open-book area.  The
    // coordinates and dimensions are computed relative to the book's
    // current position and frame size.  The text is wrapped within
    // ``maxW`` pixels horizontally and may extend across multiple rows.
    function drawPageText(text, alpha) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#2b261a";
      ctx.font = "16px monospace";
      ctx.textBaseline = "top";
      // Define a padding around the text and the maximum width.
      const padX = Math.floor(book.frameW * 0.18);
      const padY = Math.floor(book.frameH * 0.18);
      const maxW  = book.frameW - padX * 2;
      let x0 = book.x + padX;
      let y0 = book.y + padY;
      const words = String(text || "").split(/\s+/);
      let line = "";
      let y = y0;
      const lineHeight = 18; // pixels per line
      for (let i = 0; i < words.length; i++) {
        const test = line ? line + " " + words[i] : words[i];
        const w = ctx.measureText(test).width;
        if (w > maxW && line) {
          ctx.fillText(line, x0, y);
          line = words[i];
          y += lineHeight;
        } else {
          line = test;
        }
      }
      if (line) ctx.fillText(line, x0, y);
      ctx.globalAlpha = 1;
    }
    // Draw old and new pages with appropriate transparency when flipping.
    if (book.state === "flipping") {
      drawPageText(pages[oldIndex], 1 - book.flipProgress);
      drawPageText(pages[newIndex], book.flipProgress);
    } else {
      drawPageText(pages[oldIndex], 1);
    }
    // Draw interaction hint along the bottom of the book.
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "14px monospace";
    ctx.textBaseline = "bottom";
    const hint = "← click left • click right →     (Esc closes)";
    ctx.fillText(
      hint,
      book.x + Math.floor(book.frameW * 0.05),
      book.y + book.frameH - Math.floor(book.frameH * 0.05)
    );
  }
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
  // Attempt to use portals (asynchronous).  Portals may change the map.
  tryUsePortals().catch((err) => {
    console.error(err);
    if (loadingEl) loadingEl.textContent = "Error: " + err.message;
  });
  // Check for hotspot interaction and open the book if appropriate.
  tryUseHotspots();
  // Update the book animation state before drawing it.
  updateBook(dt);
  // Draw the book overlay (if open or animating) on top of everything else.
  drawBook(ctx);
  // Reset the 'E' use flag for the next frame.
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