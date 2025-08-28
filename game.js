/* =========================================================================
   game.js — A tiny, readable top-down “walk around” engine (improved)
   ========================================================================*/

/* =========================
   STEP 0 — Canvas and basics
   ========================= */
const canvas = document.getElementById("game");
const ctx    = canvas.getContext("2d");

const FLIP_H  = 0x80000000;
const FLIP_V  = 0x40000000;
const FLIP_D  = 0x20000000;
const GID_MASK = ~(FLIP_H | FLIP_V | FLIP_D) >>> 0;

// Character scale & speed
const CHARACTER_SCALE = 3;         // make the character 2x/3x larger
const FRAME_W = 16, FRAME_H = 16;  // your sheet is 3×4 frames of 16×16
const PLAYER_W = FRAME_W * CHARACTER_SCALE;
const PLAYER_H = FRAME_H * CHARACTER_SCALE;
const SPEED    = 100; // px/s

// Simple 3-frame walk animation timing
const ANIM_FPS = 8;          // frames per second while walking
const ANIM_LEN = 3;          // 3 columns per row
let animTime = 0;            // accumulates dt

// Player state
const player = {
  x: 0, y: 0, w: PLAYER_W, h: PLAYER_H,
  vx: 0, vy: 0,
  spawnId: null,
  facing: "down",
  sprite: new Image(),
  // NOTE: filename uses dash like your asset: F-01.png
  spriteSrc: "./assets/characters/F-01.png",
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

// Path helpers
function dirname(path) {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx + 1) : "";
}
function join(base, rel) {
  if (/^(https?:)?\//.test(rel)) return rel; // absolute or protocol-relative
  if (rel.startsWith("maps/")) return rel;
  return base + rel;
}

// Keyboard
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

async function loadMap(jsonPath) {
  const res = await fetch(jsonPath);
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

  // --- Preload images for Image Layers
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

  // --- Extract object layers
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

  // Place player at chosen spawn (feet on point, centered)
  if (player.spawnId && spawns[player.spawnId]) {
    const s = spawns[player.spawnId];
    player.x = Math.round(s.x - player.w / 2);
    player.y = Math.round(s.y - player.h);
    player.facing = s.facing || "down";
    player.spawnId = null;
  }

  // Ensure sprite is loaded
  if (!player.sprite.src) {
    player.sprite.src = player.spriteSrc;
    await player.sprite.decode?.().catch(() => {});
  }
}

/* =========================
   STEP 2 — Map rendering
   ========================= */
function drawMap() {
  for (const layer of currentMap.layers) {
    if (layer.visible === false) continue;

    // Image layers (e.g., composite NPCs)
    if (layer.type === "imagelayer" && layer._img) {
      ctx.save();
      if (typeof layer.opacity === "number") ctx.globalAlpha = layer.opacity;
      const ox = layer.offsetx || 0, oy = layer.offsety || 0;
      ctx.drawImage(layer._img, Math.round(ox), Math.round(oy));
      ctx.restore();
      continue;
    }

    // Tile layers
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
        ctx.save();
        // (Optional) apply flips based on rawGid & FLIP_* if needed
        ctx.drawImage(
          ts.img,
          sx, sy,
          currentMap.tilewidth, currentMap.tileheight,
          dx, dy,
          currentMap.tilewidth, currentMap.tileheight
        );
        ctx.restore();
      }
      continue;
    }

    // NEW: Draw Tiled Text Objects from any Object Layer
    if (layer.type === "objectgroup" && layer.objects?.length) {
      for (const o of layer.objects) {
        if (!o.text) continue; // only handle text objects here
        drawTiledTextObject(o, layer);
      }
      continue;
    }
  }
}

// Render a Tiled text object (font, size, wrap, color, alignment)
function drawTiledTextObject(o, layer) {
  const t = o.text;
  if (!t || t.text == null) return;

  ctx.save();

  // Opacity from layer
  if (typeof layer.opacity === "number") ctx.globalAlpha = layer.opacity;

  // Font
  const size = (t.pixelsize || 16);
  const family = t.fontfamily || "sans-serif";
  const weight = t.bold ? "bold" : "normal";
  const style  = t.italic ? "italic" : "normal";
  ctx.font = `${style} ${weight} ${size}px ${family}`;

  // Color (Tiled stores as #AARRGGBB or #RRGGBB; handle both)
  let color = t.color || "#000000";
  if (color.startsWith("#") && color.length === 9) {
    // #AARRGGBB -> set fillStyle with RGBA
    const a = parseInt(color.slice(1, 3), 16) / 255;
    const r = parseInt(color.slice(3, 5), 16);
    const g = parseInt(color.slice(5, 7), 16);
    const b = parseInt(color.slice(7, 9), 16);
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
  } else {
    ctx.fillStyle = color;
  }

  // Alignment
  const h = t.halign || "left";   // "left"|"center"|"right"|"justify"
  const v = t.valign || "top";    // "top"|"center"|"bottom"
  if (h === "center") ctx.textAlign = "center";
  else if (h === "right" || h === "justify") ctx.textAlign = "right";
  else ctx.textAlign = "left";

  if (v === "center") ctx.textBaseline = "middle";
  else if (v === "bottom") ctx.textBaseline = "bottom";
  else ctx.textBaseline = "top";

  // Position & wrapping
  const x = Math.round(o.x);
  const y = Math.round(o.y);
  const maxW = o.width || undefined;

  // Outline if requested
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

// Simple word-wrap helper for canvas text
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

/* =========================
   STEP 3 — Movement & collision
   ========================= */
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

  // Update facing
  if (vx < 0) player.facing = "left";
  else if (vx > 0) player.facing = "right";
  else if (vy < 0) player.facing = "up";
  else if (vy > 0) player.facing = "down";

  // Advance walk animation only while moving
  if (vx || vy) animTime += dt;
  else animTime = 0; // idle -> middle frame

  // Move on X, resolve
  player.x += player.vx * dt;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (player.vx > 0) player.x = r.x - player.w;
      else if (player.vx < 0) player.x = r.x + r.w;
    }
  }
  // Move on Y, resolve
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

/* =========================
   STEP 4 — Portals & spawns
   ========================= */
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
// Map facing to row in your 3×4 sprite sheet
function rowForFacing(facing) {
  switch (facing) {
    case "down":  return 0;
    case "left":  return 1;
    case "right": return 2;
    case "up":    return 3;
    default:      return 0;
  }
}

function currentAnimCol() {
  // idle -> middle frame (col 1)
  if (!(player.vx || player.vy)) return 1;
  // walking -> cycle 0,1,2 at ANIM_FPS
  const frame = Math.floor(animTime * ANIM_FPS) % ANIM_LEN;
  return frame;
}

function drawPlayer() {
  const col = currentAnimCol();
  const row = rowForFacing(player.facing);
  const sx = col * FRAME_W;
  const sy = row * FRAME_H;

  ctx.drawImage(
    player.sprite,
    sx, sy, FRAME_W, FRAME_H,              // source frame (UNSCALED)
    Math.round(player.x), Math.round(player.y), // destination
    player.w, player.h                      // scaled size
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
    await new Promise((res) => {
      player.sprite.addEventListener("load", res, { once: true });
      player.sprite.src = player.spriteSrc; // "./assets/characters/F-01.png"
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

window.addEventListener("unhandledrejection", ev => {
  console.error("Unhandled promise rejection:", ev.reason);
  if (loadingEl) loadingEl.textContent = "Error: " + (ev.reason?.message || ev.reason);
});
window.addEventListener("error", ev => {
  console.error("Window error:", ev.error || ev.message);
});
