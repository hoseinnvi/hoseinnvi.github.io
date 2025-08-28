/* =========================================================================
   improved_game.js — Top-down adventure engine with advanced sprite handling
   -------------------------------------------------------------------------

   This version of the engine builds upon the basic example found in
   ``game.js`` and adds several features to make the most of a multi-frame
   character sprite sheet.  The improvements include:

   • Robust sprite loading: the player's sprite source is configurable and
     defaults to ``F_01.png`` (three columns by four rows).  The boot
     sequence waits for the image to load but will time out after a few
     seconds rather than hang forever if the image is missing.  If your
     sprite uses a different filename (e.g. ``F-01.png``), update
     ``PLAYER_SPRITE_SRC`` accordingly.

   • Full animation support: the player cycles through three frames when
     walking in any of the four directions.  The idle frame is the middle
     frame of each row.  A "run" mode can be toggled by holding the
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
// default of 16×16 corresponds to a 3×4 sprite sheet like F_01.png.
const FRAME_W = 16;
const FRAME_H = 16;
const SPRITE_COLUMNS = 3;
const SPRITE_ROWS    = 4;

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

// Current map and tileset images
let currentMap = null;
let tilesetImages = [];

// Collision rectangles, portals, and spawns
let solidRects = [];
let portals    = [];
let spawns     = Object.create(null);

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
    } catch (e) {
      // If decode fails, log a warning but continue.  The sprite may still
      // load asynchronously via the 'load' event (below).
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
  // Alignment
  const h = t.halign || "left";
  const v = t.valign || "top";
  ctx.textAlign = h === "center" ? "center" : h === "right" || h === "justify" ? "right" : "left";
  ctx.textBaseline = v === "center" ? "middle" : v === "bottom" ? "bottom" : "top";
  // Position/wrap
  const x = Math.round(o.x);
  const y = Math.round(o.y);
  const maxW = o.width || undefined;
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

/* STEP 5 — Drawing the player sprite */
// Row index for each facing direction
function rowForFacing(facing) {
  switch (facing) {
    case "down":  return 0;
    case "left":  return 1;
    case "right": return 2;
    case "up":    return 3;
    default:       return 0;
  }
}

function currentAnimCol() {
  // Use the middle frame when idle
  if (!(player.vx || player.vy)) return 1;
  const isRunning = !!(keys["shift"] || keys["shiftleft"] || keys["shiftright"]);
  const fps = isRunning ? RUN_ANIM_FPS : WALK_ANIM_FPS;
  return Math.floor(animTime * fps) % SPRITE_COLUMNS;
}

function drawPlayer() {
  const col = currentAnimCol();
  const row = rowForFacing(player.facing);
  const sx = col * FRAME_W;
  const sy = row * FRAME_H;
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