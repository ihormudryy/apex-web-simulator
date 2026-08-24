/**
 * Drag-and-drop loader for user-supplied .gltf / .glb assets.
 *
 * Custom models are the user's responsibility — only load content you have
 * rights to use. The default bundled meshes are generic placeholders.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { normalizeToGround, enableGltfShadows } from './normalizeGltf.js';

const ACCEPT = ['.gltf', '.glb'];

/**
 * @param {File} file
 */
function isGltfFile(file) {
  const name = file.name.toLowerCase();
  return ACCEPT.some(ext => name.endsWith(ext));
}

export class GltfDropZone {
  /**
   * @param {HTMLElement} container
   * @param {{ onCar: (root: THREE.Object3D, file: File) => void, onTrack: (root: THREE.Object3D, file: File) => void, onError: (msg: string) => void }} handlers
   */
  constructor(container, { onCar, onTrack, onError }) {
    this._loader = new GLTFLoader();
    this._onCar = onCar;
    this._onTrack = onTrack;
    this._onError = onError;

    this.root = document.createElement('div');
    this.root.className = 'mod-drop';
    this.root.innerHTML = [
      '<div class="mod-drop__label">Mods</div>',
      '<div class="mod-drop__hint">Drop .glb / .gltf — car or scenery</div>',
      '<div class="mod-drop__status" aria-live="polite"></div>',
    ].join('');
    this._status = this.root.querySelector('.mod-drop__status');

    if (!document.getElementById('mod-drop-styles')) {
      const style = document.createElement('style');
      style.id = 'mod-drop-styles';
      style.textContent = `
.mod-drop {
  position: absolute; left: 14px; bottom: 118px; z-index: 140;
  pointer-events: auto; font: 10px/1.45 ui-monospace, Menlo, monospace;
  color: #7b8798; background: rgba(9,11,15,0.78);
  border: 1px dashed rgba(163,186,219,0.35); padding: 8px 10px; max-width: 200px;
}
.mod-drop.mod-drop--active { border-color: #35b6ff; color: #e9eff8; }
.mod-drop__label { letter-spacing: 0.12em; text-transform: uppercase; color: #e9eff8; margin-bottom: 4px; }
.mod-drop__status { margin-top: 6px; color: #35e06b; font-size: 9px; }
.mod-drop__status[data-kind=error] { color: #ff5a4a; }
`;
      document.head.appendChild(style);
    }

    container.appendChild(this.root);
    container.addEventListener('dragover', e => this._onDragOver(e));
    container.addEventListener('dragleave', () => this.root.classList.remove('mod-drop--active'));
    container.addEventListener('drop', e => this._onDrop(e));
  }

  /** @param {DragEvent} e */
  _onDragOver(e) {
    if (![...e.dataTransfer?.types ?? []].includes('Files')) return;
    e.preventDefault();
    this.root.classList.add('mod-drop--active');
  }

  /** @param {DragEvent} e */
  async _onDrop(e) {
    e.preventDefault();
    this.root.classList.remove('mod-drop--active');
    const file = [...e.dataTransfer?.files ?? []].find(isGltfFile);
    if (!file) {
      this._setStatus('Need a .glb or .gltf file', 'error');
      return;
    }
    try {
      const url = URL.createObjectURL(file);
      const gltf = await this._loader.loadAsync(url);
      URL.revokeObjectURL(url);
      const root = gltf.scene;
      normalizeToGround(root);
      enableGltfShadows(root);
      const kind = this._guessKind(root, file.name);
      if (kind === 'car') this._onCar(root, file);
      else this._onTrack(root, file);
      this._setStatus(`${file.name} → ${kind}`, 'ok');
    } catch (err) {
      this._onError(String(err));
      this._setStatus('Load failed — check console', 'error');
      console.error(err);
    }
  }

  /** @param {THREE.Object3D} root @param {string} name */
  _guessKind(root, name) {
    const n = name.toLowerCase();
    if (n.includes('car') || n.includes('vehicle') || n.includes('body')) return 'car';
    if (n.includes('track') || n.includes('circuit') || n.includes('scene')) return 'track';
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const long = Math.max(size.x, size.z);
    const flat = size.y < long * 0.35;
    return flat && long > 8 ? 'track' : 'car';
  }

  /** @param {string} text @param {'ok'|'error'} kind */
  _setStatus(text, kind) {
    this._status.textContent = text;
    this._status.dataset.kind = kind;
  }
}
