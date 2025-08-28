/* =========================================================================
   game.js — A tiny, readable top-down “walk around” engine (improved)
   -------------------------------------------------------------------------

   This file implements a simple 2D adventure framework for Tiled maps. The
   improvements over the original include:

   1) Resolving tileset and portal paths relative to the map JSON file.
      Tiled stores paths relative to the JSON; without resolving them
      properly the browser would look for images relative to index.html.
      The helper functions `dirname()` and `join()` take care of this.
   2) Stripping flip bits from tile global IDs.
      Tiled encodes horizontal/vertical/diagonal flips in the high bits of
      each tile's gid.  These bits must be masked off before indexing into
      tilesets; otherwise you'll see empty or wrong tiles drawn.
   3) Showing and hiding a loading overlay.
      A simple `<div id="loading">` lives in index.html.  We expose
      `showLoading()` and `hideLoading()` to toggle its visibility.
      Any fatal errors will also print into that element.
   4) Remembering where the current map came from so that portals can load
      their target maps relative to the original JSON folder.
   5) Basic error handling for asset loads and async functions to make
      debugging easier.

   The engine performs the following steps:

   • Load a Tiled map (see `loadMap`).
   • Draw its tile layers onto the canvas (see `drawMap`).
   • Preload and draw Image Layers (so “NPCs” image layers show up).
   • Extract Collision, Portals and Spawns from object layers.
   • Move a player rectangle with WASD/arrow keys; block it against
     collision rectangles and allow it to use portals.
   • Switch maps when the player touches a portal, placing them at the
     appropriate spawn in the next map.
   • Hide the loading overlay once everything is ready.

   Tip: search for “STEP” markers in the comments to see the main
   responsibilities.
   ===================================
====================================== */

/* =========================
   STEP 0 — Canvas and basics
   ========================= */
// Grab the canvas and its context.  The canvas size will be updated
// whenever a map is loaded.
const canvas = document.getElementById("game");
const ctx    = canvas.getContext("2d");

// Tiled flip flags live in the high bits of the gid.  See
// https://doc.mapeditor.org/en/stable/reference/json-map-format/#tile-object
// Mask off everything above bit 28 to get the underlying tile id.
const FLIP_H  = 0x80000000;
const FLIP_V  = 0x40000000;
const FLIP_D  = 0x20000000;
const GID_MASK = ~(FLIP_H | FLIP_V | FLIP_D) >>> 0;

// Character size, speed and sprite
const CHARACTER_SCALE = 3; // set to 2 or 3 to make the character bigger
const PLAYER_W = 16 * CHARACTER_SCALE;
const PLAYER_H = 16 * CHARACTER_SCALE;
const SPEED    = 100; // pixels per second

// Player state
const player = {
  x: 0, y: 0, w: PLAYER_W, h: PLAYER_H,
  vx: 0, vy: 0,
  spawnId: null,
  facing: "down",
  sprite: new Image(),
  spriteSrc: "./assets/characters/me.png",
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

// Helper functions to resolve paths.  `dirname()` returns the folder
// portion of a path.  `join()` concatenates a base and a relative path,
// unless the relative is already absolute.
function dirname(path) {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx + 1) : "";
}
function join(base, rel) {
  // Treat absolute URLs and project-rooted paths as already resolved.
  if (/^(https?:)?\//.test(rel)) return rel; // absolute or protocol-relative
  // If the relative path already starts with our maps root, don't double-prefix.
  if (rel.startsWith('maps/')) return rel;
  return base + rel;
}

// Keyboard listeners.  We normalise everything to lower case and track
// pressed keys in an object.  Pressing "e" sets wantUse true for one
// frame to trigger portal interactions.
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (k === "e") wantUse = true;
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = false;
});

/* =========================
   STEP 1 — Map loading
   ========================= */
// Convert a Tiled properties array into a simple object.
function toPropMap(props) {
  const out = Object.create(null);
  if (!props) return out;
  for (const p of props) out[p.name] = p.value;
  return out;
}

// Resize the canvas to fit the current map in pixels.
function resizeCanvasToMap(map) {
  canvas.width  = map.width  * map.tilewidth;
  canvas.height = map.height * map.tileheight;
}

// Load a Tiled map and all of its tileset images.
async function loadMap(jsonPath) {
  const res = await fetch(jsonPath);
  if (!res.ok) throw new Error(`Failed to load map: ${jsonPath}`);
  const map = await res.json();

  // Record where the map was loaded from to resolve relative portal
  // targets later.
  currentMap = map;
  currentMap._jsonPath = jsonPath;
  const base = dirname(jsonPath);

  tilesetImages = [];
  solidRects    = [];
  portals       = [];
  spawns        = {};

  resizeCanvasToMap(map);

  // --- Load and decode all tileset images
  for (const ts of map.tilesets) {
    const img = new Image();
    img.src = join(base, ts.image);
    await img.decode();
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

  // --- Preload images for Image Layers so they can be drawn later
  for (const layer of map.layers) {
    if (layer.type === "imagelayer" && layer.image) {
      try {
        const img = new Image();
        img.src = join(base, layer.image);
        await img.decode();
        // attach decoded image on the layer object for rendering
        layer._img = img;
      } catch (e) {
        console.warn("Failed to load image layer:", layer.name, layer.image, e);
      }
    }
  }

  // --- Extract objects from the object layers
  for (const layer of map.layers) {
    if (layer.type !== "objectgroup") continue;

    if (layer.name === "Collision") {
      for (const o of layer.objects) {
        solidRects.push({
          x: o.x, y: o.y, w: o.width, h: o.height,
        });
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
        // Determine a unique spawn identifier.  Tiled assigns each
        // object a built-in numeric `id` and a `name` property.  Users
        // can also set a custom property named `id` on the object.  We
        // prefer the custom property, then the object name, then fall
        // back to the built-in numeric id.  Without this, spawns may
        // be ignored if the map author did not attach a custom
        // property called "id" to the spawn.
        const P = toPropMap(o.properties);
        const spawnKey = P.id || o.name || String(o.id);
        // Record the raw x/y coordinates of the spawn.  Tiled stores
        // point objects with (x,y) at their centre/bottom.  When
        // positioning the player we account for the player's size.
        spawns[spawnKey] = {
          x: o.x,
          y: o.y,
          facing: P.facing || "down",
        };
      }
    }
  }

  // Position the player at the selected spawn point.  After use,
  // player.spawnId is cleared so subsequent maps load at default.
  if (player.spawnId && spawns[player.spawnId]) {
    const s = spawns[player.spawnId];
    // Align the player so that its feet stand on the spawn point and
    // the sprite is centered horizontally over the point.
    player.x = Math.round(s.x - player.w / 2);
    player.y = Math.round(s.y - player.h);
    player.facing = s.facing || "down";
    player.spawnId = null;
  }

  // Load the player's sprite (if not already)
  if (!player.sprite.src) {
    player.sprite.src = player.spriteSrc;
    await player.sprite.decode?.().catch(()=>{});
  }
}

/* =========================
   STEP 2 — Map rendering
   ========================= */
// Draw all visible layers.  The gid may include flip flags, so we
// mask them off and then compute the correct slice from the tileset.
// Also draw Image Layers (e.g., an NPC composite layer).
function drawMap() {
  for (const layer of currentMap.layers) {
    if (layer.visible === false) continue;
    if (layer.type === "imagelayer" && layer._img) {
      ctx.save();
      if (typeof layer.opacity === "number") ctx.globalAlpha = layer.opacity;
      const ox = layer.offsetx || 0, oy = layer.offsety || 0;
      ctx.drawImage(layer._img, Math.round(ox), Math.round(oy));
      ctx.restore();
      continue;
    }
    if (layer.type !== "tilelayer") continue;
    const data = layer.data;
    for (let i = 0; i < data.length; i++) {
      let gid = data[i] >>> 0;
      if (!gid) continue;
      // Remember the original gid with flags; we don't yet apply
      // flips when drawing but you can extend this check to do so.
      const rawGid = gid;
      gid = (gid & GID_MASK);
      const ts = pickTilesetFor(gid);
      if (!ts) continue;
      const localId = gid - ts.firstgid;
      const sx = (localId % ts.columns) * currentMap.tilewidth;
      const sy = Math.floor(localId / ts.columns) * currentMap.tileheight;
      const dx = (i % currentMap.width) * currentMap.tilewidth;
      const dy = Math.floor(i / currentMap.width) * currentMap.tileheight;
      ctx.save();
      // Optional: handle flips by checking rawGid & FLIP_H / FLIP_V / FLIP_D
      ctx.drawImage(
        ts.img,
        sx, sy,
        currentMap.tilewidth, currentMap.tileheight,
        dx, dy,
        currentMap.tilewidth, currentMap.tileheight
      );
      ctx.restore();
    }
  }
}

// Given a global tile id, pick the matching tileset.  Tilesets are
// sorted by firstgid ascending, so we want the last one whose firstgid
// is <= gid.
function pickTilesetFor(gid) {
  let best = null;
  for (const ts of tilesetImages) {
    if (gid >= ts.firstgid) best = ts;
    else break;
  }
  return best;
}

/* =========================
   STEP 3 — Movement & collision
   ========================= */
// Update the player's velocity based on keyboard state and move them.
// Then resolve collisions against solid rectangles.  Simple AABB sweep.
function update(dt) {
  const speed = SPEED;
  let vx = 0, vy = 0;
  if (keys["arrowleft"] || keys["a"])  vx -= speed;
  if (keys["arrowright"]|| keys["d"])  vx += speed;
  if (keys["arrowup"]   || keys["w"])  vy -= speed;
  if (keys["arrowdown"] || keys["s"])  vy += speed;

  // Normalise diagonal speed
  if (vx && vy) {
    const inv = 1 / Math.sqrt(2);
    vx *= inv; vy *= inv;
  }

  player.vx = vx;
  player.vy = vy;

  // Update facing for sprite selection if needed later
  if (vx < 0) player.facing = "left";
  else if (vx > 0) player.facing = "right";
  else if (vy < 0) player.facing = "up";
  else if (vy > 0) player.facing = "down";

  // Move on X, then resolve collisions
  player.x += player.vx * dt;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (player.vx > 0) player.x = r.x - player.w;
      else if (player.vx < 0) player.x = r.x + r.w;
    }
  }
  // Move on Y, then resolve collisions
  player.y += player.vy * dt;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (player.vy > 0) player.y = r.y - player.h;
      else if (player.vy < 0) player.y = r.y + r.h;
    }
  }

  // Using portals is handled separately to allow an "E to use" prompt.
}

// Axis-aligned rectangle overlap test
function overlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/* =========================
   STEP 4 — Portals & spawns
   ========================= */
// Check if player overlaps a portal and, if so, either auto-use it
// or require the player to press E (wantUse).
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

/* =========================
   STEP 5 — Drawing sprites
   ========================= */
// Draw the player's sprite at its current position.  We assume the
// sprite sheet's top-left frame is the idle image; you can extend this
// function to support animations as needed.
function drawPlayer() {
  ctx.drawImage(
    player.sprite,
    0, 0,
    player.w, player.h,
    Math.round(player.x), Math.round(player.y),
    player.w, player.h
  );
}

/* ===============
   STEP 6 — UI
   =============== */
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

/* =========================
   STEP 7 — Game loop
   ========================= */
function loop(t) {
  const dt = Math.min(0.05, (t - lastTime) / 1000);
  lastTime = t;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  update(dt);
  drawMap();
  drawPlayer();

  // Try to use a portal once per frame; wantUse resets after use attempt.
  tryUsePortals().catch(console.error);
  wantUse = false;

  requestAnimationFrame(loop);
}

/* =========================
   STEP 8 — Boot
   ========================= */
(async function boot() {
  try {
    showLoading("Loading map…");
    // Load the player sprite once
    await new Promise((res) => {
      player.sprite.addEventListener("load", res, { once: true });
      player.sprite.src = player.spriteSrc;
    });
    // Choose a starting spawn and map.  You can adjust spawnId and
    // map path here to start elsewhere.
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

// Global error handlers: log unhandled promise rejections and errors
// during runtime.  Helpful when debugging; these messages will not
// crash the game but will show up in the console and in the loading
// overlay if they happen during boot.
window.addEventListener('unhandledrejection', ev => {
  console.error('Unhandled promise rejection:', ev.reason);
  if (loadingEl) loadingEl.textContent = 'Error: ' + (ev.reason?.message || ev.reason);
});
window.addEventListener('error', ev => {
  console.error('Window error:', ev.error || ev.message);
});
