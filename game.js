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
