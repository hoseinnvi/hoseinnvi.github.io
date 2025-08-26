/* =========================================================================
   game.js — A tiny, readable top‑down “walk around” engine (fixed version)
   -------------------------------------------------------------------------
   This version extends the original example with support for Tiled flip
   flags and text objects. It masks off the high bits of each gid to
   correctly locate the tile graphic and then applies horizontal,
   vertical and diagonal flips using canvas transforms. It also renders
   any Tiled text objects on top of the tile layers, honouring basic
   formatting options such as font family, size, bold/italic, colour and
   wrapping. Without these changes flipped tiles (e.g. river animations)
   will display incorrectly and labels placed on the map will be absent.

   What this file does:

   1) Loads a Tiled map (your JSON from the "maps" folder).
   2) Draws its tile layers on a <canvas>, handling flipping bits.
   3) Draws text objects from object layers on top of the map.
   4) Moves a little player rectangle with WASD/arrow keys.
   5) Blocks the player with "Collision" rectangles from the map.
   6) Switches maps when the player touches a rectangle in "Portals".
      (Portal objects in Tiled have properties: targetMap, targetSpawn, etc.)
   7) Places the player at points from the "Spawns" layer (by spawn id).

   Tip: search for "STEP" to see the main steps.
   ========================================================================= */


/* =========================
   STEP 0 — Canvas and basics
   ========================= */

// Get a reference to the <canvas id="game"> in index.html
const canvas = document.getElementById("game");

// Ask the browser for a 2D drawing context we can paint pixels on
const ctx = canvas.getContext("2d");

// Each tile in your maps is 16x16 pixels (from your JSON)
const TILE_SIZE = 16;

// Tiled encodes flip flags in the high bits of each gid. These constants
// make it easy to mask and detect the flags. See:
// https://doc.mapeditor.org/en/stable/reference/tmx-map-format/#tile-flipping
const FLIP_H = 0x80000000;    // bit 31 — horizontal flip
const FLIP_V = 0x40000000;    // bit 30 — vertical flip
const FLIP_D = 0x20000000;    // bit 29 — diagonal flip
const GID_MASK = 0x1fffffff;  // lower 29 bits — actual tile id


/* =========================
   STEP 1 — The Player object
   ========================= */

// A super simple "player" represented by a small colored rectangle
const player = {
  x: 0,               // player's X position in pixels (left edge)
  y: 0,               // player's Y position in pixels (top edge)
  w: 12,              // width of the player rectangle
  h: 12,              // height of the player rectangle
  speed: 120,         // how fast the player moves (pixels per second)
  color: "#ffda33",   // the fill colour to draw the player
  spawnId: null       // when we change maps, which spawn point id to use
};


/* ==========================================
   STEP 2 — Game state for the currently loaded
             map and useful things extracted
   ========================================== */

// The whole Tiled map JSON we loaded
let currentMap = null;

// Info for each tileset image used by this map (so we can draw tiles)
let tilesetImages = [];  // each item: { firstgid, columns, img }

// Solid rectangles (walls/furniture) the player can’t walk through
let solidRects = [];     // each item: { x, y, w, h }

// Portals (rectangles) that send the player to another map + spawn
let portals = [];        // each item: { x, y, w, h, auto, prompt, targetMap, targetSpawn }

// Spawns (points) we can place the player at by name
let spawns = {};         // map: id -> { x, y, facing }

// Keyboard state; we’ll set keys["w"] = true while W is held, etc.
const keys = Object.create(null);

// For the animation loop: remember the previous timestamp to compute dt
let lastTime = 0;

// True only for the frame where the user presses "E" (use/enter)
let wantUse = false;


/* ========================================
   STEP 3 — Keyboard input (WASD + arrows + E)
   ======================================== */

// When a key goes down, remember it’s pressed
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase(); // normalize to lowercase ("ArrowUp" -> "arrowup")
  keys[k] = true;
  if (k === "e") wantUse = true; // special one-frame flag for the “use” key
});

// When a key goes up, remember it’s released
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = false;
});

// Helper: is a specific key currently down?
function isDown(k) {
  return !!keys[k];
}


/* =====================================
   STEP 4 — Load a map from /maps/*.json
   ===================================== */

async function loadMap(jsonPath) {
  // 1) Download the JSON file (e.g., "maps/outdoor.json")
  const res = await fetch(jsonPath);
  if (!res.ok) throw new Error(`Failed to load map: ${jsonPath}`);
  const map = await res.json();

  // 2) Set this as the active map and reset state extracted from it
  currentMap = map;
  tilesetImages = [];
  solidRects = [];
  portals = [];
  spawns = {};

  // 3) Size the canvas to match the map (width × tilewidth, height × tileheight)
  canvas.width  = map.width  * map.tilewidth;
  canvas.height = map.height * map.tileheight;

  // 4) Load each tileset image the map references so we can draw tiles later
  //    (Tiled gives us firstgid — the first tile id in that tileset)
  for (const ts of map.tilesets) {
    const img = new Image();
    // Some exported maps include "../" in the image path; strip it so it works on GitHub Pages
    let src = ts.image;
    if (src.startsWith("../")) {
      src = src.substring(3);
    }
    img.src = src; // example: "assets/grounds.png" (path is relative to the JSON)
    // Wait for the image to finish loading (so drawImage won’t fail)
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    // How many columns of tiles are in this image?
    const columns = Math.floor(ts.imagewidth / map.tilewidth);

    // Save only what we need for drawing
    tilesetImages.push({
      firstgid: ts.firstgid, // gid threshold where this tileset starts
      columns,               // how many tiles per row in the image
      img                    // the actual HTMLImageElement
    });
  }

  // 5) Read useful object layers out of the map (Collision, Portals, Spawns)
  for (const layer of map.layers) {
    // Only care about object layers here
    if (layer.type !== "objectgroup") continue;

    if (layer.name === "Collision") {
      // Each object is a rectangle you shouldn’t be able to walk through
      for (const o of layer.objects) {
        solidRects.push({ x: o.x, y: o.y, w: o.width, h: o.height });
      }
    }

    if (layer.name === "Portals") {
      // Portals need their custom properties from Tiled
      for (const o of layer.objects) {
        const P = toPropMap(o.properties);  // convert [{name,value}, …] -> {name:value, …}
        portals.push({
          x: o.x, y: o.y, w: o.width, h: o.height,
          auto: !!P.auto,                            // open automatically on overlap?
          prompt: P.prompt || "E: Enter",            // text to show (you can render later)
          targetMap: P.targetMap,                    // e.g., "maps/indoor.json"
          targetSpawn: P.targetSpawn                 // e.g., "toLibrary"
        });
      }
    }

    if (layer.name === "Spawns") {
      // Spawns are points with an "id" property (and optional facing)
      for (const o of layer.objects) {
        const P = toPropMap(o.properties);
        spawns[P.id] = { x: o.x, y: o.y, facing: P.facing || "down" };
      }
    }
  }

  // 6) If someone asked us to spawn at a specific spawn id, do it now
  if (player.spawnId && spawns[player.spawnId]) {
    player.x = spawns[player.spawnId].x;
    player.y = spawns[player.spawnId].y;
  }
  // Clear spawnId so the next map won’t reuse it by accident
  player.spawnId = null;
}

// Utility: convert Tiled’s property array into a plain object
function toPropMap(props = []) {
  const out = {};
  for (const p of props) out[p.name] = p.value;
  return out;
}


/* ======================================
   STEP 5 — Draw the visible tile layers
   ====================================== */

function drawMap() {
  // Loop through layers in the order Tiled gave them
  for (const layer of currentMap.layers) {
    // Only draw tile layers that are visible
    if (layer.type !== "tilelayer" || layer.visible === false) continue;

    const data = layer.data; // an array of gids (global tile ids)
    const mapWidth = currentMap.width; // number of tiles per row

    // Walk through every cell in this layer
    for (let i = 0; i < data.length; i++) {
      const rawGid = data[i];           // which tile id should be drawn here?
      if (!rawGid) continue;            // 0 means “no tile” — skip

      // Mask off flip flags to get the real tile id
      const gid = rawGid & GID_MASK;
      if (!gid) continue;

      // Find which tileset image this gid belongs to
      const ts = pickTilesetFor(gid);
      if (!ts) continue;

      // Compute the tile’s location INSIDE the tileset image
      // Example: if columns = 10 and localId = 23 => sx = 3*TILE_SIZE, sy = 2*TILE_SIZE
      const localId = gid - ts.firstgid;
      const sx = (localId % ts.columns) * TILE_SIZE;                 // source x in the image
      const sy = Math.floor(localId / ts.columns) * TILE_SIZE;       // source y in the image

      // Compute where on the canvas to draw (dx,dy)
      const dx = (i % mapWidth) * currentMap.tilewidth;              // destination x on canvas
      const dy = Math.floor(i / mapWidth) * currentMap.tileheight;   // destination y on canvas

      // Determine flip flags
      let flipHFlag = (rawGid & FLIP_H) !== 0;
      let flipVFlag = (rawGid & FLIP_V) !== 0;
      let flipDFlag = (rawGid & FLIP_D) !== 0;

      // Save the current transform before applying flips
      ctx.save();
      // Translate to the centre of the tile for rotation/flip
      ctx.translate(dx + currentMap.tilewidth / 2, dy + currentMap.tileheight / 2);

      // Handle diagonal flip: rotate 90° and swap H/V flips
      if (flipDFlag) {
        ctx.rotate(Math.PI / 2);
        const tmp = flipHFlag;
        flipHFlag = flipVFlag;
        flipVFlag = tmp;
      }

      // Apply horizontal and vertical flips
      ctx.scale(flipHFlag ? -1 : 1, flipVFlag ? -1 : 1);

      // Draw one tile-sized rectangle from the tileset image to the canvas
      // with the origin at the centre so flips work as expected
      ctx.drawImage(
        ts.img,
        sx,
        sy,
        TILE_SIZE,
        TILE_SIZE,
        -currentMap.tilewidth / 2,
        -currentMap.tileheight / 2,
        currentMap.tilewidth,
        currentMap.tileheight
      );
      ctx.restore();
    }
  }
}

// Given a gid, return the tileset whose range includes that gid
function pickTilesetFor(gid) {
  // tilesets are sorted by firstgid; pick the last one where firstgid <= gid
  let best = null;
  for (const ts of tilesetImages) {
    if (gid >= ts.firstgid) best = ts;
  }
  return best;
}


/* ===================================================
   STEP 5b — Draw text objects on top of tile layers
   =================================================== */

function drawText() {
  if (!currentMap) return;
  // Iterate over all object groups and render any text objects
  for (const layer of currentMap.layers) {
    if (layer.type !== "objectgroup" || !layer.objects) continue;
    for (const obj of layer.objects) {
      // Only render visible objects with a text property
      if (!obj.visible || !obj.text) continue;
      const t = obj.text;
      // Build font string honouring bold/italic
      const size = t.pixelsize || 16;
      const family = t.fontfamily || "sans-serif";
      const weight = t.bold ? "bold " : "";
      const style = t.italic ? "italic " : "";
      ctx.font = `${style}${weight}${size}px ${family}`;
      ctx.fillStyle = t.color || "#ffffff";
      // Text alignment: default to left; map Tiled halign values
      ctx.textAlign = t.halign || "left";
      // Vertical alignment: use baseline defaults; map Tiled valign if present
      switch ((t.valign || "top").toLowerCase()) {
        case "center":
          ctx.textBaseline = "middle";
          break;
        case "bottom":
          ctx.textBaseline = "bottom";
          break;
        default:
          ctx.textBaseline = "top";
          break;
      }
      // Compute position. In Tiled, text objects’ x,y mark the top-left corner.
      // We adjust y by the baseline for top alignment when no object.height.
      let x = obj.x;
      let y = obj.y;
      if (ctx.textBaseline === "top") {
        // shift down by nothing; baseline is at top
      } else if (ctx.textBaseline === "middle") {
        y = obj.y + (obj.height || size) / 2;
      } else if (ctx.textBaseline === "bottom") {
        y = obj.y + (obj.height || size);
      }
      const text = t.text || "";
      // If wrapping is enabled and width provided, manually wrap lines
      if (t.wrap && obj.width) {
        const words = text.split(/\s+/);
        let line = "";
        let yOffset = 0;
        for (const word of words) {
          const testLine = line.length ? line + " " + word : word;
          const metrics = ctx.measureText(testLine);
          if (metrics.width > obj.width && line.length) {
            ctx.fillText(line, x, y + yOffset);
            line = word;
            yOffset += size;
          } else {
            line = testLine;
          }
        }
        if (line.length) ctx.fillText(line, x, y + yOffset);
      } else {
        ctx.fillText(text, x, y);
      }
    }
  }
}


/* ===========================================
   STEP 6 — Move the player, stop at collisions
   =========================================== */

function updatePlayer(dt) {
  // 1) Read input and decide direction to move
  let dx = 0, dy = 0;
  if (isDown("arrowleft")  || isDown("a")) dx -= 1;
  if (isDown("arrowright") || isDown("d")) dx += 1;
  if (isDown("arrowup")    || isDown("w")) dy -= 1;
  if (isDown("arrowdown")  || isDown("s")) dy += 1;

  // 2) If moving diagonally, normalize so diagonal isn’t faster
  if (dx !== 0 && dy !== 0) {
    const inv = 1 / Math.sqrt(2);
    dx *= inv; dy *= inv;
  }

  // 3) Compute how far to move this frame (speed × time)
  const stepX = dx * player.speed * dt;
  const stepY = dy * player.speed * dt;

  // 4) Move horizontally first, then resolve overlaps with solids
  player.x += stepX;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      // If we moved right into a wall, stick to the left edge of the wall
      if (stepX > 0) player.x = r.x - player.w;
      // If we moved left into a wall, stick to the right edge of the wall
      else if (stepX < 0) player.x = r.x + r.w;
    }
  }

  // 5) Move vertically next, then resolve overlaps again
  player.y += stepY;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (stepY > 0) player.y = r.y - player.h; // moved down into a wall -> place above it
      else if (stepY < 0) player.y = r.y + r.h; // moved up into a wall -> place below it
    }
  }
}

// Axis-aligned rectangle overlap test (classic AABB collision)
function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}


/* ====================================================
   STEP 7 — Check portals (maybe load a different map)
   ==================================================== */

async function tryUsePortals() {
  for (const p of portals) {
    if (!overlap(player, p)) continue;     // must be touching the portal

    // If portal is automatic OR the player pressed E this frame -> use it
    if (p.auto || wantUse) {
      player.spawnId = p.targetSpawn;      // remember where to appear in the next map
      await loadMap(p.targetMap);          // actually load the next map (async)
      break;                               // stop after using one portal this frame
    }
  }

  // Reset the one-frame “use” flag
  wantUse = false;
}


/* =====================================
   STEP 8 — Main game loop (every frame)
   ===================================== */

function loop(timestamp) {
  // Compute time since the previous frame (in seconds)
  const dt = Math.min(0.032, (timestamp - lastTime) / 1000); // clamp, avoids big jumps
  lastTime = timestamp;

  // Update
  if (currentMap) {
    updatePlayer(dt);   // move the player & resolve collisions
  }
  tryUsePortals();      // maybe switch maps if we’re on a portal

  // Draw
  ctx.clearRect(0, 0, canvas.width, canvas.height); // wipe previous frame
  if (currentMap) {
    drawMap();   // draw tiles with flip handling
    drawText();  // draw any text objects above tiles
  }
  drawPlayer();                                     // draw the player on top

  // Ask the browser for the next frame
  requestAnimationFrame(loop);
}

// Draw the little yellow player rectangle
function drawPlayer() {
  ctx.fillStyle = player.color;
  ctx.fillRect(Math.round(player.x), Math.round(player.y), player.w, player.h);
}


/* ======================================
   STEP 9 — Boot the game (start everything)
   ======================================
*/

(async function start() {
  // Start the adventure on the Outdoor map at spawn "toOut"
  player.spawnId = "toOut";
  await loadMap("maps/outdoor.json");

  // Kick off the loop
  requestAnimationFrame((t) => { lastTime = t; loop(t); });
})();