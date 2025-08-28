/* =========================================================================
   game.js — A tiny, readable top‑down “walk around” engine (fixed version)
   -------------------------------------------------------------------------

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
const canvas= document.getElementById(("game"));
const ctx= canvas.getContext("2d");
const TILE_SIZE=16;

const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;
const FLIP_D = 0x20000000;
const GID_MASK = 0x1fffffff;

const player = {
  x:0,
  y:0,
  w:16,
  h:16,
  speed:120,
  sprite: new Image(),
  spriteSrc:  "characters/F_01.png",
  spawnId: "toHouse"
};

let currentMap= null;
let tilesetImages= [];
let solidRects=[];
let portals=[];
let spawns={};

const keys=Object.create(null);

let lastTime=0;
let wantUse=false;

// keyboard setup
window.addEventListener("keydown", (e)=>{
  const k= e.key.toLowerCase();
  keys[k]=true;
  if (k==="e") wantUse=true;
});

function isDown(k) {
  return !!keys[k];
}

//loading the map function
async function loadMap(jsonPath) {
  // jsonPath example: "maps/outdoor.json"
  const res = await fetch(jsonPath);
  if (!res.ok) throw new Error(`Failed to load map: ${jsonPath}`);
  const map = await res.json();

  currentMap = map;
  tilesetImages = [];
  solidRects = [];
  portals = [];
  spawns = {};

  // Canvas size matches map size
  canvas.width = map.width * map.tilewidth;
  canvas.height = map.height * map.tileheight;

  // --- Load tileset images
  // Each tileset has an image path relative to the JSON file.
  for (const ts of map.tilesets) {
    const img = new Image();
    img.src = ts.image; // e.g., "../assets/grounds.png"
    // Ensure the image is loaded before we draw
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

  // --- Extract object layers: Collision, Portals, Spawns
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

  // --- Place the player at the requested spawn (if any)
  if (player.spawnId && spawns[player.spawnId]) {
    player.x = spawns[player.spawnId].x;
    player.y = spawns[player.spawnId].y;
  }
  // Clear it so future loads don’t reuse automatically
  player.spawnId = null;
}

// tiny helper: convert [{name, value}, ...] to {name:value, ...}
function toPropMap(props = []) {
  const out = {};
  for (const p of props) out[p.name] = p.value;
  return out;
}

/////////////////////////////
// 4) Drawing tiles
/////////////////////////////
function drawMap() {
  // draw only visible tile layers in order
  for (const layer of currentMap.layers) {
    if (layer.type !== "tilelayer" || layer.visible === false) continue;

    const data = layer.data; // array of gids
    for (let i = 0; i < data.length; i++) {
      const gid = data[i];
      if (!gid) continue; // 0 is empty tile

      const ts = pickTilesetFor(gid);
      if (!ts) continue;

      const localId = gid - ts.firstgid; // index within the tileset image
      const sx = (localId % ts.columns) * TILE_SIZE;
      const sy = Math.floor(localId / ts.columns) * TILE_SIZE;

      const dx = (i % currentMap.width) * TILE_SIZE;
      const dy = Math.floor(i / currentMap.width) * TILE_SIZE;

      ctx.drawImage(ts.img, sx, sy, TILE_SIZE, TILE_SIZE, dx, dy, TILE_SIZE, TILE_SIZE);
    }
  }
}

function pickTilesetFor(gid) {
  // tilesets are sorted by firstgid ascending; pick the last one whose firstgid <= gid
  let best = null;
  for (const ts of tilesetImages) {
    if (gid >= ts.firstgid) best = ts;
  }
  return best;
}

/////////////////////////////
// 5) Player movement & collision
/////////////////////////////
function updatePlayer(dt) {
  let dx = 0, dy = 0;
  if (isDown("arrowleft") || isDown("a")) dx -= 1;
  if (isDown("arrowright") || isDown("d")) dx += 1;
  if (isDown("arrowup") || isDown("w")) dy -= 1;
  if (isDown("arrowdown") || isDown("s")) dy += 1;

  // Normalize diagonal movement
  if (dx !== 0 && dy !== 0) {
    const inv = 1 / Math.sqrt(2);
    dx *= inv; dy *= inv;
  }

  const stepX = dx * player.speed * dt;
  const stepY = dy * player.speed * dt;

  // Move on X, resolve collisions
  player.x += stepX;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      // push back out in the direction we moved
      if (stepX > 0) player.x = r.x - player.w;            // push left
      else if (stepX < 0) player.x = r.x + r.w;            // push right
    }
  }

  // Move on Y, resolve collisions
  player.y += stepY;
  for (const r of solidRects) {
    if (overlap(player, r)) {
      if (stepY > 0) player.y = r.y - player.h;            // push up
      else if (stepY < 0) player.y = r.y + r.h;            // push down
    }
  }
}

function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

/////////////////////////////
// 6) Portals (map switching)
/////////////////////////////
async function tryUsePortals() {
  for (const p of portals) {
    if (overlap(player, p)) {
      // Use if auto or player pressed E this frame
      if (p.auto || wantUse) {
        player.spawnId = p.targetSpawn;       // where to appear in the next map
        await loadMap(p.targetMap);           // load the new map
        break;                                // only 1 portal per frame
      }
    }
  }
}

/////////////////////////////
// 7) Main loop
/////////////////////////////
function loop(ts) {
  const dt = Math.min(0.032, (ts - lastTime) / 1000); // clamp to avoid huge steps
  lastTime = ts;

  // Update
  if (currentMap) {
    updatePlayer(dt);
  }

  // Use key (E) lasts only 1 frame
  tryUsePortals().finally(() => { wantUse = false; });

  // Draw
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (currentMap) drawMap();
  drawPlayer();

  requestAnimationFrame(loop);
}

function drawPlayer() {
  // We'll draw a character sprite instead of a solid rectangle
  ctx.drawImage(
    player.sprite, // The image to draw
    0, // x-coordinate of the top-left corner of the source frame
    0, // y-coordinate of the top-left corner of the source frame
    player.w, // width of the source frame
    player.h, // height of the source frame
    Math.round(player.x), // x-coordinate of the destination on the canvas
    Math.round(player.y), // y-coordinate of the destination on the canvas
    player.w, // width of the destination on the canvas
    player.h // height of the destination on the canvas
  );
}

/////////////////////////////
// 8) Boot the game
/////////////////////////////
(async function start() {
  // Load the player's sprite image
  player.sprite.src = player.spriteSrc;
  await new Promise((resolve) => {
    player.sprite.onload = resolve;
  });

  player.spawnId = "toOut";
  await loadMap("maps/outdoor.json");

  requestAnimationFrame((t) => {
    lastTime = t;
    loop(t);
  });
})();
