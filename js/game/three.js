// Single point of truth for where three.js lives. Every game module imports
// three from here, so moving or upgrading the vendored copy is a one-line edit.
//
// Note: three.module.min.js imports ./three.core.min.js by relative path, so
// both files must exist side by side AND both must be in the service worker's
// precache list — otherwise the game works online and shows a blank screen
// offline.
export * from '../../vendor/three/three.module.min.js';
