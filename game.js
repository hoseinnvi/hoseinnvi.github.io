/* =========================================================================
   game.js — A tiny, readable top‑down “walk around” engine (improved)
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
   • Extract Collision, Portals and Spawns from object layers.
   • Move a player rectangle with WASD/arrow keys; block it against
     collision rectangles and allow it to use portals.  
   • Switch maps when the player touches a portal, placing them at the
     appropriate spawn in the next map.
   • Hide the loading overlay once everything is ready.

   Tip: search for “STEP” markers in the comments to see the main
   responsibilities.
   ========================================================================= */

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
const GID_MASK = 0x1fffffff;

// Player object.  You can customise the sprite via spriteSrc; the image
// will be loaded at startup.
const player = {
  x: 0,
  y: 0,
  w: 16,
  h: 16,
  speed: 120,
  sprite: new Image(),
  spriteSrc: "assets/characters/F_01.png",
  spawnId: "toHouse"
};

// Globals to track the current map and extracted metadata.
let currentMap   = null;
let tilesetImages = [];
let solidRects    = [];
let portals       = [];
let spawns        = {};

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
  if (/^(https?:)?\//.test(rel)) return rel; // absolute path
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

// Test whether a key is currently down
function isDown(k) {
  return !!keys[k];
}

/* =========================
   STEP 1 — Map loading
   ========================= */
// Load a Tiled JSON map from a given path.  This resets global state,
// loads all referenced tileset images and extracts collision, portal and
// spawn objects.
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

  // Adjust canvas to the map size.  Use tilewidth/height from the map
  // instead of a global constant because different maps may have
  // different tile sizes.
  canvas.width  = map.width  * map.tilewidth;
  canvas.height = map.height * map.tileheight;

  // --- Load tilesets
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

  // --- Extract objects from the object layers
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
          prompt: P.prompt || "E: Enter",
          targetMap: P.targetMap,
          targetSpawn: P.targetSpawn,
        });
      }
    }
    if (layer.name === "Spawns") {
      for (const o of layer.objects) {
        const P = toPropMap(o.properties);
        spawns[P.id] = {
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
    player.x = spawns[player.spawnId].x;
    player.y = spawns[player.spawnId].y;
  }
  player.spawnId = null;
}

// Convert property arrays to dictionaries.  Tiled represents
// object properties as an array of `{name, value}` pairs; this helper
// converts it to a more convenient object.
function toPropMap(props = []) {
  const out = {};
  for (const p of props) out[p.name] = p.value;
  return out;
}

/* =========================
   STEP 2 — Map rendering
   ========================= */
// Draw all visible tile layers.  The gid may include flip flags, so we
// mask them off and then compute the correct slice from the tileset.
function drawMap() {
  for (const layer of currentMap.layers) {
    if (layer.type !== "tilelayer" || layer.visible === false) continue;
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
// sorted by firstgid ascending, so we return the last tileset whose
// firstgid is <= the gid.
function pickTilesetFor(gid) {
  let best = null;
  for (const ts of tilesetImages) {
    if (gid >= ts.firstgid) best = ts;
  }
  return best;
}

/* =========================
   STEP 3 — Player movement and collision
   ========================= */
// Update the player's position based on input, handling collision with
// solid rectangles.
function updatePlayer(dt) {
  let dx = 0, dy = 0;
  if (isDown("arrowleft") || isDown("a")) dx -= 1;
  if (isDown("arrowright") || isDown("d")) dx += 1;
  if (isDown("arrowup") || isDown("w")) dy -= 1;
  if (isDown("arrowdown") || isDown("s")) dy += 1;
  // Normalize diagonal movement so speed stays consistent
  if (dx !== 0 && dy !== 0) {
    const inv = 1 / Math.sqrt(2);
    dx *= inv;
    dy *= inv;
  }
  const stepX = dx * player.speed * dt;
  const stepY = dy * player.speed * dt;
  // Move horizontally
  player.x += stepX;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (stepX > 0) player.x = r.x - player.w; // push left
      else if (stepX < 0) player.x = r.x + r.w; // push right
    }
  }
  // Move vertically
  player.y += stepY;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (stepY > 0) player.y = r.y - player.h; // push up
      else if (stepY < 0) player.y = r.y + r.h; // push down
    }
  }
}

// AABB overlap test
function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

/* =========================
   STEP 4 — Portal mechanics
   ========================= */
// Check whether the player overlaps any portals.  If so, and the portal
// is auto or the player pressed E, load the target map and set the
// player's spawnId.  The target map path is resolved relative to the
// current map's folder.
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
   STEP 5 — Drawing the player
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

/* =========================
   STEP 6 — Loading overlay
   ========================= */
// Grab the loading element from the DOM.  showLoading() and
// hideLoading() toggle its visibility.  If an error occurs during
// startup we write the message into this element.
const loadingEl = document.getElementById("loading");
function hideLoading() {
  if (loadingEl) loadingEl.style.display = "none";
}
function showLoading() {
  if (loadingEl) loadingEl.style.display = "block";
}

/* =========================
   STEP 7 — Main loop
   ========================= */
function loop(ts) {
  const dt = Math.min(0.032, (ts - lastTime) / 1000);
  lastTime = ts;
  if (currentMap) updatePlayer(dt);
  tryUsePortals().finally(() => { wantUse = false; });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (currentMap) drawMap();
  drawPlayer();
  requestAnimationFrame(loop);
}

/* =========================
   STEP 8 — Boot the game
   ========================= */
// Initialise the player sprite and first map.  Show the loading
// overlay while assets are loading.  Catch and display errors.
(async function start() {
  try {
    showLoading();
    // Load the player's sprite
    await new Promise((resolve, reject) => {
      player.sprite.onload  = resolve;
      player.sprite.onerror = () => reject(new Error("Failed to load player sprite: " + player.spriteSrc));
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