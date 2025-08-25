/*
 * Minimal top‑down engine for navigating a set of Tiled maps.
 *
 * This script parses the JSON exported from Tiled (TMX) and draws
 * tile layers to a Canvas. It also supports simple collision
 * detection against rectangles defined in an object layer named
 * "Collision" and allows transitions between maps via objects in
 * an object layer named "Portals". When the player touches a
 * portal, the target map is loaded and the player is placed at
 * the corresponding spawn point defined in a "Spawns" layer.
 *
 * The intent of this file is to provide a starting point for
 * building an interactive résumé. You can enhance it by adding
 * animated sprites, UI elements, hotspots, or modal dialogs as
 * described in conversation. For now, the player is represented
 * by a simple coloured square.
 */

(function() {
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const loadingEl = document.getElementById('loading');

    // Track keyboard state
    const keys = {};
    window.addEventListener('keydown', (e) => {
        keys[e.key] = true;
    });
    window.addEventListener('keyup', (e) => {
        keys[e.key] = false;
    });

    // Player representation. Adjust width/height to match your sprite size.
    const player = {
        x: 0,
        y: 0,
        width: 16,
        height: 16,
        speed: 100, // pixels per second
        color: '#e74c3c'
    };

    // Current map state
    let currentMap = null;
    let tilesets = [];
    let colliders = [];
    let portals = [];
    let spawns = {};

    /**
     * Load an image from a relative path. Returns a Promise that
     * resolves when the image has finished loading.
     *
     * @param {string} src Path to the image relative to index.html
     */
    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    /**
     * Load tile set images defined in the Tiled map. Adjust
     * relative paths so they resolve correctly when hosted on
     * GitHub Pages (assets live next to maps folder).
     *
     * @param {Object} map The parsed Tiled map
     */
    async function loadTilesets(map) {
        tilesets = [];
        for (const ts of map.tilesets) {
            // Compute the relative path to the PNG. In exported maps
            // from Tiled, paths often include "../". We strip those
            // because index.html lives at the project root.
            let imgPath = ts.image || '';
            if (imgPath.startsWith('../')) {
                imgPath = imgPath.substring(3);
            }
            const img = await loadImage(imgPath);
            const tileWidth = ts.tilewidth || map.tilewidth;
            const tileHeight = ts.tileheight || map.tileheight;
            const columns = Math.max(1, Math.floor(img.width / tileWidth));
            tilesets.push({
                firstgid: ts.firstgid,
                image: img,
                tileWidth,
                tileHeight,
                columns
            });
        }
        // Sort by firstgid to ease lookup
        tilesets.sort((a, b) => a.firstgid - b.firstgid);
    }

    /**
     * Given a global tile ID, find the corresponding tileset.
     * Returns null if no suitable tileset is found.
     *
     * @param {number} gid The global tile ID
     */
    function findTileset(gid) {
        let selected = null;
        for (const ts of tilesets) {
            if (gid >= ts.firstgid) {
                selected = ts;
            } else {
                break;
            }
        }
        return selected;
    }

    /**
     * Parse object layers from a Tiled map and populate collision
     * boxes, portals, and spawn points.
     *
     * @param {Object} map The parsed Tiled map
     */
    function parseObjects(map) {
        colliders = [];
        portals = [];
        spawns = {};
        for (const layer of map.layers) {
            if (layer.type !== 'objectgroup' || !layer.objects) continue;
            if (layer.name === 'Collision') {
                for (const obj of layer.objects) {
                    if (!obj.visible) continue;
                    colliders.push({
                        x: obj.x,
                        y: obj.y,
                        width: obj.width,
                        height: obj.height
                    });
                }
            } else if (layer.name === 'Portals') {
                for (const obj of layer.objects) {
                    const props = {};
                    for (const p of obj.properties || []) {
                        props[p.name] = p.value;
                    }
                    portals.push({
                        x: obj.x,
                        y: obj.y,
                        width: obj.width,
                        height: obj.height,
                        targetMap: props.targetMap,
                        targetSpawn: props.targetSpawn,
                        auto: props.auto || false
                    });
                }
            } else if (layer.name === 'Spawns') {
                for (const obj of layer.objects) {
                    const props = {};
                    for (const p of obj.properties || []) {
                        props[p.name] = p.value;
                    }
                    spawns[props.id] = {
                        x: obj.x,
                        y: obj.y,
                        facing: props.facing
                    };
                }
            }
        }
    }

    /**
     * Draw the loaded map to the canvas. Iterates over all tile
     * layers in the order defined in the map file. Ignores image
     * layers and text layers for now.
     */
    function drawMap() {
        if (!currentMap) return;
        for (const layer of currentMap.layers) {
            if (layer.type === 'tilelayer' && layer.visible !== false) {
                const data = layer.data;
                const width = layer.width || currentMap.width;
                const height = layer.height || currentMap.height;
                for (let row = 0; row < height; row++) {
                    for (let col = 0; col < width; col++) {
                        const gid = data[row * width + col];
                        if (gid === 0) continue;
                        const ts = findTileset(gid);
                        if (!ts) continue;
                        const localId = gid - ts.firstgid;
                        const sx = (localId % ts.columns) * ts.tileWidth;
                        const sy = Math.floor(localId / ts.columns) * ts.tileHeight;
                        const dx = col * currentMap.tilewidth;
                        const dy = row * currentMap.tileheight;
                        ctx.drawImage(
                            ts.image,
                            sx,
                            sy,
                            ts.tileWidth,
                            ts.tileHeight,
                            dx,
                            dy,
                            currentMap.tilewidth,
                            currentMap.tileheight
                        );
                    }
                }
            }
        }
    }

    /**
     * Axis‑aligned bounding box collision check.
     */
    function rectsOverlap(a, b) {
        return (
            a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y
        );
    }

    /**
     * Update the player's position based on pressed keys and
     * prevent movement into solid objects.
     *
     * @param {number} dt Delta time in seconds since last frame
     */
    function handleMovement(dt) {
        let dx = 0;
        let dy = 0;
        // WASD/arrow controls
        if (keys['ArrowLeft'] || keys['a'] || keys['A']) dx -= player.speed * dt;
        if (keys['ArrowRight'] || keys['d'] || keys['D']) dx += player.speed * dt;
        if (keys['ArrowUp'] || keys['w'] || keys['W']) dy -= player.speed * dt;
        if (keys['ArrowDown'] || keys['s'] || keys['S']) dy += player.speed * dt;
        // Construct hypothetical next position
        const next = {
            x: player.x + dx,
            y: player.y + dy,
            width: player.width,
            height: player.height
        };
        // Collision detection: if intersects any solid, cancel that axis
        for (const box of colliders) {
            if (rectsOverlap(next, box)) {
                // determine which axis triggered the collision
                // To keep things simple, cancel both movement components
                dx = 0;
                dy = 0;
                break;
            }
        }
        player.x += dx;
        player.y += dy;
        // Clamp to map bounds
        const maxX = currentMap.width * currentMap.tilewidth - player.width;
        const maxY = currentMap.height * currentMap.tileheight - player.height;
        player.x = Math.max(0, Math.min(player.x, maxX));
        player.y = Math.max(0, Math.min(player.y, maxY));
        // Portal detection: if the player collides with a portal, switch maps
        for (const portal of portals) {
            if (rectsOverlap(player, portal)) {
                loadNextMap(portal.targetMap, portal.targetSpawn);
                return;
            }
        }
    }

    /**
     * Draw the player. Replace this with sprite drawing to add
     * animation or directional frames.
     */
    function drawPlayer() {
        ctx.fillStyle = player.color;
        ctx.fillRect(player.x, player.y, player.width, player.height);
    }

    // Main animation loop
    let lastTime = 0;
    function loop(timestamp) {
        const dt = (timestamp - lastTime) / 1000;
        lastTime = timestamp;
        if (currentMap) {
            handleMovement(dt);
            // Clear the canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            // Draw order: map first, then player
            drawMap();
            drawPlayer();
        }
        requestAnimationFrame(loop);
    }

    /**
     * Load the given map and set the player's starting position
     * according to the spawnId. If no spawnId is provided or
     * found, the player is placed at 0,0.
     *
     * @param {string} mapPath Path to the map JSON relative to index.html
     * @param {string} spawnId ID of the spawn point in the new map
     */
    async function loadNextMap(mapPath, spawnId) {
        loadingEl.style.display = 'block';
        try {
            const response = await fetch(mapPath);
            if (!response.ok) {
                throw new Error(`Failed to load map ${mapPath}: ${response.statusText}`);
            }
            const map = await response.json();
            currentMap = map;
            await loadTilesets(map);
            parseObjects(map);
            // Adjust canvas size to map size
            canvas.width = map.width * map.tilewidth;
            canvas.height = map.height * map.tileheight;
            // Determine spawn position
            const spawn = spawns[spawnId] || Object.values(spawns)[0];
            if (spawn) {
                player.x = spawn.x;
                player.y = spawn.y;
            } else {
                player.x = 0;
                player.y = 0;
            }
        } catch (err) {
            console.error(err);
        } finally {
            loadingEl.style.display = 'none';
        }
    }

    // Kick things off once the window has loaded
    window.addEventListener('load', () => {
        // Start with the outdoor map at the specified spawn
        loadNextMap('maps/outdoor.json', 'toOut').then(() => {
            lastTime = performance.now();
            requestAnimationFrame(loop);
        });
    });
})();