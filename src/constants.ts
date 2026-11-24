/**
 * Regex
 */
export const REGEX_FILE_EXTENSION = /\.[^/\\.]+$/
export const REGEX_LEADING_SLASHES = /^[\\/]+/
export const REGEX_TRAILING_SLASHES = /[\\/]+$/

/**
 * Scene
 */

export const SCENE_FILE_CURRENT_VERSION = '0.0.1'
export const SCENE_FILE_TYPE_NAME = '2D Map Editor Scene' // or when standardised: 2D Transmission Format
export const SCENE_FILE_TYPE_EXTENSION = '2dtf'

/**
 * Clipboard
 */

// Visible offset (in canvas units) applied to pasted copies so they never
// fully overlap the sprites they were duplicated from.
export const PASTE_POSITION_OFFSET = 20
