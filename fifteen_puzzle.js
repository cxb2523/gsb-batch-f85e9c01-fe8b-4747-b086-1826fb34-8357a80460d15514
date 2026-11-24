/**
 * 15-Puzzle Game Engine
 * Refined and Object-Oriented for maximum robustness and performance.
 */
class FifteenPuzzle {
    constructor(config, containerId = 'fifteen') {
        this.config = config;
        this.container = document.getElementById(containerId);
        
        // Backward compatibility for original grid setup (e.g. grid:[3,4] means 4x5)
        this.cols = this.config.grid[0] + 1;
        this.rows = this.config.grid[1] + 1;
        
        this.tileWidth = this.config.size[0] / this.cols;
        this.tileHeight = this.config.size[1] / this.rows;
        
        this.matrix = [];
        this.tiles = {};
        this.emptyPos = { x: 0, y: 0 };
        this.isPlaying = false;
        this.destroyed = false;

        this.gamepadLoop = null;
        this.lastGamepadState = false;

        // Keep references to every listener and pending asynchronous task so
        // destroy() can release exactly the resources owned by this instance.
        this.tileClickHandlers = {};
        this.timeoutIds = new Set();
        this.animationFrameIds = new Set();
        this.shuffleTimeout = null;
        this.winTimeout = null;

        this.keyDownHandler = (event) => this.handleKeyDown(event);
        this.resizeHandler = () => this.handleResize();
        this.gamepadConnectedHandler = (event) => this.handleGamepadConnected(event);

        this.init();
    }

    init() {
        if (!this.container) return console.error("Puzzle container not found.");
        
        // Setup container
        this.container.innerHTML = "";
        this.container.style.width = `${this.config.size[0]}px`;
        this.container.style.height = `${this.config.size[1]}px`;
        this.container.style.position = 'relative';

        // Setup resize handling
        this.resizeListenerAttached = false;
        if (this.config.fill) {
            this.addResizeListener();
            this.handleResize();
        } else {
            this.container.style.transform = "scale(1)";
        }

        const emptySlotTarget = this.config.emptySlot || (this.rows * this.cols);
        let idCounter = 1;

        // Generate Grid Matrix and DOM Elements
        for (let y = 0; y < this.rows; y++) {
            this.matrix[y] = [];
            for (let x = 0; x < this.cols; x++) {
                if (idCounter !== emptySlotTarget) {
                    this.matrix[y][x] = idCounter;
                    this.createDOMTile(idCounter, x, y);
                    idCounter++;
                } else {
                    this.matrix[y][x] = 0; // 0 represents the empty slot
                    this.emptyPos = { x, y };
                    idCounter++;
                }
            }
        }

        // Shuffle and bind inputs
        this.shuffle();
        this.bindInputs();
    }

    createDOMTile(id, x, y) {
        const tile = document.createElement("div");
        tile.className = "slot";
        
        if (this.config.number) tile.innerHTML = id;

        // Setup styling safely
        const bgSize = this.config.art.ratio ? `${this.config.size[0]}px auto` : `auto ${this.config.size[1]}px`;
        const customStyle = this.config.style ? this.config.style : "";
        
        tile.style.cssText = `
            position: absolute;
            width: ${this.tileWidth}px;
            height: ${this.tileHeight}px;
            background-image: url('${this.config.art.url}');
            background-size: ${bgSize};
            background-position: -${this.tileWidth * x}px -${this.tileHeight * y}px;
            cursor: pointer;
            ${customStyle}
        `;

        const clickHandler = () => {
            if (!this.destroyed) this.handleTileClick(id);
        };
        this.tileClickHandlers[id] = clickHandler;
        tile.addEventListener("click", clickHandler);
        this.container.appendChild(tile);
        this.tiles[id] = tile;
    }

    shuffle() {
        let prevEmpty = { x: -1, y: -1 };
        
        for (let i = 0; i < this.config.diff; i++) {
            const neighbors = [];
            const { x, y } = this.emptyPos;

            // Find valid neighbors (avoiding immediate reverse moves)
            if (x > 0 && prevEmpty.x !== x - 1) neighbors.push({ x: x - 1, y });
            if (x < this.cols - 1 && prevEmpty.x !== x + 1) neighbors.push({ x: x + 1, y });
            if (y > 0 && prevEmpty.y !== y - 1) neighbors.push({ x, y: y - 1 });
            if (y < this.rows - 1 && prevEmpty.y !== y + 1) neighbors.push({ x, y: y + 1 });

            // Pick random neighbor and swap
            const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
            prevEmpty = { x: this.emptyPos.x, y: this.emptyPos.y };
            
            this.matrix[this.emptyPos.y][this.emptyPos.x] = this.matrix[pick.y][pick.x];
            this.matrix[pick.y][pick.x] = 0;
            this.emptyPos = pick;
        }

        this.updateDOM(false); // Update without animation

        // Enable transitions after shuffle
        this.shuffleTimeout = this.setManagedTimeout(() => {
            this.shuffleTimeout = null;
            this.isPlaying = true;
            Object.values(this.tiles).forEach(tile => {
                if (this.config.time) tile.style.transition = `all ${this.config.time}s ease`;
            });
        }, 50);
    }

    setManagedTimeout(callback, delay) {
        if (this.destroyed) return null;

        let id;
        id = setTimeout(() => {
            this.timeoutIds.delete(id);
            if (!this.destroyed) callback();
        }, delay);

        if (id === undefined || id === null) return null;
        this.timeoutIds.add(id);
        return id;
    }

    setManagedAnimationFrame(callback) {
        if (this.destroyed || typeof requestAnimationFrame !== "function") return null;

        let id;
        id = requestAnimationFrame((timestamp) => {
            this.animationFrameIds.delete(id);
            if (!this.destroyed) callback(timestamp);
        });

        if (id === undefined || id === null) return null;
        this.animationFrameIds.add(id);
        return id;
    }

    handleTileClick(id) {
        if (this.destroyed || !this.isPlaying) return;

        let target = null;
        for (let y = 0; y < this.rows; y++) {
            for (let x = 0; x < this.cols; x++) {
                if (this.matrix[y][x] === id) target = { x, y };
            }
        }
        if (target) this.moveTile(target.x, target.y);
    }

    // Allows sliding multiple blocks in the same row/column at once
    moveTile(x, y) {
        if (this.destroyed) return false;

        const ex = this.emptyPos.x;
        const ey = this.emptyPos.y;

        if (x === ex && y === ey) return; // Clicked empty slot

        if (x === ex) {
            // Vertical shift
            const dir = y > ey ? 1 : -1;
            for (let currY = ey; currY !== y; currY += dir) {
                this.matrix[currY][ex] = this.matrix[currY + dir][ex];
            }
            this.matrix[y][x] = 0;
            this.emptyPos.y = y;
        } else if (y === ey) {
            // Horizontal shift
            const dir = x > ex ? 1 : -1;
            for (let currX = ex; currX !== x; currX += dir) {
                this.matrix[ey][currX] = this.matrix[ey][currX + dir];
            }
            this.matrix[y][x] = 0;
            this.emptyPos.x = x;
        } else {
            return; // Not in the same row or column
        }

        this.updateDOM(true);
        this.checkWin();
    }

    updateDOM(animate) {
        if (this.destroyed) return;

        for (let y = 0; y < this.rows; y++) {
            for (let x = 0; x < this.cols; x++) {
                const tileId = this.matrix[y][x];
                if (tileId !== 0) {
                    const tile = this.tiles[tileId];
                    tile.style.left = `${x * this.tileWidth}px`;
                    tile.style.top = `${y * this.tileHeight}px`;
                }
            }
        }
    }

    checkWin() {
        if (this.destroyed) return;

        let expectedId = 1;
        const max = this.rows * this.cols;

        for (let y = 0; y < this.rows; y++) {
            for (let x = 0; x < this.cols; x++) {
                if (expectedId === max) {
                    if (this.matrix[y][x] !== 0) return; // Empty slot isn't at the end
                } else {
                    if (this.matrix[y][x] !== expectedId) return; // Block out of place
                }
                expectedId++;
            }
        }

        // Win state logic
        this.isPlaying = false;
        this.winTimeout = this.setManagedTimeout(() => {
            this.winTimeout = null;
            alert('win');
        }, (this.config.time ? this.config.time * 1000 : 50));
    }

    addResizeListener() {
        if (this.resizeListenerAttached || typeof window === "undefined") return;
        window.addEventListener('resize', this.resizeHandler, true);
        this.resizeListenerAttached = true;
    }

    removeResizeListener() {
        if (!this.resizeListenerAttached || typeof window === "undefined") return;
        window.removeEventListener('resize', this.resizeHandler, true);
        this.resizeListenerAttached = false;
    }

    handleResize() {
        if (this.destroyed || !this.container || !this.container.parentNode) return;

        const rect = this.container.parentNode.getBoundingClientRect();
        const scale = Math.min(rect.width / this.config.size[0], rect.height / this.config.size[1]);
        this.container.style.transform = `scale(${scale})`;
        this.container.style.transformOrigin = "center center";
    }

    handleKeyDown(event) {
        if (this.destroyed || !this.isPlaying) return;

        const { x, y } = this.emptyPos;

        // Arrows pull tiles *into* the empty slot securely
        if (event.keyCode === 37 && x < this.cols - 1) this.moveTile(x + 1, y); // Left
        else if (event.keyCode === 39 && x > 0) this.moveTile(x - 1, y);        // Right
        else if (event.keyCode === 38 && y < this.rows - 1) this.moveTile(x, y + 1); // Up
        else if (event.keyCode === 40 && y > 0) this.moveTile(x, y - 1);        // Down
    }

    pollGamepads() {
        if (this.destroyed || typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return;

        const gamepads = navigator.getGamepads() || [];
        for (let gamepad of gamepads) {
            if (!gamepad) continue;
            const isPressed = gamepad.buttons.some(btn => btn.pressed);

            if (this.lastGamepadState !== isPressed && this.isPlaying) {
                this.lastGamepadState = isPressed;
                const { x, y } = this.emptyPos;

                // Standard D-Pad Mapping (Safely accessing bounds)
                if (gamepad.buttons[12].pressed && y < this.rows - 1) this.moveTile(x, y + 1); // Up
                else if (gamepad.buttons[13].pressed && y > 0) this.moveTile(x, y - 1);        // Down
                else if (gamepad.buttons[14].pressed && x < this.cols - 1) this.moveTile(x + 1, y); // Left
                else if (gamepad.buttons[15].pressed && x > 0) this.moveTile(x - 1, y);        // Right
            }
        }
    }

    startGamepadLoop() {
        if (this.destroyed || this.gamepadLoop !== null) return;

        const updateGamepad = () => {
            if (this.destroyed) return;
            this.pollGamepads();
            this.gamepadLoop = this.setManagedAnimationFrame(updateGamepad);
        };

        this.gamepadLoop = this.setManagedAnimationFrame(updateGamepad);
    }

    handleGamepadConnected() {
        if (this.destroyed) return;

        // Preserve the original immediate poll, while ensuring repeated
        // connection events cannot create multiple RAF polling loops.
        this.pollGamepads();
        this.startGamepadLoop();
    }

    bindInputs() {
        // Keyboard Support
        if (this.config.keyBoard) {
            document.addEventListener("keydown", this.keyDownHandler);
        }

        // Gamepad Support
        if (this.config.gamePad) {
            window.addEventListener('gamepadconnected', this.gamepadConnectedHandler);

            // A replacement instance can be created after the gamepad was
            // already connected, in which case the browser will not fire
            // gamepadconnected again. Start polling only if a pad is present.
            if (typeof navigator !== "undefined" && typeof navigator.getGamepads === "function") {
                try {
                    let hasGamepad = false;
                    const existingGamepads = navigator.getGamepads() || [];
                    for (const gamepad of existingGamepads) {
                        if (gamepad) {
                            hasGamepad = true;
                            break;
                        }
                    }
                    if (hasGamepad) this.handleGamepadConnected();
                } catch (error) {
                    // Some embedders restrict gamepad access. The
                    // gamepadconnected listener remains available as a fallback.
                }
            }
        }
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.isPlaying = false;

        if (this.config.keyBoard) {
            document.removeEventListener("keydown", this.keyDownHandler);
        }
        if (this.config.gamePad) {
            window.removeEventListener('gamepadconnected', this.gamepadConnectedHandler);
        }
        this.removeResizeListener();

        // Remove click listeners from all tiles owned by this instance.
        Object.keys(this.tileClickHandlers).forEach((id) => {
            const tile = this.tiles[id];
            if (tile) tile.removeEventListener("click", this.tileClickHandlers[id]);
        });
        this.tileClickHandlers = {};

        // Cancel pending shuffle/win callbacks and all other tracked timers.
        if (this.shuffleTimeout !== null) {
            clearTimeout(this.shuffleTimeout);
            this.timeoutIds.delete(this.shuffleTimeout);
            this.shuffleTimeout = null;
        }
        if (this.winTimeout !== null) {
            clearTimeout(this.winTimeout);
            this.timeoutIds.delete(this.winTimeout);
            this.winTimeout = null;
        }
        this.timeoutIds.forEach((id) => clearTimeout(id));
        this.timeoutIds.clear();

        // Stop the active gamepad loop and any other pending animation frames.
        if (this.gamepadLoop !== null && this.gamepadLoop !== undefined) {
            cancelAnimationFrame(this.gamepadLoop);
            this.animationFrameIds.delete(this.gamepadLoop);
            this.gamepadLoop = null;
        }
        this.animationFrameIds.forEach((id) => cancelAnimationFrame(id));
        this.animationFrameIds.clear();
    }
}
// Expose the constructor without changing the browser/exported-HTML usage.
if (typeof window !== "undefined") {
    window.FifteenPuzzle = FifteenPuzzle;
}
if (typeof module !== "undefined" && module.exports) {
    module.exports = FifteenPuzzle;
    module.exports.FifteenPuzzle = FifteenPuzzle;
    module.exports.default = FifteenPuzzle;
}

// Automatically start game if the global setup object exists (backward compatibility)
if (typeof setup !== 'undefined' && setup.puzzle_fifteen && typeof window !== 'undefined') {
    window.gameInstance = new FifteenPuzzle(setup.puzzle_fifteen, "fifteen");
}
